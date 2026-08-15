/**
 * Phase 9 — ROUTING on a road graph: Dijkstra → A* → Contraction Hierarchies.
 * Run: node "src/phase9/routing.ts"
 *
 * Everything before this phase answered "what is NEAR me?". Routing answers a
 * harder question: "what is the CHEAPEST way from A to B?" over a road network
 * modelled as a directed weighted graph — nodes are intersections (each with a
 * lat/lng), edges are road segments with a travel-cost weight. On a continent
 * that graph has tens of millions of nodes, and a maps product must answer a
 * query in well under a millisecond. The story below is how the field got there.
 *
 *   A) DIJKSTRA — settle the closest unfinalized node, relax its edges, repeat.
 *      Correct and optimal, but with no idea where the target is it expands
 *      outward in ALL directions like a growing circle, settling a huge fraction
 *      of the graph before the target falls out. Fine for a city, hopeless for a
 *      continent at interactive latency.
 *
 *   B) A* — Dijkstra plus a HEURISTIC h(n): a lower bound on the remaining cost
 *      from n to the target. Priority becomes g(n) + h(n), so the frontier is
 *      pulled toward the goal — the search becomes an ellipse, not a circle. The
 *      straight-line great-circle distance (haversineKm) is a perfect heuristic
 *      here: because every edge weight is at least its own straight-line length,
 *      h NEVER overestimates the true remaining cost — it is ADMISSIBLE — so A*
 *      is still optimal, but it settles fewer nodes. Same path cost, less work.
 *
 *   C) CONTRACTION HIERARCHIES (CH) — the Staff-level move: pay a heavy OFFLINE
 *      preprocessing cost so ONLINE queries are almost free. Rank every node by
 *      importance, then "contract" them one at a time from least important. When
 *      you remove a node you may break shortest paths that ran THROUGH it, so for
 *      each such path you add a SHORTCUT edge that preserves the distance — but
 *      only if a WITNESS SEARCH proves no equal-or-shorter detour already exists
 *      (adding needless shortcuts is what makes a bad hierarchy slow). A query
 *      then runs a BIDIRECTIONAL search that only ever moves UPWARD in the
 *      hierarchy; the two frontiers climb toward the few important nodes and meet
 *      near the top, touching a tiny fraction of the graph. Same path cost again.
 *
 *   D) CRP (comment) — CH bakes the edge weights INTO the shortcuts, so a live
 *      traffic update means the shortcuts are wrong and you must re-preprocess.
 *      Customizable Route Planning fixes this by SPLITTING topology (the road
 *      layout, which almost never changes) from the metric (the weights, which
 *      change every few minutes). A traffic update is then a cheap re-CUSTOMIZE
 *      of the metric over a fixed partition — seconds, not hours. And the weight
 *      itself is an ETA model: historical speed × live-traffic × a learned term
 *      (Google uses a Graph Neural Network), fundamentally probabilistic.
 *
 * We build a deterministic 8×8 road grid, run the SAME source→target query three
 * ways, and count NODES SETTLED — the real currency of routing. We assert all
 * three return the identical path cost, so the shrinking node counts are pure
 * efficiency, never a shortcut on correctness.
 *
 * TAKEAWAY: naive Dijkstra re-explores the whole graph per query and can't do
 * continental routing interactively; A*'s admissible heuristic aims the search at
 * the goal but still touches too many nodes; Contraction Hierarchies precompute
 * shortcuts offline so a query is a bidirectional upward search touching a
 * fraction of the nodes (sub-millisecond continental routing), and CRP splits
 * road topology from the traffic metric so a live-traffic update is a cheap
 * re-customization, not a full re-preprocess. Precompute heavy offline, serve
 * cheap online.
 */

import { log } from "../lib/log.ts";
import { haversineKm, type Point } from "../lib/geo.ts";

// Deterministic PRNG (mulberry32) so edge weights are identical on every run.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── A tiny binary min-heap keyed by cost, tie-broken by node id (fully deterministic).
class MinHeap {
  private keys: number[] = [];
  private nodes: number[] = [];
  size() { return this.nodes.length; }
  topKey() { return this.keys.length ? this.keys[0] : Infinity; }
  private less(i: number, j: number) {
    return this.keys[i] !== this.keys[j] ? this.keys[i] < this.keys[j] : this.nodes[i] < this.nodes[j];
  }
  private swap(i: number, j: number) {
    [this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]];
    [this.nodes[i], this.nodes[j]] = [this.nodes[j], this.nodes[i]];
  }
  push(node: number, key: number) {
    this.keys.push(key); this.nodes.push(node);
    let i = this.nodes.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.less(i, p)) { this.swap(i, p); i = p; } else break; }
  }
  pop(): { node: number; key: number } {
    const node = this.nodes[0], key = this.keys[0], last = this.nodes.length - 1;
    this.swap(0, last); this.keys.pop(); this.nodes.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2; let s = i;
      if (l < this.nodes.length && this.less(l, s)) s = l;
      if (r < this.nodes.length && this.less(r, s)) s = r;
      if (s === i) break; this.swap(i, s); i = s;
    }
    return { node, key };
  }
}

type Adj = Map<number, Map<number, number>>; // node → (neighbour → weight)

// ── Build a deterministic N×N grid of intersections around San Francisco.
//    Edge weight = straight-line km × a seeded congestion factor in [1.0, 3.0).
//    Because that factor is ≥ 1, the great-circle distance to any target is a
//    LOWER BOUND on the real travel cost — exactly what makes A* admissible.
function buildGrid(N: number): { nodes: Point[]; adj: Adj } {
  const baseLat = 37.70, baseLng = -122.52, step = 0.02; // ~2 km spacing
  const nodes: Point[] = [];
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++)
      nodes.push({ name: `(${r},${c})`, lat: baseLat + r * step, lng: baseLng + c * step });

  const adj: Adj = new Map();
  for (let i = 0; i < N * N; i++) adj.set(i, new Map());
  const rng = mulberry32(20260815);
  const link = (a: number, b: number) => {
    const w = haversineKm(nodes[a], nodes[b]) * (1 + 2 * rng()); // congestion ≥ 1
    adj.get(a)!.set(b, w); adj.get(b)!.set(a, w); // two-way street, same cost
  };
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      if (c + 1 < N) link(i, i + 1); // east neighbour
      if (r + 1 < N) link(i, i + N); // south neighbour
    }
  return { nodes, adj };
}

// ── A) DIJKSTRA. Stop the moment the target is settled. Counts nodes settled.
function dijkstra(adj: Adj, s: number, t: number): { cost: number; settled: number; path: number[] } {
  const dist = new Map<number, number>([[s, 0]]);
  const prev = new Map<number, number>();
  const done = new Set<number>();
  const pq = new MinHeap(); pq.push(s, 0);
  let settled = 0;
  while (pq.size()) {
    const { node: u } = pq.pop();
    if (done.has(u)) continue;
    done.add(u); settled++;
    if (u === t) break;
    for (const [v, w] of adj.get(u)!) {
      const nd = dist.get(u)! + w;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); pq.push(v, nd); }
    }
  }
  const path: number[] = [];
  for (let x: number | undefined = t; x !== undefined; x = prev.get(x)) path.unshift(x);
  return { cost: dist.get(t)!, settled, path };
}

// ── B) A*. Identical to Dijkstra but the PQ key is g + h, with h = straight-line
//    great-circle distance to the target (admissible ⇒ still optimal).
function astar(adj: Adj, nodes: Point[], s: number, t: number): { cost: number; settled: number } {
  const h = (n: number) => haversineKm(nodes[n], nodes[t]);
  const g = new Map<number, number>([[s, 0]]);
  const done = new Set<number>();
  const pq = new MinHeap(); pq.push(s, h(s));
  let settled = 0;
  while (pq.size()) {
    const { node: u } = pq.pop();
    if (done.has(u)) continue;
    done.add(u); settled++;
    if (u === t) break;
    for (const [v, w] of adj.get(u)!) {
      const nd = g.get(u)! + w;
      if (nd < (g.get(v) ?? Infinity)) { g.set(v, nd); pq.push(v, nd + h(v)); }
    }
  }
  return { cost: g.get(t)!, settled };
}

// ── Witness search: shortest u→w distance in the current graph while pretending
//    `ignore` (the node being contracted) and all already-contracted nodes are
//    gone, searching no farther than `limit`. If it stays ABOVE `limit` the
//    only ≤-limit route went through `ignore`, so a shortcut is required.
function witnessDist(adj: Adj, contracted: Set<number>, ignore: number, s: number, t: number, limit: number): number {
  const dist = new Map<number, number>([[s, 0]]);
  const pq = new MinHeap(); pq.push(s, 0);
  while (pq.size()) {
    const { node: u, key: du } = pq.pop();
    if (du > (dist.get(u) ?? Infinity)) continue;
    if (u === t) return du;
    if (du > limit) break; // nothing ≤ limit remains — no witness within budget
    for (const [v, w] of adj.get(u)!) {
      if (contracted.has(v) || v === ignore) continue;
      const nd = du + w;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); pq.push(v, nd); }
    }
  }
  return dist.get(t) ?? Infinity;
}

// Contract one node: add whatever shortcuts are needed to preserve distances.
// `simulate` computes the edge-difference (shortcuts − removed edges) without
// touching the graph, used to pick the contraction order; otherwise it applies
// the shortcuts and marks the node contracted. Returns the edge-difference.
function contract(adj: Adj, contracted: Set<number>, v: number, simulate: boolean): number {
  const nbrs = [...adj.get(v)!].filter(([n]) => !contracted.has(n));
  const toAdd: Array<[number, number, number]> = [];
  for (let i = 0; i < nbrs.length; i++)
    for (let j = i + 1; j < nbrs.length; j++) {
      const [u, wu] = nbrs[i], [w, ww] = nbrs[j];
      const viaV = wu + ww; // cost of u → v → w
      if (witnessDist(adj, contracted, v, u, w, viaV) > viaV + 1e-12) toAdd.push([u, w, viaV]);
    }
  if (!simulate) {
    for (const [u, w, wt] of toAdd) {
      const cur = adj.get(u)!.get(w);
      if (cur === undefined || wt < cur) { adj.get(u)!.set(w, wt); adj.get(w)!.set(u, wt); }
    }
    contracted.add(v);
  }
  return toAdd.length - nbrs.length;
}

// ── C-preprocess) Build the hierarchy: lazily contract least-important-first by
//    edge-difference, cloning the base graph so shortcuts don't corrupt it.
function preprocess(base: Adj): { adj: Adj; rank: number[]; shortcuts: number } {
  const adj: Adj = new Map();
  for (const [u, nbr] of base) adj.set(u, new Map(nbr));
  const n = adj.size;
  const contracted = new Set<number>();
  const rank = new Array<number>(n).fill(-1);
  const before = [...adj].reduce((s, [, m]) => s + m.size, 0);

  const pq = new MinHeap();
  for (let v = 0; v < n; v++) pq.push(v, contract(adj, contracted, v, true));

  let nextRank = 0;
  while (pq.size()) {
    const { node: v } = pq.pop();
    if (contracted.has(v)) continue;
    const ed = contract(adj, contracted, v, true); // re-evaluate now (lazy update)
    if (pq.size() && ed > pq.topKey()) { pq.push(v, ed); continue; } // someone cheaper — defer
    rank[v] = nextRank++;
    contract(adj, contracted, v, false); // really contract, adding shortcuts
  }
  const after = [...adj].reduce((s, [, m]) => s + m.size, 0);
  return { adj, rank, shortcuts: (after - before) / 2 }; // /2: edges stored both ways
}

// ── C-query) Bidirectional Dijkstra that only ever relaxes UPWARD edges
//    (toward higher-ranked nodes). The two frontiers meet near the hierarchy top.
function chQuery(adj: Adj, rank: number[], s: number, t: number): { cost: number; settled: number } {
  const distF = new Map<number, number>([[s, 0]]);
  const distB = new Map<number, number>([[t, 0]]);
  const doneF = new Set<number>(), doneB = new Set<number>();
  const pqF = new MinHeap(), pqB = new MinHeap();
  pqF.push(s, 0); pqB.push(t, 0);
  let best = Infinity, settled = 0;

  const step = (pq: MinHeap, dist: Map<number, number>, done: Set<number>, other: Map<number, number>) => {
    const { node: u, key: du } = pq.pop();
    if (done.has(u)) return;
    done.add(u); settled++;
    if (other.has(u)) best = Math.min(best, du + other.get(u)!);
    for (const [v, w] of adj.get(u)!) {
      if (rank[v] <= rank[u]) continue; // upward only
      const nd = du + w;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); pq.push(v, nd); }
    }
  };

  while (Math.min(pqF.topKey(), pqB.topKey()) < best) {
    if (pqF.topKey() <= pqB.topKey()) step(pqF, distF, doneF, distB);
    else step(pqB, distB, doneB, distF);
  }
  return { cost: best, settled };
}

function fmt(km: number) { return km.toFixed(3); }

function main() {
  const N = 8; // 8×8 = 64 intersections
  const { nodes, adj } = buildGrid(N);
  const mid = Math.floor(N / 2);
  const S = mid * N, T = mid * N + (N - 1); // straight across the middle row: left edge → right edge
  // (corner-to-corner would fill the whole grid's S–T bounding box, leaving A* nothing
  //  to prune; a mid-row query leaves rows above/below for A* to skip.)

  log(`═══ Routing an ${N}×${N} road grid (${N * N} intersections) from ${nodes[S].name} to ${nodes[T].name} ═══`);
  log("");

  // A) Dijkstra
  const dj = dijkstra(adj, S, T);
  log(`A) DIJKSTRA   settled ${String(dj.settled).padStart(2)} nodes  cost=${fmt(dj.cost)} km`);
  log(`   route: ${dj.path.map((i) => nodes[i].name).join(" → ")}`);

  // B) A*
  const as = astar(adj, nodes, S, T);
  log(`B) A*         settled ${String(as.settled).padStart(2)} nodes  cost=${fmt(as.cost)} km   (haversine heuristic aims the frontier at the goal)`);

  // C) Contraction Hierarchies — offline preprocess, then online query
  const { adj: ch, rank, shortcuts } = preprocess(adj);
  log(`C) CH preprocess: added ${shortcuts} shortcut edges while contracting all ${N * N} nodes (offline, once)`);
  const cq = chQuery(ch, rank, S, T);
  log(`   CH query    settled ${String(cq.settled).padStart(2)} nodes  cost=${fmt(cq.cost)} km   (bidirectional, upward-only)`);
  log("");

  // Correctness gate: all three MUST agree on cost.
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  if (!eq(dj.cost, as.cost) || !eq(dj.cost, cq.cost))
    throw new Error(`path costs disagree: dijkstra=${dj.cost} astar=${as.cost} ch=${cq.cost}`);

  // And CH must match Dijkstra on several other source/target pairs.
  const pairs: Array<[number, number]> = [[0, 63], [3, 60], [56, 7], [24, 39], [10, 53]];
  for (const [a, b] of pairs) {
    const d = dijkstra(adj, a, b).cost, c = chQuery(ch, rank, a, b).cost;
    if (!eq(d, c)) throw new Error(`CH ≠ Dijkstra for ${a}->${b}: ${c} vs ${d}`);
  }
  log(`✓ CH == Dijkstra on ${pairs.length} extra source/target pairs — the hierarchy is correct.`);
  log("");

  // Summary table — settled counts shrink, path cost is invariant.
  const row = (m: string, settled: number, cost: number) =>
    `   ${m.padEnd(11)}│ ${String(settled).padStart(13)} │ ${fmt(cost).padStart(9)}`;
  log("   method     │ nodes settled │ path cost");
  log("   ───────────┼───────────────┼──────────");
  log(row("Dijkstra", dj.settled, dj.cost));
  log(row("A*", as.settled, as.cost));
  log(row("CH query", cq.settled, cq.cost));
  log("");
  log("Same cost, ever-fewer nodes settled: Dijkstra explores a circle, A* an");
  log("ellipse toward the goal, and CH climbs precomputed shortcuts to meet in the");
  log("middle. Precompute heavy offline (CH), serve cheap online — and split the");
  log("traffic metric from the topology (CRP) so a live update is a re-customization.");
  process.exit(0);
}

main();
