#!/usr/bin/env node
/**
 * publish-find.mjs — build docs/find.json for the RouteWatch flight finder.
 *
 * Zero dependencies, Node 20+. Run from the repo root:
 *
 *   node scripts/publish-find.mjs            # write docs/find.json
 *   node scripts/publish-find.mjs --dry-run  # report only, write nothing
 *   node scripts/publish-find.mjs --verbose  # show what was skipped and why
 *
 * DESIGN CONTRACT — Article 5.5 (see issue #1)
 * --------------------------------------------
 * This artifact is served publicly by GitHub Pages, so it deliberately carries
 * DERIVED FACTS ONLY, in the spirit of commit b40b424:
 *
 *   - great-circle distance between two published airport coordinates
 *   - an ESTIMATED block time computed from that distance and a published
 *     cruise speed (never an observed departure or arrival time)
 *   - a coarse frequency band (seen / weekly / daily / several_daily),
 *     never a per-day count, never a schedule
 *   - operator names only
 *
 * It never emits flight numbers, departure times, arrival times or per-season
 * records. If you extend this script, keep it that way until the retention
 * question in issue #1 is resolved.
 *
 * FUTURE: OBSERVED MODE (post-Aero negotiation)
 * ---------------------------------------------
 * Every record carries `detail: "estimated"`, and the file carries
 * `detail_level: "estimated"`. Once permission is negotiated, an observed
 * layer can fill in real block times, real time-of-day bands and real
 * frequencies. The intended path is:
 *
 *   1. Set OBSERVED.enabled = true below and implement readObserved().
 *   2. Observed values overwrite block_min / freq_band / operators and flip
 *      the record to detail: "observed".
 *   3. find.html already reads `detail` per record and labels rows as
 *      "geschat" or "waargenomen" — no UI change needed.
 *
 * Until then the estimator is the single source of truth and the UI is honest
 * about it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ARGV = new Set(process.argv.slice(2));
const DRY_RUN = ARGV.has('--dry-run');
const VERBOSE = ARGV.has('--verbose');

const PATHS = {
  collection: path.join(ROOT, 'config', 'collection.json'),
  aircraft: path.join(ROOT, 'data', 'aircraft-meta.json'),
  airports: path.join(ROOT, 'data', 'airports-meta.json'),
  airlines: path.join(ROOT, 'data', 'airlines.json'),
  ledger: path.join(ROOT, 'data', 'ledger.json'),
  out: path.join(ROOT, 'docs', 'find.json'),
};

/* ------------------------------------------------------------------ *
 * Estimator constants — all of these are assumptions, not measurements.
 * Tune them here so the whole file stays consistent.
 * ------------------------------------------------------------------ */
const EST = {
  taxiOutMin: 12,
  taxiInMin: 8,
  // Climb + descent cost extra minutes versus flying the whole leg at cruise.
  climbDescentMin: 14,
  // Great-circle is optimistic; real tracks wander. Scale the distance a bit.
  trackFactor: 1.06,
  // Refuse a pairing if the leg eats more than this share of published range.
  maxRangeUtilisation: 0.85,
  // Fallback cruise speed when aircraft-meta.json does not publish one.
  fallbackCruiseKts: 450,
};

const BUCKETS = [
  { id: 'lt1', label: 'Onder 1 uur', hint: 'quick hop', min: 0, max: 60 },
  { id: '1-2', label: '1–2 uur', hint: 'korte lijndienst', min: 60, max: 120 },
  { id: '2-4', label: '2–4 uur', hint: 'Europees / Med', min: 120, max: 240 },
  { id: '4-6', label: '4–6 uur', hint: 'lange narrowbody', min: 240, max: 360 },
  { id: '6-9', label: '6–9 uur', hint: 'instap-longhaul', min: 360, max: 540 },
  { id: '9-12', label: '9–12 uur', hint: 'longhaul', min: 540, max: 720 },
  { id: 'gt12', label: '12 uur en meer', hint: 'ultralong', min: 720, max: Infinity },
];

const OBSERVED = {
  enabled: false,
  // Placeholder for the post-negotiation layer. Must return a Map keyed by
  // `${from}-${to}-${ac}` with { block_min, freq_band, operators, time_bands }.
  async read() {
    return new Map();
  },
};

const notes = [];
function note(msg) {
  notes.push(msg);
  if (VERBOSE) console.log(`[find] ${msg}`);
}

async function readJson(file, { required = false } = {}) {
  if (!existsSync(file)) {
    if (required) throw new Error(`missing required file: ${path.relative(ROOT, file)}`);
    note(`optional file absent: ${path.relative(ROOT, file)}`);
    return null;
  }
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (required) throw new Error(`cannot parse ${path.relative(ROOT, file)}: ${err.message}`);
    note(`cannot parse ${path.relative(ROOT, file)}: ${err.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Schema-tolerant readers.
 * The repo's exact JSON shapes are not assumed here: each reader accepts an
 * array, a keyed object, or a wrapper object with a plausible list property,
 * and probes a handful of common field names. Anything it cannot understand
 * is skipped with a note rather than crashing the run.
 * ------------------------------------------------------------------ */

function asList(value, listKeys = ['airports', 'items', 'entries', 'list', 'data', 'aircraft', 'types', 'airlines']) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return [];
  for (const key of listKeys) {
    if (Array.isArray(value[key])) return value[key];
    if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) {
      return Object.entries(value[key]).map(([k, v]) => ({ __key: k, ...(typeof v === 'object' ? v : { value: v }) }));
    }
  }
  return Object.entries(value)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([k, v]) => ({ __key: k, ...v }));
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj == null) continue;
    const v = obj[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function num(value) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  return Number.isFinite(n) ? n : undefined;
}

function readAirports(collection, meta) {
  const out = new Map();
  const add = (raw, source) => {
    const icao = String(pick(raw, ['icao', 'ICAO', 'code', 'ident', 'id', '__key']) || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{3,4}$/.test(icao)) return;
    const lat = num(pick(raw, ['lat', 'latitude', 'lat_deg']));
    const lon = num(pick(raw, ['lon', 'lng', 'long', 'longitude', 'lon_deg']));
    const prev = out.get(icao) || {};
    const candidate = pick(raw, ['candidate']) === true;
    const entry = {
      icao,
      name: pick(raw, ['name', 'airport', 'title']) ?? prev.name,
      city: pick(raw, ['city', 'municipality']) ?? prev.city,
      country: pick(raw, ['country', 'iso_country', 'cc']) ?? prev.country,
      lat: lat ?? prev.lat,
      lon: lon ?? prev.lon,
      narrowbody_allowed: pick(raw, ['narrowbody_allowed']) ?? prev.narrowbody_allowed,
      owned: source === 'collection' ? !candidate : prev.owned,
      candidate: source === 'collection' ? candidate : prev.candidate,
      inCollection: source === 'collection' ? true : Boolean(prev.inCollection),
    };
    out.set(icao, entry);
  };

  // Coordinates must clear the same guard routewatch.mjs applies: finite,
  // in range, and not the 0,0 placeholder.
  asList(meta).forEach((raw) => add(raw, 'meta'));
  asList(collection).forEach((raw) => add(raw, 'collection'));

  const usable = new Map();
  for (const [icao, ap] of out) {
    if (!ap.inCollection) continue;
    if (!Number.isFinite(ap.lat) || !Number.isFinite(ap.lon)) {
      note(`skip ${icao}: no finite coordinates`);
      continue;
    }
    if (Math.abs(ap.lat) > 90 || Math.abs(ap.lon) > 180) {
      note(`skip ${icao}: coordinates out of range`);
      continue;
    }
    if (ap.lat === 0 && ap.lon === 0) {
      note(`skip ${icao}: 0,0 placeholder coordinates`);
      continue;
    }
    if (ap.narrowbody_allowed === undefined) ap.narrowbody_allowed = true;
    usable.set(icao, ap);
  }
  return usable;
}

const NARROWBODY_HINT = /^(A19|A20|A21|A22|B73|B71|E1|E2|CRJ|AT[47]|DH8|C919|MD8|SU9|BCS|A32|A31)/i;

function readAircraft(meta) {
  const out = new Map();
  for (const raw of asList(meta, ['aircraft', 'types', 'items', 'data'])) {
    const code = String(pick(raw, ['icao', 'type', 'code', 'typecode', 'id', '__key']) || '').toUpperCase().trim();
    if (!code || code.length > 6) continue;
    const cruise = num(pick(raw, ['cruise_kts', 'cruise_speed_kts', 'cruise', 'cruise_speed', 'speed_kts', 'tas_kts']));
    const range = num(pick(raw, ['range_nm', 'range', 'max_range_nm']));
    let narrow = pick(raw, ['narrowbody', 'is_narrowbody', 'single_aisle']);
    if (narrow === undefined) {
      const body = String(pick(raw, ['body', 'category', 'class']) || '');
      if (/narrow|single/i.test(body)) narrow = true;
      else if (/wide|twin.?aisle/i.test(body)) narrow = false;
      else narrow = NARROWBODY_HINT.test(code);
    }
    out.set(code, {
      code,
      name: pick(raw, ['name', 'model', 'title', 'label']) || code,
      cruise_kts: cruise ?? EST.fallbackCruiseKts,
      cruise_assumed: cruise === undefined,
      range_nm: range,
      narrowbody: Boolean(narrow),
    });
  }
  return out;
}

function readAirlineNames(airlines) {
  const out = new Map();
  for (const raw of asList(airlines, ['airlines', 'items', 'data'])) {
    const code = String(pick(raw, ['icao', 'iata', 'code', 'id', '__key']) || '').toUpperCase().trim();
    const name = pick(raw, ['name', 'callsign', 'airline', 'title']);
    if (code && name) out.set(code, String(name));
  }
  return out;
}

/**
 * Best-effort operator + frequency extraction from the historic ledger.
 * The ledger's exact shape is not assumed: this walks it looking for objects
 * that expose an origin, a destination and an operator-ish field, and counts
 * distinct observation DAYS per route. Only the day count is used, and only
 * to derive a coarse band — no timestamps survive into the output.
 */
function readRouteObservations(ledger) {
  const routes = new Map();
  if (!ledger) return routes;

  const ORIG = ['from', 'origin', 'dep', 'departure', 'orig', 'from_icao', 'dep_icao', 'origin_icao'];
  const DEST = ['to', 'destination', 'arr', 'arrival', 'dest', 'to_icao', 'arr_icao', 'destination_icao'];
  const OPER = ['operator', 'airline', 'carrier', 'operator_icao', 'airline_icao', 'op'];
  const TYPE = ['type', 'aircraft', 'actype', 'aircraft_type', 'typecode', 'icao_type'];
  const WHEN = ['date', 'day', 'seen_date', 'observed', 'first_seen', 'ts', 'time', 'timestamp'];

  const icao = (v) => {
    const s = String(v ?? '').toUpperCase().trim();
    return /^[A-Z0-9]{4}$/.test(s) ? s : null;
  };
  const dayOf = (v) => {
    if (v == null) return 'unknown';
    const s = String(v);
    const m = s.match(/\d{4}-\d{2}-\d{2}/);
    if (m) return m[0];
    const n = Number(s);
    if (Number.isFinite(n) && n > 1e9) return new Date(n < 1e12 ? n * 1000 : n).toISOString().slice(0, 10);
    return 'unknown';
  };

  let visited = 0;
  const walk = (node) => {
    if (visited > 400000 || node == null || typeof node !== 'object') return;
    visited += 1;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const from = icao(pick(node, ORIG));
    const to = icao(pick(node, DEST));
    if (from && to && from !== to) {
      const key = `${from}-${to}`;
      const entry = routes.get(key) || { operators: new Set(), types: new Set(), days: new Set() };
      const op = pick(node, OPER);
      if (op && typeof op !== 'object') entry.operators.add(String(op).toUpperCase().trim());
      const ty = pick(node, TYPE);
      if (ty && typeof ty !== 'object') entry.types.add(String(ty).toUpperCase().trim());
      entry.days.add(dayOf(pick(node, WHEN)));
      routes.set(key, entry);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value);
    }
  };

  walk(ledger);
  if (!routes.size) note('ledger walk found no recognisable origin/destination pairs — operators and frequency bands will be empty');
  return routes;
}

/* ------------------------------------------------------------------ *
 * Geometry and estimation.
 * ------------------------------------------------------------------ */

function greatCircleNm(a, b) {
  const R = 3440.065; // Earth radius in nautical miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function estimateBlockMinutes(distanceNm, cruiseKts) {
  const trackNm = distanceNm * EST.trackFactor;
  const airborne = (trackNm / cruiseKts) * 60 + EST.climbDescentMin;
  return Math.round(airborne + EST.taxiOutMin + EST.taxiInMin);
}

function bucketFor(minutes) {
  return BUCKETS.find((b) => minutes >= b.min && minutes < b.max)?.id ?? 'gt12';
}

function freqBand(dayCount) {
  if (!dayCount) return null;
  if (dayCount >= 200) return 'several_daily';
  if (dayCount >= 60) return 'daily';
  if (dayCount >= 10) return 'weekly';
  return 'seen';
}

/* ------------------------------------------------------------------ *
 * Build.
 * ------------------------------------------------------------------ */

async function main() {
  const [collection, aircraftMeta, airportMeta, airlines, ledger] = await Promise.all([
    readJson(PATHS.collection, { required: true }),
    readJson(PATHS.aircraft, { required: true }),
    readJson(PATHS.airports),
    readJson(PATHS.airlines),
    readJson(PATHS.ledger),
  ]);

  const airports = readAirports(collection, airportMeta);
  const aircraft = readAircraft(aircraftMeta);
  const airlineNames = readAirlineNames(airlines);
  const observations = readRouteObservations(ledger);
  const observed = OBSERVED.enabled ? await OBSERVED.read() : new Map();

  if (!airports.size) throw new Error('no usable airports resolved from config/collection.json');
  if (!aircraft.size) throw new Error('no usable aircraft resolved from data/aircraft-meta.json');

  const codes = [...airports.keys()].sort();
  const routes = [];
  const skipped = { range: 0, narrowbody: 0 };

  for (const from of codes) {
    for (const to of codes) {
      if (from === to) continue;
      const a = airports.get(from);
      const b = airports.get(to);
      const distance = greatCircleNm(a, b);
      if (!Number.isFinite(distance) || distance < 1) continue;

      for (const ac of aircraft.values()) {
        if (ac.narrowbody && (a.narrowbody_allowed === false || b.narrowbody_allowed === false)) {
          skipped.narrowbody += 1;
          continue;
        }
        if (ac.range_nm && distance * EST.trackFactor > ac.range_nm * EST.maxRangeUtilisation) {
          skipped.range += 1;
          continue;
        }

        const blockMin = estimateBlockMinutes(distance, ac.cruise_kts);
        const obsKey = `${from}-${to}`;
        const obs = observations.get(obsKey);
        const operatorCodes = obs ? [...obs.operators].filter(Boolean).slice(0, 8) : [];
        const record = {
          from,
          to,
          ac: ac.code,
          dist_nm: Math.round(distance),
          block_min: blockMin,
          bucket: bucketFor(blockMin),
          own_from: Boolean(a.owned),
          own_to: Boolean(b.owned),
          operators: operatorCodes.map((code) => airlineNames.get(code) || code),
          freq_band: freqBand(obs ? obs.days.size : 0),
          detail: 'estimated',
        };

        const override = observed.get(`${from}-${to}-${ac.code}`);
        if (override) {
          if (Number.isFinite(override.block_min)) {
            record.block_min = override.block_min;
            record.bucket = bucketFor(override.block_min);
          }
          if (override.freq_band) record.freq_band = override.freq_band;
          if (Array.isArray(override.operators) && override.operators.length) record.operators = override.operators;
          if (Array.isArray(override.time_bands)) record.time_bands = override.time_bands;
          record.detail = 'observed';
        }

        routes.push(record);
      }
    }
  }

  const payload = {
    // Date only, deliberately: no run timestamps in a public artifact.
    generated_on: new Date().toISOString().slice(0, 10),
    detail_level: OBSERVED.enabled ? 'mixed' : 'estimated',
    estimator: {
      taxi_min: EST.taxiOutMin + EST.taxiInMin,
      climb_descent_min: EST.climbDescentMin,
      track_factor: EST.trackFactor,
      note: 'Block times are estimates from great-circle distance and published cruise speed, not observed times.',
    },
    buckets: BUCKETS.map(({ id, label, hint, min, max }) => ({
      id,
      label,
      hint,
      min_min: min,
      max_min: Number.isFinite(max) ? max : null,
    })),
    airports: Object.fromEntries(
      [...airports.values()].map((ap) => [
        ap.icao,
        {
          name: ap.name || ap.icao,
          city: ap.city || null,
          country: ap.country || null,
          owned: Boolean(ap.owned),
          narrowbody_allowed: ap.narrowbody_allowed !== false,
        },
      ]),
    ),
    aircraft: Object.fromEntries(
      [...aircraft.values()].map((ac) => [
        ac.code,
        {
          name: ac.name,
          narrowbody: ac.narrowbody,
          cruise_kts: ac.cruise_kts,
          cruise_assumed: ac.cruise_assumed,
          range_nm: ac.range_nm ?? null,
        },
      ]),
    ),
    routes,
  };

  const json = JSON.stringify(payload);
  const sizeKb = Math.round(Buffer.byteLength(json) / 1024);

  console.log(`[find] ${airports.size} airports, ${aircraft.size} aircraft types`);
  console.log(`[find] ${routes.length} pairings kept (${skipped.range} out of range, ${skipped.narrowbody} narrowbody-blocked)`);
  console.log(`[find] operators resolved for ${routes.filter((r) => r.operators.length).length} pairings`);
  console.log(`[find] payload ${sizeKb} kB, detail_level=${payload.detail_level}`);
  if (notes.length && !VERBOSE) console.log(`[find] ${notes.length} notes, rerun with --verbose to see them`);

  if (DRY_RUN) {
    console.log('[find] dry run: docs/find.json not written');
    return;
  }
  await writeFile(PATHS.out, `${json}\n`, 'utf8');
  console.log(`[find] wrote ${path.relative(ROOT, PATHS.out)}`);
}

main().catch((err) => {
  console.error(`[find] failed: ${err.message}`);
  process.exitCode = 1;
});
