/**
 * Phase 3 — QUADTREE: a spatial index that prunes the search. Run: npm run phase3
 *
 * A geohash (Phase 2) buckets space into a FIXED grid. A quadtree adapts to the
 * data: it recursively splits a region into four quadrants (NW, NE, SW, SE), but
 * only where points are dense. Sparse areas stay one big node; a crowded
 * downtown subdivides deeply. That adaptivity is its edge over a fixed grid.
 *
 *   INSERT — a node holds up to `capacity` points; on overflow it subdivides and
 *   pushes its points down into the right quadrant.
 *
 *   RANGE QUERY — to find points in a rectangle, only descend into quadrants
 *   that INTERSECT the rectangle. Whole subtrees that can't contain a match are
 *   skipped without looking at their points. That pruning turns O(n) into
 *   roughly O(log n + hits) — the entire reason to use an index.
 *
 * We build a tree over thousands of points and show how few it actually examines
 * for a small-area query, versus the brute-force scan.
 */

import { log } from "../lib/log.ts";

interface Pt { x: number; y: number }
interface Rect { x: number; y: number; w: number; h: number } // center x,y + half-width/height

const contains = (r: Rect, p: Pt) => p.x >= r.x - r.w && p.x <= r.x + r.w && p.y >= r.y - r.h && p.y <= r.y + r.h;
const intersects = (a: Rect, b: Rect) =>
  !(b.x - b.w > a.x + a.w || b.x + b.w < a.x - a.w || b.y - b.h > a.y + a.h || b.y + b.h < a.y - a.h);

class QuadTree {
  private points: Pt[] = [];
  private divided = false;
  private children: QuadTree[] = [];
  static pointsChecked = 0; // instrumentation for the demo
  private boundary: Rect;
  private capacity: number;

  constructor(boundary: Rect, capacity = 4) {
    this.boundary = boundary;
    this.capacity = capacity;
  }

  insert(p: Pt): boolean {
    if (!contains(this.boundary, p)) return false;
    if (this.points.length < this.capacity && !this.divided) { this.points.push(p); return true; }
    if (!this.divided) this.subdivide();
    return this.children.some((c) => c.insert(p));
  }

  private subdivide() {
    const { x, y, w, h } = this.boundary;
    const hw = w / 2, hh = h / 2;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
      this.children.push(new QuadTree({ x: x + dx * hw, y: y + dy * hh, w: hw, h: hh }, this.capacity));
    for (const p of this.points) this.children.some((c) => c.insert(p)); // push existing points down
    this.points = [];
    this.divided = true;
  }

  queryRange(range: Rect, found: Pt[] = []): Pt[] {
    if (!intersects(this.boundary, range)) return found; // PRUNE: skip this whole subtree
    for (const p of this.points) { QuadTree.pointsChecked++; if (contains(range, p)) found.push(p); }
    if (this.divided) for (const c of this.children) c.queryRange(range, found);
    return found;
  }
}

// Deterministic PRNG so runs are reproducible.
function makeRng(seed: number) { return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

function main() {
  const N = 5000;
  const world: Rect = { x: 0, y: 0, w: 100, h: 100 }; // 200×200 world
  const tree = new QuadTree(world, 4);
  const rng = makeRng(42);
  const all: Pt[] = [];
  for (let i = 0; i < N; i++) { const p = { x: rng() * 200 - 100, y: rng() * 200 - 100 }; all.push(p); tree.insert(p); }

  // A small query box (2% of each axis).
  const query: Rect = { x: 20, y: -30, w: 4, h: 4 };

  QuadTree.pointsChecked = 0;
  const hits = tree.queryRange(query);
  const treeChecked = QuadTree.pointsChecked;

  // Brute force for comparison.
  let bruteChecked = 0, bruteHits = 0;
  for (const p of all) { bruteChecked++; if (contains(query, p)) bruteHits++; }

  log(`═══ ${N} points; query a small box (${query.w * 2}×${query.h * 2} in a 200×200 world) ═══`);
  log("");
  log(`   BRUTE FORCE: checked ${bruteChecked} points → ${bruteHits} hits`);
  log(`   QUADTREE:    checked ${treeChecked} points → ${hits.length} hits  (same answer)`);
  log(`   → the quadtree pruned ${((1 - treeChecked / bruteChecked) * 100).toFixed(1)}% of points by skipping`);
  log("     quadrants that couldn't intersect the query box.");

  log("");
  log("Adaptive subdivision means dense areas (downtown) split deeply while empty");
  log("ocean stays one node. That's the win over a fixed grid — and R-trees extend");
  log("the same idea to arbitrary rectangles (roads, building footprints).");
  process.exit(0);
}

main();
