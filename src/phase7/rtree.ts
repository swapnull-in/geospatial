/**
 * Phase 7 — R-TREE: point-in-polygon AT SCALE, indexing EXTENTS by their MBR.
 * Run: npm run phase7  (or: node "src/phase7/rtree.ts")
 *
 * Phase 5 answered "am I inside this ONE zone?" by ray-casting a single polygon.
 * This is its "at scale" sibling: you have MANY zones (delivery areas, surge-
 * pricing regions, school districts, flood plains) and one point, and you must
 * find WHICH zone(s) contain it — without ray-casting all million polygons.
 *
 * The trick is the same one the quadtree used in Phase 3, extended from points to
 * RECTANGLES. Every polygon gets a MINIMUM BOUNDING RECTANGLE (MBR): the smallest
 * axis-aligned box (min/max lat, min/max lng) that encloses it. We index the MBRs
 * in an R-TREE — a balanced tree whose leaves hold polygon MBRs and whose interior
 * nodes hold an MBR that ENCLOSES all their children. To find the zone under a
 * point you descend only the nodes whose MBR CONTAINS the point and prune every
 * other subtree, exactly like the quadtree pruned quadrants that couldn't match.
 * (Where the quadtree partitions POINTS into disjoint quadrants, the R-tree groups
 * arbitrary RECTANGLES — and those groups' MBRs may OVERLAP, which is the whole
 * story below.) This is the index behind PostGIS / PostgreSQL's GiST.
 *
 * TWO PHASES, ALWAYS:
 *   1. FILTER — cheap. Descend the tree by MBR containment; collect the handful of
 *      candidate polygons whose MBR contains the point. Skips the rest for free.
 *   2. REFINE — exact. Ray-cast (Phase 5's even-odd test) only those candidates.
 *   The MBR is a rectangle; a real zone is not. An MBR hit is a MAYBE, never a yes.
 *
 * WHY MBRs OVERLAP (the cost R*-trees fight): two rectangles that enclose different
 * groups of zones can still overlap in space, so a single query point may sit in
 * several nodes' MBRs and the search must follow MULTIPLE paths. Plain bulk-loading
 * (we sort by Hilbert-curve order, below) keeps spatially-near zones in the same
 * leaf to limit this; the R*-tree's insert/split heuristics go further, explicitly
 * MINIMIZING node overlap and coverage area. We keep it simple — no R*-splits — and
 * just note where that effort would go.
 *
 * CURVE METHODS vs R-TREES — name which problem you have:
 *   • Points → space-filling CURVES (geohash Phase 2, S2). "Nearest drivers?" →
 *     geohash prefix / neighbor cells. Curves index LOCATIONS.
 *   • Extents → R-TREES. "Which delivery / surge / district polygon contains this
 *     point, or intersects this map window?" → point-in-polygon over regions.
 *     R-trees index AREAS.
 *   Using a proximity index for a containment question (or vice versa) is the
 *   classic geo mistake Phase 5 warned about.
 *
 * TAKEAWAY: An R-tree indexes EXTENTS by their bounding rectangle and answers
 * "which region contains this point / intersects this window?" by descending only
 * the nodes whose MBR overlaps the query — point-in-polygon at scale (PostGIS /
 * GiST). The MBR is a cheap FILTER, never the answer: always refine with the exact
 * geometry (ray casting). Curve methods index POINTS; R-trees index POLYGONS —
 * name which problem you have before you pick the index.
 */

import { log } from "../lib/log.ts";

// lng is the x-axis, lat is the y-axis — matches Phase 5's ray-casting convention.
interface LngLat { lng: number; lat: number }
interface Mbr { minLng: number; maxLng: number; minLat: number; maxLat: number }
interface Zone { name: string; verts: LngLat[]; mbr: Mbr }

// R-tree node: a leaf holds zones; an interior node holds child nodes. Either way
// `mbr` is the box enclosing everything beneath it. (No classes / constructor
// parameter properties — plain data + functions, like Phase 5.)
interface RNode {
  leaf: boolean;
  mbr: Mbr;
  zones?: Zone[];
  children?: RNode[];
}

// ── Geometry ────────────────────────────────────────────────────────────────

/** Smallest axis-aligned box enclosing a set of vertices — the polygon's MBR. */
function mbrOf(verts: LngLat[]): Mbr {
  const lngs = verts.map((v) => v.lng), lats = verts.map((v) => v.lat);
  return { minLng: Math.min(...lngs), maxLng: Math.max(...lngs), minLat: Math.min(...lats), maxLat: Math.max(...lats) };
}

/** Union of MBRs — the box a parent node needs to enclose all its children. */
function unionMbr(boxes: Mbr[]): Mbr {
  return {
    minLng: Math.min(...boxes.map((b) => b.minLng)),
    maxLng: Math.max(...boxes.map((b) => b.maxLng)),
    minLat: Math.min(...boxes.map((b) => b.minLat)),
    maxLat: Math.max(...boxes.map((b) => b.maxLat)),
  };
}

const mbrContains = (b: Mbr, p: LngLat) =>
  p.lng >= b.minLng && p.lng <= b.maxLng && p.lat >= b.minLat && p.lat <= b.maxLat;

const mbrCenter = (b: Mbr): LngLat => ({ lng: (b.minLng + b.maxLng) / 2, lat: (b.minLat + b.maxLat) / 2 });

/**
 * Ray-casting point-in-polygon (even-odd rule) — the exact test, mirrored from
 * Phase 5. Shoot a rightward ray; ODD edge-crossings ⇒ inside. This is the REFINE
 * step; the MBR check above is only the cheap FILTER.
 */
function pointInPolygon(pt: LngLat, poly: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    const straddles = (a.lat > pt.lat) !== (b.lat > pt.lat);
    if (straddles) {
      const lngCross = a.lng + ((pt.lat - a.lat) / (b.lat - a.lat)) * (b.lng - a.lng);
      if (pt.lng < lngCross) inside = !inside;
    }
  }
  return inside;
}

// ── Deterministic zone generation ─────────────────────────────────────────────

/** mulberry32 PRNG — seeded, so every run produces the identical zone layout. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeZone(name: string, verts: LngLat[]): Zone {
  return { name, verts, mbr: mbrOf(verts) };
}

/** An axis-aligned square zone (for a square, MBR == the polygon itself). */
function squareZone(name: string, cLat: number, cLng: number, half: number): Zone {
  return makeZone(name, [
    { lng: cLng - half, lat: cLat - half },
    { lng: cLng + half, lat: cLat - half },
    { lng: cLng + half, lat: cLat + half },
    { lng: cLng - half, lat: cLat + half },
  ]);
}

function buildZones(): Zone[] {
  const rng = mulberry32(1337);
  const zones: Zone[] = [];

  // 14 non-overlapping filler zones on a grid across SF's west/south side — the
  // "haystack" that MBR pruning skips. Seeded sizes keep the run reproducible.
  const rows = [37.744, 37.756, 37.768];
  const cols = [-122.485, -122.473, -122.461, -122.449, -122.437];
  const centers: Array<[number, number]> = [];
  for (const lat of rows) for (const lng of cols) centers.push([lat, lng]);
  for (let i = 0; i < 14; i++) {
    const [lat, lng] = centers[i];
    const half = 0.0035 + rng() * 0.002; // < half the grid spacing ⇒ no overlap
    zones.push(squareZone(`zone ${String(i + 1).padStart(2, "0")}`, lat, lng, half));
  }

  // Three OVERLAPPING surge zones around Union Square — realistic: promo/surge
  // regions stack. Their MBRs all cover the same point, so the query follows
  // multiple paths (Demo A).
  zones.push(squareZone("surge zone Alpha", 37.788, -122.4074, 0.006));
  zones.push(squareZone("surge zone Bravo", 37.790, -122.405, 0.005));
  zones.push(squareZone("surge zone Charlie", 37.786, -122.409, 0.005));

  // One CONCAVE, L-shaped delivery zone in the Mission (same shape as Phase 5).
  // Its MBR covers the notch, but the notch is OUTSIDE the polygon (Demo B).
  zones.push(makeZone("Mission L-zone", [
    { lng: -122.420, lat: 37.760 },
    { lng: -122.408, lat: 37.760 },
    { lng: -122.408, lat: 37.766 },
    { lng: -122.414, lat: 37.766 },
    { lng: -122.414, lat: 37.772 },
    { lng: -122.420, lat: 37.772 },
  ]));

  return zones;
}

// ── R-tree bulk-load (sort by Hilbert order, group into nodes of capacity M) ──

/**
 * Hilbert index of an integer grid cell (Wikipedia xy2d). Ordering leaves along a
 * space-filling curve keeps spatially-near zones in the same leaf, so leaf MBRs
 * stay small and overlap little — a cheap stand-in for the R*-tree's split
 * heuristics. `n` must be a power of two.
 */
function hilbertIndex(n: number, x: number, y: number): number {
  let d = 0;
  for (let s = n >> 1; s > 0; s = s >> 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = n - 1 - x; y = n - 1 - y; }
      const t = x; x = y; y = t;
    }
  }
  return d;
}

/** Bulk-load: Hilbert-sort the zones, pack M per leaf, then pack M nodes per parent. */
function bulkLoad(zones: Zone[], M = 4): RNode {
  const N = 1 << 10; // 1024×1024 Hilbert grid
  const centers = zones.map((z) => mbrCenter(z.mbr));
  const minLng = Math.min(...centers.map((c) => c.lng)), maxLng = Math.max(...centers.map((c) => c.lng));
  const minLat = Math.min(...centers.map((c) => c.lat)), maxLat = Math.max(...centers.map((c) => c.lat));
  const norm = (v: number, lo: number, hi: number) => (hi === lo ? 0 : Math.round(((v - lo) / (hi - lo)) * (N - 1)));

  const ordered = zones
    .map((z) => {
      const c = mbrCenter(z.mbr);
      return { z, h: hilbertIndex(N, norm(c.lng, minLng, maxLng), norm(c.lat, minLat, maxLat)) };
    })
    .sort((a, b) => a.h - b.h)
    .map((e) => e.z);

  // Pack sorted zones into leaves of capacity M.
  let level: RNode[] = [];
  for (let i = 0; i < ordered.length; i += M) {
    const group = ordered.slice(i, i + M);
    level.push({ leaf: true, zones: group, mbr: unionMbr(group.map((z) => z.mbr)) });
  }
  // Pack nodes into parents until a single root remains.
  while (level.length > 1) {
    const next: RNode[] = [];
    for (let i = 0; i < level.length; i += M) {
      const group = level.slice(i, i + M);
      next.push({ leaf: false, children: group, mbr: unionMbr(group.map((n) => n.mbr)) });
    }
    level = next;
  }
  return level[0];
}

function countNodes(node: RNode): number {
  return node.leaf ? 1 : 1 + (node.children ?? []).reduce((s, c) => s + countNodes(c), 0);
}

// ── The two-phase query ───────────────────────────────────────────────────────

interface QueryStats { nodesVisited: number; exactTests: number }

/**
 * "Which zone(s) contain this point?" Descend only nodes whose MBR contains the
 * point (PRUNE the rest — this is the win). At a leaf, use each zone's MBR as a
 * cheap FILTER, then ray-cast (REFINE) only the survivors.
 */
function zonesContaining(node: RNode, pt: LngLat, stats: QueryStats): Zone[] {
  stats.nodesVisited++;
  if (!mbrContains(node.mbr, pt)) return []; // PRUNE: nothing under here can match
  const hits: Zone[] = [];
  if (node.leaf) {
    for (const z of node.zones ?? []) {
      if (mbrContains(z.mbr, pt)) {          // 1. FILTER (cheap rectangle test)
        stats.exactTests++;
        if (pointInPolygon(pt, z.verts)) hits.push(z); // 2. REFINE (exact ray cast)
      }
    }
  } else {
    for (const c of node.children ?? []) hits.push(...zonesContaining(c, pt, stats));
  }
  return hits;
}

// ── Demo ──────────────────────────────────────────────────────────────────────

function main() {
  const zones = buildZones();
  const tree = bulkLoad(zones, 4);
  const totalNodes = countNodes(tree);

  log(`═══ R-tree over ${zones.length} delivery/surge zones (leaf capacity 4, ${totalNodes} nodes) ═══`);
  log("");

  // ── A) MBR PRUNING ──────────────────────────────────────────────────────────
  log("─── A) MBR PRUNING: 'which zone contains this point?' ───");
  const qA: LngLat = { lng: -122.4074, lat: 37.788 }; // Union Square
  const statsA: QueryStats = { nodesVisited: 0, exactTests: 0 };
  const hitsA = zonesContaining(tree, qA, statsA);
  log(`   query point: Union Square (${qA.lat}, ${qA.lng})`);
  log(`   exact ray-casts run: ${statsA.exactTests} of ${zones.length} zones  ` +
    `(MBR pruning skipped ${zones.length - statsA.exactTests})`);
  log(`   tree nodes visited:  ${statsA.nodesVisited} of ${totalNodes}`);
  log(`   → inside: ${hitsA.map((z) => z.name).join(", ")}`);
  log(`   The point sits in ${hitsA.length} OVERLAPPING surge zones, so the search followed`);
  log("   multiple paths — the node-overlap cost an R*-tree works to minimize.");
  log("");

  // ── B) MBR IS A FILTER, NOT THE ANSWER ────────────────────────────────────────
  log("─── B) MBR IS A FILTER, NOT THE ANSWER: concave L-zone (cf. Phase 5) ───");
  const lZone = zones.find((z) => z.name === "Mission L-zone")!;
  const qInside: LngLat = { lng: -122.412, lat: 37.762 }; // in the L's base
  const qNotch: LngLat = { lng: -122.410, lat: 37.770 };  // in the L's NOTCH

  const sIn: QueryStats = { nodesVisited: 0, exactTests: 0 };
  const hitsIn = zonesContaining(tree, qInside, sIn);
  log(`   point in the L's base (${qInside.lat}, ${qInside.lng}):`);
  log(`      MBR contains? ${mbrContains(lZone.mbr, qInside)}   ray-cast inside? ${pointInPolygon(qInside, lZone.verts)}` +
    `   → ${hitsIn.length ? "✓ " + hitsIn[0].name : "✗ none"}`);

  const sNotch: QueryStats = { nodesVisited: 0, exactTests: 0 };
  const hitsNotch = zonesContaining(tree, qNotch, sNotch);
  log(`   point in the L's NOTCH (${qNotch.lat}, ${qNotch.lng}):`);
  log(`      MBR contains? ${mbrContains(lZone.mbr, qNotch)}   ray-cast inside? ${pointInPolygon(qNotch, lZone.verts)}` +
    `   → ${hitsNotch.length ? "✓ " + hitsNotch[0].name : "✗ none (MBR passed, polygon rejected)"}`);
  log(`   exact ray-casts run for the notch query: ${sNotch.exactTests} of ${zones.length}`);
  log("   The MBR test PASSED but the exact ray-cast correctly REJECTED it: the notch");
  log("   is inside the bounding box yet outside the polygon. Filter, then refine.");
  log("");

  // ── C) CONTRAST WITH CURVE METHODS ────────────────────────────────────────────
  log("─── C) CURVE METHODS vs R-TREES — name which problem you have ───");
  log("   'nearest drivers to this point?'      → POINTS  → geohash / S2 (Phase 2)");
  log("   'which delivery/surge zone is this?'  → EXTENTS → R-tree point-in-polygon");
  log("   Curves index locations; R-trees index areas. This is the PostGIS/GiST path.");

  process.exit(0);
}

main();
