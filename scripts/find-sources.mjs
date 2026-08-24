// scripts/find-sources.mjs — zero-dependency Node 20.
//
// Source readers for publish-find.mjs, written against the ACTUAL data structures
// as verified on 2026-08-24:
//
//   config/collection.json   fleet.owned[]  = { key, name, role, range_nm, types[] }
//                            fleet.near_match = { B38M: { substitute, concession } }
//                            airports carry narrowbody_allowed as a plain boolean
//                            role is the MISSION ("pax" / "cargo"), NOT the body width
//   data/ledger.json         object keyed "EHAM-LEMG|HV|HV6115"
//                            value: { pair, airline, flight, nm, cargo, first_seen,
//                                     days[], types{ "AIRBUS A321 NEO": n },
//                                     seasons{ S26:{ first,last,days,types,std } },
//                                     dow[], std, sources[], state, missed,
//                                     last_seen, status, simmable, candidate, regs[] }
//   data/aircraft-meta.json  object keyed by REGISTRATION
//                            value: { reg, model:"A21N", typeCode:"Airbus A321 NEO", ... }
//                            no range, no body width: never use it for filtering,
//                            but its typeCode -> model mapping is a useful bridge
//
// Two naming worlds have to meet here. The ledger records display names, the
// fleet records ICAO codes, and the substitutes live in near_match. Everything is
// matched on a squashed key (uppercase, non-alphanumerics removed) so that
// "AIRBUS A321 NEO" and "Airbus A321neo" collapse onto the same string.

import { readFileSync, existsSync } from 'node:fs';

export const norm = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
export const squash = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

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

// ---------------------------------------------------------------------------
// Body width per ICAO type code. Explicit, because it cannot be derived from
// `role` (that is pax/cargo) and a prefix rule would put A318/A319 in the same
// bucket as A330/A350. Anything not listed here counts as widebody.
// ---------------------------------------------------------------------------
const NARROWBODY = new Set([
  'B733', 'B734', 'B735', 'B736', 'B737', 'B738', 'B739', 'B73H', 'B73Y',
  'B738F', 'B734F', 'B37M', 'B38M', 'B38X', 'B39M', 'B752', 'B753',
  'BCS1', 'BCS3', 'A318', 'A319', 'A320', 'A321', 'A19N', 'A20N', 'A21N',
  'E145', 'E170', 'E175', 'E190', 'E195', 'E290', 'E295',
  'AT43', 'AT45', 'AT46', 'AT72', 'AT75', 'AT76',
  'DH8A', 'DH8C', 'DH8D', 'CRJ2', 'CRJ7', 'CRJ9', 'CRJX',
  'SB20', 'SF34', 'F70', 'F100', 'C919', 'SU95',
]);

// Code to display name, mirroring the TYPES table in index.html and map.html so
// the pages agree on wording. Used to match the ledger's display names.
const ICAO_NAMES = {
  B733: 'Boeing 737-300', B734: 'Boeing 737-400', B735: 'Boeing 737-500',
  B736: 'Boeing 737-600', B737: 'Boeing 737-700', B738: 'Boeing 737-800',
  B739: 'Boeing 737-900', B73H: 'Boeing 737-800', B73Y: 'Boeing 737-800 freighter',
  B738F: 'Boeing 737-800 freighter', B734F: 'Boeing 737-400 freighter',
  B37M: 'Boeing 737 MAX 7', B38M: 'Boeing 737 MAX 8', B38X: 'Boeing 737 MAX 8-200',
  B39M: 'Boeing 737 MAX 9', B752: 'Boeing 757-200', B753: 'Boeing 757-300',
  B762: 'Boeing 767-200', B763: 'Boeing 767-300', B764: 'Boeing 767-400',
  B772: 'Boeing 777-200', B77L: 'Boeing 777F', B77F: 'Boeing 777F',
  B77W: 'Boeing 777-300ER', B773: 'Boeing 777-300',
  B788: 'Boeing 787-8', B789: 'Boeing 787-9', B78X: 'Boeing 787-10',
  B744: 'Boeing 747-400', B748: 'Boeing 747-8',
  BCS1: 'Airbus A220-100', BCS3: 'Airbus A220-300',
  A318: 'Airbus A318', A319: 'Airbus A319', A320: 'Airbus A320', A321: 'Airbus A321',
  A19N: 'Airbus A319neo', A20N: 'Airbus A320neo', A21N: 'Airbus A321neo',
  A332: 'Airbus A330-200', A333: 'Airbus A330-300',
  A338: 'Airbus A330-800neo', A339: 'Airbus A330-900neo',
  A343: 'Airbus A340-300', A346: 'Airbus A340-600',
  A359: 'Airbus A350-900', A35K: 'Airbus A350-1000', A388: 'Airbus A380-800',
  E145: 'Embraer ERJ-145', E170: 'Embraer E170', E175: 'Embraer E175',
  E190: 'Embraer E190', E195: 'Embraer E195', E290: 'Embraer E190-E2', E295: 'Embraer E195-E2',
  AT43: 'ATR 42', AT45: 'ATR 42-500', AT46: 'ATR 42-600',
  AT72: 'ATR 72', AT75: 'ATR 72-500', AT76: 'ATR 72-600',
  DH8A: 'Dash 8-100', DH8C: 'Dash 8-300', DH8D: 'Dash 8 Q400',
  CRJ2: 'Bombardier CRJ200', CRJ7: 'Bombardier CRJ700',
  CRJ9: 'Bombardier CRJ900', CRJX: 'Bombardier CRJ1000',
  MD11: 'McDonnell Douglas MD-11',
};

const isNarrow = (codes) => codes.some((c) => NARROWBODY.has(String(c).toUpperCase()));

// ---------------------------------------------------------------------------
// Fleet: the only legitimate source of range_nm, role and body width.
// ---------------------------------------------------------------------------
export function readFleet(path = 'config/collection.json') {
  const notes = [];
  const cfg = readJson(path);
  if (!cfg) return { types: [], byAlias: new Map(), notes: ['collection.json missing'] };

  const owned = cfg?.fleet?.owned ?? [];
  const list = Array.isArray(owned) ? owned : Object.entries(owned).map(([k, v]) => ({ key: k, ...v }));

  const types = [];
  const byAlias = new Map();
  const register = (key, type) => {
    if (!key || byAlias.has(key)) return;
    byAlias.set(key, type);
  };

  for (const f of list) {
    const code = f?.key ?? f?.code ?? f?.icao ?? null;
    const range = num(f?.range_nm ?? f?.range);
    if (!code) { notes.push('skip fleet entry without key'); continue; }
    if (range === null || range <= 0) {
      notes.push(`skip ${code}: range_nm missing or not positive (${JSON.stringify(f?.range_nm)})`);
      continue;
    }
    const codes = [String(code), ...(Array.isArray(f?.types) ? f.types : [])];
    const t = {
      code: String(code),
      label: f?.name ?? String(code),
      role: f?.role ?? null,
      cargo: /cargo|freight/i.test(String(f?.role ?? '')),
      range_nm: range,
      cruise_kt: num(f?.cruise_kt ?? f?.cruise ?? f?.tas_kt) ?? 447,
      // Body width comes from the type codes, never from role: role is pax/cargo.
      narrowbody: typeof f?.narrowbody === 'boolean' ? f.narrowbody : isNarrow(codes),
      icao_types: codes,
    };
    types.push(t);

    for (const c of codes) {
      register(squash(c), t);
      if (ICAO_NAMES[String(c).toUpperCase()]) register(squash(ICAO_NAMES[String(c).toUpperCase()]), t);
    }
    if (f?.name) register(squash(f.name), t);
  }

  // near_match maps a real-world type onto a substitute you do own. Without this
  // the ledger's A21N, B38M and B38X rows resolve to nothing.
  const near = cfg?.fleet?.near_match ?? {};
  let nearRegistered = 0;
  for (const [realCode, spec] of Object.entries(near)) {
    const sub = typeof spec === 'string' ? spec : spec?.substitute;
    const target = byAlias.get(squash(sub));
    if (!target) continue;
    const before = byAlias.size;
    register(squash(realCode), target);
    const pretty = ICAO_NAMES[String(realCode).toUpperCase()];
    if (pretty) register(squash(pretty), target);
    if (byAlias.size > before) nearRegistered += 1;
  }

  notes.unshift(`${types.length} fleet types with a usable range_nm, ${byAlias.size} aliases (${nearRegistered} via near_match)`);
  return { types, byAlias, notes };
}

// bridge: an optional Map of squashed display name -> ICAO code, built from
// data/aircraft-meta.json, tried when the alias table does not know a name.
export function resolveType(name, byAlias, bridge) {
  if (!name) return null;
  const key = squash(name);
  const direct = byAlias.get(key);
  if (direct) return direct;
  if (bridge) {
    const code = bridge.get(key);
    if (code) return byAlias.get(squash(code)) ?? null;
  }
  return null;
}

// aircraft-meta.json in its real role: which tails were seen, plus the display
// name to ICAO code mapping the enrichment step already resolved for us.
export function readAircraftRegs(path = 'data/aircraft-meta.json') {
  const raw = readJson(path);
  if (!raw) return { regs: [], nameToCode: new Map(), notes: ['aircraft-meta.json missing'] };
  const records = Array.isArray(raw) ? raw : Object.values(raw);
  const nameToCode = new Map();
  for (const r of records) {
    if (r?.typeCode && r?.model) nameToCode.set(squash(r.typeCode), String(r.model).toUpperCase());
  }
  return {
    regs: records.map((r) => ({
      reg: r?.reg ?? null,
      model: r?.model ?? null,
      typeCode: r?.typeCode ?? null,
      airline: r?.airline ?? null,
      built: r?.built ?? null,
    })),
    nameToCode,
    notes: [`${records.length} known registrations, ${nameToCode.size} name-to-code bridges`],
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
  if (h < 5) return 'night';
  if (h < 9) return 'morning';
  if (h < 12) return 'late morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'late evening';
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

export function walkLedger(path = 'data/ledger.json', byAlias = new Map(), bridge = null) {
  const notes = [];
  const raw = readJson(path);
  if (!raw) return { map: new Map(), notes: ['ledger.json missing'] };

  const entries = Array.isArray(raw)
    ? raw.map((v) => [null, v])
    : Object.entries(raw);
  const names = airlineNames();
  const map = new Map();
  const unknownTypes = new Map();
  let noPair = 0, noType = 0;

  for (const [key, entry] of entries) {
    const pairStr = entry?.pair ?? (key ? String(key).split('|')[0] : null);
    const m = /^([A-Z0-9]{4})-([A-Z0-9]{4})$/.exec(norm(pairStr).replace(/\s/g, ''));
    if (!m) { noPair++; continue; }
    const [, from, to] = m;

    const observed = Object.keys(entry?.types ?? {});
    const resolved = [...new Set(observed.map((t) => resolveType(t, byAlias, bridge)).filter(Boolean))];
    if (!resolved.length) {
      noType++;
      for (const t of observed) unknownTypes.set(t, (unknownTypes.get(t) ?? 0) + 1);
      continue;
    }

    const band = freqBand(entry);
    const std = entry?.std ?? Object.values(entry?.seasons ?? {})[0]?.std ?? null;
    const operator = names.get(norm(entry?.airline)) ?? entry?.airline ?? null;
    const isCargo = Boolean(Number(entry?.cargo ?? 0));

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
        cargo_seen: false,
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
      if (isCargo) cur.cargo_seen = true;
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
          cargo: isCargo ? 1 : 0,
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
  if (unknownTypes.size) {
    const top = [...unknownTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([t, n]) => `${t} (${n})`).join(', ');
    notes.push(`most common unmatched types: ${top}`);
  }
  notes.push(`detail mode: ${DETAIL_MODE}`);
  return { map, notes };
}

// ---------------------------------------------------------------------------
// OBSERVED, as consumed by publish-find.mjs.
//
// Honest limitation: the ledger stores std (scheduled departure) but no arrival
// time, so there is no real block time in here. block_min stays null and the
// estimate is kept; only frequency, time bands, operators, tails, cargo presence
// and per-season presence are genuinely observed. Feed real block times in from
// data/calibration.json once scripts/calibrate-find.mjs has samples.
// ---------------------------------------------------------------------------
export const OBSERVED = {
  enabled: true,
  read() {
    const { byAlias, notes: fleetNotes } = readFleet();
    for (const n of fleetNotes) console.log(`[find] fleet: ${n}`);
    const { nameToCode } = readAircraftRegs();
    const { map, notes } = walkLedger('data/ledger.json', byAlias, nameToCode);
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
        cargo_seen: v.cargo_seen,
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
