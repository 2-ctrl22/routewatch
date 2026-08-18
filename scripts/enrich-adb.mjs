#!/usr/bin/env node
/**
 * enrich-adb.mjs v2 - verrijking bovenop RouteWatch, budgetbewust
 *
 * Raakt routewatch.mjs NIET aan. Schrijft losse cachebestanden:
 *
 *   data/airports-meta.json   baangegevens + metadata per veld   (Tier 1, 1 unit)
 *   data/aircraft-meta.json   toestel per registratie            (Tier 1, 1 unit)
 *   data/type-history.json    7 dagen typegebruik per vluchtnr   (Tier 2, 2 units)
 *   data/enrich-cursor.json   waar de rotatie is gebleven
 *   data/last-enrich.md       samenvatting per run
 *
 * NIEUW IN v2: GEEN HANDMATIGE LIJST MEER NODIG
 * ---------------------------------------------------------------------------
 * De vluchtnummers worden automatisch uit data/ledger.json gehaald, in deze
 * prioriteitsorde:
 *   1. GEMENGDE VLOOT   meer dan 1 toesteltype gezien -> je matchstatus is hier
 *                       "per datum te bevestigen" en dat wil je opgelost hebben
 *   2. TYPE ONBEKEND    geen enkel type gezien -> matchStatus() geeft ONBEKEND
 *   3. REST             op aantal waargenomen dagen, drukste eerst
 *
 * Binnen elke groep draait een cursor rond: elke run pakt de volgende N
 * vluchtnummers op, dus over de weken komt alles langs zonder dat jij iets
 * hoeft bij te houden. Een vluchtnummer dat deze week al is opgehaald wordt
 * overgeslagen (cache), dus herhalen kost 0 units.
 *
 * WAAROM NIET ALLE 465 PAREN IN EEN KEER
 * ---------------------------------------------------------------------------
 * Je 254 bediende paren hebben elk meerdere operators, dus honderden unieke
 * vluchtnummers. Per vluchtnummer per week kost dat 2 units. Bij 400 nummers
 * is dat 800 units per week tegen een maandbudget van 600. Dat past niet.
 * Let op: voor "bestaat de route en met welk toestel" heb je dit NIET nodig -
 * collect-adb.mjs levert operator en type al voor elke waargenomen vlucht.
 * Deze sectie is het precisie-instrument voor typewisselingen per datum.
 *
 * BUDGET (AeroDataBox BASIC: 600 units/maand, 2400 requests, 1 req/seconde)
 *   Tier 1 = 1 unit, Tier 2 = 2, Tier 3 = 6, Tier 4 = 60.
 *   collect-adb wekelijks:   circa 355 units
 *   banen (eenmalig):        82 units, daarna 0
 *   registraties:            circa 20 units per maand
 *   deze rotatie:            25 nummers x 2 units x 4,33 runs = circa 216
 *   Samen na de eerste maand: circa 590 van 600. Zet ENRICH_FLIGHTS lager als
 *   je meer marge wilt.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const LOG = (...a) => console.log("[enrich]", ...a);

const KEY = process.env.RAPIDAPI_KEY;
if (!KEY) { LOG("geen RAPIDAPI_KEY - verrijking overgeslagen"); process.exit(0); }

const HOST = "aerodatabox.p.rapidapi.com";
const H = { "X-RapidAPI-Key": KEY, "X-RapidAPI-Host": HOST };

const CAP = Number(process.env.ENRICH_UNIT_CAP ?? 60);
const FORCE = String(process.env.FORCE_REFRESH ?? "").toLowerCase() === "true";
const N_FLIGHTS = Number(process.env.ENRICH_FLIGHTS ?? 25);
const DO_RUNWAYS = String(process.env.ENRICH_RUNWAYS ?? "true").toLowerCase() !== "false";

let spent = 0, stopped = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const load = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const iso = d => d.toISOString().slice(0, 10);

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
if (!CFG?.airports?.length) { LOG("config/collection.json onbruikbaar of leeg"); process.exit(1); }
mkdirSync("data", { recursive: true });

// Controle van je config, zodat je in de log ziet of het goed staat.
const MBS = CFG.settings?.missed_before_suspend;
LOG(`config: ${CFG.airports.length} velden, missed_before_suspend = ${MBS ?? "niet gezet (script gebruikt 3)"}`);
if (MBS === undefined) LOG("WAARSCHUWING: zet settings.missed_before_suspend op 6, anders schorst RouteWatch routes te snel door de roterende vensters");
else if (MBS < 6) LOG(`WAARSCHUWING: missed_before_suspend staat op ${MBS}. Met roterende vensters is 6 of hoger nodig.`);
if (CFG.settings?.watch_flights) LOG(`let op: settings.watch_flights staat nog in je config maar wordt door v2 genegeerd - de selectie gaat nu automatisch`);

/* ============================== 1. BAANGEGEVENS + METADATA (Tier 1) ======= */

const META = load("data/airports-meta.json", {});
let metaNew = 0;

if (DO_RUNWAYS) {
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
      // INDICATIE op baanlengte alleen. Gewicht, hoogte, temperatuur en
      // baanconditie zijn niet meegerekend.
      narrowbody_ok: longest ? longest >= 6500 : null,
      widebody_ok: longest ? longest >= 9000 : null,
      fetched: iso(new Date())
    };
    metaNew++;
    LOG(`${a.icao}: ${runways.length} banen, langste ${longest ?? "?"} ft (units ${spent}/${CAP})`);
  }
  writeFileSync("data/airports-meta.json", JSON.stringify(META, null, 1));
  LOG(`airports-meta.json: ${Object.keys(META).length} van ${CFG.airports.length} velden, ${metaNew} nieuw`);
}

/* ============================== 2. TOESTELLEN PER REGISTRATIE (Tier 1) ==== */

const LEDGER = load("data/ledger.json", {});
const ACM = load("data/aircraft-meta.json", {});

const regs = new Set();
for (const row of Object.values(LEDGER)) {
  for (const r of row?.regs ?? []) if (r) regs.add(String(r).toUpperCase());
}

let acNew = 0;
for (const reg of regs) {
  if (stopped) break;
  if (ACM[reg] !== undefined && !FORCE) continue;
  const j = await get(`https://${HOST}/aircrafts/reg/${encodeURIComponent(reg)}`, 1, `aircraft ${reg}`);
  if (j === null) break;
  const ac = Array.isArray(j) ? j[0] : j;
  ACM[reg] = ac ? {
    reg,
    model: ac?.model ?? null,
    typeCode: ac?.typeName ?? ac?.icaoCode ?? null,
    airline: ac?.airlineName ?? null,
    built: ac?.rolloutDate ?? ac?.firstFlightDate ?? null,
    fetched: iso(new Date())
  } : null;
  acNew++;
}
writeFileSync("data/aircraft-meta.json", JSON.stringify(ACM, null, 1));
LOG(`aircraft-meta.json: ${Object.keys(ACM).length} registraties, ${acNew} nieuw`);

/* ===================== 3. TYPEVERIFICATIE, AUTOMATISCH GESELECTEERD ======= */

/* Kandidaten uit de ledger, geprioriteerd. Elke ledgerregel heeft een sleutel
 * van de vorm "PAAR|airline|flight" en velden types, days en pair.
 * We kijken alleen naar echte vluchtnummers, niet naar de stand-ins met een *.
 */

function candidates() {
  const rows = [];
  for (const [key, r] of Object.entries(LEDGER)) {
    const fn = String(r?.flight ?? "").trim().toUpperCase();
    if (!fn || fn === "?" || fn.includes("*")) continue;      // stand-in of onbekend
    if (r?.state === "suspended") continue;
    const types = Object.keys(r?.types ?? {});
    rows.push({
      fn,
      pair: r?.pair ?? key.split("|")[0],
      days: Array.isArray(r?.days) ? r.days.length : 0,
      nTypes: types.length,
      prio: types.length > 1 ? 0 : (types.length === 0 ? 1 : 2)
    });
  }
  // dedupliceer op vluchtnummer, houd de regel met de meeste dagen
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.fn);
    if (!cur || r.days > cur.days || r.prio < cur.prio) best.set(r.fn, r);
  }
  return [...best.values()].sort((a, b) =>
    a.prio - b.prio || b.days - a.days || a.fn.localeCompare(b.fn));
}

const ALLCAND = candidates();
const TH = load("data/type-history.json", {});
const CUR = load("data/enrich-cursor.json", { index: 0, rounds: 0 });

const from = iso(new Date(Date.now() - 7 * 864e5));
const to = iso(new Date(Date.now() - 1 * 864e5));
const weekKey = `${from}_${to}`;

const mixed = ALLCAND.filter(c => c.prio === 0).length;
const unknown = ALLCAND.filter(c => c.prio === 1).length;
LOG(`kandidaten: ${ALLCAND.length} vluchtnummers (${mixed} gemengde vloot, ${unknown} zonder type)`);

if (!ALLCAND.length) {
  LOG("nog geen vluchtnummers in de ledger - draai eerst collect-adb en routewatch, dan vult dit zichzelf");
} else {
  let start = Number(CUR.index) || 0;
  if (start >= ALLCAND.length) { start = 0; CUR.rounds = (Number(CUR.rounds) || 0) + 1; }

  let done = 0, i = start, seen = 0;
  while (done < N_FLIGHTS && seen < ALLCAND.length && !stopped) {
    const c = ALLCAND[i % ALLCAND.length];
    i++; seen++;

    if (!TH[c.fn]) TH[c.fn] = {};
    if (TH[c.fn][weekKey] && !FORCE) continue;               // deze week al gedaan, 0 units

    const j = await get(`https://${HOST}/flights/number/${encodeURIComponent(c.fn)}/${from}/${to}`, 2, `flight ${c.fn}`);
    if (j === null) break;
    if (j === undefined) { done++; continue; }

    const legs = Array.isArray(j) ? j : (j?.flights ?? []);
    const byDay = {}, typeCount = {};
    for (const f of legs) {
      const day = String(f?.departure?.scheduledTime?.utc ?? f?.departure?.scheduledTimeUtc ?? "").slice(0, 10);
      const t = f?.aircraft?.model ?? f?.aircraft?.typeCode ?? null;
      if (day) byDay[day] = { type: t, reg: f?.aircraft?.reg ?? null };
      if (t) typeCount[t] = (typeCount[t] ?? 0) + 1;
    }
    const types = Object.keys(typeCount);
    TH[c.fn][weekKey] = {
      pair: c.pair,
      legs: legs.length,
      per_day: byDay,
      type_count: typeCount,
      mixed_fleet: types.length > 1,
      fetched: iso(new Date())
    };
    done++;
    LOG(`${c.fn} (${c.pair}): ${legs.length} legs, types ${types.join("/") || "?"}${types.length > 1 ? " - GEMENGDE VLOOT" : ""} (units ${spent}/${CAP})`);
  }

  CUR.index = i % ALLCAND.length;
  CUR.updated = new Date().toISOString();
  CUR.total_candidates = ALLCAND.length;
  writeFileSync("data/enrich-cursor.json", JSON.stringify(CUR, null, 1));
  LOG(`rotatie: ${done} nummers deze run, cursor staat nu op ${CUR.index}/${ALLCAND.length}, ronde ${CUR.rounds}`);
}

writeFileSync("data/type-history.json", JSON.stringify(TH, null, 1));
LOG(`type-history.json: ${Object.keys(TH).length} vluchtnummers in cache`);

/* ============================== samenvatting ============================= */

const mixedFound = Object.entries(TH)
  .filter(([, w]) => Object.values(w).some(x => x?.mixed_fleet))
  .map(([fn]) => fn);

const report = [
  `# Verrijking ${new Date().toISOString().slice(0, 16)}`,
  ``,
  `- velden met baangegevens: ${Object.keys(META).length} van ${CFG.airports.length} (${metaNew} nieuw)`,
  `- registraties in cache: ${Object.keys(ACM).length} (${acNew} nieuw)`,
  `- vluchtnummers in typehistorie: ${Object.keys(TH).length} van ${ALLCAND.length} kandidaten`,
  `- cursor: ${CUR.index ?? 0}/${ALLCAND.length}, volledige rondes: ${CUR.rounds ?? 0}`,
  `- verbruikte units deze run: ${spent} van plafond ${CAP}`,
  stopped ? `- LET OP: vroegtijdig gestopt om je quotum te beschermen` : `- volledig afgerond`,
  ``,
  `## Gemengde vloot vastgesteld (${mixedFound.length})`,
  mixedFound.length ? mixedFound.slice(0, 40).map(f => `- ${f}`).join("\n") : `- nog geen`,
  ``,
  `Deze vluchtnummers wisselen binnen een week van toesteltype. Dat is precies de`,
  `categorie die in je inventarisatie als "per datum te bevestigen" staat.`
].join("\n");
writeFileSync("data/last-enrich.md", report + "\n");

LOG(`klaar: ${spent} units verbruikt`);
