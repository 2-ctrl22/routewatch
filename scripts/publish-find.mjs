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
 * WHERE THE FACTS COME FROM
 * -------------------------
 *   config/collection.json   airports (46) AND fleet.owned, the only source of
 *                            range_nm, role and cruise speed. Body width comes
 *                            from the ICAO type codes, not from role, because
 *                            role is the mission: "pax" or "cargo".
 *   data/airports-meta.json  enrichment for names, cities, countries
 *   data/ledger.json         observed traffic, keyed "EHAM-LEMG|HV|HV6115"
 *   data/aircraft-meta.json  registration cache. No range and no body width, so
 *                            it must never drive filtering, but its
 *                            typeCode -> model mapping bridges the ledger's
 *                            display names onto ICAO codes.
 *
 * That aircraft-meta line used to be wrong and it cost the 2026-08-24 dry run its
 * entire range filter: readAircraft() read tails as types, range_nm came back
 * undefined, and `if (ac.range_nm && ...)` skipped the guard instead of failing
 * it. All 46 x 45 x 20 = 41400 pairings survived. The readers now live in
 * scripts/find-sources.mjs and refuse what they cannot verify.
 *
 * AUTOMATION
 * ----------
 * .github/workflows/find.yml rebuilds docs/find.json at 08:30 UTC, on manual
 * dispatch, and on any push to main that touches config/collection.json, the
 * airport or aircraft metadata, data/ledger.json, data/airlines.json, either of
 * the two find scripts, or the workflow itself. It reports a dry run first and
 * commits the result only when the file actually changed.
 *
 * DETAIL LEVEL — Article 5.5 (see issue #1)
 * -----------------------------------------
 * This artifact is served publicly by GitHub Pages. Aero granted written
 * permission for the observed scenario on 2026-08-24, so DETAIL_MODE defaults to
 * 'full': flight numbers, scheduled times, registrations and per-season records
 * are included. Run with FIND_DETAIL=derived to fall back to the earlier
 * derived-only artifact (distance, estimated block time, coarse frequency band,
 * operator names) if the retention question in issue #1 is reopened.
 *
 * OBSERVED LAYER
 * --------------
 * OBSERVED.read() returns a Map keyed `${from}-${to}-${ac}`. Observed values
 * overwrite the estimate and flip the record to detail: "observed". One honest
 * gap remains: the ledger stores std (scheduled departure) but no arrival time,
 * so there is no real block time in it. block_min therefore stays estimated even
 * on observed rows; feed real block times in from data/calibration.json once
 * scripts/calibrate-find.mjs has samples.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  EST,
  DETAIL_MODE,
  OBSERVED,
  readFleet,
  readAircraftRegs,
  pairingAllowed,
  estimateBlockMin,
} from './find-sources.mjs';

const ROOT = process.cwd();
const ARGV = new Set(process.argv.slice(2));
const DRY_RUN = ARGV.has('--dry-run');
const VERBOSE = ARGV.has('--verbose');

const PATHS = {
  collection: path.join(ROOT, 'config', 'collection.json'),
  aircraft: path.join(ROOT, 'data', 'aircraft-meta.json'),
  airports: path.join(ROOT, 'data', 'airports-meta.json'),
  out: path.join(ROOT, 'docs', 'find.json'),
};

const BUCKETS = [
  { id: 'lt1', label: 'Under 1 hour', hint: 'quick hop', min: 0, max: 60 },
  { id: '1-2', label: '1–2 hours', hint: 'short scheduled leg', min: 60, max: 120 },
  { id: '2-4', label: '2–4 hours', hint: 'Europe / Med', min: 120, max: 240 },
  { id: '4-6', label: '4–6 hours', hint: 'long narrowbody', min: 240, max: 360 },
  { id: '6-9', label: '6–9 hours', hint: 'entry-level long haul', min: 360, max: 540 },
  { id: '9-12', label: '9–12 hours', hint: 'long haul', min: 540, max: 720 },
  { id: 'gt12', label: '12 hours and more', hint: 'ultra long', min: 720, max: Infinity },
];

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
 * Airport reader. Schema-tolerant on purpose: accepts an array, a keyed
 * object, or a wrapper, and skips what it cannot understand with a note.
 * ------------------------------------------------------------------ */

function asList(value, listKeys = ['airports', 'items', 'entries', 'list', 'data']) {
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
    out.set(icao, {
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
    });
  };

  asList(meta).forEach((raw) => add(raw, 'meta'));
  asList(collection).forEach((raw) => add(raw, 'collection'));

  // Coordinates must clear the same guard routewatch.mjs applies: finite,
  // in range, and not the 0,0 placeholder.
  const usable = new Map();
  for (const [icao, ap] of out) {
    if (!ap.inCollection) continue;
    if (!Number.isFinite(ap.lat) || !Number.isFinite(ap.lon)) { note(`skip ${icao}: no finite coordinates`); continue; }
    if (Math.abs(ap.lat) > 90 || Math.abs(ap.lon) > 180) { note(`skip ${icao}: coordinates out of range`); continue; }
    if (ap.lat === 0 && ap.lon === 0) { note(`skip ${icao}: 0,0 placeholder coordinates`); continue; }
    if (ap.narrowbody_allowed === undefined) ap.narrowbody_allowed = true;
    usable.set(icao, ap);
  }
  return usable;
}

/* ------------------------------------------------------------------ *
 * Geometry.
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

function bucketFor(minutes) {
  return BUCKETS.find((b) => minutes >= b.min && minutes < b.max)?.id ?? 'gt12';
}

/* ------------------------------------------------------------------ *
 * Build.
 * ------------------------------------------------------------------ */

async function main() {
  const [collection, airportMeta] = await Promise.all([
    readJson(PATHS.collection, { required: true }),
    readJson(PATHS.airports),
  ]);

  const airports = readAirports(collection, airportMeta);

  // Range, role and cruise speed come from fleet.owned. Never from
  // aircraft-meta.json, which only knows registrations.
  const fleet = readFleet(PATHS.collection);
  for (const n of fleet.notes) note(`fleet: ${n}`);
  const aircraft = new Map(fleet.types.map((t) => [t.code, t]));

  const tails = readAircraftRegs(PATHS.aircraft);
  for (const n of tails.notes) note(`tails: ${n}`);

  const observed = OBSERVED.enabled ? await OBSERVED.read() : new Map();

  if (!airports.size) throw new Error('no usable airports resolved from config/collection.json');
  if (!aircraft.size) {
    throw new Error('no usable fleet types resolved from config/collection.json — every fleet.owned entry needs a positive range_nm (rerun with --verbose to see which were skipped)');
  }

  const codes = [...airports.keys()].sort();
  const routes = [];
  const skipped = { 'out-of-range': 0, 'narrowbody-blocked': 0, 'no-range-data': 0, 'no-distance': 0 };

  for (const from of codes) {
    for (const to of codes) {
      if (from === to) continue;
      const a = airports.get(from);
      const b = airports.get(to);
      const distance = greatCircleNm(a, b);
      if (!Number.isFinite(distance) || distance < 1) continue;

      for (const ac of aircraft.values()) {
        const verdict = pairingAllowed(a, b, ac, distance);
        if (!verdict.ok) {
          skipped[verdict.reason] = (skipped[verdict.reason] ?? 0) + 1;
          continue;
        }

        const blockMin = estimateBlockMin(distance, ac);
        const record = {
          from,
          to,
          ac: ac.code,
          dist_nm: Math.round(distance),
          routed_nm: verdict.routed_nm,
          block_min: blockMin,
          bucket: bucketFor(blockMin),
          own_from: Boolean(a.owned),
          own_to: Boolean(b.owned),
          operators: [],
          freq_band: null,
          detail: 'estimated',
        };

        const override = observed.get(`${from}-${to}-${ac.code}`);
        if (override) {
          // The ledger has no arrival time, so block_min normally stays estimated.
          // It is only overwritten when a real block time was supplied.
          if (Number.isFinite(override.block_min)) {
            record.block_min = override.block_min;
            record.bucket = bucketFor(override.block_min);
            record.block_source = 'observed';
          } else {
            record.block_source = 'estimated';
          }
          if (override.freq_band) record.freq_band = override.freq_band;
          if (Array.isArray(override.operators) && override.operators.length) record.operators = override.operators;
          if (Array.isArray(override.time_bands) && override.time_bands.length) record.time_bands = override.time_bands;
          if (Array.isArray(override.dow) && override.dow.length) record.dow = override.dow;
          if (Number.isFinite(override.days_seen)) record.days_seen = override.days_seen;
          if (Number.isFinite(override.observed_nm)) record.observed_nm = override.observed_nm;
          if (override.simmable) record.simmable = true;
          if (override.cargo_seen) record.cargo_seen = true;
          if (DETAIL_MODE === 'full') {
            if (Array.isArray(override.flights) && override.flights.length) record.flights = override.flights;
            if (Array.isArray(override.regs) && override.regs.length) record.regs = override.regs;
            if (override.seasons && Object.keys(override.seasons).length) record.seasons = override.seasons;
          }
          record.detail = 'observed';
        }

        routes.push(record);
      }
    }
  }

  const observedRows = routes.filter((r) => r.detail === 'observed').length;
  const cargoRows = routes.filter((r) => r.cargo_seen).length;
  const detailLevel = observedRows === 0
    ? 'estimated'
    : observedRows === routes.length ? 'observed' : 'mixed';

  const payload = {
    // Date only, deliberately: no run timestamps in a public artifact.
    generated_on: new Date().toISOString().slice(0, 10),
    detail_level: detailLevel,
    detail_mode: DETAIL_MODE,
    estimator: {
      taxi_min: EST.taxiOutMin + EST.taxiInMin,
      climb_descent_min: EST.climbDescentMin,
      track_factor: EST.trackFactor,
      max_range_utilisation: EST.maxRangeUtilisation,
      note: 'Block times are estimates from great-circle distance, a distance-dependent track factor and the cruise speed published in fleet.owned. Observed rows keep the estimated block time because the ledger records no arrival time; run scripts/calibrate-find.mjs to fit the factors against real flight plans.',
    },
    counts: {
      airports: airports.size,
      fleet_types: aircraft.size,
      tails_known: tails.regs.length,
      observed_pairings: observed.size,
      observed_rows: observedRows,
      cargo_rows: cargoRows,
      rejected: skipped,
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
          name: ac.label,
          role: ac.role,
          cargo: Boolean(ac.cargo),
          narrowbody: ac.narrowbody,
          cruise_kts: ac.cruise_kt,
          range_nm: ac.range_nm,
          usable_range_nm: Math.round(ac.range_nm * EST.maxRangeUtilisation),
          icao_types: ac.icao_types ?? [],
        },
      ]),
    ),
    routes,
  };

  const json = JSON.stringify(payload);
  const sizeKb = Math.round(Buffer.byteLength(json) / 1024);

  console.log(`[find] ${airports.size} airports, ${aircraft.size} fleet types, ${tails.regs.length} known tails`);
  console.log(`[find] ${routes.length} pairings kept (` +
    `${skipped['out-of-range']} out of range, ` +
    `${skipped['narrowbody-blocked']} narrowbody-blocked, ` +
    `${skipped['no-range-data']} without range data)`);
  console.log(`[find] ${observed.size} observed pairings from the ledger, ${observedRows} matched onto a pairing, ${cargoRows} with cargo traffic`);
  console.log(`[find] operators resolved for ${routes.filter((r) => r.operators.length).length} pairings`);
  console.log(`[find] payload ${sizeKb} kB, detail_level=${detailLevel}, detail_mode=${DETAIL_MODE}`);
  if (skipped['no-range-data']) {
    console.log('[find] warning: some fleet types have no usable range_nm — fix fleet.owned in config/collection.json');
  }
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
