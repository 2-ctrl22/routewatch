#!/usr/bin/env node
/**
 * budget.mjs - keeps track of AeroDataBox units and requests per period.
 *
 *   node scripts/budget.mjs                        show the current position
 *   node scripts/budget.mjs --check                exit 1 if the next run does not fit
 *   node scripts/budget.mjs --record 101 142       record a finished run: calls, units
 *   node scripts/budget.mjs --seed 251 169         seed from the dashboard: units, calls
 *   node scripts/budget.mjs --period 2026-08-18 30 set period start and length
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
 * ------------------------------------------------------- MEASURED, 19 AUGUST 2026
 *   RapidAPI 7-day view:   169 calls in total
 *   RapidAPI 30-day view:   68 calls, active on 18 August only (one day behind)
 *   Difference:            101 calls on 19 August
 *
 * The 19 August run: 41 collector calls at 2 units = 82, plus 30 airports at
 * 2 units = 60, so 101 calls and 142 units. That matches the graph exactly.
 *
 * For 18 August only the call count is known, not the mix, so units there are
 * between 68 and 136. Roughly 109 is the realistic figure: 41 collector calls at
 * 2 units plus 27 tier-1 calls at 1 unit.
 *
 * ------------------------------------------------------------------ THE PERIOD
 * Still unverified: RapidAPI quotas reset per subscription period, not per
 * calendar month, and neither dashboard view shows the reset date. The 30-day
 * view is a rolling window, not a billing period.
 *
 * The default below therefore assumes the period starts on the 18th, the day the
 * subscription was taken. That is the STRICTER assumption: it puts four Mondays in
 * the period instead of two. Correct it with --period once you know, because the
 * difference decides whether two runs fit or four.
 *
 * Overage note: API Overage Spend reads $0 and this is a free plan, so exceeding
 * the quota blocks calls with HTTP 429 rather than charging money. The risk being
 * managed here is a stalled run, not a bill.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const LOG = (...a) => console.log("[budget]", ...a);
const FILE = "data/unit-budget.json";
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const after = (f, n = 1) => { const i = argv.indexOf(f); return i < 0 ? null : argv[i + n]; };
const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

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
  _period_is_unverified: "Assumed to start on the 18th, the subscription date. RapidAPI resets "
    + "per subscription period, not per calendar month. Correct with --period.",
  period_start: "2026-08-18",
  period_days: 30,
  seeded_units: 0,
  seeded_calls: 0,
  runs: []
};

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
