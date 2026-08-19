#!/usr/bin/env node
/**
 * collect-adb.mjs - budget-conscious collector for RouteWatch
 *
 * Does NOT touch routewatch.mjs. Writes CSVs in the shape the existing manual()
 * provider already reads:
 *     data/manual/{ICAO}_{YYYY-MM-DD}.csv
 *     arr_icao,airline,flight_no,std,type_raw,cargo,reg,airline_name
 *
 * ------------------------------------------------------------------ FIX v2 --
 * WHAT WAS WRONG: the URL sets withLeg=true. The documentation says about that:
 *   "Movement property will be replaced with Departure and Arrival properties"
 * This code read f.movement.airport.icao, which then does not exist, so every
 * destination came out undefined and fell outside the collection. Result: 527
 * departures found at EHAM and 0 usable rows.
 *
 * NOW: arrival.airport first, then movement.airport as a fallback. So it works
 * with and without withLeg. On top of that an IATA code is recognised and
 * translated to ICAO through the config, so AMS also yields EHAM.
 *
 * ALSO NEW: 429 backoff. On the previous run the rate limit hit after only 9
 * calls even though the pauses were 1.3 to 2.8 seconds. The pause is now
 * 2,500 ms and on a 429 the script waits 60 seconds and retries once before
 * giving up.
 *
 * ------------------------------------------------------------------ FIX v3 --
 * The registration is written as a seventh column. routewatch.mjs stores it per
 * flight line in the ledger as `regs`, and enrich-adb.mjs reads exactly that
 * field to look up aircraft. Without this column that lookup has nothing to
 * work with and data/aircraft-meta.json stays empty.
 *
 * -------------------------------------------------------------------- v4 ---
 * AIRLINE NAMES, FOR FREE. Every flight object already carries f.airline.name,
 * and we used to throw it away after picking the code. It is now written as an
 * eighth column, so routewatch.mjs can build data/airlines.json from your own
 * observations. No extra API units, and a new or renamed airline names itself
 * the first time it shows up in your network.
 *
 * Both new columns are appended at the end, and manual() maps columns by name,
 * so older CSVs without them keep working.
 *
 * BUDGET (AeroDataBox BASIC: 600 units/month, 2400 requests, 1 req/second)
 *   Tier 1 = 1 unit, Tier 2 = 2, Tier 3 = 6, Tier 4 = 60.
 *   41 airports x 2 units = 82 units per round, 1 round per week = about 355/month.
 *
 * COVERAGE WITHOUT BLIND SPOTS
 *   The FIDS window may be 12 hours at most. Instead of 2 calls per day we make
 *   1 call and rotate the window per week:
 *     week 0: 06:00-18:00   week 1: 12:00-00:00
 *     week 2: 00:00-12:00   week 3: 18:00-06:00
 *   The measured day also shifts per week, so all 7 weekdays come around.
 *   The ledger in routewatch.mjs is cumulative, so those partial measurements
 *   add up.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const LOG = (...a) => console.log("[collect-adb]", ...a);

const KEY = process.env.RAPIDAPI_KEY;
if (!KEY) {
  LOG("no RAPIDAPI_KEY set - nothing to do, RouteWatch will run on the existing CSVs");
  process.exit(0);
}

const HOST = "aerodatabox.p.rapidapi.com";
const UNITS_PER_CALL = Number(process.env.ADB_UNITS_PER_CALL ?? 2);
const UNIT_CAP = Number(process.env.ADB_UNIT_CAP ?? 110);
const DAYS = Math.max(1, Math.min(7, Number(process.env.BACKFILL_DAYS ?? 1)));
const OVERWRITE = String(process.env.ADB_OVERWRITE ?? "").toLowerCase() === "true";
const SLEEP_MS = Number(process.env.ADB_SLEEP_MS ?? 2500);
const BACKOFF_MS = Number(process.env.ADB_BACKOFF_MS ?? 60000);

let spent = 0;
let stopped = false;
let diagnosed = false;

/* ---------------------------------------------------------------- config --- */

let CFG;
try {
  CFG = JSON.parse(readFileSync("config/collection.json", "utf8"));
} catch (e) {
  LOG("cannot read config/collection.json:", e.message);
  process.exit(1);
}

const AIRPORTS = (CFG.airports ?? []).map(a => a.icao).filter(Boolean);
const KNOWN = new Set(AIRPORTS);

// IATA -> ICAO, so AMS is recognised as EHAM as well.
const IATA2ICAO = {};
for (const a of CFG.airports ?? []) {
  if (a.iata && a.icao) IATA2ICAO[String(a.iata).toUpperCase()] = a.icao;
}

if (!AIRPORTS.length) {
  LOG("no airports found in the config");
  process.exit(1);
}

/* ------------------------------------------------------------- rotation --- */

const EPOCH = Date.UTC(2026, 0, 5);                 // Monday 5 January 2026
const weekIndex = Math.floor((Date.now() - EPOCH) / (7 * 864e5));
const WINDOWS = ["06:00", "12:00", "00:00", "18:00"];
const START = process.env.ADB_WINDOW || WINDOWS[((weekIndex % 4) + 4) % 4];
const DAY_SHIFT = ((weekIndex % 7) + 7) % 7;

const pad = n => String(n).padStart(2, "0");
const iso = d => d.toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function windowFor(day) {
  const h = Number(START.slice(0, 2));
  const m = Number(START.slice(3, 5));
  return {
    from: `${day}T${pad(h)}:${pad(m)}`,
    to: `${day}T${pad((h + 12) % 24)}:${pad(m)}`
  };
}

/* ------------------------------------------------------------------ csv --- */

/* reg and airline_name are last on purpose: manual() in routewatch.mjs maps
   columns by name, so appending a column never breaks CSVs already on disk. */
const HEADER = "arr_icao,airline,flight_no,std,type_raw,cargo,reg,airline_name";
const clean = v => String(v ?? "").replace(/[,\r\n]/g, " ").trim();

function writeCsv(icao, day, rows) {
  mkdirSync("data/manual", { recursive: true });
  const path = `data/manual/${icao}_${day}.csv`;
  const body = rows.map(r =>
    [clean(r.arr), clean(r.airline), clean(r.flight), clean(r.std), clean(r.type),
     r.cargo ? 1 : 0, clean(r.reg), clean(r.airline_name)].join(",")
  );
  writeFileSync(path, [HEADER, ...body].join("\n") + "\n");
  const withReg = rows.filter(r => r.reg).length;
  const withName = rows.filter(r => r.airline_name).length;
  LOG(`wrote ${path}: ${rows.length} rows, ${withReg} with a registration, ${withName} with an airline name`);
}

/* -------------------------------------------------------- destination ----- */

/* With withLeg=true the block is called arrival; without withLeg it is called
 * movement. Both are tried, and ICAO as well as IATA is recognised.
 */
function destOf(f) {
  const ap = f?.arrival?.airport ?? f?.movement?.airport ?? null;
  if (!ap) return null;
  const icao = String(ap.icao ?? "").toUpperCase();
  if (icao && KNOWN.has(icao)) return icao;
  const iata = String(ap.iata ?? "").toUpperCase();
  if (iata && IATA2ICAO[iata]) return IATA2ICAO[iata];
  return null;
}

function stdOf(f) {
  const dep = f?.departure ?? f?.movement ?? {};
  const t = dep?.scheduledTime?.local ?? dep?.scheduledTimeLocal ?? dep?.scheduledTime?.utc ?? "";
  const s = String(t);
  const m = s.match(/(\d{2}:\d{2})/);
  return m ? m[1] : "";
}

/* One-off diagnosis: which keys does the answer really contain?
 * Costs nothing and stops us from ever having to guess again.
 */
function diagnose(f) {
  if (diagnosed || !f) return;
  diagnosed = true;
  LOG(`diagnosis - keys per flight: ${Object.keys(f).join(", ")}`);
  const ap = f?.arrival?.airport ?? f?.movement?.airport;
  if (ap) LOG(`diagnosis - destination keys: ${Object.keys(ap).join(", ")} | icao=${ap.icao ?? "-"} iata=${ap.iata ?? "-"}`);
  else LOG(`diagnosis - NO arrival.airport and NO movement.airport found`);
  const ac = f?.aircraft;
  if (ac) LOG(`diagnosis - aircraft keys: ${Object.keys(ac).join(", ")} | reg=${ac.reg ?? "-"}`);
  else LOG(`diagnosis - no aircraft block, so no registrations this run`);
  const al = f?.airline;
  if (al) LOG(`diagnosis - airline keys: ${Object.keys(al).join(", ")} | iata=${al.iata ?? "-"} icao=${al.icao ?? "-"} name=${al.name ?? "-"}`);
  else LOG(`diagnosis - no airline block, so no airline names this run`);
}

/* ------------------------------------------------------------- fetching --- */

async function fetchAirportDay(icao, day, retried = false) {
  if (stopped) return null;
  if (spent + UNITS_PER_CALL > UNIT_CAP) {
    LOG(`unit cap ${UNIT_CAP} reached after ${spent} units - rest of the run skipped`);
    stopped = true;
    return null;
  }

  const { from, to } = windowFor(day);
  const url = `https://${HOST}/flights/airports/icao/${icao}/${from}/${to}`
    + "?withLeg=true&direction=Departure&withCancelled=false&withCodeshared=false&withCargo=true&withPrivate=false";

  try {
    const res = await fetch(url, { headers: { "X-RapidAPI-Key": KEY, "X-RapidAPI-Host": HOST } });
    spent += UNITS_PER_CALL;

    if (res.status === 429) {
      if (!retried) {
        LOG(`${icao} ${day}: 429 - waiting ${Math.round(BACKOFF_MS / 1000)}s and retrying once`);
        await sleep(BACKOFF_MS);
        return fetchAirportDay(icao, day, true);
      }
      LOG(`${icao} ${day}: 429 after the second attempt - quota or rate limit, stopping this run`);
      stopped = true;
      return null;
    }
    if (res.status === 403) { LOG(`${icao} ${day}: 403 - key not subscribed to this plan, stopping`); stopped = true; return null; }
    if (res.status === 404) { LOG(`${icao} ${day}: 404 - no data in this window`); return []; }
    if (!res.ok) { LOG(`${icao} ${day}: HTTP ${res.status}`); return []; }

    const j = await res.json();
    const deps = j.departures ?? [];
    diagnose(deps[0]);

    const rows = [];
    for (const f of deps) {
      const arr = destOf(f);
      if (!arr || arr === icao) continue;                 // only pairs inside your collection
      rows.push({
        arr,
        airline: f?.airline?.iata ?? f?.airline?.icao ?? f?.airline?.name ?? "?",
        flight: String(f?.number ?? "").replace(/\s/g, "") || "?",
        std: stdOf(f),
        type: f?.aircraft?.model ?? f?.aircraft?.typeCode ?? "",
        cargo: String(f?.isCargo ?? "").toLowerCase() === "true" ? 1 : 0,
        /* Feeds ledger.regs, which enrich-adb.mjs turns into aircraft-meta.json. */
        reg: f?.aircraft?.reg ?? "",
        /* Feeds data/airlines.json, so the dashboard never needs a hand-kept list. */
        airline_name: f?.airline?.name ?? ""
      });
    }
    LOG(`${icao} ${day} ${START}+12h: ${deps.length} departures, ${rows.length} inside your collection (units ${spent}/${UNIT_CAP})`);
    return rows;
  } catch (e) {
    LOG(`${icao} ${day} error:`, e.message);
    return [];
  }
}

/* --------------------------------------------------------------- main loop - */

LOG(`round ${weekIndex}: window ${START}+12h, day shift ${DAY_SHIFT}, ${DAYS} day(s), ${AIRPORTS.length} airports`);
LOG(`cap ${UNIT_CAP} units, ${UNITS_PER_CALL} per call, pause ${SLEEP_MS} ms, so at most ${Math.floor(UNIT_CAP / UNITS_PER_CALL)} calls this run`);

let written = 0, skipped = 0, totalRows = 0, totalRegs = 0;
const namesSeen = new Map();

outer:
for (let d = 1; d <= DAYS; d++) {
  const day = iso(new Date(Date.now() - (d + DAY_SHIFT) * 864e5));
  for (const icao of AIRPORTS) {
    if (stopped) break outer;
    const path = `data/manual/${icao}_${day}.csv`;
    if (existsSync(path) && !OVERWRITE) { skipped++; continue; }
    const rows = await fetchAirportDay(icao, day);
    if (rows === null) break outer;
    if (rows.length) {
      writeCsv(icao, day, rows);
      written++; totalRows += rows.length;
      totalRegs += rows.filter(r => r.reg).length;
      for (const r of rows) if (r.airline && r.airline_name) namesSeen.set(r.airline, r.airline_name);
    }
    await sleep(SLEEP_MS);
  }
}

LOG(`done: ${written} CSVs with ${totalRows} rows (${totalRegs} carrying a registration), `
  + `${skipped} skipped because they already existed, ${spent} units used`);
LOG(`airline names seen this run: ${namesSeen.size}`
  + (namesSeen.size ? ` (for example ${[...namesSeen].slice(0, 4).map(([c, n]) => c + "=" + n).join(", ")})` : ""));
if (stopped) LOG("note: the run stopped early to protect your quota");
if (!written && !skipped) LOG("zero CSVs: check the diagnosis line above to see what the destination is called in the answer");
if (written && !totalRegs) LOG("note: rows were written but no registrations came back, so aircraft-meta.json cannot fill up yet");
if (written && !namesSeen.size) LOG("note: rows were written but no airline names came back, so the dashboard falls back to its built-in list");
