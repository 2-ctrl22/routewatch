#!/usr/bin/env node
/**
 * run-enrich.mjs - safe English-language wrapper for enrich-adb.mjs.
 *
 * Why a wrapper instead of rewriting enrich-adb.mjs?
 * The enrichment code spends paid API units, manages two independent 429 backoff
 * sections, and has a priority rotation over flight numbers. GitHub's file tool
 * replaces a whole file; it cannot apply a surgical text patch. Keeping the
 * original byte-for-byte intact avoids accidentally changing quota or retry logic
 * just to translate a log message.
 *
 * This wrapper runs the original process unchanged and translates only stdout and
 * stderr on their way to the GitHub Actions log. Exit code and all files written
 * by enrich-adb.mjs pass through exactly as before.
 */
import { spawn } from "node:child_process";

const MAP=[
  [/geen RAPIDAPI_KEY - verrijking overgeslagen/g,"no RAPIDAPI_KEY - enrichment skipped"],
  [/config\/collection\.json onbruikbaar of leeg/g,"config/collection.json unreadable or empty"],
  [/config: (\d+) velden, missed_before_suspend =/g,"config: $1 airports, missed_before_suspend ="],
  [/niet gezet \(script gebruikt 3\)/g,"not set (script uses 3)"],
  [/WAARSCHUWING:/g,"WARNING:"],
  [/Met roterende vensters is 6 of hoger nodig\./g,"With rotating windows, 6 or higher is needed."],
  [/banensectie staat uit/g,"runway section is disabled"],
  [/banensectie: alle (\d+) velden zitten al in de cache, 0 units/g,"runway section: all $1 airports are already cached, 0 units"],
  [/banensectie: nog (\d+) van (\d+) velden te doen/g,"runway section: $1 of $2 airports still to do"],
  [/unitplafond (\d+) bereikt na (\d+) units - (.*) en de rest overgeslagen/g,"unit cap $1 reached after $2 units - $3 and the rest skipped"],
  [/niet gevonden of endpointvorm klopt niet/g,"not found or endpoint form is incorrect"],
  [/429 - (\d+)s wachten, poging (\d+)/g,"429 - waiting $1s, attempt $2"],
  [/429 blijft - deze sectie stopt, andere secties gaan door/g,"429 persists - this section stops, other sections continue"],
  [/sleutel niet geabonneerd, hele run stopt/g,"key not subscribed, entire run stops"],
  [/banen, langste/g,"runways, longest"],
  [/airports-meta\.json: (\d+) van (\d+) velden, (\d+) nieuw/g,"airports-meta.json: $1 of $2 airports, $3 new"],
  [/sectie gestopt op 429/g,"section stopped on 429"],
  [/registraties, (\d+) nieuw/g,"registrations, $1 new"],
  [/geen registraties in de ledger/g,"no registrations in the ledger"],
  [/kandidaten: (\d+) unieke vluchtnummers/g,"candidates: $1 unique flight numbers"],
  [/gemengde vloot/g,"mixed fleet"],
  [/zonder type/g,"without type"],
  [/overig/g,"other"],
  [/bij (\d+) per week: urgente groep rond in (\d+) weken, alles in (\d+) weken/g,"at $1 per week: urgent group complete in $2 weeks, all complete in $3 weeks"],
  [/nog geen vluchtnummers in de ledger - draai eerst collect-adb en routewatch/g,"no flight numbers in the ledger yet - run collect-adb and RouteWatch first"],
  [/nummers deze run, cursor/g,"numbers this run, cursor"],
  [/ronde/g,"round"],
  [/GEMENGDE VLOOT/g,"MIXED FLEET"],
  [/klaar: (\d+) units verbruikt/g,"done: $1 units used"]
];
const translate=s=>MAP.reduce((out,[from,to])=>out.replace(from,to),s);

const child=spawn(process.execPath,["scripts/enrich-adb.mjs"],{
  stdio:["inherit","pipe","pipe"],env:process.env
});
child.stdout.on("data",d=>process.stdout.write(translate(d.toString())));
child.stderr.on("data",d=>process.stderr.write(translate(d.toString())));
child.on("error",e=>{console.error("[run-enrich] could not start enrich-adb.mjs:",e.message);process.exit(1);});
child.on("close",code=>process.exit(code??1));
