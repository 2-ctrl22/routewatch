#!/usr/bin/env node
// add-airport.mjs
//
// Self-service tool to add, promote, demote, remove or list airports in
// config/collection.json without hand-editing JSON. Zero dependencies:
// only node:fs and node:path. Node 20 baseline.
//
// Usage:
//   node scripts/add-airport.mjs --icao VTBS --name "Bangkok Suvarnabhumi" \
//     --iata BKK --country TH --lat 13.6811 --lon 100.7477 --narrowbody \
//     [--own | --candidate] [--template EHAM] [--focus pax] [--why "..."] \
//     [--dry-run]
//
//   node scripts/add-airport.mjs --list
//   node scripts/add-airport.mjs --promote EKCH        (candidate -> own)
//   node scripts/add-airport.mjs --demote LIMC --focus pax+cargo --why "..."
//   node scripts/add-airport.mjs --remove EDLV
//
// Schema contract (matches config/collection.json as of 2026-08-23):
//   - "own" airport  = object WITHOUT a "candidate" key.
//   - "candidate"    = object WITH "candidate": true, plus "focus", "why"
//                       and a "price_search" block with 7 shop URLs.
//   - narrowbody_allowed is a plain boolean per airport (own or candidate).
//   - needs_coordinates: true (written by scan-sim.mjs for MSFS proposals)
//     or non-finite / missing lat/lon airports are refused, mirroring the
//     coordinate guard in routewatch.mjs and check-config.mjs.

import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = path.resolve(process.cwd(), 'config/collection.json');
const UNIT_COST_PER_AIRPORT = 2; // per collection round
const MONTHLY_UNIT_CEILING = 600;

const SHOPS = ['fsaddoncompare', 'simmarket', 'contrail', 'orbx', 'inibuilds', 'aerosoft', 'justflight'];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config not found at ${CONFIG_PATH}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  try {
    return { data: JSON.parse(raw), raw };
  } catch (e) {
    console.error(`Config is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

function findAirportsArray(data) {
  // Generic walk, same spirit as editor.html: find the array of airport-like
  // objects rather than assuming a fixed path, so this keeps working if the
  // config shape changes.
  if (Array.isArray(data.airports) && data.airports.every((a) => a && typeof a === 'object' && 'icao' in a)) {
    return data.airports;
  }
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      if (node.length && node.every((a) => a && typeof a === 'object' && 'icao' in a && 'lat' in a)) {
        return node;
      }
      for (const item of node) if (item && typeof item === 'object') stack.push(item);
    } else if (node && typeof node === 'object') {
      for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

function isFiniteCoord(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function validCoords(lat, lon) {
  if (!isFiniteCoord(lat) || !isFiniteCoord(lon)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lon < -180 || lon > 180) return false;
  if (lat === 0 && lon === 0) return false;
  return true;
}

function isCandidate(ap) {
  return ap && ap.candidate === true;
}

function projection(airports) {
  const own = airports.filter((a) => !isCandidate(a));
  const cand = airports.filter(isCandidate);
  const units = airports.length * UNIT_COST_PER_AIRPORT;
  const pairs = (own.length * (own.length - 1)) / 2;
  return { ownCount: own.length, candCount: cand.length, units, pairs };
}

function printProjection(before, after) {
  console.error('');
  console.error('Projection:');
  console.error(`  own airports:   ${before.ownCount} -> ${after.ownCount}`);
  console.error(`  candidates:     ${before.candCount} -> ${after.candCount}`);
  console.error(`  own pairs:      ${before.pairs} -> ${after.pairs}`);
  console.error(`  collector cost: ${before.units} -> ${after.units} units/round (ceiling ${MONTHLY_UNIT_CEILING}/month)`);
  console.error('');
}

function warnGuardRisks(ap) {
  if (ap.needs_coordinates === true) {
    console.error(`WARNING: ${ap.icao} has needs_coordinates: true — the coordinate guard in routewatch.mjs will drop it from OWN, CAND and CODES until this is false.`);
  }
  if (!validCoords(ap.lat, ap.lon)) {
    console.error(`WARNING: ${ap.icao} has invalid or missing coordinates and would be dropped by the guard.`);
  }
}

function buildPriceSearch(icao, name) {
  const q = encodeURIComponent(`${icao} ${name}`.trim());
  const out = {};
  for (const shop of SHOPS) {
    switch (shop) {
      case 'fsaddoncompare': out[shop] = `https://www.fsaddoncompare.com/search?q=${q}`; break;
      case 'simmarket': out[shop] = `https://secure.simmarket.com/?s=${icao}`; break;
      case 'contrail': out[shop] = `https://contrail.co.uk/?s=${icao}`; break;
      case 'orbx': out[shop] = `https://orbxdirect.com/search?q=${icao}`; break;
      case 'inibuilds': out[shop] = `https://www.inibuilds.com/search?q=${icao}`; break;
      case 'aerosoft': out[shop] = `https://www.aerosoft.com/en/search?q=${icao}`; break;
      case 'justflight': out[shop] = `https://www.justflight.com/searchresults?searchterm=${icao}`; break;
    }
  }
  return out;
}

function saveConfig(data) {
  const backupPath = `${CONFIG_PATH}.bak`;
  fs.copyFileSync(CONFIG_PATH, backupPath);
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.error(`Wrote ${CONFIG_PATH} (backup at ${backupPath})`);
}

function cmdList(airports) {
  const own = airports.filter((a) => !isCandidate(a));
  const cand = airports.filter(isCandidate);
  console.log('OWN:');
  for (const a of own) console.log(`  ${a.icao} (${a.iata || '--'}) ${a.name} narrowbody_allowed=${a.narrowbody_allowed}`);
  console.log('CANDIDATE:');
  for (const a of cand) console.log(`  ${a.icao} (${a.iata || '--'}) ${a.name} focus=${a.focus || '--'}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { data } = loadConfig();
  const airports = findAirportsArray(data);
  if (!airports) {
    console.error('Could not locate the airports array in config/collection.json.');
    process.exit(1);
  }

  if (args.list) {
    cmdList(airports);
    return;
  }

  if (args.remove) {
    const icao = String(args.remove).toUpperCase();
    const idx = airports.findIndex((a) => a.icao === icao);
    if (idx === -1) {
      console.error(`${icao} not found.`);
      process.exit(1);
    }
    const before = projection(airports);
    if (!args['dry-run']) airports.splice(idx, 1);
    console.error(`Removed ${icao}.`);
    printProjection(before, projection(airports));
    if (!args['dry-run']) saveConfig(data);
    else console.error('Dry run: nothing written.');
    return;
  }

  if (args.promote || args.demote) {
    const icao = String(args.promote || args.demote).toUpperCase();
    const ap = airports.find((a) => a.icao === icao);
    if (!ap) {
      console.error(`${icao} not found.`);
      process.exit(1);
    }
    const before = projection(airports);
    if (args.promote) {
      if (!isCandidate(ap)) {
        console.error(`${icao} is already own.`);
      } else {
        delete ap.candidate;
        delete ap.why;
        delete ap.price_search;
        delete ap.known_developers;
        if (args.focus) ap.focus = args.focus;
      }
    } else {
      ap.candidate = true;
      ap.focus = args.focus || ap.focus || 'pax';
      ap.why = args.why || ap.why || 'Manually demoted to candidate.';
      ap.price_search = ap.price_search || buildPriceSearch(icao, ap.name || icao);
    }
    warnGuardRisks(ap);
    printProjection(before, projection(airports));
    if (!args['dry-run']) saveConfig(data);
    else console.error('Dry run: nothing written.');
    return;
  }

  // Add mode
  if (!args.icao) {
    console.error('Usage: --icao <ICAO> --name "<name>" --lat <lat> --lon <lon> [--iata][--country][--own|--candidate][--template <ICAO>][--narrowbody|--no-narrowbody][--focus][--why][--dry-run]');
    process.exit(1);
  }
  const icao = String(args.icao).toUpperCase();
  if (airports.some((a) => a.icao === icao)) {
    console.error(`${icao} already exists in config. Use --promote/--demote/--remove instead.`);
    process.exit(1);
  }
  if (!/^[A-Z0-9]{4}$/.test(icao)) {
    console.error(`WARNING: ${icao} does not look like a 4-letter ICAO code.`);
  }

  let base = {};
  if (args.template) {
    const tmpl = airports.find((a) => a.icao === String(args.template).toUpperCase());
    if (!tmpl) {
      console.error(`Template ${args.template} not found.`);
      process.exit(1);
    }
    base = JSON.parse(JSON.stringify(tmpl));
    delete base.candidate;
    delete base.why;
    delete base.price_search;
    delete base.known_developers;
    delete base.focus;
    delete base.night;
  }

  const lat = args.lat !== undefined ? Number(args.lat) : base.lat;
  const lon = args.lon !== undefined ? Number(args.lon) : base.lon;

  const newAirport = {
    ...base,
    icao,
    iata: args.iata ? String(args.iata).toUpperCase() : base.iata,
    name: args.name || base.name || icao,
    country: args.country || base.country,
    lat,
    lon,
    narrowbody_allowed: args['no-narrowbody'] ? false : args.narrowbody ? true : (base.narrowbody_allowed ?? false),
  };
  if (args.night) newAirport.night = args.night;

  if (!validCoords(newAirport.lat, newAirport.lon)) {
    console.error(`Refusing to add ${icao}: lat/lon are missing, non-finite, out of range, or 0,0.`);
    console.error('This mirrors the guard in routewatch.mjs, which drops such airports from OWN, CAND and CODES.');
    process.exit(1);
  }

  if (args.candidate) {
    newAirport.candidate = true;
    newAirport.focus = args.focus || 'pax';
    newAirport.why = args.why || 'Added via add-airport.mjs; fill in a real rationale.';
    newAirport.price_search = buildPriceSearch(icao, newAirport.name);
  } else if (args.focus) {
    newAirport.focus = args.focus;
  }

  const before = projection(airports);
  const preview = [...airports, newAirport];
  const after = projection(preview);

  warnGuardRisks(newAirport);
  console.error(`${args['dry-run'] ? '[dry-run] ' : ''}Adding ${icao} (${newAirport.name}) as ${args.candidate ? 'CANDIDATE' : 'OWN'}.`);
  printProjection(before, after);

  if (args['dry-run']) {
    console.error('Dry run: nothing written. Preview of the new entry:');
    console.log(JSON.stringify(newAirport, null, 2));
    return;
  }

  airports.push(newAirport);
  saveConfig(data);
  console.error('Next step: node scripts/check-config.mjs');
}

main();
