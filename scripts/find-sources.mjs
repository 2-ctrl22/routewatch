// scripts/find-sources.mjs — zero-dependency Node 20.
//
// Source readers for publish-find.mjs, written against the ACTUAL data structures
// as verified on 2026-08-24:
//
//   config/collection.json   fleet.owned[] = { key, name, types[], role, range_nm }
//                            airports carry narrowbody_allowed as a plain boolean
//   data/ledger.json         object keyed "EHAM-LEMG|HV|HV6115"
//                            value: { pair, airline, flight, nm, cargo, first_seen,
//                                     days[], types{ "AIRBUS A321 NEO": n },
//                                     seasons{ S26:{ first,last,days,types,std } },
//                                     dow[], std, sources[], state, missed,
//                                     last_seen, status, simmable, candidate, regs[] }
//   data/aircraft-meta.json  object keyed by REGISTRATION
//                            value: { reg, model, typeCode, airline, built, fetched }
//                            -> no range, no narrowbody: never use it for filtering
//
// Why this file exists: publish-find.mjs:214 pulled range_nm out of
// aircraft-meta.json, got null, and line 377 then skipped the range guard
// entirely. Result: 41400 pairings kept, 0 out of range, 0 narrowbody-blocked.

import { readFileSync, existsSync } from 'node:fs';

export const norm = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ---------------------------------------------------------------------------
// Estimator constants. trackFactor is distance-dependent: route extension over
// the great circle shrinks as the leg gets longer, so one global 1.06 is both
// too low for short European legs and too high for long haul. Replace these with
// the fitted values printed by scripts/calibrate-find.mjs --fit.
// ---------------------------------------------------------------------------
export const EST = {
  taxiOutMin: 12,
  taxiInMin: 8,
  climbDescentMin: 14,
  maxRangeUtilisation: 0.85,
  trackFactor: { lt500: 1.09, lt1500: 1.07, lt3500: 1.05, gte3500: 1.04 },
  windBias: { east: 0, west: 0, meridional: 0 },
};

export function trackFactorFor(nm) {
  if (nm < 500) return EST.trackFactor.lt500;
  if (nm < 1500) return EST.trackFactor.lt1500;
  if (nm < 3500) return EST.trackFactor.lt3500;
  return EST.trackFactor.gte3500;
}

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

// ---------------------------------------------------------------------------
// Fleet: the only legitimate source of range_nm and narrowbody status.
// ---------------------------------------------------------------------------
export function readFleet(path = 'config/collection.json') {
  const notes = [];
  const cfg = readJson(path);
  if (!cfg) return { types: [], byAlias: new Map(), notes: ['collection.json missing'] };

  const owned = cfg?.fleet?.owned ?? cfg?.fleet ?? [];
  const list = Array.isArray(owned) ? owned : Object.entries(owned).map(([k, v]) => ({ key: k, ...v }));

  const types = [];
  const byAlias = new Map();

  for (const f of list) {
    const code = f?.key ?? f?.code ?? f?.icao ?? null;
    const range = num(f?.range_nm ?? f?.range);
    if (!code) { notes.push('skip fleet entry without key'); continue; }
    if (range === null || range <= 0) {
      notes.push(`skip ${code}: range_nm missing or not positive (${JSON.stringify(f?.range_nm)})`);
      continue;
    }
    const role = f?.role ?? null;
    const t = {
      code: String(code),
      label: f?.name ?? String(code),
      role,
      range_nm: range,
      cruise_kt: num(f?.cruise_kt ?? f?.cruise ?? f?.tas_kt) ?? 447,
      narrowbody: typeof f?.narrowbody === 'boolean' ? f.narrowbody : /narrow/i.test(String(role ?? '')),
      aliases: [String(code), f?.name, ...(Array.isArray(f?.types) ? f.types : [])].filter(Boolean),
    };
    types.push(t);
    for (const a of t.aliases) byAlias.set(norm(a), t);
  }

  notes.unshift(`${types.length} fleet types with a usable range_nm`);
  return { types, byAlias, notes };
}

export function resolveType(name, byAlias) {
  return byAlias.get(norm(name)) ?? null;
}

// aircraft-meta.json in its real role: which tails were actually seen.
export function readAircraftRegs(path = 'data/aircraft-meta.json') {
  const raw = readJson(path);
  if (!raw) return { regs: [], notes: ['aircraft-meta.json missing'] };
  const records = Array.isArray(raw) ? raw : Object.values(raw);
  return {
    regs: records.map((r) => ({
      reg: r?.reg ?? null,
      model: r?.model ?? null,
      typeCode: r?.typeCode ?? null,
      airline: r?.airline ?? null,
      built: r?.built ?? null,
    })),
    notes: [`${records.length} known registrations`],
  };
}

// ---------------------------------------------------------------------------
// The filter. A type with no finite range is REFUSED, never waved through.
// ---------------------------------------------------------------------------
export function pairingAllowed(from, to, type, distance_nm) {
  if (!Number.isFinite(type?.range_nm)) return { ok: false, reason: 'no-range-data' };
  if (!Number.isFinite(distance_nm)) return { ok: false, reason: 'no-distance' };
  const routed = distance_nm * trackFactorFor(distance_nm);
  if (routed > type.range_nm * EST.maxRangeUtilisation) return { ok: false, reason: 'out-of-range' };
  if (type.narrowbody && (from?.narrowbody_allowed === false || to?.narrowbody_allowed === false)) {
    return { ok: false, reason: 'narrowbody-blocked' };
  }
  return { ok: true, routed_nm: Math.round(routed) };
}

export function estimateBlockMin(distance_nm, type) {
  const routed = distance_nm * trackFactorFor(distance_nm);
  const cruise = type?.cruise_kt ?? 447;
  return Math.round((routed / cruise) * 60 + EST.taxiOutMin + EST.taxiInMin + EST.climbDescentMin);
}

// ---------------------------------------------------------------------------
// Ledger walk. Keys are "PAIR|AIRLINE|FLIGHT"; entry.pair is the fallback.
// ---------------------------------------------------------------------------
const FREQ_ORDER = ['several_daily', 'daily', 'weekly', 'seen'];

function freqBand(entry) {
  const days = Array.isArray(entry?.days) ? entry.days.length : 0;
  if (!days) return 'seen';
  const first = Date.parse(entry.first_seen ?? entry.days[0]);
  const last = Date.parse(entry.last_seen ?? entry.days[days - 1]);
  const weeks = Math.max(1, (last - first) / (7 * 864e5));
  const perWeek = days / weeks;
  if (perWeek >= 14) return 'several_daily';
  if (perWeek >= 6) return 'daily';
  if (perWeek >= 1) return 'weekly';
  return 'seen';
}

export function timeBand(std) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(std ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  if (h < 5) return 'nacht';
  if (h < 9) return 'ochtend';
  if (h < 12) return 'late ochtend';
  if (h < 17) return 'middag';
  if (h < 21) return 'avond';
  return 'late avond';
}

function airlineNames(path = 'data/airlines.json') {
  const raw = readJson(path);
  const out = new Map();
  if (!raw) return out;
  const add = (c, n) => { if (c && n) out.set(norm(c), n); };
  if (Array.isArray(raw)) for (const a of raw) add(a?.iata ?? a?.code ?? a?.icao, a?.name ?? a?.airline);
  else for (const [k, v] of Object.entries(raw)) add(k, typeof v === 'string' ? v : (v?.name ?? v?.airline));
  return out;
}

// DETAIL_MODE:
//   'full'    flight numbers, scheduled times, registrations, per-season records.
//             Enabled because Aero granted written permission for the observed
//             scenario. See the 2026-08-24 comment on issue #1.
//   'derived' distance, block band, coarse frequency and operator names only.
export const DETAIL_MODE = process.env.FIND_DETAIL ?? 'full';

export function walkLedger(path = 'data/ledger.json', byAlias = new Map()) {
  const notes = [];
  const raw = readJson(path);
  if (!raw) return { map: new Map(), notes: ['ledger.json missing'] };

  const entries = Array.isArray(raw)
    ? raw.map((v) => [null, v])
    : Object.entries(raw);
  const names = airlineNames();
  const map = new Map();
  let noPair = 0, noType = 0;

  for (const [key, entry] of entries) {
    const pairStr = entry?.pair ?? (key ? String(key).split('|')[0] : null);
    const m = /^([A-Z0-9]{4})-([A-Z0-9]{4})$/.exec(norm(pairStr).replace(/\s/g, ''));
    if (!m) { noPair++; continue; }
    const [, from, to] = m;

    const observed = Object.keys(entry?.types ?? {});
    const resolved = [...new Set(observed.map((t) => resolveType(t, byAlias)).filter(Boolean))];
    if (!resolved.length) { noType++; continue; }

    const band = freqBand(entry);
    const std = entry?.std ?? Object.values(entry?.seasons ?? {})[0]?.std ?? null;
    const operator = names.get(norm(entry?.airline)) ?? entry?.airline ?? null;

    for (const t of resolved) {
      const k = `${from}-${to}-${t.code}`;
      const cur = map.get(k) ?? {
        from, to, ac: t.code,
        nm: num(entry?.nm),
        block_min: null,
        freq_band: 'seen',
        operators: new Set(),
        time_bands: new Set(),
        dow: new Set(),
        days_seen: 0,
        simmable: false,
        flights: [],
        regs: new Set(),
        seasons: {},
      };
      if (FREQ_ORDER.indexOf(band) < FREQ_ORDER.indexOf(cur.freq_band)) cur.freq_band = band;
      if (operator) cur.operators.add(operator);
      const tb = timeBand(std);
      if (tb) cur.time_bands.add(tb);
      for (const d of entry?.dow ?? []) cur.dow.add(d);
      cur.days_seen += Array.isArray(entry?.days) ? entry.days.length : 0;
      if (entry?.simmable) cur.simmable = true;
      if (cur.nm == null && num(entry?.nm) != null) cur.nm = num(entry.nm);

      if (DETAIL_MODE === 'full') {
        cur.flights.push({
          airline: entry?.airline ?? null,
          flight: entry?.flight ?? null,
          std,
          dow: entry?.dow ?? [],
          days: Array.isArray(entry?.days) ? entry.days.length : 0,
          first_seen: entry?.first_seen ?? null,
          last_seen: entry?.last_seen ?? null,
          status: entry?.status ?? null,
          cargo: entry?.cargo ?? 0,
        });
        for (const r of entry?.regs ?? []) cur.regs.add(r);
        for (const [s, v] of Object.entries(entry?.seasons ?? {})) {
          const prev = cur.seasons[s] ?? { days: 0, std: [], first: null, last: null };
          prev.days += num(v?.days) ?? 0;
          if (v?.std) prev.std.push(v.std);
          prev.first = prev.first && prev.first < v?.first ? prev.first : (v?.first ?? prev.first);
          prev.last = prev.last && prev.last > v?.last ? prev.last : (v?.last ?? prev.last);
          cur.seasons[s] = prev;
        }
      }
      map.set(k, cur);
    }
  }

  notes.push(`${entries.length} ledger entries -> ${map.size} observed pairings`);
  notes.push(`${noPair} entries without a parsable ICAO pair, ${noType} with no fleet type`);
  notes.push(`detail mode: ${DETAIL_MODE}`);
  return { map, notes };
}

// ---------------------------------------------------------------------------
// OBSERVED, as consumed by publish-find.mjs.
//
// Honest limitation: the ledger stores std (scheduled departure) but no arrival
// time, so there is no real block time in here. block_min stays null and the
// estimate is kept; only frequency, time bands, operators, tails and per-season
// presence are genuinely observed. Feed real block times in from
// data/calibration.json once scripts/calibrate-find.mjs has samples.
// ---------------------------------------------------------------------------
export const OBSERVED = {
  enabled: true,
  read() {
    const { byAlias, notes: fleetNotes } = readFleet();
    for (const n of fleetNotes) console.log(`[find] fleet: ${n}`);
    const { map, notes } = walkLedger('data/ledger.json', byAlias);
    for (const n of notes) console.log(`[find] ledger: ${n}`);

    const out = new Map();
    for (const [k, v] of map) {
      const rec = {
        block_min: v.block_min,
        freq_band: v.freq_band,
        operators: [...v.operators].sort(),
        time_bands: [...v.time_bands],
        dow: [...v.dow].sort((a, b) => a - b),
        days_seen: v.days_seen,
        observed_nm: v.nm,
        simmable: v.simmable,
      };
      if (DETAIL_MODE === 'full') {
        rec.flights = v.flights.sort((a, b) => String(a.std).localeCompare(String(b.std)));
        rec.regs = [...v.regs].sort();
        rec.seasons = v.seasons;
      }
      out.set(k, rec);
    }
    return out;
  },
};
