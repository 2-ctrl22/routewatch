#!/usr/bin/env node
/**
 * RouteWatch - one script, zero dependencies, no database.
 * Storage = JSON in this repository, so git is your history and your backup.
 *
 * New in v2: CANDIDATE AIRPORTS. An airport with "candidate": true is collected
 * but does not count towards your main matrix. That way the app measures how many
 * new served pairs and new MATCH pairs buying it would give you.
 * Price comparison does not happen here: FSAddonCompare already does it better.
 * The config only holds direct search links per candidate.
 *
 * All output is written in English. The pages under docs/ still translate the
 * older Dutch wording, because data/events.json keeps up to 3000 historical
 * records that were written before this change.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const CFG = JSON.parse(readFileSync("config/collection.json", "utf8"));
const S = CFG.settings;
const ALL = Object.fromEntries(CFG.airports.map(a => [a.icao, a]));
const OWN = CFG.airports.filter(a => !a.candidate).map(a => a.icao);
const CAND = CFG.airports.filter(a => a.candidate).map(a => a.icao);
const CODES = Object.keys(ALL);
const isOwn = c => !ALL[c]?.candidate;

const lastSunday = (y,m0)=>{const d=new Date(Date.UTC(y,m0+1,0));d.setUTCDate(d.getUTCDate()-d.getUTCDay());return d;};
const iso = d => d.toISOString().slice(0,10);
const yy = n => String(n%100).padStart(2,"0");
function seasonFor(day){
  for(const o of CFG.seasons?.overrides ?? []) if(day>=o.start && day<=o.end) return o;
  const d=new Date(day+"T00:00:00Z"), y=d.getUTCFullYear();
  const mar=lastSunday(y,2), oct=lastSunday(y,9);
  if(d>=mar&&d<oct){const e=new Date(oct);e.setUTCDate(e.getUTCDate()-1);
    return {label:"S"+yy(y),start:iso(mar),end:iso(e)};}
  if(d>=oct) return {label:"W"+yy(y)+"/"+yy(y+1),start:iso(oct),end:iso(lastSunday(y+1,2))};
  return {label:"W"+yy(y-1)+"/"+yy(y),start:iso(lastSunday(y-1,9)),end:iso(mar)};
}
const counter = l => l.startsWith("S") ? "W"+yy(2000+ +l.slice(1))+"/"+yy(2001+ +l.slice(1)) : "S"+yy(2000+ +l.slice(1,3));

const OWNED={}, BYKEY={};
for(const f of CFG.fleet.owned){BYKEY[f.key]=f; for(const t of f.types) OWNED[t]=f;}
const NEAR = CFG.fleet.near_match ?? {};
const WIDE = new Set(["A350","B77F"]);
const ALIAS={"BOEING 737-800":"B738","737-800":"B738","73H":"B738","738":"B738","BOEING 737 MAX 8":"B38M",
 "737 MAX 8":"B38M","7M8":"B38M","AIRBUS A320":"A320","A320NEO":"A20N","32N":"A20N","AIRBUS A321NEO":"A21N",
 "A321NEO":"A21N","AIRBUS A319":"A319","AIRBUS A350-900":"A359","A350-900":"A359","AIRBUS A350-1000":"A35K",
 "A350-1000":"A35K","BOEING 777F":"B77L","777F":"B77L","EMBRAER 195-E2":"E295","EMBRAER 195":"E195",
 "EMBRAER 175":"E175","AIRBUS A220-300":"BCS3","ATR 72-600":"AT76","BOEING 787-9":"B789","BOEING 777-300ER":"B77W"};
const normType = r => r ? (ALIAS[String(r).trim().toUpperCase()] ?? String(r).trim().toUpperCase()) : null;
const gcNm=(a,b)=>{const r=Math.PI/180,p1=a.lat*r,p2=b.lat*r,dl=(b.lon-a.lon)*r;
 return Math.round(3440.065*Math.acos(Math.min(1,Math.sin(p1)*Math.sin(p2)+Math.cos(p1)*Math.cos(p2)*Math.cos(dl))));};
const pk=(a,b)=>[a,b].sort().join("-");

function matchStatus(types){const t=new Set();
 for(const x of types) if(x) t.add(OWNED[x]?"MATCH":NEAR[x]?"NEAR-MATCH":"NO-MATCH");
 if(!t.size) return "UNKNOWN";
 if(t.size===1) return [...t][0];
 if(t.has("MATCH")) return "MATCH+"+[...t].filter(x=>x!=="MATCH").sort().join("+");
 return "NEAR-MATCH+NO-MATCH";}
function simmable(pair,types,nm,cargo){const [a,b]=pair.split("-");
 const nbOk = ALL[a]?.narrowbody_allowed!==false && ALL[b]?.narrowbody_allowed!==false;
 const need = cargo?"cargo":"pax";
 for(const t of types){const spec=OWNED[t] ?? (NEAR[t]?BYKEY[NEAR[t].substitute]:null);
  if(!spec||spec.role!==need||nm>spec.range_nm) continue;
  if(!WIDE.has(spec.key)&&!nbOk) continue;
  return true;} return false;}

const REGF="data/registry.json";
const load=(p,d)=>{try{return JSON.parse(readFileSync(p,"utf8"));}catch{return d;}};
const REG=load(REGF,{}), LEDGER=load("data/ledger.json",{}), OLDEV=load("data/events.json",[]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function openSky(icao,day){
 const u=process.env.OPENSKY_USER,p=process.env.OPENSKY_PASS;
 const headers=u&&p?{authorization:"Basic "+Buffer.from(u+":"+p).toString("base64")}:{};
 const begin=Math.floor(new Date(day+"T00:00:00Z").getTime()/1000);
 let rows=[];
 try{const res=await fetch(`https://opensky-network.org/api/flights/departure?airport=${icao}&begin=${begin}&end=${begin+86400}`,{headers});
  if(!res.ok) return []; rows=(await res.json())??[];}catch{return [];}
 const out=[];
 for(const r of rows){
  const arr=String(r.estArrivalAirport??"").toUpperCase();
  if(!ALL[arr]||arr===icao) continue;
  if(r.icao24 && REG[r.icao24]===undefined){
   try{const m=await fetch(`https://opensky-network.org/api/metadata/aircraft/icao/${r.icao24}`,{headers});
    REG[r.icao24]=m.ok?await m.json():null;}catch{REG[r.icao24]=null;}}
  const meta=r.icao24?REG[r.icao24]:null;
  out.push({layer:"actual",source:"opensky",dep:icao,arr,
   airline:String(r.callsign??"").trim().slice(0,3)||"?",flight:String(r.callsign??"").trim()||"?",
   std:new Date(r.firstSeen*1000).toISOString().slice(11,16),
   type:meta?normType(meta.typeCode??meta.model):null, reg:meta?meta.registration??null:null, cargo:0});}
 return out;}

async function aeroDataBox(icao,day){
 const key=process.env.RAPIDAPI_KEY; if(!key) return [];
 const host="aerodatabox.p.rapidapi.com", out=[];
 for(const [s,e] of [["00:00","11:59"],["12:00","23:59"]]){
  try{const res=await fetch(`https://${host}/flights/airports/icao/${icao}/${day}T${s}/${day}T${e}`
   +`?withLeg=true&direction=Departure&withCancelled=false&withCodeshared=false&withCargo=true&withPrivate=false`,
   {headers:{"X-RapidAPI-Key":key,"X-RapidAPI-Host":host}});
   if(!res.ok) continue; const j=await res.json();
   for(const f of j.departures??[]){const arr=String(f?.movement?.airport?.icao??"").toUpperCase();
    if(!ALL[arr]||arr===icao) continue;
    out.push({layer:"schedule",source:"aerodatabox",dep:icao,arr,
     airline:f?.airline?.iata??f?.airline?.icao??"?",flight:String(f?.number??"").replace(/\s/g,"")||"?",
     std:String(f?.departure?.scheduledTime?.local??"").slice(11,16)||null,
     type:normType(f?.aircraft?.model??f?.aircraft?.typeCode),reg:f?.aircraft?.reg??null,
     cargo:String(f?.isCargo??"").toLowerCase()==="true"?1:0});}
  }catch{} await sleep(1100);}
 return out;}

function manual(icao,day){
 const p=`data/manual/${icao}_${day}.csv`; if(!existsSync(p)) return [];
 const [head,...lines]=readFileSync(p,"utf8").trim().split(/\r?\n/);
 const cols=head.split(",").map(s=>s.trim());
 return lines.filter(Boolean).map(l=>{const v=l.split(","),o={};
  cols.forEach((c,i)=>o[c]=(v[i]??"").trim());
  return {layer:"schedule",source:"manual",dep:icao,arr:String(o.arr_icao).toUpperCase(),
   airline:o.airline||"?",flight:o.flight_no||"?",std:o.std||null,type:normType(o.type_raw),
   reg:null,cargo:Number(o.cargo||0)};}).filter(o=>ALL[o.arr]&&o.arr!==icao);}

/** Optional and off by default: price from the schema.org JSON-LD of a product URL. */
async function scrapePrice(url){
 try{const res=await fetch(url,{headers:{"user-agent":"RouteWatch/1.0 (personal use)"}});
  if(!res.ok) return null; const html=await res.text();
  for(const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)){
   try{const j=JSON.parse(m[1]); const nodes=Array.isArray(j)?j:[j];
    for(const n of nodes){const off=n.offers?Array.isArray(n.offers)?n.offers[0]:n.offers:null;
     if(off?.price) return {price:Number(off.price),currency:off.priceCurrency??null};}}catch{}}
  const m2=/"price"\s*:\s*"?([0-9]+(?:[.,][0-9]{2})?)"?/.exec(html);
  return m2?{price:Number(String(m2[1]).replace(",",".")),currency:null}:null;
 }catch{return null;}}

const HIGH=new Set(["PAIR_NEW","PAIR_GONE","ROUTE_NEW","SUSPENDED","RESUMED","MATCH_CHANGED","SIMMABLE_CHANGED","SEASON_NEW","SEASON_NOT_RETURNING","CANDIDATE_GAIN_UP"]);
const MED=new Set(["TYPE_NEW","TYPE_MIX_SHIFT","SEASON_TYPE_SWAP","DOW_PATTERN_CHANGE","PRICE_DROP"]);
const events=[];
const evt=(kind,o)=>events.push({at:new Date().toISOString(),kind,
 severity:HIGH.has(kind)?"high":MED.has(kind)?"medium":"low",...o});

const days=Math.max(1,Math.min(30,Number(process.env.BACKFILL_DAYS||1)));
const fresh=[];
for(let d=1;d<=days;d++){
 const day=iso(new Date(Date.now()-d*864e5));
 for(const icao of CODES){
  const rows=[...(S.providers?.opensky?await openSky(icao,day):[]),
              ...(S.providers?.aerodatabox?await aeroDataBox(icao,day):[]),
              ...(S.providers?.manual?manual(icao,day):[])];
  for(const o of rows) fresh.push({...o,day,season:seasonFor(day).label,
   dow:new Date(day+"T00:00:00Z").getUTCDay()});}
 process.stderr.write(`${day}: ${fresh.length} observations so far\n`);}

const group=new Map();
for(const o of fresh){const k=`${pk(o.dep,o.arr)}|${o.airline}|${o.flight}`;
 if(!group.has(k)) group.set(k,[]); group.get(k).push(o);}
const prevPairs=new Set(Object.values(LEDGER).filter(x=>x.state==="active").map(x=>x.pair));
const touched=new Set();

for(const [key,rows] of group){
 touched.add(key);
 const pair=key.split("|")[0],[a,b]=pair.split("-");
 const nm=gcNm(ALL[a],ALL[b]);
 const cargo=rows.some(r=>r.cargo)?1:0;
 const cur=LEDGER[key]??{pair,airline:rows[0].airline,flight:rows[0].flight,nm,cargo,
  first_seen:rows[0].day,days:[],types:{},seasons:{},dow:[],std:null,sources:[],state:"active",missed:0};
 const before={status:cur.status,simmable:cur.simmable,types:{...cur.types},dow:[...cur.dow]};
 for(const o of rows){
  if(!cur.days.includes(o.day)) cur.days.push(o.day);
  if(o.type) cur.types[o.type]=(cur.types[o.type]??0)+1;
  if(!cur.dow.includes(o.dow)) cur.dow.push(o.dow);
  if(!cur.sources.includes(o.source)) cur.sources.push(o.source);
  const s=(cur.seasons[o.season]??={first:o.day,last:o.day,days:0,types:{},std:o.std});
  s.first=s.first<o.day?s.first:o.day; s.last=s.last>o.day?s.last:o.day; s.days++;
  if(o.type) s.types[o.type]=(s.types[o.type]??0)+1;
  if(o.std){s.std=o.std; cur.std=o.std;}}
 cur.days=cur.days.sort().slice(-120);
 cur.last_seen=cur.days[cur.days.length-1]; cur.nm=nm; cur.cargo=cargo;
 const types=Object.keys(cur.types);
 cur.status=matchStatus(types); cur.simmable=simmable(pair,types,nm,cargo);
 cur.candidate=!isOwn(a)||!isOwn(b);
 const wasSusp=cur.state==="suspended"; cur.state="active"; cur.missed=0;
 const id={pair,airline:cur.airline,flight:cur.flight};
 const conf=`n=${cur.days.length}d, sources=${cur.sources.length}`;
 if(!before.status){ evt("ROUTE_NEW",{...id,detail:{nm,types,status:cur.status,candidate:cur.candidate},confidence:conf}); }
 else{
  if(before.status!==cur.status) evt("MATCH_CHANGED",{...id,detail:{from:before.status,to:cur.status,types},confidence:conf});
  if(before.simmable!==cur.simmable) evt("SIMMABLE_CHANGED",{...id,detail:{from:before.simmable,to:cur.simmable,nm},confidence:conf});
  const added=types.filter(t=>!(t in before.types));
  if(added.length) evt("TYPE_NEW",{...id,detail:{added,previously:Object.keys(before.types)},confidence:conf});
  const tot=o=>Object.values(o).reduce((x,y)=>x+y,0)||1;
  for(const t of new Set([...Object.keys(before.types),...types])){
   if(added.includes(t)) continue;
   const va=(before.types[t]??0)/tot(before.types), na=(cur.types[t]??0)/tot(cur.types);
   if(Math.abs(na-va)>=(S.type_share_delta??0.2))
    evt("TYPE_MIX_SHIFT",{...id,detail:{type:t,share_from:+va.toFixed(2),share_to:+na.toFixed(2)},confidence:conf});}
  if(before.dow.length && before.dow.sort().join()!==[...cur.dow].sort().join())
   evt("DOW_PATTERN_CHANGE",{...id,detail:{from:before.dow,to:cur.dow}});
  if(wasSusp) evt("RESUMED",{...id,detail:{resumed_on:cur.last_seen},confidence:conf});}
 LEDGER[key]=cur;}

for(const [key,x] of Object.entries(LEDGER)){
 if(touched.has(key)||x.state==="suspended") continue;
 x.missed=(x.missed??0)+1;
 if(x.missed>=(S.missed_before_suspend??3)){x.state="suspended";
  evt("SUSPENDED",{pair:x.pair,airline:x.airline,flight:x.flight,
   detail:{last_seen:x.last_seen,missed_opportunities:x.missed},
   confidence:`${x.missed} consecutive opportunities missed`});}}

const active=Object.values(LEDGER).filter(x=>x.state==="active");
const nowPairs=new Set(active.map(x=>x.pair));
for(const p of nowPairs) if(!prevPairs.has(p)) evt("PAIR_NEW",{pair:p,detail:{first_connection:true}});
for(const p of prevPairs) if(!nowPairs.has(p)) evt("PAIR_GONE",{pair:p,detail:{no_active_flight_line:true}});

const curS=seasonFor(iso(new Date())).label, othS=counter(curS);
for(const x of Object.values(LEDGER)){
 const A=x.seasons?.[curS],B=x.seasons?.[othS];
 const id={pair:x.pair,airline:x.airline,flight:x.flight,season:curS};
 if(A&&!B) evt("SEASON_NEW",{...id,detail:{observed:`${A.first} through ${A.last}`,days:A.days,counter_season:othS},confidence:"observed boundaries, not estimated"});
 else if(!A&&B) evt("SEASON_NOT_RETURNING",{...id,detail:{previous:`${B.first} through ${B.last}`,counter_season:othS}});
 else if(A&&B){
  const ta=Object.keys(A.types),tb=Object.keys(B.types);
  if(ta.some(t=>!tb.includes(t))||tb.some(t=>!ta.includes(t))) evt("SEASON_TYPE_SWAP",{...id,detail:{[curS]:ta,[othS]:tb}});
  if(A.std&&B.std&&A.std!==B.std) evt("SEASON_TIME_SHIFT",{...id,detail:{[curS]:A.std,[othS]:B.std}});}}

/* ---------- main matrix: airports you own only ---------- */
const pairRow=(x,y)=>{const p=pk(x,y),legs=active.filter(l=>l.pair===p);
 return {pair:p,from:ALL[x].name,to:ALL[y].name,nm:gcNm(ALL[x],ALL[y]),
  operators:[...new Set(legs.map(l=>l.airline))].sort(),
  types:[...new Set(legs.flatMap(l=>Object.keys(l.types)))].sort(),
  status:legs.length?legs.map(l=>l.status).sort().reverse()[0]:"NO SERVICE",
  simmable:legs.some(l=>l.simmable),cargo:legs.some(l=>l.cargo),
  legs:legs.map(l=>({airline:l.airline,flight:l.flight,types:l.types,status:l.status,
   days:l.days.length,std:l.std,sources:l.sources,seasons:l.seasons,first:l.first_seen,last:l.last_seen}))};};
const pairs=[];
for(let i=0;i<OWN.length;i++) for(let j=i+1;j<OWN.length;j++) pairs.push(pairRow(OWN[i],OWN[j]));
const served=pairs.filter(p=>p.status!=="NO SERVICE").length;

/* ---------- buy advice: network gain per candidate ---------- */
const OLDGAIN=load("data/candidates.json",{});
const candidates=[];
for(const c of CAND){
 const rows=OWN.map(o=>pairRow(c,o)).filter(r=>r.status!=="NO SERVICE");
 const gain={new_pairs:rows.length,
  match_pairs:rows.filter(r=>r.status.startsWith("MATCH")).length,
  simmable_pairs:rows.filter(r=>r.simmable).length,
  cargo_pairs:rows.filter(r=>r.cargo).length,
  connects:rows.map(r=>r.pair.split("-").find(x=>x!==c)).sort()};
 const meta=ALL[c];
 let prices=null;
 if(S.price_scrape && meta.price_urls){
  prices=[];
  for(const [store,url] of Object.entries(meta.price_urls)){
   const p=await scrapePrice(url); if(p) prices.push({store,...p,url});}
  prices.sort((a,b)=>a.price-b.price);
  const prev=OLDGAIN[c]?.prices?.[0]?.price;
  if(prev && prices[0] && prices[0].price < prev*0.95)
   evt("PRICE_DROP",{pair:c,detail:{from:prev,to:prices[0].price,store:prices[0].store}});}
 const prevGain=OLDGAIN[c]?.gain?.match_pairs;
 if(prevGain!==undefined && gain.match_pairs>prevGain)
  evt("CANDIDATE_GAIN_UP",{pair:c,detail:{from:prevGain,to:gain.match_pairs,
   note:"this purchase now unlocks more MATCH pairs than at the previous measurement"}});
 candidates.push({icao:c,iata:meta.iata,name:meta.name,focus:meta.focus??"pax",why:meta.why??null,
  known_developers:meta.known_developers??null,price_search:meta.price_search??null,
  prices,gain,routes:rows});}
candidates.sort((a,b)=>b.gain.match_pairs-a.gain.match_pairs || b.gain.new_pairs-a.gain.new_pairs);
writeFileSync("data/candidates.json",JSON.stringify(Object.fromEntries(
 candidates.map(c=>[c.icao,{gain:c.gain,prices:c.prices}])),null,1));

/* ---------- write everything out ---------- */
mkdirSync("data",{recursive:true}); mkdirSync("docs",{recursive:true});
writeFileSync("data/ledger.json",JSON.stringify(LEDGER,null,1));
writeFileSync(REGF,JSON.stringify(REG));
const allEv=[...events,...OLDEV].slice(0,3000);
writeFileSync("data/events.json",JSON.stringify(allEv,null,1));
const summary={generated:new Date().toISOString(),season:seasonFor(iso(new Date())),counter_season:othS,
 airports:OWN.length,candidates:CAND.length,pairs_possible:pairs.length,pairs_served:served,
 pairs_unserved:pairs.length-served,pairs_match:pairs.filter(p=>p.status.startsWith("MATCH")).length,
 pairs_simmable:pairs.filter(p=>p.simmable).length,cargo_pairs:pairs.filter(p=>p.cargo).length,
 flightlines:active.filter(l=>!l.candidate).length,
 suspended:Object.values(LEDGER).filter(x=>x.state==="suspended").length,new_events:events.length,
 price_scrape:!!S.price_scrape};
/* _prices is the English key; _prijzen is still read so an older config keeps working. */
writeFileSync("docs/data.json",JSON.stringify({summary,pairs,candidates,
 events:allEv.slice(0,800),fleet:CFG.fleet,airports:CFG.airports,
 prices_note:CFG._prices ?? CFG._prijzen ?? null}));

const md=[`## RouteWatch ${summary.generated.slice(0,16)}`,"",
 `- season **${summary.season.label}** (${summary.season.start} through ${summary.season.end})`,
 `- pairs with a connection: **${served}** of ${pairs.length}`,
 `- with MATCH: **${summary.pairs_match}** &middot; simmable: **${summary.pairs_simmable}**`,
 `- new changes: **${events.length}**`,"","### Buy advice by network gain",""];
for(const c of candidates.slice(0,6))
 md.push(`- **${c.icao} ${c.name}** (${c.focus}): +${c.gain.new_pairs} pairs, +${c.gain.match_pairs} with MATCH`
  + (c.prices?.[0]?` &middot; cheapest now ${c.prices[0].price} ${c.prices[0].currency??""} at ${c.prices[0].store}`:""));
md.push("");
for(const e of events.slice(0,40)) md.push(`- \`${e.kind}\` ${e.pair??""} ${e.airline??""} ${e.flight??""} - ${JSON.stringify(e.detail)}`);
writeFileSync("data/last-run.md",md.join("\n"));
if(process.env.ROUTEWATCH_WEBHOOK && events.length)
 await fetch(process.env.ROUTEWATCH_WEBHOOK,{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({text:md.join("\n")})}).catch(()=>{});
console.log(`done: ${served}/${pairs.length} pairs, ${events.length} changes, ${candidates.length} candidates`);
