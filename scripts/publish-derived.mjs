#!/usr/bin/env node
/**
 * publish-derived.mjs - builds TWO variants of the shareable file so they can be
 * compared honestly, and sweeps expired raw Contents.
 *
 *   node scripts/publish-derived.mjs            build both variants
 *   node scripts/publish-derived.mjs --sweep    also delete expired cached CSVs
 *   node scripts/publish-derived.mjs --audit    report only, write nothing
 *
 * VARIANT A - docs/community.json           aggregate only, safe to serve
 * VARIANT B - data/community-immersion.json aggregate plus flight-level detail
 *
 * -------------------------------------------------------------- THE TRADE-OFF
 * A tells a user "Amsterdam to Munich is served and you can fly it".
 * B tells a user "KL1401 departs 07:15 on a Boeing 737-800, and you own one".
 *
 * A is information. B is a flight you can recreate tonight. For a community that
 * cares about immersion, that difference is the whole product, which is why both
 * exist here instead of one compromise that satisfies nobody.
 *
 * ------------------------------------------------------------ WHICH IS ALLOWED
 * AeroDataBox Terms of Use, Article 5:
 *
 *   5.2(g)  no permanent copies of Contents, no databases built from them
 *   5.2(i)  no copying, reselling, distributing or sublicensing Contents
 *   5.3     commercial use requires Contents obtained through a paid channel
 *   5.4     attribution required only on a free or trial plan
 *   5.5     cached Contents deleted after seven days at the latest
 *   5.6     5.2(g), 5.2(i) and 5.5 do NOT apply to Derived Works; Derived Works
 *           may be sublicensed as far as the Plan Terms permit
 *
 * VARIANT A holds classifications, counts and distances I calculate myself. That
 * is my own analysis, and 5.6 exempts it from the distribution ban.
 *
 * VARIANT B adds flight numbers, departure times, airline and aircraft type per
 * route. Those are Contents, not analysis. Article 5.2 explicitly rules out
 * handing over "lightly changed data - reformatted, translated, or with fields
 * renamed".
 *
 * So B defaults to data/, which GitHub Pages does not serve, and .gitignore keeps
 * it out of the repository entirely. Two independent safeguards, because a flag
 * you have to remember is not a safeguard. Point it at docs/ only once the
 * permission is on paper:
 *
 *   IMMERSION_DIR=docs node scripts/publish-derived.mjs
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LOG=(...a)=>console.log("[publish]",...a);
const SWEEP=process.argv.includes("--sweep");
const AUDIT=process.argv.includes("--audit");
const load=(p,d)=>{try{return JSON.parse(readFileSync(p,"utf8"));}catch{return d;}};
const kb=n=>Math.round(n/1024)+" kB";

const RETENTION_DAYS=Number(process.env.RETENTION_DAYS??7);
const OUTDIR=process.env.PUBLISH_DIR??"docs";
/* Default is data/, not docs/: anything under docs/ is published by Pages the
 * moment it is committed, and variant B is not cleared for that yet. */
const IMMERSION_DIR=process.env.IMMERSION_DIR??"data";

/* ------------------------------------------------------------ 1. the sweep --- */

function sweepRawContents(){
  const dir="data/manual";
  if(!existsSync(dir)) return {checked:0,expired:[],deleted:0};
  const cutoff=new Date(Date.now()-RETENTION_DAYS*864e5);
  const expired=[]; let checked=0;
  for(const f of readdirSync(dir)){
    if(!/\.csv$/i.test(f)) continue;
    checked++;
    const m=f.match(/_(\d{4}-\d{2}-\d{2})\.csv$/);
    const day=m?new Date(m[1]+"T00:00:00Z"):null;
    const when=day??(()=>{try{return statSync(join(dir,f)).mtime;}catch{return null;}})();
    if(when && when<cutoff) expired.push(f);
  }
  let deleted=0;
  if(SWEEP) for(const f of expired){
    try{ unlinkSync(join(dir,f)); deleted++; }
    catch(e){ LOG(`could not delete ${f}: ${e.message}`); }
  }
  return {checked,expired,deleted};
}

/* ----------------------------------------------------------------- shared --- */

function band(status){
  const s=String(status||"");
  if(s==="GEEN VERBINDING"||s==="NO SERVICE") return "none";
  if(s.startsWith("MATCH")) return "own";
  if(s.startsWith("NEAR")) return "substitute";
  if(s.startsWith("NO-")) return "not_in_fleet";
  return "unknown";
}

/** Airports and fleet come from the user's own config, never from the API. */
function commonHead(D){
  const s=D.summary||{};
  return {
    generated:s.generated??null,
    season:s.season??null,
    counts:{
      airports_owned:s.airports??null,
      wishlist_airports:s.candidates??null,
      pairs_possible:s.pairs_possible??null,
      pairs_served:s.pairs_served??null,
      pairs_flyable:s.pairs_match??null,
      pairs_simmable:s.pairs_simmable??null,
      pairs_cargo:s.cargo_pairs??null
    },
    airports:(D.airports||[]).map(a=>({
      icao:a.icao,iata:a.iata??null,name:a.name,lat:a.lat,lon:a.lon,
      candidate:!!a.candidate,focus:a.focus??null
    })),
    fleet:D.fleet??null
  };
}

function candidateList(D){
  return (D.candidates||[]).map(c=>({
    icao:c.icao,name:c.name,focus:c.focus??null,
    new_pairs:c.gain?.new_pairs??0,
    flyable_pairs:c.gain?.match_pairs??0,
    simmable_pairs:c.gain?.simmable_pairs??0,
    cargo_pairs:c.gain?.cargo_pairs??0,
    connects_count:(c.gain?.connects||[]).length,
    why:c.why??null,
    known_developers:c.known_developers??null
  })).sort((a,b)=>b.flyable_pairs-a.flyable_pairs||b.new_pairs-a.new_pairs);
}

/* ------------------------------------------------- VARIANT A: aggregate only */

function buildAggregate(D){
  return {
    _variant:"A - aggregate only",
    _what_this_is:
      "Derived Work. Classifications, counts and distances computed by RouteWatch. "
      +"No flight numbers, no departure times, no airline per route, no aircraft "
      +"type per route, no registrations, no per-day records.",
    _permission:
      "Article 5.6 exempts Derived Works from 5.2(g), 5.2(i) and 5.5. Sublicensing "
      +"is allowed as far as the Plan Terms permit, so confirm that scope in writing.",
    ...commonHead(D),
    pairs:(D.pairs||[]).map(p=>({
      pair:p.pair,
      nm:p.nm,                                   /* my own great-circle maths */
      flyable:band(p.status),                    /* my classification */
      operator_count:(p.operators||[]).length,   /* how many, not which */
      aircraft_count:(p.types||[]).length,
      simmable:!!p.simmable,
      cargo:!!p.cargo
    })),
    candidates:candidateList(D)
  };
}

/* ------------------------------------------- VARIANT B: immersion, gated ---- */

function buildImmersion(D){
  return {
    _variant:"B - immersion, needs written permission",
    _what_this_is:
      "Contains flight-level detail: flight numbers, scheduled departure times, "
      +"operating airline and aircraft type per route. These are AeroDataBox "
      +"Contents, not my own analysis.",
    _do_not_publish_until:
      "AeroDataBox has confirmed in writing that the Plan Terms of your plan permit "
      +"showing these fields to end users (Article 5.6), and the Contents were "
      +"obtained through a paid channel (Article 5.3). Aircraft registrations are "
      +"deliberately excluded even then.",
    _retention_note:
      "If permission covers display only and not storage, treat this file as a "
      +"cache: delete and regenerate within "+RETENTION_DAYS+" days (Article 5.5).",
    ...commonHead(D),
    pairs:(D.pairs||[]).map(p=>({
      pair:p.pair,
      nm:p.nm,
      flyable:band(p.status),
      simmable:!!p.simmable,
      cargo:!!p.cargo,
      /* --- the immersion fields --- */
      operators:p.operators??[],
      aircraft:p.types??[],
      flights:(p.legs||[]).map(l=>({
        airline:l.airline,
        flight:l.flight,
        std:l.std??null,
        aircraft:Object.keys(l.types||{}),
        flyable:band(l.status),
        days_seen:l.days??null,
        first_seen:l.first??null,
        last_seen:l.last??null
        /* registrations are never copied here, on purpose */
      }))
    })),
    candidates:candidateList(D)
  };
}

/* ------------------------------------------------------------- 3. the audit -- */

function auditRetention(){
  const findings=[];
  const led=load("data/ledger.json",null);
  if(led){
    const rows=Object.values(led);
    const withDays=rows.filter(r=>Array.isArray(r.days)&&r.days.length);
    const maxDays=Math.max(0,...withDays.map(r=>r.days.length));
    const oldest=withDays.flatMap(r=>r.days).sort()[0]??null;
    const ageDays=oldest?Math.round((Date.now()-new Date(oldest+"T00:00:00Z"))/864e5):0;
    if(ageDays>RETENTION_DAYS)
      findings.push(`data/ledger.json keeps observation dates going back ${ageDays} days `
        +`(longest series ${maxDays} entries), over the ${RETENTION_DAYS}-day cap in 5.5. `
        +`The per-day arrays, std times and regs are Contents; the computed status and `
        +`counts are not.`);
  }
  for(const [f,what] of [["data/registry.json","cached aircraft records"],
                         ["data/aircraft-meta.json","cached aircraft records"],
                         ["data/type-history.json","per-week type observations"]]){
    const j=load(f,null);
    if(j&&Object.keys(j).length) findings.push(`${f} holds ${Object.keys(j).length} ${what}.`);
  }
  if(existsSync(join("docs","data.json")))
    findings.push(`docs/data.json is served publicly by GitHub Pages and contains legs `
      +`with flight numbers, departure times and per-season records. That is Contents.`);
  if(existsSync(join("docs","community-immersion.json")))
    findings.push(`docs/community-immersion.json exists and IS served by Pages. Move it to `
      +`data/ unless the permission is on paper.`);
  return findings;
}

/* --------------------------------------------------------------------- run --- */

const D=load("docs/data.json",null);
if(!D){ LOG("docs/data.json not found - run routewatch.mjs first"); process.exit(1); }

const sweep=sweepRawContents();
const findings=auditRetention();

const A=buildAggregate(D), B=buildImmersion(D);
const sizeA=JSON.stringify(A).length, sizeB=JSON.stringify(B).length;
const flights=B.pairs.reduce((n,p)=>n+p.flights.length,0);
const withTime=B.pairs.reduce((n,p)=>n+p.flights.filter(f=>f.std).length,0);

if(!AUDIT){
  mkdirSync(OUTDIR,{recursive:true});
  writeFileSync(join(OUTDIR,"community.json"),JSON.stringify(A));
  mkdirSync(IMMERSION_DIR,{recursive:true});
  writeFileSync(join(IMMERSION_DIR,"community-immersion.json"),JSON.stringify(B));
  LOG(`variant A: ${join(OUTDIR,"community.json")} ${kb(sizeA)} - safe to serve`);
  LOG(`variant B: ${join(IMMERSION_DIR,"community-immersion.json")} ${kb(sizeB)}, `
     +`${flights} flights, ${withTime} with a departure time`);
  if(IMMERSION_DIR==="docs")
    LOG("WARNING: variant B is in docs/, which Pages serves. Only do this with permission on paper.");
  else
    LOG("variant B is not served and is gitignored. Set IMMERSION_DIR=docs once permitted.");
}

/* ------------------------------------------------------ the comparison ------ */

const servedA=A.pairs.filter(p=>p.flyable!=="none").length;
const ownA=A.pairs.filter(p=>p.flyable==="own").length;

const md=[
`# Two variants, side by side  ${new Date().toISOString().slice(0,16)}`,``,
`## What each one tells a user`,``,
`Take one served pair as an example. Variant A can say:`,``,
`> EHAM-EDDM, 315 NM, you can fly it, 3 airlines, 2 aircraft types, fits a session.`,``,
`Variant B can say:`,``,
`> KL1401 departs 07:15 on a Boeing 737-800. You own that aircraft. Seen on 6 of`,
`> the last 7 days, since 12 August.`,``,
`Both are true. Only one of them is a flight you can sit down and recreate.`,``,
`## Size and content`,``,
`| | Variant A | Variant B |`,
`|---|---|---|`,
`| File | \`${join(OUTDIR,"community.json")}\` | \`${join(IMMERSION_DIR,"community-immersion.json")}\` |`,
`| Served by Pages | yes | ${IMMERSION_DIR==="docs"?"**yes**":"no"} |`,
`| Size | ${kb(sizeA)} | ${kb(sizeB)} |`,
`| Airport pairs | ${A.pairs.length} | ${B.pairs.length} |`,
`| Individual flights | none | ${flights} |`,
`| Flights with a departure time | none | ${withTime} |`,
`| Flight numbers | no | yes |`,
`| Airline per route | count only | named |`,
`| Aircraft type per route | count only | named |`,
`| First and last seen | no | yes |`,
`| Aircraft registrations | no | no, excluded on purpose |`,
`| Needs written permission | no | **yes** |`,``,
`## What both variants share`,``,
`- ${A.pairs.length} airport pairs, of which ${servedA} served and ${ownA} flyable with your own fleet`,
`- distances calculated from public coordinates, which are mine either way`,
`- the candidate ranking: ${A.candidates.length} airports scored on network gain`,
`- your airport list and your fleet, both from your own config`,``,
`## The immersion argument, honestly stated`,``,
`Variant A answers "is this route worth owning". That is a purchase decision, made`,
`once per airport. Variant B answers "what do I fly tonight", which is a decision`,
`made every session. The second question is why someone opens the app again`,
`tomorrow, so the immersion fields are not decoration, they are the retention.`,``,
`The catch is equally plain: those fields are Contents, not analysis. Article 5.2`,
`rules out handing over "lightly changed data", and a list of flight numbers is`,
`exactly that no matter how it is packaged. Article 5.6 exempts Derived Works from`,
`the distribution ban, but a flight number does not become a Derived Work by being`,
`placed next to one.`,``,
`## A middle road worth considering`,``,
`If AeroDataBox says no to variant B as a published file, there is a third shape`,
`that keeps the immersion without distributing anything:`,``,
`- ship variant A as the public file`,
`- have the paid app call the API with the **user's own key** for the flight-level`,
`  detail, on the handful of airports that user owns`,
`- then nothing is redistributed at all, because each user retrieves their own data`,
`  under their own subscription, and your paywall sits on the software`,``,
`That costs the user a few dollars a month on top of a one-time purchase, which`,
`this community dislikes. It is the only version that needs no permission at all,`,
`so it is worth keeping as the fallback.`,``,
`## Raw Contents in data/manual`,``,
`- CSV files present: **${sweep.checked}**`,
`- older than ${RETENTION_DAYS} days: **${sweep.expired.length}**`,
`- deleted this run: **${sweep.deleted}**`+(SWEEP?``:` (run with \`--sweep\`)`),``,
`## Retention findings`,``];
if(findings.length) for(const f of findings) md.push(`- ${f}`);
else md.push(`- nothing over the limit.`);
md.push(``,`## Note on git history`,``,
`Deleting a file removes it from the working tree, not from earlier commits. Both`,
`data/manual/*.csv and the immersion variant are in .gitignore for that reason: a`,
`cache that lives in git history forever is not a cache.`);

mkdirSync("data",{recursive:true});
writeFileSync("data/variant-comparison.md",md.join("\n")+"\n");

LOG(`comparison in data/variant-comparison.md`);
LOG(`${sweep.checked} cached CSVs, ${sweep.expired.length} past ${RETENTION_DAYS} days, ${sweep.deleted} deleted`);
for(const f of findings) LOG("finding: "+f);
