/**
 * Phase 1 — DISTANCE & THE BRUTE-FORCE BASELINE. Run: npm run phase1
 *
 * Every "what's near me" feature starts with two things: a way to MEASURE
 * distance on a sphere, and the naive way to find the nearest points — so you
 * understand what a spatial index (Phases 2–4) actually buys you.
 *
 * DISTANCE — the Earth is a sphere, so you can't use flat Pythagoras on lat/lng.
 * The HAVERSINE formula gives the great-circle distance (the real "as the crow
 * flies" km). Good enough for proximity; routing/ETA needs a road graph (a
 * different problem — see the note at the end).
 *
 * kNN THE DUMB WAY — to find the nearest K, compute the distance to EVERY point,
 * sort, take K. Correct, and O(n) per query. Fine for 10 points; catastrophic for
 * 10 million driver locations at 100k queries/sec. That O(n) is the whole reason
 * spatial indexes exist.
 */

import { haversineKm, SF_PLACES, type Point } from "../lib/geo.ts";
import { log } from "../lib/log.ts";

/** Brute-force k nearest neighbours: measure everything, sort, slice. */
function nearestK(query: { lat: number; lng: number }, points: Point[], k: number) {
  return points
    .map((p) => ({ ...p, km: haversineKm(query, p) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, k);
}

function main() {
  const me = { lat: 37.7937, lng: -122.3965 }; // near the Embarcadero

  log("═══ Distance from one point to a few landmarks (haversine) ═══");
  for (const name of ["Ferry Building", "Twin Peaks", "Golden Gate Park"]) {
    const p = SF_PLACES.find((x) => x.name === name)!;
    log(`   ${name.padEnd(20)} ${haversineKm(me, p).toFixed(2)} km`);
  }

  log("");
  log("═══ Brute-force kNN: nearest 3 places to me (scan all, sort, take 3) ═══");
  const comparisons = SF_PLACES.length;
  for (const p of nearestK(me, SF_PLACES, 3)) log(`   ${p.name.padEnd(20)} ${p.km.toFixed(2)} km`);
  log(`   (computed ${comparisons} distances for ${SF_PLACES.length} points — O(n) per query)`);

  log("");
  log("With 10 points this is instant. The problem is scale: O(n) per query means");
  log("a million points × thousands of queries/sec = melt. Phases 2–4 build indexes");
  log("that only look at points NEAR the query. (For driving time, not straight-line");
  log("distance, you'd swap haversine for a routing graph — a separate problem.)");
  process.exit(0);
}

main();
