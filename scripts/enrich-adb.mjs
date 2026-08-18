#!/usr/bin/env node
/**
 * enrich-adb.mjs - verrijking bovenop RouteWatch, budgetbewust
 *
 * Raakt routewatch.mjs NIET aan. Schrijft losse cachebestanden die je dashboard
 * of latere analyses kunnen inlezen:
 *
 *   data/airports-meta.json   baangegevens + metadata per veld   (Tier 1, 1 unit)
 *   data/aircraft-meta.json   toestel per registratie            (Tier 1, 1 unit)
 *   data/type-history.json    7 dagen typegebruik per vluchtnr   (Tier 2, 2 units)
 *
 * ALLES WORDT GECACHED. Een tweede run kost 0 units voor wat al binnen is.
 * Verversen kan met FORCE_REFRESH=true, maar dat kost opnieuw units.
 *
 * WAAROM DEZE DRIE
 *   1. Baangegevens: je config heeft narrowbody_allowed als handmatige aanname.
 *      Met echte baanlengtes wordt dat een gemeten feit. Eenmalig 2 units per veld.
 *   2. Toestelhistorie: 1 unit per registratie, verandert daarna nooit meer.
 *   3. Typeverificatie: het BASIC-plan geeft 7 dagen geschiedenis PER AANROEP.
 *      Voor 2 units zie je dus een hele week typegebruik van een vluchtnummer.
 *      Dat lost het probleem op van operators met een gemengde vloot, waar de
 *      matchstatus per datum verschilt.
 *
 * BUDGET (AeroDataBox BASIC: 600 units/maand, 2400 requests, 1 req/seconde)
 *   Tier 1 = 1 unit, Tier 2 = 2, Tier 3 = 6, Tier 4 = 60.
 *   Eerste runs:        41 velden x 2 = 82 units, eenmalig, gespreid over runs
 *   Daarna maandelijks: circa 40 units typeverificatie + 15 units registraties
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const LOG = (...a) => console.log("[enrich]", ...a);

const KEY = process.env.RAPIDAPI_KEY;
if (!KEY) { LOG("geen RAPIDAPI_KEY - verrijking overgeslagen"); process.exit(0); }

const HOST = "aerodatabox.p.rapidapi.com";
const H = { "X-RapidAPI-Key": KEY, "X-RapidAPI-Host": HOST };

const CAP = Number(process.env.ENRICH_UNIT_CAP ?? 60);
const FORCE = String(process.env.FORCE_REFRESH ?? "").toLowerCase() === "true";
const MAX_FLIGHTS = Number(process.env.ENRICH_MAX_FLIGHTS ?? 10);

let spent = 0, stopped = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const load = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };

function spend(units, label) {
  if (stopped) return false;
  if (spent + units > CAP) {
    LOG(`unitplafond ${CAP} bereikt na ${spent} units - ${label} en de rest overgeslagen`);
    stopped = true;
    return false;
  }
  spent += units;
  return true;
}

async function get(url, units, label) {
  if (!spend(units, label)) return null;
  try {
    const res = await fetch(url, { headers: H });
    if (res.status === 429) { LOG(`${label}: 429 - quotum of snelheidslimiet, stop`); stopped = true; return null; }
    if (res.status === 403) { LOG(`${label}: 403 - sleutel niet geabonneerd, stop`); stopped = true; return null; }
    if (res.status === 404) { LOG(`${label}: 404 - niet gevonden of endpointvorm klopt niet`); return undefined; }
    if (!res.ok) { LOG(`${label}: HTTP ${res.status}`); return undefined; }
    return await res.json();
  } catch (e) { LOG(`${label} error:`, e.message); return undefined; }
  finally { await sleep(1100); }
}

const CFG = load("config/collection.json", null);
if (!CFG?.airports?.length) { LOG("config/collection.json onbruikbaar"); process.exit(1); }
mkdirSync("data", { recursive: true });

/* ============================== 1. BAANGEGEVENS + METADATA (Tier 1) ======= */

const META = load("data/airports-meta.json", {});
let metaNew = 0;

for (const a of CFG.airports) {
  if (stopped) break;
  if (META[a.icao] && !FORCE) continue;

  const info = await get(`https://${HOST}/airports/icao/${a.icao}`, 1, `airport ${a.icao}`);
  if (info === null) break;
  const rw = await get(`https://${HOST}/airports/icao/${a.icao}/runways`, 1, `runways ${a.icao}`);
  if (rw === null) break;

  const runways = Array.isArray(rw) ? rw : (rw?.runways ?? []);
  const lengths = runways.map(r => Number(r?.length?.feet ?? r?.lengthFeet ?? 0)).filter(n => n > 0);
  const longest = lengths.length ? Math.max(...lengths) : null;

  META[a.icao] = {
    icao: a.icao,
    iata: info?.iata ?? a.iata ?? null,
    name: info?.fullName ?? info?.shortName ?? a.name ?? null,
    country: info?.country?.name ?? null,
    tz: info?.timeZone ?? null,
    elevation_ft: info?.elevation?.feet ?? null,
    runway_count: runways.length || null,
    longest_runway_ft: longest,
    surfaces: [...new Set(runways.map(r => r?.surface?.type ?? r?.surface ?? null).filter(Boolean))],
    // Vuistregels: 737-800/A320 willen circa 6.500 ft, A350/777F circa 9.000 ft.
    // Dit is een INDICATIE op baanlengte alleen; gewicht, hoogte, temperatuur en
    // baanconditie zijn niet meegerekend.
    narrowbody_ok: longest ? longest >= 6500 : null,
    widebody_ok: longest ? longest >= 9000 : null,
    fetched: new Date().toISOString().slice(0, 10)
  };
  metaNew++;
  LOG(`${a.icao}: ${runways.length} banen, langste ${longest ?? "?"} ft (units ${spent}/${CAP})`);
}

writeFileSync("data/airports-meta.json", JSON.stringify(META, null, 1));
LOG(`airports-meta.json: ${Object.keys(META).length} velden, ${metaNew} nieuw`);

/* ============================== 2. TOESTELLEN PER REGISTRATIE (Tier 1) ==== */

const ACM = load("data/aircraft-meta.json", {});
const LEDGER = load("data/ledger.json", {});

// Registraties komen uit de ledger, als die ze bijhoudt. Ontbreken ze, dan doet
// deze sectie niets en kost ook niets.
const regs = new Set();
for (const row of Object.values(LEDGER)) {
  for (const r of row?.regs ?? []) if (r) regs.add(String(r).toUpperCase());
}

let acNew = 0;
for (const reg of regs) {
  if (stopped) break;
  if (ACM[reg] && !FORCE) continue;
  const j = await get(`https://${HOST}/aircrafts/reg/${encodeURIComponent(reg)}`, 1, `aircraft ${reg}`);
  if (j === null) break;
  const ac = Array.isArray(j) ? j[0] : j;
  ACM[reg] = ac ? {
    reg,
    model: ac?.model ?? null,
    typeCode: ac?.typeName ?? ac?.icaoCode ?? null,
    airline: ac?.airlineName ?? null,
    built: ac?.rolloutDate ?? ac?.firstFlightDate ?? null,
    fetched: new Date().toISOString().slice(0, 10)
  } : null;
  acNew++;
}
writeFileSync("data/aircraft-meta.json", JSON.stringify(ACM, null, 1));
LOG(`aircraft-meta.json: ${Object.keys(ACM).length} registraties, ${acNew} nieuw`);

/* ============================== 3. TYPEVERIFICATIE 7 DAGEN (Tier 2) ====== */

/* Het BASIC-plan geeft 7 dagen per aanroep voor Flight History & Schedule.
 * Voor 2 units zie je dus een hele week typegebruik van een vluchtnummer.
 *
 * Welke vluchtnummers? Uit config/collection.json, sectie settings.watch_flights.
 * Bijvoorbeeld:  "watch_flights": ["DY1800", "KL1600", "HV6619"]
 * Staat die lijst er niet, dan doet deze sectie niets en kost het niets.
 *
 * LET OP: de padvorm hieronder is niet geverifieerd in de documentatie. Komt er
 * een 404, dan moet dit endpoint anders worden aangeroepen. Het script gaat dan
 * gewoon door en de rest van de verrijking blijft werken.
 */

const WATCH = (CFG.settings?.watch_flights ?? []).slice(0, MAX_FLIGHTS);
const TH = load("data/type-history.json", {});
const iso = d => d.toISOString().slice(0, 10);
const from = iso(new Date(Date.now() - 7 * 864e5));
const to = iso(new Date(Date.now() - 1 * 864e5));
const weekKey = `${from}_${to}`;

let thNew = 0;
for (const fn of WATCH) {
  if (stopped) break;
  if (!TH[fn]) TH[fn] = {};
  if (TH[fn][weekKey] && !FORCE) continue;

  const j = await get(`https://${HOST}/flights/number/${encodeURIComponent(fn)}/${from}/${to}`, 2, `flight ${fn}`);
  if (j === null) break;
  if (j === undefined) continue;

  const legs = Array.isArray(j) ? j : (j?.flights ?? []);
  const byDay = {};
  const typeCount = {};
  for (const f of legs) {
    const day = String(f?.departure?.scheduledTime?.utc ?? f?.departure?.scheduledTimeUtc ?? "").slice(0, 10);
    const t = f?.aircraft?.model ?? f?.aircraft?.typeCode ?? null;
    if (day) byDay[day] = { type: t, reg: f?.aircraft?.reg ?? null };
    if (t) typeCount[t] = (typeCount[t] ?? 0) + 1;
  }
  const types = Object.keys(typeCount);
  TH[fn][weekKey] = {
    legs: legs.length,
    per_day: byDay,
    type_count: typeCount,
    mixed_fleet: types.length > 1,       // hier zit je antwoord op "per datum te bevestigen"
    fetched: new Date().toISOString().slice(0, 10)
  };
  thNew++;
  LOG(`${fn}: ${legs.length} legs, types ${types.join("/") || "?"}${types.length > 1 ? " - GEMENGDE VLOOT" : ""} (units ${spent}/${CAP})`);
}
writeFileSync("data/type-history.json", JSON.stringify(TH, null, 1));
LOG(`type-history.json: ${Object.keys(TH).length} vluchtnummers, ${thNew} nieuw deze week`);

/* ============================== samenvatting ============================= */

const report = [
  `# Verrijking ${new Date().toISOString().slice(0, 16)}`,
  ``,
  `- velden met baangegevens: ${Object.keys(META).length} (${metaNew} nieuw)`,
  `- registraties in cache: ${Object.keys(ACM).length} (${acNew} nieuw)`,
  `- vluchtnummers met weekhistorie: ${Object.keys(TH).length} (${thNew} nieuw)`,
  `- verbruikte units deze run: ${spent} van plafond ${CAP}`,
  stopped ? `- LET OP: vroegtijdig gestopt om je quotum te beschermen` : `- volledig afgerond`
].join("\n");
writeFileSync("data/last-enrich.md", report + "\n");

LOG(`klaar: ${spent} units verbruikt`);
