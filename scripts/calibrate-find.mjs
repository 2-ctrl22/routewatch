#!/usr/bin/env node
// scripts/calibrate-find.mjs — zero-dependency Node 20.
//
// Calibrates the flight-time estimator against real flight plans WITHOUT any local
// simulator or navdata installation. SimBrief computes the real route for you and
// reports both the great-circle and the route distance in the same OFP.
//
// Free and keyless: only your SimBrief Pilot ID is needed. The plan-generation API
// requires a key; the OFP fetcher used here does not.
//
//   node scripts/calibrate-find.mjs --dump  --id 123456   # inspect field names
//   node scripts/calibrate-find.mjs --fetch --id 123456   # store latest plan
//   node scripts/calibrate-find.mjs --seed EHAM LEMG A21N --gc 1017 --route 1082 --ete 155
//   node scripts/calibrate-find.mjs --fit                 # print EST constants
//
// You do not have to fly a plan to calibrate with it. Generating one plan per
// distance band and per direction is enough to fit a usable curve.
//
// data/calibration.json keeps full plan detail, including flight number, scheduled
// times and registration. That is deliberate: Aero granted written permission for
// the observed scenario on 2026-08-24 (see issue #1). Set CAL_DETAIL=derived to
// store only the geometry and the fitted residuals.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STORE = 'data/calibration.json';
const DETAIL = process.env.CAL_DETAIL ?? 'full';
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const BANDS = [
  { key: 'lt500', max: 500, seed: 1.09 },
  { key: 'lt1500', max: 1500, seed: 1.07 },
  { key: 'lt3500', max: 3500, seed: 1.05 },
  { key: 'gte3500', max: Infinity, seed: 1.04 },
];
const bandOf = (nm) => BANDS.find((b) => nm < b.max).key;

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null;
};

// SimBrief JSON uses seconds for durations; some layouts show hh:mm.
function minutes(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const hhmm = /^(\d{1,3}):(\d{2})$/.exec(s);
  if (hhmm) return Number(hhmm[1]) * 60 + Number(hhmm[2]);
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n > 600 ? Math.round(n / 60) : Math.round(n);
}

const load = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : { schema: 1, detail: DETAIL, samples: [], fit: null });
const save = (db) => { mkdirSync(dirname(STORE), { recursive: true }); writeFileSync(STORE, JSON.stringify(db, null, 2) + '\n'); };

function pick(obj, names) {
  for (const n of names) {
    const v = n.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

// Direction drives the wind term: eastbound legs run faster than the same leg
// westbound. Derived from the published longitudes already in collection.json,
// so no weather model and no extra download is needed.
function airportLon(path = 'config/collection.json') {
  const map = new Map();
  if (!existsSync(path)) return map;
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      const icao = v.icao ?? v.ICAO;
      const lon = num(v.lon ?? v.lng ?? v.longitude);
      if (icao && lon != null) map.set(String(icao).toUpperCase(), lon);
      Object.values(v).forEach(walk);
    }
  };
  walk(JSON.parse(readFileSync(path, 'utf8')));
  return map;
}

function directionOf(from, to, lons) {
  const a = lons.get(from), b = lons.get(to);
  if (a == null || b == null) return 'unknown';
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  if (Math.abs(d) < 5) return 'meridional';
  return d > 0 ? 'east' : 'west';
}

async function fetchOfp(id) {
  if (!id) throw new Error('need --id or SIMBRIEF_ID (Pilot ID from SimBrief Account Settings)');
  const url = `https://www.simbrief.com/api/xml.fetcher.php?userid=${encodeURIComponent(id)}&json=1`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`SimBrief fetcher returned ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error('response was not JSON - check the Pilot ID and that a plan exists'); }
}

function sampleFromOfp(ofp, lons) {
  const from = String(pick(ofp, ['origin.icao_code', 'origin.icao']) ?? '').toUpperCase();
  const to = String(pick(ofp, ['destination.icao_code', 'destination.icao']) ?? '').toUpperCase();
  const type = String(pick(ofp, ['aircraft.icaocode', 'aircraft.icao_code', 'aircraft.base_type', 'aircraft.name']) ?? '').toUpperCase();
  const s = {
    from, to, type,
    gc_nm: num(pick(ofp, ['general.gc_distance', 'general.gcd'])),
    route_nm: num(pick(ofp, ['general.route_distance', 'general.air_distance', 'general.total_distance'])),
    ete_min: minutes(pick(ofp, ['times.est_time_enroute', 'times.est_ete'])),
    block_min: minutes(pick(ofp, ['times.est_block', 'times.block_time'])),
    taxi_out_min: minutes(pick(ofp, ['times.taxi_out'])),
    taxi_in_min: minutes(pick(ofp, ['times.taxi_in'])),
    wind_kt: num(pick(ofp, ['general.avg_wind_comp', 'general.avg_wind_component'])),
    cruise_kt: num(pick(ofp, ['general.avg_tas', 'general.cruise_tas'])),
    month: new Date().toISOString().slice(0, 7),
    direction: directionOf(from, to, lons),
    source: 'simbrief-fetcher',
  };
  if (DETAIL === 'full') {
    s.airline = pick(ofp, ['general.icao_airline', 'general.airline']);
    s.flight = pick(ofp, ['general.flight_number', 'general.fltnum']);
    s.reg = pick(ofp, ['aircraft.reg', 'aircraft.registration']);
    s.std = pick(ofp, ['times.sched_out', 'times.est_out']);
    s.sta = pick(ofp, ['times.sched_in', 'times.est_in']);
    s.route = pick(ofp, ['general.route']);
    s.cruise_level = pick(ofp, ['general.initial_altitude', 'general.stepclimb_string']);
  }
  return s;
}

function addSample(db, s) {
  if (!s.from || !s.to || !s.gc_nm || !s.route_nm) {
    console.error('[cal] incomplete sample, not stored:', JSON.stringify(s));
    return false;
  }
  const same = db.samples.find((x) => x.from === s.from && x.to === s.to && x.type === s.type &&
                                      x.month === s.month && x.route_nm === s.route_nm);
  if (same) { console.log('[cal] duplicate sample, skipped'); return false; }
  db.samples.push(s);
  console.log(`[cal] stored ${s.from}-${s.to} ${s.type}: gc ${s.gc_nm} nm, route ${s.route_nm} nm, ` +
              `factor ${(s.route_nm / s.gc_nm).toFixed(3)}` +
              (s.ete_min ? `, ete ${s.ete_min} min` : '') +
              (s.wind_kt != null ? `, wind ${s.wind_kt > 0 ? '+' : ''}${s.wind_kt} kt` : '') +
              `, ${s.direction}bound`);
  return true;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function fit(db) {
  const out = { n: db.samples.length, fitted_on: new Date().toISOString().slice(0, 10), trackFactor: {}, windBias: {} };
  for (const b of BANDS) {
    const f = db.samples.filter((s) => bandOf(s.gc_nm) === b.key).map((s) => s.route_nm / s.gc_nm);
    out.trackFactor[b.key] = { value: Number((median(f) ?? b.seed).toFixed(3)), n: f.length, seeded: f.length < 3 };
  }
  for (const dir of ['east', 'west', 'meridional']) {
    const w = db.samples.filter((s) => s.direction === dir && s.wind_kt != null).map((s) => s.wind_kt);
    out.windBias[dir] = { avg_wind_kt: Number((median(w) ?? 0).toFixed(1)), n: w.length };
  }
  db.fit = out;

  console.log(`\n[cal] fit over ${out.n} samples - paste into EST in scripts/find-sources.mjs:\n`);
  console.log('  trackFactor: {');
  for (const b of BANDS) {
    const t = out.trackFactor[b.key];
    console.log(`    ${b.key}: ${t.value},${t.seeded ? `   // still seeded, n=${t.n}` : `   // fitted, n=${t.n}`}`);
  }
  console.log('  },');
  console.log('  windBias: {');
  for (const dir of ['east', 'west', 'meridional']) {
    const w = out.windBias[dir];
    console.log(`    ${dir}: ${w.avg_wind_kt},   // kt, + = tailwind, n=${w.n}`);
  }
  console.log('  },\n');
  console.log('[cal] Wind dominates the error budget: 40 kt on a 7 h leg is ~45 min, while 6%');
  console.log('[cal] route extension on 700 nm is ~6 min. Show a band, not a single number.');

  const thin = BANDS.filter((b) => out.trackFactor[b.key].seeded).map((b) => b.key);
  if (thin.length) console.log(`[cal] thin bands: ${thin.join(', ')} - generate one plan each and rerun --fetch`);
  return out;
}

const db = load();
db.detail = DETAIL;
const lons = airportLon();

if (flag('dump')) {
  const ofp = await fetchOfp(val('id') ?? process.env.SIMBRIEF_ID);
  console.log('[cal] top-level keys:', Object.keys(ofp).join(', '));
  for (const k of ['general', 'times', 'aircraft', 'origin', 'destination']) {
    console.log(`[cal] ${k}:`, JSON.stringify(ofp[k]).slice(0, 900));
  }
} else if (flag('fetch')) {
  const s = sampleFromOfp(await fetchOfp(val('id') ?? process.env.SIMBRIEF_ID), lons);
  if (addSample(db, s)) { fit(db); save(db); }
} else if (flag('seed')) {
  const pos = args.filter((a) => !a.startsWith('--') && !['--gc', '--route', '--ete', '--wind', '--month', '--id'].includes(args[args.indexOf(a) - 1]));
  const [from, to, type] = pos.slice(0, 3).map((x) => String(x).toUpperCase());
  const s = {
    from, to, type,
    gc_nm: num(val('gc')), route_nm: num(val('route')),
    ete_min: minutes(val('ete')), wind_kt: num(val('wind')),
    month: val('month') ?? new Date().toISOString().slice(0, 7),
    direction: directionOf(from, to, lons),
    source: 'manual',
  };
  if (addSample(db, s)) { fit(db); save(db); }
} else if (flag('fit')) {
  fit(db);
  save(db);
} else {
  console.log('usage: --fetch --id <pilotID> | --seed FROM TO TYPE --gc n --route n [--ete min] [--wind kt] | --fit | --dump --id <pilotID>');
}
