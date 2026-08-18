#!/usr/bin/env node
/**
 * collect-adb.mjs - budgetbewuste collector voor RouteWatch
 *
 * Raakt routewatch.mjs NIET aan. Deze collector schrijft CSV's in de vorm die
 * de bestaande manual()-provider al leest:
 *     data/manual/{ICAO}_{JJJJ-MM-DD}.csv
 *     arr_icao,airline,flight_no,std,type_raw,cargo
 *
 * Doel: onder de 600 API-units per maand blijven op het gratis AeroDataBox
 * BASIC-plan, zonder blinde vlekken in de dekking.
 *
 * HOE HET BUDGET WERKT
 *   BASIC = 600 units/maand, 2400 requests/maand, 1 verzoek/seconde.
 *   Tier 1 = 1 unit, Tier 2 = 2, Tier 3 = 6, Tier 4 = 60.
 *   FIDS-aanroep (Tier 2) = 2 units. 41 velden x 2 = 82 units per ronde.
 *   1 ronde per week = circa 355 units per maand. Blijft 245 over als buffer.
 *
 * HOE DE DEKKING WERKT
 *   Het FIDS-endpoint staat maximaal 12 uur tussen begin en einde toe, dus een
 *   volle dag past niet in een aanroep. In plaats van 2 aanroepen per dag doen
 *   we 1 aanroep en roteren we het venster per week:
 *     week 0: 06:00-18:00   week 1: 12:00-00:00
 *     week 2: 00:00-12:00   week 3: 18:00-06:00
 *   Na vier rondes is de klok rond. De gemeten dag schuift ook per week op, zodat
 *   alle zeven weekdagen aan bod komen. De ledger van routewatch.mjs is
 *   cumulatief, dus die deelmetingen vullen elkaar aan.
 *
 * BELANGRIJK
 *   Zet settings.missed_before_suspend in config/collection.json op 6 of hoger.
 *   Met roterende vensters lijkt een ochtendroute anders drie rondes "verdwenen".
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

let spent = 0;
let stopped = false;

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
  const from = `${day}T${pad(h)}:${pad(m)}`;
  const to = `${day}T${pad((h + 12) % 24)}:${pad(m)}`;
  return { from, to };
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

/* ------------------------------------------------------------- ophalen ---- */

async function fetchAirportDay(icao, day) {
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

    if (res.status === 429) { LOG(`${icao} ${day}: 429 - quotum of snelheidslimiet bereikt, stop deze run`); stopped = true; return null; }
    if (res.status === 403) { LOG(`${icao} ${day}: 403 - sleutel niet geabonneerd op dit plan, stop`); stopped = true; return null; }
    if (res.status === 404) { LOG(`${icao} ${day}: 404 - geen data in dit venster`); return []; }
    if (!res.ok) { LOG(`${icao} ${day}: HTTP ${res.status}`); return []; }

    const j = await res.json();
    const deps = j.departures ?? [];
    const rows = [];
    for (const f of deps) {
      const arr = String(f?.movement?.airport?.icao ?? "").toUpperCase();
      if (!KNOWN.has(arr) || arr === icao) continue;      // alleen paren binnen je collectie
      rows.push({
        arr,
        airline: f?.airline?.iata ?? f?.airline?.icao ?? "?",
        flight: String(f?.number ?? "").replace(/\s/g, "") || "?",
        std: String(f?.departure?.scheduledTime?.local ?? "").slice(11, 16) || "",
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
LOG(`plafond ${UNIT_CAP} units, ${UNITS_PER_CALL} per aanroep, dus maximaal ${Math.floor(UNIT_CAP / UNITS_PER_CALL)} aanroepen deze run`);

let written = 0, skipped = 0;

outer:
for (let d = 1; d <= DAYS; d++) {
  const day = iso(new Date(Date.now() - (d + DAY_SHIFT) * 864e5));
  for (const icao of AIRPORTS) {
    if (stopped) break outer;
    const path = `data/manual/${icao}_${day}.csv`;
    if (existsSync(path) && !OVERWRITE) { skipped++; continue; }
    const rows = await fetchAirportDay(icao, day);
    if (rows === null) break outer;
    if (rows.length) { writeCsv(icao, day, rows); written++; }
    await sleep(1100);                                  // 1 verzoek per seconde
  }
}

LOG(`klaar: ${written} CSV's geschreven, ${skipped} overgeslagen omdat ze al bestonden, ${spent} units verbruikt`);
if (stopped) LOG("let op: de run is vroegtijdig gestopt om je quotum te beschermen");
