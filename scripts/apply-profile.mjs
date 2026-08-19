#!/usr/bin/env node
/**
 * apply-profile.mjs - decides what docs/data.json is allowed to contain.
 *
 *   PUBLISH_PROFILE=restricted node scripts/apply-profile.mjs   (default)
 *   PUBLISH_PROFILE=full       node scripts/apply-profile.mjs
 *   node scripts/apply-profile.mjs --dry-run                    report only
 *
 * Why a separate script
 * ---------------------
 * routewatch.mjs writes docs/data.json with complete legs: flight numbers,
 * scheduled departure times and per-season records. The retention audit flags that
 * file because GitHub Pages serves everything under docs/, so those fields are
 * published Contents under Article 5.5.
 *
 * Rewriting routewatch.mjs to strip them would mean replacing a 22 KB file to
 * change a few lines, which is exactly the kind of risky edit we avoid for scripts
 * that carry real logic. This runs AFTER routewatch.mjs instead and rewrites the
 * one artifact that gets published. routewatch.mjs stays byte-for-byte untouched,
 * and its own data/ledger.json keeps every field, so nothing is lost locally.
 *
 * The point of the two profiles
 * -----------------------------
 * Everything is built and working now, on the assumption that permission will be
 * granted. Release then becomes a single flag flip rather than a migration:
 *
 *   restricted  what a public site may serve today. Aggregates, classifications,
 *               distances and counts - all computed by RouteWatch, which Article
 *               5.6 treats as a Derived Work.
 *   full        adds the immersion fields back. Only switch to this once written
 *               permission covers showing them, matching the same gate that keeps
 *               community-immersion.json out of docs/.
 *
 * restricted is the default deliberately. A profile you have to remember to set is
 * not a safeguard.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const FILE = "docs/data.json";
const PROFILE = (process.env.PUBLISH_PROFILE ?? "restricted").toLowerCase();
const DRY = process.argv.includes("--dry-run");
const LOG = (...a) => console.log("[profile]", ...a);
const kb = n => Math.round(n / 1024) + " kB";

if (!existsSync(FILE)) {
  console.error(`[profile] ${FILE} not found - run routewatch.mjs first`);
  process.exit(1);
}
if (PROFILE !== "restricted" && PROFILE !== "full") {
  console.error(`[profile] PUBLISH_PROFILE must be "restricted" or "full", got "${PROFILE}"`);
  process.exit(1);
}

const before = readFileSync(FILE, "utf8");
let D;
try {
  D = JSON.parse(before);
} catch (e) {
  console.error(`[profile] cannot parse ${FILE}: ${e.message}`);
  process.exit(1);
}

/* What is actually in there right now, so the log states facts, not guesses. */
const legCount = (D.pairs ?? []).reduce((n, p) => n + (p.legs?.length ?? 0), 0);
const candLegCount = (D.candidates ?? [])
  .reduce((n, c) => n + (c.routes ?? []).reduce((m, r) => m + (r.legs?.length ?? 0), 0), 0);
const seasonBlocks = (D.pairs ?? [])
  .reduce((n, p) => n + (p.legs ?? []).filter(l => l.seasons && Object.keys(l.seasons).length).length, 0);
const eventsWithFlight = (D.events ?? []).filter(e => e.flight && e.flight !== "?").length;

LOG(`${FILE} is ${kb(before.length)} with ${(D.pairs ?? []).length} pairs, `
  + `${legCount} legs, ${candLegCount} candidate-route legs, ${seasonBlocks} legs carrying season records, `
  + `${eventsWithFlight} events naming a flight`);

if (PROFILE === "full") {
  LOG("profile full: leaving every field in place");
  LOG("reminder: this publishes flight numbers, departure times and per-season records "
    + "through GitHub Pages. Only correct once written permission covers it.");
  if (DRY) LOG("--dry-run: nothing written");
  process.exit(0);
}

/* ---------------------------------------------------------------- restricted */

let removedLegs = 0, removedCandLegs = 0, strippedEvents = 0;

for (const p of D.pairs ?? []) {
  if (Array.isArray(p.legs)) {
    removedLegs += p.legs.length;
    /* Keep the shape of the field so a consumer can tell the difference between
     * "no service" and "detail withheld", instead of silently seeing nothing. */
    p.leg_count = p.legs.length;
    delete p.legs;
  }
}

for (const c of D.candidates ?? []) {
  for (const r of c.routes ?? []) {
    if (Array.isArray(r.legs)) {
      removedCandLegs += r.legs.length;
      r.leg_count = r.legs.length;
      delete r.legs;
    }
  }
}

/* Events are the second, less obvious leak: a ROUTE_NEW record names the airline
 * and flight number just as plainly as a leg does. The event kind, severity,
 * timestamp and pair are my own analysis and stay. */
for (const e of D.events ?? []) {
  let touched = false;
  if (e.flight !== undefined) { delete e.flight; touched = true; }
  if (e.airline !== undefined) { delete e.airline; touched = true; }
  if (e.detail && typeof e.detail === "object") {
    for (const k of ["std", "flight", "types", "added", "previously", "type", "observed", "previous"]) {
      if (e.detail[k] !== undefined) { delete e.detail[k]; touched = true; }
    }
  }
  if (touched) strippedEvents++;
}

D._profile = "restricted";
D._profile_note =
  "Flight-level detail is withheld from this published file. Legs, flight numbers, "
  + "scheduled times, per-season records and per-flight event details are removed; "
  + "counts, classifications, distances and candidate gains remain, because those are "
  + "computed by RouteWatch. Set PUBLISH_PROFILE=full to restore the detail, but only "
  + "once written permission covers publishing it.";
D._profile_removed = {
  legs: removedLegs,
  candidate_route_legs: removedCandLegs,
  events_stripped: strippedEvents
};

const after = JSON.stringify(D);
LOG(`restricted: removed ${removedLegs} legs, ${removedCandLegs} candidate-route legs, `
  + `stripped ${strippedEvents} events`);
LOG(`size ${kb(before.length)} -> ${kb(after.length)}`);
LOG(`kept: summary, airports, fleet, airlines, ${(D.pairs ?? []).length} pair rows with `
  + `nm, status, simmable, cargo and leg_count, plus ${(D.candidates ?? []).length} candidate gains`);
LOG("note: data/ledger.json still holds every field, so nothing is lost locally");

if (DRY) {
  LOG("--dry-run: nothing written");
  process.exit(0);
}

writeFileSync(FILE, after);
LOG(`wrote ${FILE}`);
