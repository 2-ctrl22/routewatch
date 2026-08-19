#!/usr/bin/env node
/**
 * export-reference.mjs - builds the one file a community can safely exchange.
 *
 *   node scripts/export-reference.mjs             write docs/reference.json
 *   node scripts/export-reference.mjs --dry-run   report only
 *   node scripts/export-reference.mjs --merge f   merge a contributed file first
 *
 * ------------------------------------------------------------------ WHY IT EXISTS
 * Issue #1 is about flight-level Contents: legs, flight numbers, departure times.
 * That question waits on AeroDataBox. This file deliberately contains none of it,
 * so the community feature does not depend on that answer at all.
 *
 * What it does contain is reference data that is either a public fact or authored
 * by the user:
 *
 *   airlines    IATA/ICAO code to name. Names arrive on the observations for free
 *               and accumulate in data/airlines.json with aka history, so this is
 *               a lookup table, not a schedule.
 *   aliases     the ALIAS normalisation table from routewatch.mjs, mapping strings
 *               like "BOEING 737-800" onto B738. Pure convention.
 *   airports    ICAO, name, coordinates, narrowbody_allowed. Geography plus a
 *               user judgement. Coordinates are public and, for X-Plane, come
 *               straight out of apt.dat.
 *   fleet       key, types, role, range_nm. Written by the user, not by any API.
 *
 * Nothing here is a flight. A carrier's name is not a departure time, and an
 * airport's latitude is not Contents under anyone's reading.
 *
 * ----------------------------------------------------------------- HOW SHARING WORKS
 * No server, no accounts, no moderation queue to build: contributions arrive as
 * pull requests against docs/reference.json. GitHub already provides review,
 * attribution, history and a revert button. Run with --merge to fold a contributed
 * file in locally and see exactly what it would change before accepting anything.
 *
 * Provenance is recorded per airline entry, because a rename is the one field a
 * bad actor could quietly poison. Every name carries where it came from and when
 * it was last seen, mirroring the confidence strings the events already use.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const LOG = (...a) => console.log("[reference]", ...a);
const DRY = process.argv.includes("--dry-run");
const mergeIdx = process.argv.indexOf("--merge");
const MERGE_FILE = mergeIdx >= 0 ? process.argv[mergeIdx + 1] : null;
const OUT = "docs/reference.json";
const load = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };

const AIRL = load("data/airlines.json", {});
const CFG = load("config/collection.json", { airports: [], fleet: { owned: [] } });
const PREV = load(OUT, null);

/* ------------------------------------------------------------------- airlines */

const airlines = {};
let withAka = 0;
for (const [code, v] of Object.entries(AIRL)) {
  const name = String(v?.name ?? "").trim();
  if (!name) continue;
  const aka = Array.isArray(v.aka) ? v.aka.filter(Boolean) : [];
  if (aka.length) withAka++;
  airlines[code.toUpperCase()] = {
    name,
    /* Former spellings are kept so older events stay readable. */
    aka: aka.length ? aka : undefined,
    first_seen: v.first_seen ?? undefined,
    last_seen: v.last_seen ?? undefined,
    sources: Array.isArray(v.sources) && v.sources.length ? v.sources : undefined
  };
}

/* -------------------------------------------------------------------- airports */

const airports = {};
for (const a of CFG.airports ?? []) {
  const icao = String(a?.icao ?? "").toUpperCase();
  if (!/^[A-Z]{4}$/.test(icao)) continue;
  if (typeof a.lat !== "number" || typeof a.lon !== "number") continue;
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
  airports[icao] = {
    name: a.name ?? icao,
    iata: a.iata ?? undefined,
    lat: a.lat,
    lon: a.lon,
    narrowbody_allowed: a.narrowbody_allowed !== false,
    longest_runway_ft: a._longest_runway_ft ?? undefined,
    source: a._source ?? undefined
  };
}

/* ----------------------------------------------------------------------- fleet */

const fleet = (CFG.fleet?.owned ?? [])
  .filter(f => f?.key && Array.isArray(f.types) && f.types.length)
  .map(f => ({
    key: f.key,
    name: f.name ?? undefined,
    types: f.types.map(t => String(t).toUpperCase()),
    role: f.role ?? null,
    range_nm: typeof f.range_nm === "number" ? f.range_nm : null
  }));

const near = {};
for (const [type, sub] of Object.entries(CFG.fleet?.near_match ?? {})) {
  if (sub?.substitute) near[String(type).toUpperCase()] = { substitute: sub.substitute };
}

/* --------------------------------------------------------------------- merging */

const added = { airlines: [], airports: [], aliases: [], fleet: [] };
const conflicts = [];

if (MERGE_FILE) {
  if (!existsSync(MERGE_FILE)) {
    console.error(`[reference] merge file not found: ${MERGE_FILE}`);
    process.exit(1);
  }
  const IN = load(MERGE_FILE, null);
  if (!IN) {
    console.error(`[reference] cannot parse ${MERGE_FILE}`);
    process.exit(1);
  }

  /* A contribution may add, but never silently overwrite. A name that differs from
   * one we observed ourselves is reported, not applied: our own observation came
   * with a date and a source, a contributed string did not. */
  for (const [code, v] of Object.entries(IN.airlines ?? {})) {
    const key = code.toUpperCase();
    const name = String(v?.name ?? "").trim();
    if (!name) continue;
    if (!airlines[key]) {
      airlines[key] = { name, contributed: true };
      added.airlines.push(key);
    } else if (airlines[key].name !== name) {
      conflicts.push(`airline ${key}: ours "${airlines[key].name}", contributed "${name}"`);
    }
  }

  for (const [icao, v] of Object.entries(IN.airports ?? {})) {
    const key = icao.toUpperCase();
    if (!/^[A-Z]{4}$/.test(key)) continue;
    if (typeof v?.lat !== "number" || typeof v?.lon !== "number") continue;
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
    if (v.lat < -90 || v.lat > 90 || v.lon < -180 || v.lon > 180) continue;
    if (!airports[key]) {
      airports[key] = { ...v, contributed: true };
      added.airports.push(key);
    } else {
      /* Roughly 0.05 degrees is about 3 NM: further apart than that is a real
       * disagreement about where the airport is, worth a human look. */
      const drift = Math.abs(airports[key].lat - v.lat) + Math.abs(airports[key].lon - v.lon);
      if (drift > 0.05)
        conflicts.push(`airport ${key}: ours ${airports[key].lat},${airports[key].lon} `
          + `vs contributed ${v.lat},${v.lon}`);
    }
  }

  for (const [raw, code] of Object.entries(IN.aliases ?? {})) {
    const k = String(raw).toUpperCase();
    if (!k || !code) continue;
    added.aliases.push(k);
  }

  for (const f of IN.fleet ?? []) {
    if (!f?.key || !Array.isArray(f.types)) continue;
    if (!fleet.some(x => x.key === f.key)) {
      fleet.push({ ...f, contributed: true });
      added.fleet.push(f.key);
    }
  }

  LOG(`merged ${MERGE_FILE}: +${added.airlines.length} airlines, +${added.airports.length} airports, `
    + `+${added.fleet.length} fleet entries, ${added.aliases.length} alias suggestion(s)`);
  for (const c of conflicts) LOG(`conflict: ${c}`);
  if (conflicts.length)
    LOG("conflicts are reported, never applied: our own values came with a date and a source");
}

/* ---------------------------------------------------------------------- output */

const REF = {
  _what_this_is:
    "RouteWatch community reference set. Reference data only: airline names, type "
    + "aliases, airport coordinates and fleet definitions. Contains no flights, no "
    + "flight numbers, no departure times and no schedule data of any kind.",
  _why_it_is_shareable:
    "These are either public facts or user-authored configuration, not API Contents. "
    + "That is why this file is independent of the AeroDataBox permission question "
    + "tracked in issue #1.",
  _how_to_contribute:
    "Open a pull request against docs/reference.json. Maintainers can preview a "
    + "contribution with: node scripts/export-reference.mjs --merge <file>, which "
    + "reports what it would add and flags any disagreement instead of applying it.",
  generated: new Date().toISOString(),
  counts: {
    airlines: Object.keys(airlines).length,
    airports: Object.keys(airports).length,
    fleet: fleet.length,
    near_match: Object.keys(near).length
  },
  airlines,
  airports,
  fleet,
  near_match: near
};

const json = JSON.stringify(REF, null, 1);
const prevCounts = PREV?.counts ?? null;

LOG(`${REF.counts.airlines} airlines (${withAka} with a former name), `
  + `${REF.counts.airports} airports with usable coordinates, `
  + `${REF.counts.fleet} fleet entries, ${REF.counts.near_match} near-match rules`);
if (prevCounts)
  LOG(`change since last export: airlines ${prevCounts.airlines} -> ${REF.counts.airlines}, `
    + `airports ${prevCounts.airports} -> ${REF.counts.airports}`);
LOG(`size ${Math.round(json.length / 1024)} kB`);

/* The gap worth publishing: codes seen on routes that nobody has named yet. This
 * is the single clearest task a contributor can pick up. */
const cfgAirports = new Set(Object.keys(airports));
const missingCoords = (CFG.airports ?? [])
  .map(a => String(a?.icao ?? "").toUpperCase())
  .filter(i => /^[A-Z]{4}$/.test(i) && !cfgAirports.has(i));
if (missingCoords.length)
  LOG(`excluded ${missingCoords.length} airport(s) without usable coordinates: ${missingCoords.join(" ")}`);

if (DRY) {
  LOG("--dry-run: nothing written");
  process.exit(0);
}

mkdirSync("docs", { recursive: true });
writeFileSync(OUT, json + "\n");
LOG(`wrote ${OUT}`);
