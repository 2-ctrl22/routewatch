#!/usr/bin/env node
/**
 * budget.mjs - keeps track of AeroDataBox units and requests per period.
 *
 *   node scripts/budget.mjs                        show the current position
 *   node scripts/budget.mjs --check                exit 1 if the next run does not fit
 *   node scripts/budget.mjs --plan 60 --reserve auto --margin 34   plan a run
 *   node scripts/budget.mjs --record 101 142       record a finished run: calls, units
 *   node scripts/budget.mjs --seed 260 169         seed from the dashboard: units, calls
 *   node scripts/budget.mjs --period 2026-08-18 31 set period start and length
 *
 * ------------------------------------------------------------------ WHY THIS EXISTS
 * On 19 August 2026 the budget was estimated three times and the estimate changed
 * twice, because nobody had checked the actual cost per endpoint. This file exists
 * so that never happens again: the costs below are read off the source code, not
 * guessed, and the dashboard numbers are recorded rather than reconstructed.
 *
 * ------------------------------------------------------- VERIFIED COSTS PER CALL
 * From scripts/enrich-adb.mjs, where get(url, units, label) states the cost:
 *
 *   /airports/icao/{icao}                1 unit    tier 1
 *   /airports/icao/{icao}/runways        1 unit    tier 1
 *   /aircrafts/reg/{reg}                 1 unit    tier 1
 *   /flights/number/{no}/{from}/{to}     2 units   tier 2
 *
 * From scripts/collect-adb.mjs, via ADB_UNITS_PER_CALL:
 *
 *   /flights/airports/icao/{icao}/...    2 units   tier 2
 *
 * IMPORTANT: the runway section spends 2 units per AIRPORT, because it makes two
 * separate 1-unit calls per airport - the airport record and its runways. The log
 * line "units 2/60" after the first airport is therefore correct, not a
 * double-count. A cap of 60 buys 30 airports and costs 60 real units.
 *
 * ---------------------------------------------------- MEASURED, 19-20 AUGUST 2026
 *   RapidAPI 7-day view:     169 calls in total
 *   RapidAPI 30-day view:     68 calls, active on 18 August only (one day behind)
 *   Difference:              101 calls on 19 August
 *   Subscriptions view:      Quota Usage 43.33 % of 600 units = 260 units used
 *
 * The 19 August run: 41 collector calls at 2 units = 82, plus 30 airports at
 * 2 units = 60, so 101 calls and 142 units. That matches the graph exactly.
 *
 * 18 August now follows by subtraction, because the total is measured rather than
 * estimated: 68 calls and 118 units, which resolves to 50 calls at 2 units plus 18
 * calls at 1 unit. Those 18 single-unit calls are the 9 airports that were already
 * cached before the 19 August run, at 2 calls each. The earlier figure of "roughly
 * 109 units" was an estimate and it was wrong. Do not reintroduce it.
 *
 * ------------------------------------------------------------------ THE PERIOD
 * Verified on 20 August 2026. The RapidAPI Subscriptions view lists AeroDataBox
 * Basic ($0.00/mo), status Active, Date Subscribed 18 aug 2026 19:19, Quota Usage
 * 43.33 %, Bandwidth Quota 0.04 %. RapidAPI resets per subscription period, so the
 * next reset is 18 September 2026 at 19:19, not the first of the month. The 30-day
 * view stays a rolling window and is not a billing period.
 *
 * Consequence for this period, and it is the strict variant: four Mondays fall
 * inside it - 24 and 31 August, 7 and 14 September. At 142 units per run that is
 * 568 units against 340 remaining, so only two full runs fit.
 *
 * ------------------------------------------------------- AUTOMATIC ROLLOVER
 * The period rolls forward on its own, by calendar month rather than by a fixed
 * number of days, so it can never drift off the 18th. A ledger left on an expired
 * period would report units that no longer exist and block runs that in fact fit.
 *
 * The roll happens one day AFTER the anniversary, not on it. The reset itself is at
 * 19:19 while the workflow starts at 05:00 UTC, so rolling on the day itself could
 * hand out a clean budget hours before RapidAPI has actually reset. Recorded runs
 * are kept and filtered by date, not deleted, so nothing is lost if a run and a
 * roll land on the same day.
 *
 * A roll is announced in the log. Verify it against the dashboard when convenient
 * with --seed; the roll assumes a full quota, it does not measure one.
 *
 * ------------------------------------------------------------------ PLANNING
 * --plan MAX prints key=value lines on stdout and nothing else, so a workflow can
 * append it to $GITHUB_OUTPUT. Every human-readable line goes to stderr in that
 * mode. The collector is non-negotiable; enrichment gets what is left after the
 * reserve, capped at MAX and rounded down to an even number because a flight
 * number costs 2 units.
 *
 * --reserve auto keeps the collector funded for every remaining Monday except the
 * last one. A tight period therefore costs the rotation first, and at most the
 * final week of collection, never a week in the middle: the ledger the alpha
 * depends on keeps growing every Monday. --margin is added on top of the reserve in
 * both modes and is what remains available for a retry after a 429.
 *
 * Worked example, 20 August 2026 with 340 units left and 4 Mondays to go:
 * reserve = 82 x (4 - 2) + 34 = 198, so enrichment gets min(60, 340 - 82 - 198) =
 * 60 on 24 August. The two Mondays after that fall back to collector only, and
 * 14 September is stopped by --check before a single unit is spent.
 *
 * Overage note: API Overage Spend reads $0 and this is a free plan, so exceeding
 * the quota blocks calls with HTTP 429 rather than charging money. The risk being
 * managed here is a stalled run, not a bill.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const FILE = "data/unit-budget.json";
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const after = (f, n = 1) => { const i = argv.indexOf(f); return i < 0 ? null : argv[i + n]; };
const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/* In --plan mode stdout carries key=value lines only. Everything else goes to
 * stderr, otherwise the log would end up in $GITHUB_OUTPUT. */
const PLAN = has("--plan");
const LOG = (...a) => (PLAN ? console.error : console.log)("[budget]", ...a);
const OUT = (k, v) => console.log(`${k}=${v}`);

/* Verified unit cost per endpoint. Unknown endpoints cost 2, never 1, so an
 * unrecognised call can never make the projection look cheaper than reality. */
export const UNIT_COST = [
  [/\/airports\/icao\/[^/]+\/runways/i, 1],
  [/\/airports\/icao\/[^/]+$/i, 1],
  [/\/aircrafts?\/reg\//i, 1],
  [/\/flights\/number\//i, 2],
  [/\/flights\/airports\//i, 2]
];
export const unitsFor = path => (UNIT_COST.find(([re]) => re.test(path)) ?? [null, 2])[1];

const UNIT_LIMIT = numOr(process.env.ADB_UNIT_LIMIT, 600);
const REQ_LIMIT = numOr(process.env.ADB_REQUEST_LIMIT, 2400);
const today = new Date().toISOString().slice(0, 10);

let L;
try { L = JSON.parse(readFileSync(FILE, "utf8")); } catch { L = null; }
L ??= {
  _what_this_is: "Units and requests per subscription period. Two independent limits: "
    + "units are tier-weighted, requests are raw call counts.",
  _period_verified: "Verified on 20 August 2026 against the RapidAPI Subscriptions view: "
    + "Date Subscribed 18 aug 2026 19:19. RapidAPI resets per subscription period, not per "
    + "calendar month. The period rolls forward by itself; confirm with --seed.",
  period_start: "2026-08-18",
  period_days: 30,
  seeded_units: 0,
  seeded_calls: 0,
  runs: []
};

/* Same day of the month, one month on. A 31st in a 30-day month clamps to the last
 * day of that month instead of spilling into the next one. */
function nextAnniversary(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const t = new Date(Date.UTC(y, m, d));
  if (t.getUTCDate() !== d) t.setUTCDate(0);
  return t.toISOString().slice(0, 10);
}
const daysBetween = (a, b) =>
  Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);

if (!has("--period")) {
  let rolls = 0;
  while (rolls < 24) {
    const anniversary = nextAnniversary(L.period_start);
    const rollAt = new Date(anniversary + "T00:00:00Z").getTime() + 864e5;
    if (Date.now() < rollAt) break;
    L.period_start = anniversary;
    L.period_days = daysBetween(anniversary, nextAnniversary(anniversary));
    L.seeded_units = 0;
    L.seeded_calls = 0;
    rolls++;
  }
  if (rolls) LOG(`period rolled forward to ${L.period_start} for ${L.period_days} days, `
    + `counters cleared - confirm against the RapidAPI dashboard with --seed`);
}

if (has("--period")) {
  const d = after("--period"), days = numOr(after("--period", 2), 30);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) {
    console.error("[budget] --period needs YYYY-MM-DD, optionally followed by a number of days");
    process.exit(1);
  }
  L.period_start = d;
  L.period_days = days;
  L.seeded_units = 0;
  L.seeded_calls = 0;
  L.runs = [];
  LOG(`period set to ${d} for ${days} days, ledger cleared`);
}

if (has("--seed")) {
  const u = numOr(after("--seed"), null), c = numOr(after("--seed", 2), null);
  if (u === null) {
    console.error("[budget] --seed needs units, optionally followed by calls");
    process.exit(1);
  }
  L.seeded_units = u;
  if (c !== null) L.seeded_calls = c;
  LOG(`seeded with ${u} units${c !== null ? ` and ${c} calls` : ""}`);
}

if (has("--record")) {
  const c = numOr(after("--record"), null), u = numOr(after("--record", 2), null);
  if (c === null || u === null) {
    console.error("[budget] --record needs two numbers: calls and units");
    process.exit(1);
  }
  L.runs.push({ at: today, calls: c, units: u });
  LOG(`recorded ${c} calls and ${u} units on ${today}`);
}

L.runs = (L.runs ?? []).filter(r => r.at >= L.period_start);
L.unit_limit = UNIT_LIMIT;
L.request_limit = REQ_LIMIT;

const usedUnits = L.seeded_units + L.runs.reduce((n, r) => n + numOr(r.units, 0), 0);
const usedCalls = L.seeded_calls + L.runs.reduce((n, r) => n + numOr(r.calls, 0), 0);
const leftUnits = UNIT_LIMIT - usedUnits;
const leftCalls = REQ_LIMIT - usedCalls;

/* ------------------------------------------------- projected cost of one run */

let airports = null;
try {
  const cfg = JSON.parse(readFileSync("config/collection.json", "utf8"));
  if (Array.isArray(cfg?.airports)) airports = cfg.airports.length;
} catch { /* leave null */ }

const ENRICH_CAP = numOr(process.env.ENRICH_UNIT_CAP, 60);
const COLLECT_PER_CALL = numOr(process.env.ADB_UNITS_PER_CALL, 2);

/* Collector: one call per airport at 2 units.
 * Enrichment: spends up to its cap in real units. Its cheapest calls cost 1 unit,
 * so the cap is also the worst-case number of calls it can make. */
const projUnits = airports === null ? null : airports * COLLECT_PER_CALL + ENRICH_CAP;
const projCalls = airports === null ? null : airports + ENRICH_CAP;

const start = new Date(L.period_start + "T00:00:00Z");
const end = new Date(start.getTime() + L.period_days * 864e5);
const daysLeft = Math.max(0, Math.ceil((end - Date.now()) / 864e5));
const mondaysLeft = (() => {
  let n = 0;
  for (let t = Date.now(); t < end.getTime(); t += 864e5)
    if (new Date(t).getUTCDay() === 1) n++;
  return n;
})();

LOG(`period ${L.period_start} for ${L.period_days} days, ${daysLeft} day(s) left, ${mondaysLeft} Monday(s) to go`);
LOG(`units ${usedUnits} of ${UNIT_LIMIT}, ${leftUnits} left`);
LOG(`requests ${usedCalls} of ${REQ_LIMIT}, ${leftCalls} left`);

if (PLAN) {
  const max = Math.max(0, numOr(after("--plan"), 60));
  const margin = Math.max(0, numOr(after("--margin"), 0));
  const reserveArg = after("--reserve");
  const auto = String(reserveArg) === "auto";
  if (airports === null) {
    LOG("config/collection.json unreadable, so enrichment gets 0 units");
    OUT("airports", 0);
    OUT("collector_units", 0);
    OUT("enrich_cap", 0);
  } else {
    const collectorUnits = airports * COLLECT_PER_CALL;
    const futureMondays = Math.max(0, mondaysLeft - 2);
    const reserve = (auto ? collectorUnits * futureMondays : Math.max(0, numOr(reserveArg, 0))) + margin;
    let cap = Math.min(max, leftUnits - collectorUnits - reserve);
    if (!Number.isFinite(cap) || cap < 0) cap = 0;
    cap -= cap % 2;
    LOG(`plan: ${leftUnits} units left, collector ${collectorUnits}, reserve ${reserve}`
      + (auto ? ` (${futureMondays} Monday(s) of collector plus margin ${margin})` : "")
      + `, so enrichment gets ${cap} of at most ${max}`);
    if (cap === 0) LOG("plan: no room for enrichment this run, the collector goes alone");
    OUT("airports", airports);
    OUT("collector_units", collectorUnits);
    OUT("enrich_cap", cap);
  }
}

let fail = false;
if (projUnits === null) {
  LOG("config/collection.json unreadable, so no projection");
} else {
  LOG(`one run: ${projCalls} calls at most, ${projUnits} units `
    + `(${airports} collector calls at ${COLLECT_PER_CALL}, enrichment cap ${ENRICH_CAP})`);
  const fits = Math.floor(leftUnits / projUnits);
  LOG(`room for ${fits} more run(s); ${mondaysLeft} scheduled`);
  if (mondaysLeft > fits)
    LOG(`WARNING: ${mondaysLeft} Monday(s) scheduled but only ${fits} fit. `
      + `Lower ENRICH_UNIT_CAP, remove airports, or skip a week.`);

  if (has("--check")) {
    if (projUnits > leftUnits) {
      console.error(`[budget] ERROR: this run needs ${projUnits} units, only ${leftUnits} remain `
        + `(period resets in ${daysLeft} day(s))`);
      fail = true;
    } else if (projCalls > leftCalls) {
      console.error(`[budget] ERROR: this run needs up to ${projCalls} requests, only ${leftCalls} remain`);
      fail = true;
    }
  }
}

if (L.runs.length) {
  const last = L.runs[L.runs.length - 1];
  LOG(`${L.runs.length} run(s) recorded this period, last ${last.at}: ${last.calls} calls, ${last.units} units`);
}

mkdirSync("data", { recursive: true });
writeFileSync(FILE, JSON.stringify(L, null, 1) + "\n");

if (fail) {
  console.error("[budget] stopping before any units are spent");
  process.exit(1);
}
