/**
 * Phase 2 — GEOHASH: turning 2D coordinates into a 1D string. Run: npm run phase2
 *
 * A geohash interleaves the bits of latitude and longitude and base32-encodes
 * them. Two magic properties fall out:
 *
 *   • Each character narrows a rectangular CELL. More characters = smaller cell.
 *     "9q8yy" is a ~150m box; "9q8" is a ~150km box.
 *   • Nearby points usually share a PREFIX. So "find points near X" becomes
 *     "find points whose geohash starts with X's prefix" — a plain string range
 *     query any B-tree/Redis can do. That's why geohash is everywhere.
 *
 * THE BOUNDARY PROBLEM (the classic gotcha): two points can be meters apart but
 * sit on opposite sides of a cell edge, so their geohashes diverge at the very
 * first character and share NO prefix. A naive prefix search misses the neighbor.
 *
 * THE FIX: also search the 8 neighboring cells around the query cell. We show the
 * miss, then the fix.
 */

import { haversineKm, SF_PLACES } from "../lib/geo.ts";
import { log } from "../lib/log.ts";

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

function encode(lat: number, lng: number, precision = 7): string {
  let latR = [-90, 90], lngR = [-180, 180];
  let hash = "", bits = 0, bit = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lngR[0] + lngR[1]) / 2;
      if (lng >= mid) { bits = bits * 2 + 1; lngR[0] = mid; } else { bits *= 2; lngR[1] = mid; }
    } else {
      const mid = (latR[0] + latR[1]) / 2;
      if (lat >= mid) { bits = bits * 2 + 1; latR[0] = mid; } else { bits *= 2; latR[1] = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += BASE32[bits]; bits = 0; bit = 0; }
  }
  return hash;
}

/** Decode a geohash back to its center point and cell size (degrees). */
function decode(hash: string) {
  let latR = [-90, 90], lngR = [-180, 180], even = true;
  for (const ch of hash) {
    const idx = BASE32.indexOf(ch);
    for (let b = 4; b >= 0; b--) {
      const bit = (idx >> b) & 1;
      if (even) { const mid = (lngR[0] + lngR[1]) / 2; if (bit) lngR[0] = mid; else lngR[1] = mid; }
      else { const mid = (latR[0] + latR[1]) / 2; if (bit) latR[0] = mid; else latR[1] = mid; }
      even = !even;
    }
  }
  return { lat: (latR[0] + latR[1]) / 2, lng: (lngR[0] + lngR[1]) / 2, dLat: latR[1] - latR[0], dLng: lngR[1] - lngR[0] };
}

/** The query cell plus its 8 neighbors, computed by stepping one cell in each direction. */
function cellAndNeighbors(lat: number, lng: number, precision: number): string[] {
  const c = decode(encode(lat, lng, precision));
  const out = new Set<string>();
  for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1])
    out.add(encode(c.lat + dy * c.dLat, c.lng + dx * c.dLng, precision));
  return [...out];
}

function main() {
  const P = 6;
  log(`═══ Geohashes (precision ${P}) — nearby places share a prefix ═══`);
  for (const p of SF_PLACES.slice(0, 5)) log(`   ${p.name.padEnd(20)} ${encode(p.lat, p.lng, P)}`);
  log("   (Ferry Building & Coit Tower are close — compare how many leading chars match)");

  // ─── Boundary problem: construct two points that straddle a cell edge ──────
  log("");
  log("═══ The boundary problem ═══");
  // Take a cell, then place two points a few meters apart across its north edge.
  const cell = decode(encode(37.7749, -122.4194, P));
  const edgeLat = cell.lat + cell.dLat / 2; // the cell's northern boundary
  const a = { lat: edgeLat - cell.dLat * 0.02, lng: cell.lng }; // just inside
  const b = { lat: edgeLat + cell.dLat * 0.02, lng: cell.lng }; // just across the edge
  const ha = encode(a.lat, a.lng, P), hb = encode(b.lat, b.lng, P);
  let common = 0; while (common < P && ha[common] === hb[common]) common++;
  log(`   point A ${ha}   point B ${hb}   (only ${(haversineKm(a, b) * 1000).toFixed(0)}m apart)`);
  log(`   they fall in DIFFERENT cells (shared prefix ${common}/${P} chars) — an exact-cell`);
  log(`   lookup on A's cell "${ha}" would MISS B despite it being meters away.`);

  // ─── The fix: search the cell + its 8 neighbors ────────────────────────────
  log("");
  log("═══ The fix: search the query cell AND its 8 neighbors ═══");
  const cells = cellAndNeighbors(a.lat, a.lng, P);
  log(`   query covers ${cells.length} cells: ${cells.join(" ")}`);
  const bCell = encode(b.lat, b.lng, P);
  log(`   B's cell ${bCell} is ${cells.includes(bCell) ? "✓ included" : "❌ missed"} — the neighbor search catches it`);

  log("");
  log("Prefix = cheap proximity on any string index; the 8-neighbor search patches");
  log("the edge case. This is exactly how Redis GEO and most geo layers work.");
  process.exit(0);
}

main();
