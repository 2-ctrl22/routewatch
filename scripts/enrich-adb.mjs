#!/usr/bin/env node
/**
 * enrich-adb.mjs v3 - verrijking bovenop RouteWatch, budgetbewust
 *
 * Raakt routewatch.mjs NIET aan. Schrijft:
 *   data/airports-meta.json   baangegevens per veld            (Tier 1, 2 units/veld)
 *   data/aircraft-meta.json   toestel per registratie          (Tier 1, 1 unit)
 *   data/type-history.json    7 dagen typegebruik per vluchtnr (Tier 2, 2 units)
 *   data/enrich-cursor.json   waar de rotatie is gebleven
 *   data/last-enrich.md       samenvatting per run
 *
 * ---------------------------------------------------------------- FIX v3 ---
 * PROBLEEM 1: een 429 in de banensectie zette een globale vlag, waardoor de
 *   vluchtnummer-sectie in dezelfde run helemaal werd overgeslagen. Zichtbaar
 *   als "rotatie: 0 nummers deze run" terwijl er 2453 kandidaten waren.
 *   NU: elke sectie heeft zijn eigen vlag. Alleen een 403 of een leeg quotum
 *   stopt de hele run.
 *
 * PROBLEEM 2: de 429 kwam al na 2 tot 3 aanroepen ondanks pauzes van 2,7 s.
 *   RapidAPI meet strenger dan 1 verzoek per seconde suggereert.
 *   NU: pauze 3000 ms, en bij een 429 twee pogingen met 45 en 90 seconden wacht.
 *
 * PROBLEEM 3: 2453 unieke vluchtnummers x 25 per week is bijna twee jaar voor
 *   een volledige ronde. Dat is geen dedup-fout, er zijn echt zoveel nummers.
 *   NU: strakke prioritering, want alleen deze gevallen veranderen je matchstatus:
 *     prio 0  meer dan 1 type gezien        -> "per datum te bevestigen"
 *     prio 1  geen type bekend              -> matchStatus() geeft ONBEKEND
 *     prio 2  NEAR-MATCH regel              -> kan bij een ander type MATCH worden
 *     prio 3  de rest, drukste eerst        -> laagste waarde, komt zelden aan bod
 *   De log meldt hoeveel weken een volledige ronde per prioriteit kost.
 *
 * BUDGET (AeroDataBox BASIC: 600 units/maand, 2400 requests, Tier 1=1, Tier 2=2)
 *   collect-adb wekelijks 82, banen eenmalig 82, rotatie 25 x 2 = 50 per week.
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
const SLEEP_MS = Number(process.env.ENRICH_SLEEP_MS ?? 3000);
const BACKOFFS = [45000, 90000];

let spent = 0;
let hardStop = false;             // 403 of unitplafond: hele run stopt
const sleep = ms => new Promise(r => setTimeout(r, ms));
const load = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const iso = d => d.toISOString().slice(0, 10);

/* Retourwaarden van get():
 *   object     gelukt
 *   undefined  overslaan (404 of andere fout), sectie mag doorgaan
 *   null       deze sectie stoppen (429 na alle pogingen)
 *   false      hele run stoppen (403 of plafond)
 */
async function get(url, units, label) {
  if (hardStop) return false;
  if (spent + units > CAP) {
    LOG(`unitplafond ${CAP} bereikt na ${spent} units - ${label} en de rest overgeslagen`);
    hardStop = true;
    return false;
  }
  for (let attempt = 0; attempt <= BACKOFFS.length; attempt++) {
    try {
      const res = await fetch(url, { headers: H });
      if (attempt === 0) spent += units;
      if (res.status === 429) {
        if (attempt < BACKOFFS.length) {
          const w = BACKOFFS[attempt];
          LOG(`${label}: 429 - ${Math.round(w / 1000)}s wachten, poging ${attempt + 2}`);
          await sleep(w);
          continue;
        }
        LOG(`${label}: 429 blijft - deze sectie stopt, andere secties gaan door`);
        return null;
      }
      if (res.status === 403) { LOG(`${label}: 403 - sleutel niet geabonneerd, hele run stopt`); hardStop = true; return false; }
      if (res.status === 404) { LOG(`${label}: 404 - niet gevonden of endpointvorm klopt niet`); return undefined; }
      if (!res.ok) { LOG(`${label}: HTTP ${res.status}`); return undefined; }
      return await res.json();
    } catch (e) {
      LOG(`${label} error:`, e.message);
      return undefined;
    } finally {
      await sleep(SLEEP_MS);
    }
  }
  return null;
}

const CFG = load("config/collection.json", null);
if (!CFG?.airports?.length) { LOG("config/collection.json onbruikbaar of leeg"); process.exit(1); }
mkdirSync("data", { recursive: true });

const MBS = CFG.settings?.missed_before_suspend;
LOG(`config: ${CFG.airports.length} velden, missed_before_suspend = ${MBS ?? "niet gezet (script gebruikt 3)"}`);
if ((MBS ?? 3) < 6) LOG(`WAARSCHUWING: missed_before_suspend is ${MBS ?? 3}. Met roterende vensters is 6 of hoger nodig.`);

/* ============================== 1. BAANGEGEVENS (Tier 1) ================== */

const META = load("data/airports-meta.json", {});
let metaNew = 0, metaStopped = false;
const missing = CFG.airports.filter(a => !META[a.icao] || FORCE);

if (!DO_RUNWAYS) {
  LOG("banensectie staat uit (ENRICH_RUNWAYS=false)");
} else if (!missing.length) {
  LOG(`banensectie: alle ${CFG.airports.length} velden zitten al in de cache, 0 units`);
} else {
  LOG(`banensectie: nog ${missing.length} van ${CFG.airports.length} velden te doen`);
  for (const a of missing) {
    if (hardStop || metaStopped) break;
    const info = await get(`https://${HOST}/airports/icao/${a.icao}`, 1, `airport ${a.icao}`);
    if (info === false) break;
    if (info === null) { metaStopped = true; break; }
    const rw = await get(`https://${HOST}/airports/icao/${a.icao}/runways`, 1, `runways ${a.icao}`);
    if (rw === false) break;
    if (rw === null) { metaStopped = true; break; }

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
  LOG(`airports-meta.json: ${Object.keys(META).length} van ${CFG.airports.length} velden, ${metaNew} nieuw` +
      (metaStopped ? " (sectie gestopt op 429)" : ""));
}

/* ============================== 2. REGISTRATIES (Tier 1) ================== */

const LEDGER = load("data/ledger.json", {});
const ACM = load("data/aircraft-meta.json", {});
const regs = new Set();
for (const row of Object.values(LEDGER)) {
  for (const r of row?.regs ?? []) if (r) regs.add(String(r).toUpperCase());
}

let acNew = 0, acStopped = false;
for (const reg of regs) {
  if (hardStop || acStopped) break;
  if (ACM[reg] !== undefined && !FORCE) continue;
  const j = await get(`https://${HOST}/aircrafts/reg/${encodeURIComponent(reg)}`, 1, `aircraft ${reg}`);
  if (j === false) break;
  if (j === null) { acStopped = true; break; }
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
LOG(`aircraft-meta.json: ${Object.keys(ACM).length} registraties, ${acNew} nieuw` +
    (regs.size ? "" : " (geen registraties in de ledger)"));

/* ============ 3. TYPEVERIFICATIE, GEPRIORITEERD EN ROTEREND (Tier 2) ===== */

/* Alleen deze gevallen veranderen je matchstatus, dus die gaan voor:
 *   0  meer dan 1 type gezien   -> per datum te bevestigen
 *   1  geen type bekend         -> ONBEKEND in de matrix
 *   2  NEAR-MATCH               -> kan op een andere dag MATCH zijn
 *   3  de rest                  -> alleen als er ruimte is
 */
function candidates() {
  const best = new Map();
  for (const [key, r] of Object.entries(LEDGER)) {
    const fn = String(r?.flight ?? "").trim().toUpperCase();
    if (!fn || fn === "?" || fn.includes("*")) continue;
    if (r?.state === "suspended") continue;
    const types = Object.keys(r?.types ?? {});
    const st = String(r?.status ?? "");
    const prio = types.length > 1 ? 0
               : types.length === 0 ? 1
               : /NEAR/.test(st) ? 2 : 3;
    const row = {
      fn,
      pair: r?.pair ?? String(key).split("|")[0],
      days: Array.isArray(r?.days) ? r.days.length : 0,
      prio
    };
    const cur = best.get(fn);
    if (!cur || row.prio < cur.prio || (row.prio === cur.prio && row.days > cur.days)) best.set(fn, row);
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

const byPrio = [0, 1, 2, 3].map(p => ALLCAND.filter(c => c.prio === p).length);
LOG(`kandidaten: ${ALLCAND.length} unieke vluchtnummers ` +
    `(gemengde vloot ${byPrio[0]}, zonder type ${byPrio[1]}, near-match ${byPrio[2]}, overig ${byPrio[3]})`);
if (N_FLIGHTS > 0) {
  const urgent = byPrio[0] + byPrio[1] + byPrio[2];
  LOG(`bij ${N_FLIGHTS} per week: urgente groep rond in ${Math.ceil(urgent / N_FLIGHTS)} weken, ` +
      `alles in ${Math.ceil(ALLCAND.length / N_FLIGHTS)} weken`);
}

let thNew = 0, thStopped = false;
if (!ALLCAND.length) {
  LOG("nog geen vluchtnummers in de ledger - draai eerst collect-adb en routewatch");
} else {
  let i = Number(CUR.index) || 0;
  if (i >= ALLCAND.length) { i = 0; CUR.rounds = (Number(CUR.rounds) || 0) + 1; }
  let seen = 0;

  while (thNew < N_FLIGHTS && seen < ALLCAND.length && !hardStop && !thStopped) {
    const c = ALLCAND[i % ALLCAND.length];
    i++; seen++;

    if (!TH[c.fn]) TH[c.fn] = {};
    if (TH[c.fn][weekKey] && !FORCE) continue;          // deze week al gedaan, 0 units

    const j = await get(`https://${HOST}/flights/number/${encodeURIComponent(c.fn)}/${from}/${to}`, 2, `flight ${c.fn}`);
    if (j === false) break;
    if (j === null) { thStopped = true; break; }
    if (j === undefined) { thNew++; continue; }         // 404: geteld, anders blijven we hangen

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
      pair: c.pair, prio: c.prio, legs: legs.length,
      per_day: byDay, type_count: typeCount,
      mixed_fleet: types.length > 1,
      fetched: iso(new Date())
    };
    thNew++;
    LOG(`${c.fn} (${c.pair}, prio ${c.prio}): ${legs.length} legs, types ${types.join("/") || "?"}` +
        `${types.length > 1 ? " - GEMENGDE VLOOT" : ""} (units ${spent}/${CAP})`);
  }

  CUR.index = i % ALLCAND.length;
  CUR.updated = new Date().toISOString();
  CUR.total_candidates = ALLCAND.length;
  writeFileSync("data/enrich-cursor.json", JSON.stringify(CUR, null, 1));
  LOG(`rotatie: ${thNew} nummers deze run, cursor ${CUR.index}/${ALLCAND.length}, ronde ${CUR.rounds}` +
      (thStopped ? " (sectie gestopt op 429)" : ""));
}
writeFileSync("data/type-history.json", JSON.stringify(TH, null, 1));

/* ============================== samenvatting ============================= */

const mixedFound = Object.entries(TH)
  .filter(([, w]) => Object.values(w).some(x => x?.mixed_fleet))
  .map(([fn]) => fn);

const report = [
  `# Enrichment ${new Date().toISOString().slice(0, 16)}`,
  ``,
  `- runway data: ${Object.keys(META).length} of ${CFG.airports.length} airports (${metaNew} new)${metaStopped ? " - section hit 429" : ""}`,
  `- aircraft registrations cached: ${Object.keys(ACM).length} (${acNew} new)`,
  `- flight numbers in type history: ${Object.keys(TH).length} of ${ALLCAND.length} candidates`,
  `- rotation cursor: ${CUR.index ?? 0}/${ALLCAND.length}, full rounds: ${CUR.rounds ?? 0}`,
  `- API units used this run: ${spent} of cap ${CAP}`,
  hardStop ? `- NOTE: run stopped early to protect your quota` : `- completed`,
  ``,
  `## Mixed fleet confirmed (${mixedFound.length})`,
  mixedFound.length ? mixedFound.slice(0, 40).map(f => `- ${f}`).join("\n") : `- none yet`,
  ``,
  `These flight numbers switch aircraft type within one week. That is exactly the`,
  `category your inventory marks as "to be confirmed per date".`
].join("\n");
writeFileSync("data/last-enrich.md", report + "\n");

LOG(`klaar: ${spent} units verbruikt`);
