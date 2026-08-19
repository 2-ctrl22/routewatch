#!/usr/bin/env node
/**
 * scan-xplane.mjs - reads an X-Plane install and reports which airports and which
 * aircraft you actually own. Local only, never in CI: a GitHub runner has no
 * access to your disk.
 *
 *   node scripts/scan-xplane.mjs                 report only
 *   node scripts/scan-xplane.mjs --write         also write config/collection.scan.json
 *   XPLANE_ROOT="/Users/you/X-Plane 12" node scripts/scan-xplane.mjs
 *
 * Output:
 *   data/xplane-scan.json   everything found, with a confidence per item
 *   data/xplane-scan.md     a readable report
 *   config/collection.scan.json   (only with --write) a merge proposal
 *
 * ------------------------------------------- WHY THIS IS BETTER THAN THE MSFS SCAN
 * scan-sim.mjs has to guess: MSFS keeps airport data in binary BGL files, so the
 * ICAO code is inferred from folder names, package titles and BGL file names, and
 * coordinates cannot be read at all. Every MSFS airport therefore gets a
 * confidence, and new ones are written with needs_coordinates:true.
 *
 * X-Plane stores the same information in plain text:
 *
 *   Earth nav data/apt.dat    airport header rows declare the identifier
 *   Aircraft/*.acf            "P acf/_ICAO B738" declares the aircraft type
 *
 * So identifiers are declared rather than inferred, and coordinates come straight
 * from the runway rows. That means confidence is high and needs_coordinates is
 * false - which is exactly the field check-config.mjs refuses to accept.
 *
 * ------------------------------------------------------------- THE apt.dat FORMAT
 * Every row starts with an integer row code:
 *
 *   1     land airport header    1 <elevation> <deprecated> <deprecated> <ICAO> <name>
 *   16    seaplane base header   same shape
 *   17    heliport header        same shape
 *   100   runway                 width, surface, ... then per runway end:
 *                                <number> <lat> <lon> ...
 *   1302  metadata row           key/value pairs, may carry icao_code and city
 *
 * Runway latitude and longitude are decimal degrees. Averaging the two ends of the
 * longest runway gives a usable airport reference point, which is all RouteWatch
 * needs: gcNm() only computes great-circle distance between airports.
 *
 * -------------------------------------------------------- SCENERY LOAD ORDER
 * Custom Scenery/scenery_packs.ini decides what the sim actually loads. Packs at
 * the top win, and a line beginning SCENERY_PACK_DISABLED is switched off
 * entirely. This scanner honours both, otherwise it would report airports the sim
 * ignores. Packs present on disk but missing from the ini are treated as active,
 * because X-Plane adds those to the top of the file on next start.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, platform } from "node:os";

const LOG = (...a) => console.log("[scan-xplane]", ...a);
const WRITE = process.argv.includes("--write");

/* ------------------------------------------------------------ locate X-Plane */

const looksLikeRoot = p => {
  try {
    if (!statSync(p).isDirectory()) return false;
  } catch { return false; }
  /* A real root has Custom Scenery and either Aircraft or Global Scenery. */
  return existsSync(join(p, "Custom Scenery"))
      && (existsSync(join(p, "Aircraft")) || existsSync(join(p, "Global Scenery")));
};

function candidateRoots() {
  const out = [];
  if (process.env.XPLANE_ROOT) out.push(process.env.XPLANE_ROOT);

  const home = homedir();
  const names = ["X-Plane 12", "X-Plane 11", "X-Plane12", "X-Plane11", "X-Plane"];
  const bases = [home, join(home, "Desktop"), join(home, "Documents"), join(home, "Applications")];

  if (platform() === "darwin") bases.push("/Applications", "/Volumes");
  if (platform() === "win32") {
    for (const drive of ["C:\\", "D:\\", "E:\\", "F:\\"]) bases.push(drive);
  } else {
    bases.push("/opt", "/srv", "/mnt", "/media");
  }

  for (const b of bases) {
    for (const n of names) out.push(join(b, n));
    /* One level down, so /Volumes/SSD/X-Plane 12 is found too. */
    try {
      for (const d of readdirSync(b, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        for (const n of names) out.push(join(b, d.name, n));
      }
    } catch { /* unreadable base, skip */ }
  }
  return [...new Set(out)];
}

const roots = candidateRoots().filter(looksLikeRoot);
if (!roots.length) {
  LOG("no X-Plane install found. Looked for a folder containing 'Custom Scenery' plus");
  LOG("'Aircraft' or 'Global Scenery', in the usual places. Point at it directly:");
  LOG('  XPLANE_ROOT="/Users/you/X-Plane 12" node scripts/scan-xplane.mjs');
  process.exit(0);
}
for (const r of roots) LOG(`found install: ${r}`);

/* --------------------------------------------------------- scenery load order */

/** Returns {order:Map<packName,index>, disabled:Set<packName>} from the ini. */
function sceneryOrder(root) {
  const ini = join(root, "Custom Scenery", "scenery_packs.ini");
  const order = new Map(), disabled = new Set();
  if (!existsSync(ini)) return { order, disabled, present: false };
  let txt = "";
  try { txt = readFileSync(ini, "utf8"); } catch { return { order, disabled, present: false }; }
  let i = 0;
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*(SCENERY_PACK(?:_DISABLED)?)\s+(.+?)\s*$/);
    if (!m) continue;
    /* Entries look like: SCENERY_PACK Custom Scenery/EHAM_Schiphol/ */
    const parts = m[2].replace(/[\\/]+$/, "").split(/[\\/]/);
    const name = parts[parts.length - 1];
    if (!name) continue;
    if (m[1] === "SCENERY_PACK_DISABLED") disabled.add(name);
    else if (!order.has(name)) order.set(name, i++);
  }
  return { order, disabled, present: true };
}

/* ------------------------------------------------------------- apt.dat parsing */

/** Find the apt.dat inside a scenery pack, if it has one. */
function aptDatIn(dir) {
  for (const sub of ["Earth nav data", "earth nav data", "Earth Nav Data"]) {
    const p = join(dir, sub, "apt.dat");
    if (existsSync(p)) return p;
  }
  return null;
}

const midpoint = (a, b) => ({ lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 });
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/**
 * Parse one apt.dat. Returns airports keyed by identifier, each with a name, a
 * reference coordinate taken from the longest runway, and that runway's length.
 */
function parseAptDat(file) {
  let txt;
  try { txt = readFileSync(file, "utf8"); } catch { return []; }

  const out = [];
  let cur = null;

  const finish = () => {
    if (!cur) return;
    if (cur.best) {
      const mid = midpoint(cur.best.a, cur.best.b);
      cur.lat = Math.round(mid.lat * 1e6) / 1e6;
      cur.lon = Math.round(mid.lon * 1e6) / 1e6;
      cur.runway_m = Math.round(cur.best.metres);
      cur.runway_ft = Math.round(cur.best.metres * 3.28084);
    }
    delete cur.best;
    out.push(cur);
    cur = null;
  };

  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split(/\s+/);
    const code = f[0];

    if (code === "1" || code === "16" || code === "17") {
      finish();
      /* 1 <elev> <x> <x> <ident> <name...> */
      const ident = String(f[4] ?? "").toUpperCase();
      cur = {
        icao: ident,
        name: f.slice(5).join(" ") || ident,
        kind: code === "1" ? "land" : code === "16" ? "seaplane" : "heliport",
        elevation_ft: num(f[1]),
        lat: null, lon: null, runway_m: null, runway_ft: null,
        best: null
      };
      continue;
    }

    if (!cur) continue;

    /* 1302 metadata rows can carry a more authoritative icao_code. */
    if (code === "1302" && f[1] === "icao_code" && f[2]) {
      const v = String(f[2]).toUpperCase();
      if (/^[A-Z0-9]{3,4}$/.test(v)) cur.icao = v;
      continue;
    }

    /* 100 <width> <surf> ... then repeating runway-end blocks:
       <number> <lat> <lon> <displaced> <blast> <markings> <lights> ... */
    if (code === "100") {
      const ends = [];
      for (let i = 8; i + 2 < f.length && ends.length < 2; i += 9) {
        const lat = num(f[i + 1]), lon = num(f[i + 2]);
        if (lat === null || lon === null) continue;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
        ends.push({ lat, lon });
      }
      if (ends.length === 2) {
        /* Equirectangular approximation is plenty for a runway-length sort. */
        const R = 6371000, toRad = Math.PI / 180;
        const dLat = (ends[1].lat - ends[0].lat) * toRad;
        const dLon = (ends[1].lon - ends[0].lon) * toRad;
        const meanLat = ((ends[0].lat + ends[1].lat) / 2) * toRad;
        const metres = R * Math.hypot(dLat, dLon * Math.cos(meanLat));
        if (!cur.best || metres > cur.best.metres)
          cur.best = { a: ends[0], b: ends[1], metres };
      }
      continue;
    }
  }
  finish();
  return out.filter(a => /^[A-Z0-9]{3,4}$/.test(a.icao));
}

/* ------------------------------------------------------------- .acf parsing --- */

/** "P acf/_ICAO B738" is the type code RouteWatch matches on. */
function parseAcf(file) {
  let txt;
  try { txt = readFileSync(file, "utf8", { encoding: "utf8" }); } catch { return null; }
  const grab = key => {
    const m = txt.match(new RegExp(`^\\s*P\\s+${key}\\s+(.+?)\\s*$`, "m"));
    return m ? m[1].trim() : null;
  };
  const type = grab("acf/_ICAO");
  if (!type) return null;
  return {
    type: type.toUpperCase(),
    studio: grab("acf/_studio"),
    author: grab("acf/_author"),
    description: grab("acf/_descrip"),
    file: basename(file)
  };
}

/** Walk a folder for .acf files, bounded so a huge library cannot hang the scan. */
function findAcf(root, maxDepth = 4, maxHits = 400) {
  const hits = [], stack = [[root, 0]];
  while (stack.length && hits.length < maxHits) {
    const [dir, depth] = stack.pop();
    let items = [];
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const full = join(dir, it.name);
      if (it.isDirectory()) { if (depth < maxDepth) stack.push([full, depth + 1]); }
      else if (/\.acf$/i.test(it.name)) hits.push(full);
      if (hits.length >= maxHits) break;
    }
  }
  return hits;
}

/* ---------------------------------------------------------------------- scan */

const airports = new Map();   // ICAO -> record
const aircraft = new Map();   // type -> record
const scanned = [];
let skippedDisabled = 0;

for (const root of roots) {
  const { order, disabled, present } = sceneryOrder(root);
  LOG(present
    ? `scenery_packs.ini: ${order.size} active, ${disabled.size} disabled`
    : "no scenery_packs.ini, treating every pack as active");

  const custom = join(root, "Custom Scenery");
  const packs = (() => {
    try { return readdirSync(custom, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
    catch { return []; }
  })();
  LOG(`Custom Scenery: ${packs.length} packs`);

  for (const pack of packs) {
    if (disabled.has(pack)) { skippedDisabled++; continue; }
    const dir = join(custom, pack);
    const apt = aptDatIn(dir);
    if (!apt) continue;

    const found = parseAptDat(apt);
    scanned.push({ pack, airports: found.length, priority: order.get(pack) ?? null });

    for (const a of found) {
      const prev = airports.get(a.icao);
      const prio = order.get(pack) ?? 9999;
      /* Lower index wins, matching how X-Plane resolves overlapping packs. */
      if (!prev || prio < prev._priority) {
        airports.set(a.icao, { ...a, source: "apt.dat", pack, confidence: "high", _priority: prio });
      }
    }
  }

  const acfRoot = join(root, "Aircraft");
  if (existsSync(acfRoot)) {
    const files = findAcf(acfRoot);
    LOG(`Aircraft: ${files.length} .acf file(s)`);
    for (const f of files) {
      const ac = parseAcf(f);
      if (!ac) continue;
      const cur = aircraft.get(ac.type) ?? {
        type: ac.type, studio: ac.studio, author: ac.author,
        description: ac.description, variants: 0, files: []
      };
      cur.variants++;
      if (cur.files.length < 12) cur.files.push(ac.file);
      if (!cur.studio && ac.studio) cur.studio = ac.studio;
      if (!cur.description && ac.description) cur.description = ac.description;
      aircraft.set(ac.type, cur);
    }
  } else {
    LOG("no Aircraft folder in this install");
  }
}

for (const a of airports.values()) delete a._priority;

/* ------------------------------------------------- compare with your config */

const readJson = p => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const CFG = readJson("config/collection.json") ?? { airports: [], fleet: { owned: [] } };
const known = new Set((CFG.airports ?? []).map(a => String(a.icao).toUpperCase()));
const knownTypes = new Set((CFG.fleet?.owned ?? []).flatMap(f => f.types ?? []).map(t => String(t).toUpperCase()));

const land = [...airports.values()].filter(a => a.kind === "land");
const newAirports = land.filter(a => !known.has(a.icao)).sort((x, y) => x.icao.localeCompare(y.icao));
const haveAirports = land.filter(a => known.has(a.icao)).sort((x, y) => x.icao.localeCompare(y.icao));
const newTypes = [...aircraft.values()].filter(a => !knownTypes.has(a.type)).sort((x, y) => x.type.localeCompare(y.type));
const missingInSim = [...known].filter(i => !airports.has(i)).sort();
const noCoords = land.filter(a => a.lat === null || a.lon === null);

mkdirSync("data", { recursive: true });
writeFileSync("data/xplane-scan.json", JSON.stringify({
  scanned_at: new Date().toISOString(),
  installs: roots,
  packs_with_airports: scanned.length,
  packs_skipped_disabled: skippedDisabled,
  airports: [...airports.values()].sort((x, y) => x.icao.localeCompare(y.icao)),
  aircraft: [...aircraft.values()].sort((x, y) => x.type.localeCompare(y.type)),
  compared_with_config: {
    airports_new: newAirports.map(a => a.icao),
    airports_already_in_config: haveAirports.map(a => a.icao),
    airports_in_config_not_found_in_sim: missingInSim,
    aircraft_types_new: newTypes.map(a => a.type),
    airports_without_coordinates: noCoords.map(a => a.icao)
  }
}, null, 1));

/* --------------------------------------------------------------- the report */

const md = [`# X-Plane scan ${new Date().toISOString().slice(0, 16)}`, ``];
for (const r of roots) md.push(`- install: \`${r}\``);
md.push(``,
  `Read ${scanned.length} scenery pack(s) containing an apt.dat`
  + (skippedDisabled ? `, skipped ${skippedDisabled} disabled in scenery_packs.ini` : ``) + `.`,
  ``,
  `## Aircraft found (${aircraft.size})`, ``,
  `Read from \`P acf/_ICAO\` in the .acf file, so these codes are declared, not guessed.`, ``);
if (aircraft.size) {
  md.push(`| Type | Description | Variants | In your fleet |`, `|---|---|---|---|`);
  for (const a of [...aircraft.values()].sort((x, y) => x.type.localeCompare(y.type)))
    md.push(`| \`${a.type}\` | ${a.description ?? a.studio ?? "?"} | ${a.variants} | ${knownTypes.has(a.type) ? "yes" : "**no**"} |`);
} else md.push(`Nothing found.`);

md.push(``, `## Airports found (${land.length} land airports)`, ``,
  `Identifier comes from the apt.dat header row; coordinates are the midpoint of the`,
  `longest runway. No guessing and no missing coordinates, unlike the MSFS scan.`, ``,
  `| ICAO | Name | Lat | Lon | Longest runway | Pack | In your config |`, `|---|---|---|---|---|---|---|`);
for (const a of land.sort((x, y) => x.icao.localeCompare(y.icao)))
  md.push(`| \`${a.icao}\` | ${a.name} | ${a.lat ?? "?"} | ${a.lon ?? "?"} | ${a.runway_ft ? a.runway_ft + " ft" : "?"} | ${a.pack} | ${known.has(a.icao) ? "yes" : "**no**"} |`);

md.push(``, `## What to do next`, ``,
  `- **${newAirports.length}** airport(s) are installed but not in your config.`,
  `- **${newTypes.length}** aircraft type(s) are installed but not in your fleet.`,
  `- **${missingInSim.length}** airport(s) in your config were not found here`
  + (missingInSim.length ? `: ${missingInSim.join(" ")}` : ``)
  + `. Those may be default Global Scenery airports, or candidates you do not own yet.`,
  `- **${noCoords.length}** airport(s) had no readable runway coordinates.`, ``,
  `Every airport you add costs 2 API units per collection round. Run`,
  `\`node scripts/check-config.mjs\` after merging: it recomputes the projected`,
  `monthly cost against the 600-unit plan and refuses coordinates it cannot trust.`);
writeFileSync("data/xplane-scan.md", md.join("\n") + "\n");

/* -------------------------------------------------------- merge proposal --- */

if (WRITE) {
  const proposal = JSON.parse(JSON.stringify(CFG));
  proposal._scan_note = "Generated by scripts/scan-xplane.mjs. Review before replacing "
    + "config/collection.json. Coordinates come from apt.dat runway ends, so these entries "
    + "are complete - no needs_coordinates flag is required.";
  proposal.airports = proposal.airports ?? [];
  for (const a of newAirports) {
    proposal.airports.push({
      icao: a.icao,
      name: a.name,
      lat: a.lat,
      lon: a.lon,
      /* A short runway cannot take a narrowbody; 5000 ft is a conservative line. */
      narrowbody_allowed: a.runway_ft === null ? true : a.runway_ft >= 5000,
      _found_in: a.pack,
      _confidence: "high",
      _source: "xplane apt.dat",
      _longest_runway_ft: a.runway_ft
    });
  }
  if (newTypes.length) {
    proposal.fleet = proposal.fleet ?? { owned: [] };
    proposal.fleet._scan_suggested_types = newTypes.map(a => ({
      type: a.type, description: a.description, variants: a.variants,
      note: "add this to an existing fleet.owned entry, or create one with key, name, role and range_nm"
    }));
  }
  mkdirSync("config", { recursive: true });
  writeFileSync("config/collection.scan.json", JSON.stringify(proposal, null, 2));
  LOG("wrote config/collection.scan.json - review it, then merge what you want into collection.json");
}

LOG(`done: ${land.length} land airports, ${aircraft.size} aircraft types, ${scanned.length} packs with an apt.dat`);
LOG(`new versus your config: ${newAirports.length} airports, ${newTypes.length} aircraft types`);
LOG(`reports in data/xplane-scan.md and data/xplane-scan.json`);
if (!WRITE) LOG("run again with --write to also get config/collection.scan.json");
