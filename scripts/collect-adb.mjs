#!/usr/bin/env node
/**
 * collect-adb.mjs - budgetbewuste collector voor RouteWatch
 *
 * Raakt routewatch.mjs NIET aan. Schrijft CSV's in de vorm die de bestaande
 * manual()-provider al leest:
 *     data/manual/{ICAO}_{JJJJ-MM-DD}.csv
 *     arr_icao,airline,flight_no,std,type_raw,cargo
 *
 * ------------------------------------------------------------------ FIX v2 --
 * WAT ER MIS WAS: de URL zet withLeg=true. De documentatie zegt daarover:
 *   "Movement property will be replaced with Departure and Arrival properties"
 * Deze code las f.movement.airport.icao, dat bestaat dan niet, dus elke
 * bestemming werd undefined en viel buiten de collectie. Resultaat: 527
 * vertrekken gevonden op EHAM en 0 bruikbare regels.
 *
 * NU: eerst arrival.airport, dan movement.airport als terugval. Werkt dus met
 * en zonder withLeg. Bovendien wordt een IATA-code herkend en via de config
 * naar ICAO vertaald, zodat AMS ook EHAM oplevert.
 *
 * OOK NIEUW: 429-backoff. Bij de vorige run kwam de snelheidslimiet al na 9
 * aanroepen langs terwijl de pauzes 1,3 tot 2,8 seconden waren. De pauze staat
 * nu op 2.500 ms en bij een 429 wacht het script 60 seconden en probeert het
 * eenmaal opnieuw voordat het stopt.
 *
 * BUDGET (AeroDataBox BASIC: 600 units/maand, 2400 requests, 1 req/seconde)
 *   Tier 1 = 1 unit, Tier 2 = 2, Tier 3 = 6, Tier 4 = 60.
 *   41 velden x 2 units = 82 units per ronde, 1 ronde per week = circa 355/maand.
 *
 * DEKKING ZONDER BLINDE VLEKKEN
 *   Het FIDS-venster mag maximaal 12 uur zijn. In plaats van 2 aanroepen per dag
 *   doen we 1 aanroep en roteren we het venster per week:
 *     week 0: 06:00-18:00   week 1: 12:00-00:00
 *     week 2: 00:00-12:00   week 3: 18:00-06:00
 *   De gemeten dag schuift ook per week op, zodat alle 7 weekdagen langskomen.
 *   De ledger van routewatch.mjs is cumulatief, dus die deelmetingen vullen aan.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const LOG = (...a) => console.log("[collect-adb]", ...a);

const KEY = process.env.RAPIDAPI_KEY;
if (!KEY) {
  LOG("geen RAPIDAPI_KEY gezet - niets te doen, RouteWatch draait straks op bestaande CSV's");
  process.exit(0);
}

const HOST = "aerodatabox.p.rapidapi.com";
const UNITS_PER_CALL = Number(process.env.ADB_UNITS_PER_CALL ?? 2);
const UNIT_CAP = Number(process.env.ADB_UNIT_CAP ?? 110);
const DAYS = Math.max(1, Math.min(7, Number(process.env.BACKFILL_DAYS ?? 1)));
const OVERWRITE = String(process.env.ADB_OVERWRITE ?? "").toLowerCase() === "true";
const SLEEP_MS = Number(process.env.ADB_SLEEP_MS ?? 2500);
const BACKOFF_MS = Number(process.env.ADB_BACKOFF_MS ?? 60000);

let spent = 0;
let stopped = false;
let diagnosed = false;

/* ---------------------------------------------------------------- config --- */

let CFG;
try {
  CFG = JSON.parse(readFileSync("config/collection.json", "utf8"));
} catch (e) {
  LOG("kan config/collection.json niet lezen:", e.message);
  process.exit(1);
}

const AIRPORTS = (CFG.airports ?? []).map(a => a.icao).filter(Boolean);
const KNOWN = new Set(AIRPORTS);

// IATA -> ICAO, zodat AMS ook als EHAM wordt herkend.
const IATA2ICAO = {};
for (const a of CFG.airports ?? []) {
  if (a.iata && a.icao) IATA2ICAO[String(a.iata).toUpperCase()] = a.icao;
}

if (!AIRPORTS.length) {
  LOG("geen luchthavens in de config gevonden");
  process.exit(1);
}

/* ------------------------------------------------------------- rotatie ---- */

const EPOCH = Date.UTC(2026, 0, 5);                 // maandag 5 januari 2026
const weekIndex = Math.floor((Date.now() - EPOCH) / (7 * 864e5));
const WINDOWS = ["06:00", "12:00", "00:00", "18:00"];
const START = process.env.ADB_WINDOW || WINDOWS[((weekIndex % 4) + 4) % 4];
const DAY_SHIFT = ((weekIndex % 7) + 7) % 7;

const pad = n => String(n).padStart(2, "0");
const iso = d => d.toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function windowFor(day) {
  const h = Number(START.slice(0, 2));
  const m = Number(START.slice(3, 5));
  return {
    from: `${day}T${pad(h)}:${pad(m)}`,
    to: `${day}T${pad((h + 12) % 24)}:${pad(m)}`
  };
}

/* ------------------------------------------------------------------ csv --- */

const HEADER = "arr_icao,airline,flight_no,std,type_raw,cargo";
const clean = v => String(v ?? "").replace(/[,\r\n]/g, " ").trim();

function writeCsv(icao, day, rows) {
  mkdirSync("data/manual", { recursive: true });
  const path = `data/manual/${icao}_${day}.csv`;
  const body = rows.map(r =>
    [clean(r.arr), clean(r.airline), clean(r.flight), clean(r.std), clean(r.type), r.cargo ? 1 : 0].join(",")
  );
  writeFileSync(path, [HEADER, ...body].join("\n") + "\n");
  LOG(`geschreven ${path}: ${rows.length} regels`);
}

/* --------------------------------------------------------- bestemming ----- */

/* Met withLeg=true heet het blok arrival; zonder withLeg heet het movement.
 * Beide worden geprobeerd, en zowel ICAO als IATA wordt herkend.
 */
function destOf(f) {
  const ap = f?.arrival?.airport ?? f?.movement?.airport ?? null;
  if (!ap) return null;
  const icao = String(ap.icao ?? "").toUpperCase();
  if (icao && KNOWN.has(icao)) return icao;
  const iata = String(ap.iata ?? "").toUpperCase();
  if (iata && IATA2ICAO[iata]) return IATA2ICAO[iata];
  return null;
}

function stdOf(f) {
  const dep = f?.departure ?? f?.movement ?? {};
  const t = dep?.scheduledTime?.local ?? dep?.scheduledTimeLocal ?? dep?.scheduledTime?.utc ?? "";
  const s = String(t);
  const m = s.match(/(\d{2}:\d{2})/);
  return m ? m[1] : "";
}

/* Eenmalige diagnose: welke sleutels zitten er echt in het antwoord?
 * Kost niets en voorkomt dat we ooit weer moeten gokken.
 */
function diagnose(f) {
  if (diagnosed || !f) return;
  diagnosed = true;
  LOG(`diagnose - sleutels per vlucht: ${Object.keys(f).join(", ")}`);
  const ap = f?.arrival?.airport ?? f?.movement?.airport;
  if (ap) LOG(`diagnose - sleutels bestemming: ${Object.keys(ap).join(", ")} | icao=${ap.icao ?? "-"} iata=${ap.iata ?? "-"}`);
  else LOG(`diagnose - GEEN arrival.airport en GEEN movement.airport gevonden`);
}

/* ------------------------------------------------------------- ophalen ---- */

async function fetchAirportDay(icao, day, retried = false) {
  if (stopped) return null;
  if (spent + UNITS_PER_CALL > UNIT_CAP) {
    LOG(`unitplafond ${UNIT_CAP} bereikt na ${spent} units - rest van de run overgeslagen`);
    stopped = true;
    return null;
  }

  const { from, to } = windowFor(day);
  const url = `https://${HOST}/flights/airports/icao/${icao}/${from}/${to}`
    + "?withLeg=true&direction=Departure&withCancelled=false&withCodeshared=false&withCargo=true&withPrivate=false";

  try {
    const res = await fetch(url, { headers: { "X-RapidAPI-Key": KEY, "X-RapidAPI-Host": HOST } });
    spent += UNITS_PER_CALL;

    if (res.status === 429) {
      if (!retried) {
        LOG(`${icao} ${day}: 429 - even ${Math.round(BACKOFF_MS / 1000)}s wachten en eenmaal opnieuw proberen`);
        await sleep(BACKOFF_MS);
        return fetchAirportDay(icao, day, true);
      }
      LOG(`${icao} ${day}: 429 na de tweede poging - quotum of snelheidslimiet, stop deze run`);
      stopped = true;
      return null;
    }
    if (res.status === 403) { LOG(`${icao} ${day}: 403 - sleutel niet geabonneerd op dit plan, stop`); stopped = true; return null; }
    if (res.status === 404) { LOG(`${icao} ${day}: 404 - geen data in dit venster`); return []; }
    if (!res.ok) { LOG(`${icao} ${day}: HTTP ${res.status}`); return []; }

    const j = await res.json();
    const deps = j.departures ?? [];
    diagnose(deps[0]);

    const rows = [];
    for (const f of deps) {
      const arr = destOf(f);
      if (!arr || arr === icao) continue;                 // alleen paren binnen je collectie
      rows.push({
        arr,
        airline: f?.airline?.iata ?? f?.airline?.icao ?? f?.airline?.name ?? "?",
        flight: String(f?.number ?? "").replace(/\s/g, "") || "?",
        std: stdOf(f),
        type: f?.aircraft?.model ?? f?.aircraft?.typeCode ?? "",
        cargo: String(f?.isCargo ?? "").toLowerCase() === "true" ? 1 : 0
      });
    }
    LOG(`${icao} ${day} ${START}+12u: ${deps.length} vertrekken, ${rows.length} binnen je collectie (units ${spent}/${UNIT_CAP})`);
    return rows;
  } catch (e) {
    LOG(`${icao} ${day} error:`, e.message);
    return [];
  }
}

/* --------------------------------------------------------------- hoofdlus - */

LOG(`ronde ${weekIndex}: venster ${START}+12u, dagverschuiving ${DAY_SHIFT}, ${DAYS} dag(en), ${AIRPORTS.length} velden`);
LOG(`plafond ${UNIT_CAP} units, ${UNITS_PER_CALL} per aanroep, pauze ${SLEEP_MS} ms, dus maximaal ${Math.floor(UNIT_CAP / UNITS_PER_CALL)} aanroepen deze run`);

let written = 0, skipped = 0, totalRows = 0;

outer:
for (let d = 1; d <= DAYS; d++) {
  const day = iso(new Date(Date.now() - (d + DAY_SHIFT) * 864e5));
  for (const icao of AIRPORTS) {
    if (stopped) break outer;
    const path = `data/manual/${icao}_${day}.csv`;
    if (existsSync(path) && !OVERWRITE) { skipped++; continue; }
    const rows = await fetchAirportDay(icao, day);
    if (rows === null) break outer;
    if (rows.length) { writeCsv(icao, day, rows); written++; totalRows += rows.length; }
    await sleep(SLEEP_MS);
  }
}

LOG(`klaar: ${written} CSV's met ${totalRows} regels, ${skipped} overgeslagen omdat ze al bestonden, ${spent} units verbruikt`);
if (stopped) LOG("let op: de run is vroegtijdig gestopt om je quotum te beschermen");
if (!written && !skipped) LOG("nul CSV's: kijk naar de diagnoseregel hierboven om te zien hoe de bestemming heet in het antwoord");
