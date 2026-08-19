#!/usr/bin/env node
/**
 * check-config.mjs - validates config/collection.json BEFORE anything else runs.
 *
 * Why this exists
 * ---------------
 * routewatch.mjs computes great-circle distance straight from the config:
 *
 *   const gcNm=(a,b)=>{ ... Math.acos(... Math.sin(p1)*Math.sin(p2) ...) }
 *
 * If lat or lon is null, undefined or a string, that expression yields NaN.
 * simmable() then tests `nm > spec.range_nm`, and any comparison against NaN is
 * false, so the leg is silently reported as NOT simmable instead of raising an
 * error. One bad airport therefore corrupts distances, MATCH classification and
 * every candidate gain figure - quietly.
 *
 * scripts/scan-sim.mjs --write deliberately produces airports with
 * `lat: null, lon: null, needs_coordinates: true`, because MSFS package data does
 * not contain coordinates. That proposal is safe on its own; merging it into
 * config/collection.json without filling the coordinates is what breaks things.
 * This validator is the guard between those two states.
 *
 * It is read-only: it never edits config, never calls an API, never spends units.
 * It exits 1 on an error so the workflow stops BEFORE the collector spends its
 * 82 units on a config that cannot produce correct output.
 *
 *   node scripts/check-config.mjs            fail on errors, warn on the rest
 *   node scripts/check-config.mjs --strict    also fail on warnings
 */
import { readFileSync } from "node:fs";

const STRICT = process.argv.includes("--strict");
const FILE = "config/collection.json";
const errors = [], warnings = [], notes = [];
const E = m => errors.push(m);
const W = m => warnings.push(m);

let CFG;
try {
  CFG = JSON.parse(readFileSync(FILE, "utf8"));
} catch (e) {
  console.error(`[check-config] cannot read or parse ${FILE}: ${e.message}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ airports */

const airports = Array.isArray(CFG.airports) ? CFG.airports : null;
if (!airports) {
  E("airports is missing or not an array");
} else if (!airports.length) {
  E("airports is empty, so there is nothing to collect");
}

const numeric = v => typeof v === "number" && Number.isFinite(v);
const seen = new Map();
let own = 0, cand = 0;

for (const [i, a] of (airports ?? []).entries()) {
  const where = `airports[${i}]`;
  const icao = String(a?.icao ?? "").toUpperCase();
  const label = icao || where;

  if (!/^[A-Z]{4}$/.test(icao)) {
    E(`${where}: icao "${a?.icao ?? ""}" is not four letters A-Z`);
  } else if (seen.has(icao)) {
    E(`${label}: duplicate icao, also at airports[${seen.get(icao)}]`);
  } else {
    seen.set(icao, i);
  }

  /* This is the check that prevents the silent NaN. */
  if (a?.needs_coordinates === true) {
    E(`${label}: needs_coordinates is true - fill lat and lon before using this airport. `
      + `Left as is, every distance involving ${label} becomes NaN and every leg reports as not simmable.`);
  }
  if (!numeric(a?.lat) || !numeric(a?.lon)) {
    E(`${label}: lat/lon must be finite numbers, got lat=${JSON.stringify(a?.lat)} lon=${JSON.stringify(a?.lon)}`);
  } else {
    if (a.lat < -90 || a.lat > 90) E(`${label}: lat ${a.lat} is outside -90..90`);
    if (a.lon < -180 || a.lon > 180) E(`${label}: lon ${a.lon} is outside -180..180`);
    if (a.lat === 0 && a.lon === 0) W(`${label}: lat and lon are both 0, which is almost certainly a placeholder`);
  }

  if (!String(a?.name ?? "").trim()) W(`${label}: no name, the dashboard will show the code only`);
  if (a?.narrowbody_allowed !== undefined && typeof a.narrowbody_allowed !== "boolean")
    E(`${label}: narrowbody_allowed must be true or false, got ${JSON.stringify(a.narrowbody_allowed)}`);
  if (a?.candidate !== undefined && typeof a.candidate !== "boolean")
    E(`${label}: candidate must be true or false, got ${JSON.stringify(a.candidate)}`);
  if (a?.iata !== undefined && a.iata !== null && !/^[A-Z]{3}$/.test(String(a.iata).toUpperCase()))
    W(`${label}: iata "${a.iata}" is not three letters, so IATA to ICAO resolution will not use it`);

  if (a?._confidence === "low")
    W(`${label}: came from a low-confidence simulator scan (${a?._found_in ?? "unknown package"}), verify it manually`);

  if (a?.candidate === true) cand++; else own++;
}

/* --------------------------------------------------------------------- fleet */

const owned = CFG.fleet?.owned;
if (!Array.isArray(owned) || !owned.length) {
  E("fleet.owned is missing or empty, so matchStatus() can never return MATCH");
} else {
  const keys = new Set();
  for (const [i, fl] of owned.entries()) {
    const where = `fleet.owned[${i}]`;
    const key = String(fl?.key ?? "").trim();
    if (!key) E(`${where}: key is required, near_match substitutes refer to it`);
    else if (keys.has(key)) E(`${where}: duplicate key "${key}"`);
    else keys.add(key);

    if (!Array.isArray(fl?.types) || !fl.types.length)
      E(`${where} (${key || "?"}): types must be a non-empty array of ICAO type codes`);
    if (fl?.role !== "pax" && fl?.role !== "cargo")
      E(`${where} (${key || "?"}): role must be "pax" or "cargo", got ${JSON.stringify(fl?.role)}`);
    if (!numeric(fl?.range_nm) || fl.range_nm <= 0)
      E(`${where} (${key || "?"}): range_nm must be a positive number, got ${JSON.stringify(fl?.range_nm)}`);
  }

  const near = CFG.fleet?.near_match ?? {};
  for (const [type, sub] of Object.entries(near)) {
    const target = sub?.substitute;
    if (!target) E(`fleet.near_match.${type}: substitute is missing`);
    else if (!keys.has(target))
      E(`fleet.near_match.${type}: substitute "${target}" is not a key in fleet.owned`);
  }

  const suggested = CFG.fleet?._scan_suggested_types;
  if (Array.isArray(suggested) && suggested.length)
    W(`fleet._scan_suggested_types still holds ${suggested.length} unmerged scan suggestion(s); `
      + `they are ignored by routewatch.mjs until added to fleet.owned`);
}

/* ------------------------------------------------------------------ settings */

const S = CFG.settings;
if (!S) {
  E("settings is missing");
} else {
  const mbs = S.missed_before_suspend;
  if (mbs !== undefined && (!numeric(mbs) || mbs < 1))
    E(`settings.missed_before_suspend must be a number of at least 1, got ${JSON.stringify(mbs)}`);
  else if (numeric(mbs) && mbs < 6)
    W(`settings.missed_before_suspend is ${mbs}; with the collector's rotating windows 6 or higher `
      + `avoids suspending routes that simply were not in this week's window`);

  const d = S.type_share_delta;
  if (d !== undefined && (!numeric(d) || d <= 0 || d >= 1))
    E(`settings.type_share_delta must be between 0 and 1, got ${JSON.stringify(d)}`);

  if (S.price_scrape) W("settings.price_scrape is on; FSAddonCompare does price comparison better and this adds page fetches");

  const p = S.providers ?? {};
  if (!p.opensky && !p.aerodatabox && !p.manual)
    W("all providers are disabled, so routewatch.mjs will only re-read what is already on disk");
  if (p.aerodatabox) notes.push("aerodatabox provider is ON inside routewatch.mjs, which spends units on top of the collector");
}

/* --------------------------------------------------------- projected budget */

const perCall = Number(process.env.ADB_UNITS_PER_CALL || 2);
const collect = seen.size * perCall;
const enrich = Number(process.env.ENRICH_UNIT_CAP || 60);
const monthly = (collect + enrich) * 4;
notes.push(`${seen.size} airports (${own} own, ${cand} candidate) at ${perCall} units per call = ${collect} units per collection round`);
notes.push(`with an enrichment cap of ${enrich}, one weekly run costs about ${collect + enrich} units, roughly ${monthly} per month against a 600-unit plan`);
if (monthly > 600)
  W(`projected monthly cost ${monthly} exceeds the 600-unit plan; remove airports, lower ENRICH_UNIT_CAP, or run less often`);

/* ---------------------------------------------------------------- reporting */

for (const n of notes)    console.log(`[check-config] ${n}`);
for (const w of warnings) console.log(`[check-config] WARNING: ${w}`);
for (const e of errors)   console.error(`[check-config] ERROR: ${e}`);

console.log(`[check-config] ${errors.length} error(s), ${warnings.length} warning(s)`);

if (errors.length) {
  console.error("[check-config] stopping before any API units are spent");
  process.exit(1);
}
if (STRICT && warnings.length) {
  console.error("[check-config] --strict: treating warnings as failures");
  process.exit(1);
}
console.log("[check-config] config is usable");
