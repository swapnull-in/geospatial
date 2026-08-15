/**
 * Phase 6 — S2 / HILBERT CURVE: the space-filling curve done right. Run: node "src/phase6/s2-hilbert.ts"
 *
 * Phase 2's geohash walks space along the Z-ORDER (Morton) curve: interleave the
 * bits of x and y and you get a 1-D index. It's simple, but the "Z" shape SNAPS
 * BACK — when the curve finishes one quadrant it leaps across the whole grid to
 * start the next. Those long jumps mean two cells that are ADJACENT on the curve
 * can be far apart on the map (and vice-versa), so a 1-D range query drags in
 * false candidates you must throw away.
 *
 * Google's S2 uses the HILBERT curve instead. Three things fall out of that choice:
 *
 *   A) LOCALITY — the Hilbert curve NEVER jumps: consecutive cells are always
 *      edge-adjacent (grid distance exactly 1). We walk both curves over a 16×16
 *      grid and MEASURE the jumps. Z-order has big snap-backs; Hilbert has none.
 *      Better locality ⇒ tighter 1-D ranges ⇒ fewer false candidates to re-rank.
 *
 *   B) HIERARCHICAL CELLS — because the Hilbert curve is self-similar, a cell's
 *      index is HIERARCHICAL: the PARENT is just a bit-truncation of the child
 *      (drop 2 bits = go up one level, since each level has 4 children). That's
 *      how an S2CellId rolls a fine dispatch cell up to a coarse surge cell with
 *      a shift — no re-indexing. We aggregate 4 children into their parent.
 *
 *   C) REGION COVER — given an arbitrary shape (here a query circle), return the
 *      MINIMAL set of cells that covers it. Geohash fans out a fixed 3×3 of
 *      same-size cells; S2 picks whatever cells actually touch the shape (and in
 *      real S2, mixes levels — big cells inside, small cells on the rim). We
 *      cover the disk, then re-rank hits by true Haversine (the cover over-covers
 *      the corners, so the cell set is a CANDIDATE filter, not the final answer).
 *
 * TAKEAWAY: geohash rides the Z-order curve (occasional long jumps, fixed-precision
 * prefixes); S2 rides the Hilbert curve (never jumps — better locality → tighter
 * ranges, fewer false candidates) plus hierarchical cells (parent = bit-truncation,
 * so dispatch cells roll up to surge cells for free) and region cover (the minimal,
 * adaptive, multi-level cell set for any shape). Reach for S2 when you need
 * hierarchical roll-up or region-cover — not just "find me the nearest thing".
 */

import { haversineKm, SF_PLACES } from "../lib/geo.ts";
import { log } from "../lib/log.ts";

// ─── Deterministic PRNG (seeded) so the surge demand numbers never drift ───────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── A) The two space-filling curves ───────────────────────────────────────────

/** Z-ORDER (Morton): interleave the bits of x and y — the same trick geohash uses. */
function zEncode(x: number, y: number, bitsPerAxis: number): number {
  let d = 0;
  for (let b = 0; b < bitsPerAxis; b++) {
    d |= ((x >> b) & 1) << (2 * b);
    d |= ((y >> b) & 1) << (2 * b + 1);
  }
  return d;
}
function zDecode(d: number, bitsPerAxis: number): [number, number] {
  let x = 0, y = 0;
  for (let b = 0; b < bitsPerAxis; b++) {
    x |= ((d >> (2 * b)) & 1) << b;
    y |= ((d >> (2 * b + 1)) & 1) << b;
  }
  return [x, y];
}

/** Rotate/reflect a quadrant — the heart of the Hilbert recursion (Wikipedia's rot). */
function hRot(n: number, x: number, y: number, rx: number, ry: number): [number, number] {
  if (ry === 0) {
    if (rx === 1) { x = n - 1 - x; y = n - 1 - y; }
    return [y, x]; // swap
  }
  return [x, y];
}
/** HILBERT xy2d: (x,y) → distance along the curve on an n×n grid (n a power of two). */
function hEncode(n: number, x: number, y: number): number {
  let d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    [x, y] = hRot(s, x, y, rx, ry);
  }
  return d;
}
/** HILBERT d2xy: distance along the curve → (x,y). */
function hDecode(n: number, d: number): [number, number] {
  let x = 0, y = 0, t = d;
  for (let s = 1; s < n; s <<= 1) {
    const rx = 1 & (t >> 1);
    const ry = 1 & (t ^ rx);
    [x, y] = hRot(s, x, y, rx, ry);
    x += s * rx;
    y += s * ry;
    t >>= 2;
  }
  return [x, y];
}

/** Walk a curve cell-by-cell and record the grid Manhattan jump between neighbours. */
function measureLocality(n: number, decode: (d: number) => [number, number]) {
  let max = 0, longJumps = 0;
  let [px, py] = decode(0);
  for (let d = 1; d < n * n; d++) {
    const [x, y] = decode(d);
    const jump = Math.abs(x - px) + Math.abs(y - py);
    if (jump > max) max = jump;
    if (jump > 1) longJumps++;
    [px, py] = [x, y];
  }
  return { max, longJumps, steps: n * n - 1 };
}

// ─── Geo grid: map an SF bounding box onto a 2^LEVEL × 2^LEVEL cell grid ─────────
const LEVEL = 4;                 // dispatch level: 16×16 = 256 cells
const N = 1 << LEVEL;            // side length = 16
const BBOX = { latMin: 37.74, latMax: 37.82, lngMin: -122.50, lngMax: -122.37 };

const lngToX = (lng: number) => Math.min(N - 1, Math.max(0, Math.floor((lng - BBOX.lngMin) / (BBOX.lngMax - BBOX.lngMin) * N)));
const latToY = (lat: number) => Math.min(N - 1, Math.max(0, Math.floor((lat - BBOX.latMin) / (BBOX.latMax - BBOX.latMin) * N)));

/** The lat/lng rectangle covered by grid cell (x,y). */
function cellRect(x: number, y: number) {
  const lngMin = BBOX.lngMin + (x / N) * (BBOX.lngMax - BBOX.lngMin);
  const lngMax = BBOX.lngMin + ((x + 1) / N) * (BBOX.lngMax - BBOX.lngMin);
  const latMin = BBOX.latMin + (y / N) * (BBOX.latMax - BBOX.latMin);
  const latMax = BBOX.latMin + ((y + 1) / N) * (BBOX.latMax - BBOX.latMin);
  return { lngMin, lngMax, latMin, latMax };
}

/** Closest-point test: does cell (x,y)'s rectangle come within `radiusKm` of `center`? */
function cellIntersectsDisk(x: number, y: number, center: { lat: number; lng: number }, radiusKm: number): boolean {
  const r = cellRect(x, y);
  const nearLng = Math.min(r.lngMax, Math.max(r.lngMin, center.lng));
  const nearLat = Math.min(r.latMax, Math.max(r.latMin, center.lat));
  return haversineKm(center, { lat: nearLat, lng: nearLng }) <= radiusKm;
}

const bin = (v: number, width: number) => v.toString(2).padStart(width, "0");

function main() {
  // ─── A) HILBERT vs Z-ORDER LOCALITY ──────────────────────────────────────────
  log(`═══ A) Locality on a ${N}×${N} grid — walk the curve, measure each jump ═══`);
  const z = measureLocality(N, (d) => zDecode(d, LEVEL));
  const h = measureLocality(N, (d) => hDecode(N, d));
  log(`   Z-ORDER (Morton, what geohash uses): max jump ${z.max} cells, ${z.longJumps} long jumps (>1) over ${z.steps} steps`);
  log(`   HILBERT (what S2 uses):              max jump ${h.max} cells, ${h.longJumps} long jumps (>1) over ${h.steps} steps`);
  log(`   → Hilbert's consecutive cells are ALWAYS edge-adjacent. Z-order snaps back`);
  log(`     across quadrants ${z.longJumps} times (worst leap ${z.max} cells) — those gaps become`);
  log(`     false candidates a 1-D range query has to fetch and discard.`);

  // ─── B) HIERARCHICAL CELLS — parent = bit-truncation ─────────────────────────
  log("");
  log("═══ B) Hierarchical cells — the parent is a bit-truncation of the child ═══");
  const place = SF_PLACES.find((p) => p.name === "Union Square")!;
  const cx = lngToX(place.lng), cy = latToY(place.lat);
  const fine = hEncode(N, cx, cy);                 // level-4 id, 8 bits
  const parent = fine >> 2;                          // level-3 id: drop one level (4 children)
  const surge = fine >> 4;                           // level-2 id: drop two levels
  const [px3, py3] = hDecode(N >> 1, parent);        // decode parent on the 8×8 grid
  const [sx2, sy2] = hDecode(N >> 2, surge);         // decode surge on the 4×4 grid
  log(`   ${place.name} → dispatch cell (x=${cx}, y=${cy})  id L4 = ${bin(fine, 8)} (${fine})`);
  log(`     >>2  parent   L3 = ${bin(parent, 6).padStart(8)} (${parent})  → 8×8 cell (${px3},${py3})`);
  log(`     >>4  surge    L2 = ${bin(surge, 4).padStart(8)} (${surge})  → 4×4 cell (${sx2},${sy2})`);
  log("   Rolling a fine cell up to a coarse one is a SHIFT — no lookup, no re-indexing.");

  // Roll-up: seed a demand count per fine cell, aggregate 4 children into their parent.
  const rng = mulberry32(42);
  const demand = new Map<number, number>();
  for (let d = 0; d < N * N; d++) demand.set(d, 1 + Math.floor(rng() * 20));
  const surgeParent = fine >> 2;                      // the level-3 parent above Union Square
  const children = [0, 1, 2, 3].map((k) => surgeParent * 4 + k);
  const rolled = children.reduce((sum, c) => sum + (demand.get(c) ?? 0), 0);
  log(`   roll-up: parent L3 id ${surgeParent} aggregates its 4 children ${JSON.stringify(children)}`);
  log(`            child demand ${JSON.stringify(children.map((c) => demand.get(c)))}  →  parent total ${rolled} rides`);

  // ─── C) REGION COVER — minimal cell set for a query circle ────────────────────
  log("");
  log("═══ C) Region cover — minimal cells touching a query circle ═══");
  const center = SF_PLACES.find((p) => p.name === "Ferry Building")!;
  const radiusKm = 1.2;
  const cover: Array<{ x: number; y: number; id: number }> = [];
  // Only scan the grid rows/cols that the disk's bounding box can reach.
  for (let x = 0; x < N; x++)
    for (let y = 0; y < N; y++)
      if (cellIntersectsDisk(x, y, center, radiusKm)) cover.push({ x, y, id: hEncode(N, x, y) });
  cover.sort((a, b) => a.id - b.id); // sorted by Hilbert id ⇒ ready for a 1-D range scan
  log(`   query: ${radiusKm}km around ${center.name} — cover is ${cover.length} cells (of ${N * N})`);
  log(`   Hilbert ids in cover: ${cover.map((c) => c.id).join(" ")}`);
  log("   (contrast: geohash always fans out a fixed 3×3 = 9 same-size cells; S2 picks");
  log("    only the cells that touch the shape — and in production mixes big/small levels.)");

  // Re-rank: the cover over-covers corners, so verify each candidate with true Haversine.
  log("");
  log("   the cover is a CANDIDATE filter — re-rank by true Haversine to drop corner false-positives:");
  const covered = new Set(cover.map((c) => c.id));
  const candidates = SF_PLACES.filter((p) => covered.has(hEncode(N, lngToX(p.lng), latToY(p.lat))));
  for (const p of candidates) {
    const dist = haversineKm(center, p);
    const inside = dist <= radiusKm;
    log(`     ${p.name.padEnd(20)} ${dist.toFixed(2)}km  ${inside ? "✓ within radius" : "✗ in a covered cell but outside the disk"}`);
  }

  log("");
  log("Z-order is cheap and fine for prefix proximity; Hilbert + hierarchical ids +");
  log("region cover are why S2 wins when you need roll-up or arbitrary-shape coverage.");
  process.exit(0);
}

main();
