/**
 * Phase 4 — EXPANDING-RING kNN: "the nearest 10 drivers". Run: npm run phase4
 *
 * This is the Uber/Lyft dispatch query: given my location, find the K closest
 * drivers, fast, over a fleet of live locations that update constantly. The
 * standard structure is an in-memory GRID (fixed cells, like geohash), and the
 * query is an EXPANDING RING search:
 *
 *   1. Look in the query's own cell.
 *   2. Expand outward one ring at a time (the square of cells at Chebyshev
 *      distance 1, then 2, …), accumulating candidates.
 *   3. TERMINATION — the subtle part. Once you have K candidates, you can't stop
 *      immediately: a point in the NEXT ring might still be closer than your
 *      current Kth. You may only stop once your Kth-nearest distance is ≤ the
 *      minimum possible distance to any unscanned ring (ring index × cell size).
 *      Only then is it impossible for a farther ring to beat your current K.
 *
 * Getting that termination condition right is the whole gate. We show the rings
 * expanding and the search stopping as soon as — but not before — it's safe.
 */

import { log } from "../lib/log.ts";

interface Pt { id: number; x: number; y: number }

class Grid {
  private cells = new Map<string, Pt[]>();
  private size: number;
  constructor(size: number) { this.size = size; }

  private key(cx: number, cy: number) { return `${cx},${cy}`; }
  private cellOf(x: number, y: number) { return [Math.floor(x / this.size), Math.floor(y / this.size)] as const; }

  insert(p: Pt) {
    const [cx, cy] = this.cellOf(p.x, p.y);
    const k = this.key(cx, cy);
    (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(p);
  }

  kNearest(qx: number, qy: number, k: number) {
    const [qcx, qcy] = this.cellOf(qx, qy);
    const dist = (p: Pt) => Math.hypot(p.x - qx, p.y - qy);
    let candidates: Array<{ p: Pt; d: number }> = [];
    let cellsScanned = 0;

    for (let ring = 0; ; ring++) {
      // Scan the square ring of cells at Chebyshev distance `ring`.
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // border of the square only
          cellsScanned++;
          for (const p of this.cells.get(this.key(qcx + dx, qcy + dy)) ?? []) candidates.push({ p, d: dist(p) });
        }
      }
      candidates.sort((a, b) => a.d - b.d);

      // Termination: do we have K, and is the Kth closer than anything a farther ring could hold?
      if (candidates.length >= k) {
        const kth = candidates[k - 1].d;
        const minNextRing = ring * this.size; // nearest possible point beyond the scanned square
        log(`   ring ${ring}: ${cellsScanned} cells scanned, ${candidates.length} candidates, Kth=${kth.toFixed(1)}, guaranteed-safe beyond ${minNextRing.toFixed(1)}`);
        if (kth <= minNextRing) { log(`   ✓ stop: Kth (${kth.toFixed(1)}) ≤ ${minNextRing.toFixed(1)} — no farther ring can beat it`); break; }
      } else {
        log(`   ring ${ring}: ${cellsScanned} cells scanned, only ${candidates.length}/${k} candidates — expand`);
      }
      if (ring > 50) break; // safety
    }
    return { nearest: candidates.slice(0, k).map((c) => c.p), cellsScanned };
  }
}

function makeRng(seed: number) { return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

function main() {
  const grid = new Grid(10); // 10-unit cells
  const rng = makeRng(7);
  for (let i = 0; i < 2000; i++) grid.insert({ id: i, x: rng() * 1000 - 500, y: rng() * 1000 - 500 });

  log("═══ Find the 5 nearest 'drivers' to (0,0) via expanding rings ═══");
  const { nearest, cellsScanned } = grid.kNearest(0, 0, 5);
  log("");
  log(`   nearest 5: ${nearest.map((p) => `#${p.id}(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(", ")}`);
  log(`   scanned ${cellsScanned} grid cells instead of all 2000 points.`);

  log("");
  log("The expanding ring only touches cells near the query, and the termination");
  log("rule guarantees correctness without over-scanning. At Uber scale this grid");
  log("lives in memory (750k location writes/sec), with the DB getting only samples.");
  process.exit(0);
}

main();
