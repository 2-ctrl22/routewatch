#!/usr/bin/env node
/**
 * scan-sim.mjs - reads your Flight Simulator install and reports which airports
 * and which aircraft you actually own. Runs on YOUR machine, never in CI: a
 * GitHub runner has no access to your disk, and a browser page cannot walk a
 * file system at all.
 *
 *   node scripts/scan-sim.mjs                 report only
 *   node scripts/scan-sim.mjs --write         also write config/collection.scan.json
 *
 * Output:
 *   data/sim-scan.json   everything found, with a confidence per item
 *   data/sim-scan.md     a readable report
 *   config/collection.scan.json   (only with --write) a merge proposal
 *
 * ---------------------------------------------------------------- HOW IT WORKS
 * The Community folder is NOT at a fixed path. Users move it to another drive all
 * the time, and the sim then records the new location. The single source of truth
 * is UserCfg.opt, which holds a line like:
 *     InstalledPackagesPath "D:\\MSFS2024"
 * The Community folder is that path plus \\Community, and marketplace content sits
 * in Official\\OneStore or Official\\Steam.
 *
 * UserCfg.opt lives in a different place per sim and per edition:
 *   MSFS 2024 Steam      %APPDATA%\\Microsoft Flight Simulator 2024\\UserCfg.opt
 *   MSFS 2024 MS Store   %LOCALAPPDATA%\\Packages\\Microsoft.Limitless_8wekyb3d8bbwe\\LocalCache\\UserCfg.opt
 *   MSFS 2020 Steam      %APPDATA%\\Microsoft Flight Simulator\\UserCfg.opt
 *   MSFS 2020 MS Store   %LOCALAPPDATA%\\Packages\\Microsoft.FlightSimulator_8wekyb3d8bbwe\\LocalCache\\UserCfg.opt
 *
 * Override with environment variables when your setup is unusual:
 *   SIM_USERCFG=path\\to\\UserCfg.opt
 *   SIM_PACKAGES=path\\to\\Packages        (skips UserCfg.opt entirely)
 *   SIM_COMMUNITY=path\\to\\Community     (scan just this one folder)
 *
 * ------------------------------------------------------------ WHAT IS CERTAIN
 * Aircraft are reliable: aircraft.cfg carries icao_type_designator, which is the
 * same code RouteWatch matches against, for example B738 or A20N.
 *
 * Airports are a best effort. The ICAO code is buried in binary BGL files, so
 * this script reads it from folder names, package titles and BGL file names
 * instead. Every airport therefore gets a confidence, and "low" means: check it
 * yourself before trusting it.
 *
 * Coordinates cannot be read this way at all. An airport that is not already in
 * your config is written with needs_coordinates: true, because a wrong latitude
 * would silently corrupt every distance and every simmable check. Fill those in
 * by hand, or in the Editor.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, basename, sep } from "node:path";
import { homedir, platform } from "node:os";

const LOG = (...a) => console.log("[scan-sim]", ...a);
const WRITE = process.argv.includes("--write");

/* ------------------------------------------------------------ locate the sim */

function userCfgCandidates(){
  const out = [];
  if (process.env.SIM_USERCFG) out.push({ sim:"override", edition:"env", path:process.env.SIM_USERCFG });
  const APPDATA = process.env.APPDATA;
  const LOCAL = process.env.LOCALAPPDATA;
  if (APPDATA){
    out.push({ sim:"MSFS 2024", edition:"Steam", path:join(APPDATA,"Microsoft Flight Simulator 2024","UserCfg.opt") });
    out.push({ sim:"MSFS 2020", edition:"Steam", path:join(APPDATA,"Microsoft Flight Simulator","UserCfg.opt") });
  }
  if (LOCAL){
    out.push({ sim:"MSFS 2024", edition:"MS Store",
      path:join(LOCAL,"Packages","Microsoft.Limitless_8wekyb3d8bbwe","LocalCache","UserCfg.opt") });
    out.push({ sim:"MSFS 2020", edition:"MS Store",
      path:join(LOCAL,"Packages","Microsoft.FlightSimulator_8wekyb3d8bbwe","LocalCache","UserCfg.opt") });
  }
  /* Wine and Proton keep a Windows-shaped tree under the user's home. */
  if (platform() !== "win32"){
    const w = join(homedir(),".steam","steam","steamapps","compatdata");
    if (existsSync(w)) out.push({ sim:"MSFS (Proton)", edition:"Steam", path:null, hint:w });
  }
  return out.filter(c => c.path);
}

/** InstalledPackagesPath "D:\MSFS2024"  ->  D:\MSFS2024 */
function packagesPathFrom(file){
  let txt;
  try { txt = readFileSync(file, "utf8"); } catch { return null; }
  const m = txt.match(/InstalledPackagesPath\s+"([^"]+)"/i)
         || txt.match(/InstalledPackagesPath\s+(\S+)/i);
  return m ? m[1].trim() : null;
}

function findRoots(){
  if (process.env.SIM_COMMUNITY)
    return [{ sim:"override", edition:"env", packages:null, folders:[process.env.SIM_COMMUNITY] }];
  if (process.env.SIM_PACKAGES){
    const p = process.env.SIM_PACKAGES;
    return [{ sim:"override", edition:"env", packages:p, folders:subFolders(p) }];
  }
  const found = [];
  for (const c of userCfgCandidates()){
    if (!existsSync(c.path)) continue;
    const pkg = packagesPathFrom(c.path);
    if (!pkg){ LOG(`${c.sim} ${c.edition}: UserCfg.opt found but no InstalledPackagesPath in it`); continue; }
    if (!existsSync(pkg)){
      LOG(`${c.sim} ${c.edition}: packages path from UserCfg.opt does not exist: ${pkg}`);
      continue;
    }
    found.push({ sim:c.sim, edition:c.edition, packages:pkg, folders:subFolders(pkg), cfg:c.path });
  }
  return found;
}

/** Community plus the marketplace stores, whichever exist. */
function subFolders(pkgRoot){
  const want = [ join(pkgRoot,"Community"),
                 join(pkgRoot,"Official","OneStore"),
                 join(pkgRoot,"Official","Steam") ];
  return want.filter(p => existsSync(p));
}

/* ------------------------------------------------------------------ helpers */

const dirs = p => { try { return readdirSync(p,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name); }
                    catch { return []; } };

/** Walk a package, but stop early: these trees can hold tens of thousands of files. */
function walk(root, maxDepth=6, maxFiles=4000){
  const out=[]; const stack=[[root,0]];
  while(stack.length && out.length<maxFiles){
    const [d,depth]=stack.pop();
    let items=[];
    try { items=readdirSync(d,{withFileTypes:true}); } catch { continue; }
    for(const it of items){
      const full=join(d,it.name);
      if(it.isDirectory()){ if(depth<maxDepth) stack.push([full,depth+1]); }
      else out.push(full);
      if(out.length>=maxFiles) break;
    }
  }
  return out;
}

const readJson = p => { try { return JSON.parse(readFileSync(p,"utf8")); } catch { return null; } };

/* Four capitals is also a normal English word, so keep a stop list. Without it
 * you get "AREA", "DATA" and "MESH" reported as airports. */
const NOT_ICAO = new Set(["AREA","DATA","MESH","TEXT","BASE","CORE","MAIN","TEST","TEMP","DEMO",
 "PART","FULL","FREE","PACK","CITY","LAND","ROAD","TREE","ROCK","SNOW","WIND","FUEL","GATE",
 "RAMP","TAXI","APRON","LIGHT","NIGHT","WORLD","SCENE","MODEL","ASOBO","MSFS","SIMS","ONLY",
 "BETA","HDRI","LODS","HIGH","LOW1","XBOX","WASM","HTML","JSON","XML1","VFX1","SOUND","AUDIO"]);
const plausibleIcao = s => /^[A-Z]{4}$/.test(s) && !NOT_ICAO.has(s) && /^[A-Z]/.test(s);

/** Pull candidate ICAO codes out of names, with a note on where each came from. */
function icaosFrom(pkgName, title, files){
  const hits = new Map();          // code -> reason
  const add=(c,why)=>{ if(plausibleIcao(c) && !hits.has(c)) hits.set(c,why); };

  /* airport-eham, EHAM_Schiphol, ehamscenery ... */
  for(const part of String(pkgName).split(/[^A-Za-z0-9]+/))
    if(part.length===4) add(part.toUpperCase(),"package name");
  for(const part of String(title||"").split(/[^A-Za-z0-9]+/))
    if(part.length===4) add(part.toUpperCase(),"package title");

  /* Scenery BGLs are very often named after the airport they contain. */
  for(const f of files){
    if(!/\.bgl$/i.test(f)) continue;
    const b=basename(f).replace(/\.bgl$/i,"");
    for(const part of b.split(/[^A-Za-z0-9]+/))
      if(part.length===4) add(part.toUpperCase(),"BGL file name");
  }
  return [...hits].map(([icao,source])=>({icao,source}));
}

/** aircraft.cfg holds the code RouteWatch matches on, so this part is solid. */
function aircraftFrom(files){
  const out=[];
  for(const f of files){
    if(basename(f).toLowerCase()!=="aircraft.cfg") continue;
    let txt; try { txt=readFileSync(f,"utf8"); } catch { continue; }
    const code=(txt.match(/icao_type_designator\s*=\s*"?([A-Za-z0-9]{2,5})"?/i)||[])[1];
    const model=(txt.match(/icao_model\s*=\s*"?([^"\r\n;]+)"?/i)||[])[1];
    const title=(txt.match(/^\s*title\s*=\s*"?([^"\r\n;]+)"?/im)||[])[1];
    const maker=(txt.match(/icao_manufacturer\s*=\s*"?([^"\r\n;]+)"?/i)||[])[1];
    if(!code) continue;
    out.push({ type:code.toUpperCase().trim(),
               model:(model||"").trim()||null,
               manufacturer:(maker||"").trim()||null,
               livery:(title||"").trim()||null });
  }
  return out;
}

/* --------------------------------------------------------------------- scan */

const roots=findRoots();
if(!roots.length){
  LOG("no simulator found. Looked for UserCfg.opt in the standard places for MSFS 2020 and 2024,");
  LOG("both Steam and Microsoft Store. If your install is elsewhere, run it like this:");
  LOG('  SIM_COMMUNITY="D:\\\\MSFS2024\\\\Community" node scripts/scan-sim.mjs');
  process.exit(0);
}

for(const r of roots)
  LOG(`${r.sim} ${r.edition}: packages at ${r.packages ?? "(given directly)"}, ${r.folders.length} folder(s) to scan`);

const airports=new Map();   // ICAO -> {icao, sources[], packages[], confidence}
const aircraft=new Map();   // type -> {type, model, manufacturer, count, packages[]}
const scanned=[];

for(const r of roots){
  for(const folder of r.folders){
    const pkgs=dirs(folder);
    LOG(`scanning ${folder}: ${pkgs.length} packages`);
    for(const pkgName of pkgs){
      const pkgPath=join(folder,pkgName);
      const man=readJson(join(pkgPath,"manifest.json")) || {};
      const kind=String(man.content_type||"").toUpperCase();
      const title=man.title||null;
      /* layout.json lists every file, which is cheaper than walking the tree. */
      const layout=readJson(join(pkgPath,"layout.json"));
      const files = layout && Array.isArray(layout.content)
        ? layout.content.map(c=>String(c.path||""))
        : walk(pkgPath).map(f=>f.slice(pkgPath.length+1));

      scanned.push({ package:pkgName, folder, content_type:kind||null, title,
                     creator:man.creator||null, files:files.length });

      const isScenery = kind==="SCENERY" || files.some(f=>/\.bgl$/i.test(f));
      const isPlane   = kind==="AIRCRAFT" || files.some(f=>/aircraft\.cfg$/i.test(f));

      if(isScenery){
        for(const {icao,source} of icaosFrom(pkgName,title,files)){
          const cur=airports.get(icao) ?? {icao,sources:[],packages:[],title:title||null};
          if(!cur.sources.includes(source)) cur.sources.push(source);
          if(!cur.packages.includes(pkgName)) cur.packages.push(pkgName);
          if(!cur.title && title) cur.title=title;
          airports.set(icao,cur);
        }
      }
      if(isPlane){
        /* layout.json gives names only, so aircraft.cfg has to be read from disk. */
        for(const ac of aircraftFrom(walk(pkgPath,7,6000))){
          const cur=aircraft.get(ac.type) ?? {type:ac.type,model:ac.model,
            manufacturer:ac.manufacturer,liveries:0,packages:[]};
          cur.liveries++;
          if(!cur.model && ac.model) cur.model=ac.model;
          if(!cur.manufacturer && ac.manufacturer) cur.manufacturer=ac.manufacturer;
          if(!cur.packages.includes(pkgName)) cur.packages.push(pkgName);
          aircraft.set(ac.type,cur);
        }
      }
    }
  }
}

/* Two independent hints is a lot more convincing than one. */
for(const a of airports.values())
  a.confidence = a.sources.length>=2 ? "high"
               : a.sources.includes("BGL file name") ? "medium" : "low";

/* ------------------------------------------------- compare with your config */

const CFG=readJson("config/collection.json") || {airports:[],fleet:{owned:[]}};
const known=new Set((CFG.airports||[]).map(a=>String(a.icao).toUpperCase()));
const knownCoords=Object.fromEntries((CFG.airports||[])
  .map(a=>[String(a.icao).toUpperCase(),a]));
const knownTypes=new Set((CFG.fleet?.owned||[]).flatMap(f=>f.types||[])
  .map(t=>String(t).toUpperCase()));

const newAirports=[...airports.values()].filter(a=>!known.has(a.icao))
  .sort((a,b)=>a.icao.localeCompare(b.icao));
const haveAirports=[...airports.values()].filter(a=>known.has(a.icao))
  .sort((a,b)=>a.icao.localeCompare(b.icao));
const newTypes=[...aircraft.values()].filter(a=>!knownTypes.has(a.type))
  .sort((a,b)=>a.type.localeCompare(b.type));
const missingInSim=[...known].filter(i=>!airports.has(i)).sort();

mkdirSync("data",{recursive:true});
writeFileSync("data/sim-scan.json", JSON.stringify({
  scanned_at:new Date().toISOString(),
  installs:roots.map(r=>({sim:r.sim,edition:r.edition,packages:r.packages,folders:r.folders})),
  packages:scanned.length,
  airports:[...airports.values()].sort((a,b)=>a.icao.localeCompare(b.icao)),
  aircraft:[...aircraft.values()].sort((a,b)=>a.type.localeCompare(b.type)),
  compared_with_config:{
    airports_new:newAirports.map(a=>a.icao),
    airports_already_in_config:haveAirports.map(a=>a.icao),
    airports_in_config_not_found_in_sim:missingInSim,
    aircraft_types_new:newTypes.map(a=>a.type)
  }
},null,1));

/* --------------------------------------------------------------- the report */

const md=[`# Simulator scan ${new Date().toISOString().slice(0,16)}`,``];
for(const r of roots) md.push(`- ${r.sim} ${r.edition}: \`${r.packages ?? "given directly"}\``);
md.push(``,`Scanned **${scanned.length}** packages.`,``,
  `## Aircraft found (${aircraft.size})`,``,
  `Read from \`icao_type_designator\` in aircraft.cfg, so these codes are the real thing.`,``);
if(aircraft.size){
  md.push(`| Type | Model | Liveries | In your config |`,`|---|---|---|---|`);
  for(const a of [...aircraft.values()].sort((x,y)=>x.type.localeCompare(y.type)))
    md.push(`| \`${a.type}\` | ${a.model??"?"} | ${a.liveries} | ${knownTypes.has(a.type)?"yes":"**no**"} |`);
} else md.push(`Nothing found. Aircraft add-ons may be installed elsewhere.`);

md.push(``,`## Airports found (${airports.size})`,``,
  `The ICAO code is inside binary BGL files, so it is inferred from names here.`,
  `Check anything marked low before you trust it.`,``,
  `| ICAO | Confidence | Inferred from | Package | In your config |`,`|---|---|---|---|---|`);
for(const a of [...airports.values()].sort((x,y)=>x.icao.localeCompare(y.icao)))
  md.push(`| \`${a.icao}\` | ${a.confidence} | ${a.sources.join(", ")} | ${a.packages[0]??""} | ${known.has(a.icao)?"yes":"**no**"} |`);

md.push(``,`## What to do next`,``,
  `- **${newAirports.length}** airport(s) are installed but not in your config.`,
  `- **${newTypes.length}** aircraft type(s) are installed but not in your fleet.`,
  `- **${missingInSim.length}** airport(s) in your config were not found in the sim`
  + (missingInSim.length?`: ${missingInSim.join(" ")}`:``)
  + `. Those may be default airports, or candidates you do not own yet, which is fine.`,``,
  `Coordinates cannot be read from a package, so any new airport needs a latitude and`,
  `longitude from you. A wrong coordinate quietly breaks every distance and every`,
  `simmable check, which is why this script refuses to guess.`);
writeFileSync("data/sim-scan.md", md.join("\n")+"\n");

/* -------------------------------------------------------- merge proposal --- */

if(WRITE){
  const proposal=JSON.parse(JSON.stringify(CFG));
  proposal._scan_note="Generated by scripts/scan-sim.mjs. Review before replacing "
    +"config/collection.json. Entries with needs_coordinates:true are incomplete on purpose.";
  for(const a of newAirports){
    proposal.airports.push({
      icao:a.icao,
      name:a.title||a.icao,
      lat:null, lon:null,
      needs_coordinates:true,
      narrowbody_allowed:true,
      _found_in:a.packages[0]||null,
      _confidence:a.confidence
    });
  }
  if(newTypes.length){
    proposal.fleet=proposal.fleet||{owned:[]};
    proposal.fleet._scan_suggested_types=newTypes.map(a=>({
      type:a.type, model:a.model, liveries:a.liveries,
      note:"add this to an existing fleet.owned entry, or create one with key, name, role and range_nm"
    }));
  }
  mkdirSync("config",{recursive:true});
  writeFileSync("config/collection.scan.json", JSON.stringify(proposal,null,2));
  LOG("wrote config/collection.scan.json - review it, then copy what you want into collection.json");
}

LOG(`done: ${scanned.length} packages, ${airports.size} airports, ${aircraft.size} aircraft types`);
LOG(`new versus your config: ${newAirports.length} airports, ${newTypes.length} aircraft types`);
LOG(`reports in data/sim-scan.md and data/sim-scan.json`);
if(!WRITE) LOG("run again with --write to also get config/collection.scan.json");
