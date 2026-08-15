/**
 * Phase 11 — PROXIMITY SEARCH AT SCALE: the seams around the index. Run: node src/phase11/scale.ts
 *
 * Phases 1–5 built the RETRIEVAL layer: haversine, geohash cells, the 9-cell
 * neighbor fan-out, kNN, geofencing. That is the easy 20%. The interview is won
 * in the SEAMS around the index — what happens when it is sharded across nodes,
 * hammered by real traffic, and asked to power a product ranking. This file is a
 * deterministic simulation of those seams. Nothing here is random at runtime
 * (seeded mulberry32 only), so every number below is reproducible.
 *
 * The index is sharded: entities live in geohash CELLS, and each cell is owned by
 * exactly one shard/node. (We assign cell→shard by HASHING the cell id, which
 * SPREADS neighboring cells across shards. The textbook alternative — range-
 * partitioning the geohash keyspace — instead COLOCATES neighbors on one shard,
 * which is efficient for reads but turns a hot place like Times Square into a hot
 * SHARD. We lean on both facts below.)
 *
 * Five seams, each a place a Staff answer goes and the easy answer doesn't:
 *
 *   A) SCATTER-GATHER — a "nearby k" query is a coordinator computing the 9 target
 *      cells, routing a sub-query to each OWNING shard in parallel, then MERGE →
 *      true-haversine → rank → top-k. Retrieval is fan-out, not a point lookup.
 *   B) TAIL LATENCY — scatter-gather inherits the SLOWEST shard: query p99 = p99
 *      of the worst cell touched. Mitigate with HEDGED REQUESTS (duplicate to a
 *      replica after a short delay, take the first back) and PARTIAL RESULTS ON A
 *      DEADLINE (return what's in at 50ms; proximity is approximate anyway).
 *   C) HOT CELL — the Times Square problem: one cell holds ~100× the entities and
 *      absorbs ~100× the reads. A hot key in geo clothing. Fix by REPLICATE +
 *      SUB-SHARD (precision 6→8 just there) + CACHE the candidate set (short TTL).
 *   D) RETRIEVE → RANK — distance only gets the candidate SET. RANKING is a product
 *      blend (distance, rating, popularity, personalization, sponsored). A 4.8★
 *      place 800m away should beat a 3.0★ next door. Same two-stage shape as
 *      search and ads: cheap retrieve, expensive rank.
 *   E) SURGE — per cell over a sliding window, open-requests : available-drivers →
 *      a multiplier, cached per cell (short TTL) and rolled UP the cell hierarchy
 *      to a coarser surge-cell. Eventual/approximate; the committed quote is
 *      pinned to the trip, not the live heatmap.
 *
 * TAKEAWAY: the index is just retrieval — at scale a nearby query is a scatter-
 * gather over the cell + neighbors whose p99 is the worst shard's (hedge it /
 * deadline it), the hot cell (Times Square) is a hot key you replicate + sub-shard
 * + cache with a short TTL, ranking is a retrieve→rank blend (not a distance-sort),
 * and surge is a per-cell demand/supply heatmap rolled up the cell hierarchy.
 * Naming these seams is what separates a Staff proximity answer from the easy 20%.
 */

import { haversineKm, type Point } from "../lib/geo.ts";
import { log } from "../lib/log.ts";

// ─── Geohash (inlined from Phase 2 so this file runs standalone) ──────────────
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

function encode(lat: number, lng: number, precision = 6): string {
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

/** The query cell plus its 8 neighbors — the scatter-gather's target cells. */
function cellAndNeighbors(lat: number, lng: number, precision: number): string[] {
  const c = decode(encode(lat, lng, precision));
  const out = new Set<string>();
  for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1])
    out.add(encode(c.lat + dy * c.dLat, c.lng + dx * c.dLng, precision));
  return [...out];
}

// ─── Deterministic primitives (no Math.random / Date.now anywhere) ────────────
/** Seeded PRNG so entity placement, QPS, and interarrivals are reproducible. */
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable string hash — used for cell→shard ownership and per-cell latency. */
function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const P = 6;              // precision of the index's cells
const NUM_SHARDS = 8;     // nodes the index is sharded across
const shardOf = (cell: string) => strHash(cell) % NUM_SHARDS;

// A hot cell is also (realistically) a latency straggler: it GC-pauses under load.
const STRAGGLER_MS = 130; // the hot cell's response time when scanned directly
const DEADLINE_MS = 50;   // partial-results cutoff for the scatter-gather
const HEDGE_DELAY_MS = 15; // fire the hedge to a replica after this delay

/** Base per-cell latency (deterministic): a slow node is a property of the cell it owns. */
function cellLatency(cell: string, hotCell: string): number {
  if (cell === hotCell) return STRAGGLER_MS;
  return 8 + (strHash("lat:" + cell) % 25); // 8–32ms
}

interface Entity extends Point { rating: number; reviews: number; cell: string }

function main() {
  const QUERY: Point = { name: "Union Square (query origin)", lat: 37.7880, lng: -122.4074 };
  const hotCell = encode(QUERY.lat, QUERY.lng, P);

  // ── Build the sharded index: scatter entities across an SF bounding box ──────
  const rng = mulberry32(42);
  const entities: Entity[] = [];
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const lat = 37.74 + rng() * 0.09;   // ~SF latitude span
    const lng = -122.47 + rng() * 0.11; // ~SF longitude span
    entities.push({ name: `e${i}`, lat, lng, cell: encode(lat, lng, P), rating: 1 + rng() * 4, reviews: Math.floor(rng() * 500), });
  }
  // THE HOT CELL: Times-Square-ify Union Square — jam ~100× the normal load in.
  const HOT_EXTRA = 2100;
  for (let i = 0; i < HOT_EXTRA; i++) {
    const c = decode(hotCell);
    const lat = c.lat + (rng() - 0.5) * c.dLat * 0.9;
    const lng = c.lng + (rng() - 0.5) * c.dLng * 0.9;
    entities.push({ name: `hot${i}`, lat, lng, cell: encode(lat, lng, P), rating: 1 + rng() * 4, reviews: Math.floor(rng() * 500), });
  }
  // Index: cell → entities, and shard → the cells it owns.
  const byCell = new Map<string, Entity[]>();
  for (const e of entities) (byCell.get(e.cell) ?? byCell.set(e.cell, []).get(e.cell)!).push(e);

  // ════════════════════════════════════════════════════════════════════════
  // A) SCATTER-GATHER / FAN-OUT
  // ════════════════════════════════════════════════════════════════════════
  log("═══ A) Scatter-gather: a 'nearby k' query fans out to the owning shards ═══");
  const targetCells = cellAndNeighbors(QUERY.lat, QUERY.lng, P);
  // Coordinator groups the 9 target cells by owning shard → one sub-query per shard.
  const subqueries = new Map<number, string[]>();
  for (const cell of targetCells) (subqueries.get(shardOf(cell)) ?? subqueries.set(shardOf(cell), []).get(shardOf(cell))!).push(cell);
  log(`   query cell ${hotCell} + 8 neighbors = ${targetCells.length} target cells`);
  log(`   fan-out hits ${subqueries.size} of ${NUM_SHARDS} shards (each cell owned by exactly one):`);
  for (const [shard, cells] of [...subqueries].sort((a, b) => a[0] - b[0]))
    log(`     shard ${shard} ← ${cells.length} cell(s): ${cells.join(" ")}`);

  // Gather: union the candidate sets the shards return, then rank by TRUE distance.
  const candidates: Entity[] = [];
  for (const cell of targetCells) for (const e of byCell.get(cell) ?? []) candidates.push(e);
  const K = 5;
  const ranked = candidates
    .map((e) => ({ e, d: haversineKm(QUERY, e) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, K);
  log(`   gathered ${candidates.length} candidates across those cells → haversine → top-${K}:`);
  for (const { e, d } of ranked) log(`     ${e.name.padEnd(8)} ${(d * 1000).toFixed(0)}m`);
  log("   Retrieval at scale is fan-out + merge, not a single-node point lookup.");

  // ════════════════════════════════════════════════════════════════════════
  // B) TAIL LATENCY — the query is as slow as the worst shard it touched
  // ════════════════════════════════════════════════════════════════════════
  log("");
  log("═══ B) Tail latency: scatter-gather inherits the SLOWEST shard ═══");
  const touched = [...subqueries.entries()].map(([shard, cells]) => {
    const lat = Math.max(...cells.map((c) => cellLatency(c, hotCell)));
    return { shard, lat, cells };
  });
  for (const t of touched.sort((a, b) => b.lat - a.lat))
    log(`     shard ${t.shard}: ${t.lat}ms${t.cells.includes(hotCell) ? "  ← owns the hot cell (straggler)" : ""}`);
  const naive = Math.max(...touched.map((t) => t.lat));
  log(`   naive query latency = max over touched shards = ${naive}ms (one slow cell taxes the whole query)`);

  // Mitigation 1 — HEDGED REQUEST: duplicate the straggler to a replica after a short
  // delay; take whichever returns first. The replica isn't GC-pausing, so it's fast.
  const replicaLat = 8 + (strHash("replica:" + hotCell) % 25); // healthy replica of the hot cell
  const hedged = touched.map((t) =>
    t.cells.includes(hotCell) ? Math.min(t.lat, HEDGE_DELAY_MS + replicaLat) : t.lat);
  const withHedge = Math.max(...hedged);
  log(`   + HEDGE: re-issue hot cell to a replica after ${HEDGE_DELAY_MS}ms (replica=${replicaLat}ms) → take first back`);
  log(`     query latency ${naive}ms → ${withHedge}ms`);

  // Mitigation 2 — PARTIAL RESULTS ON A DEADLINE: at 50ms, return what's in and drop
  // the straggler's cells. Proximity is approximate — a few missing candidates is fine.
  const inByDeadline = touched.filter((t) => t.lat <= DEADLINE_MS);
  const droppedCells = touched.filter((t) => t.lat > DEADLINE_MS).flatMap((t) => t.cells);
  log(`   + DEADLINE ${DEADLINE_MS}ms: return the ${inByDeadline.length}/${touched.length} shards that answered in time`);
  log(`     query latency capped at ${DEADLINE_MS}ms; ${droppedCells.length} cell(s) dropped: ${droppedCells.join(" ") || "none"} (approximate, acceptable)`);

  // ════════════════════════════════════════════════════════════════════════
  // C) HOT CELL — the Times Square problem (a hot key in geo clothing)
  // ════════════════════════════════════════════════════════════════════════
  log("");
  log("═══ C) Hot cell: one cell dwarfs the rest in entities AND reads ═══");
  const counts = [...byCell.values()].map((es) => es.length).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)];
  const hotCount = (byCell.get(hotCell) ?? []).length;
  log(`   hot cell ${hotCell}: ${hotCount} entities vs median cell ${median} → ${(hotCount / median).toFixed(0)}× skew`);
  // Read skew mirrors entity skew: QPS is proportional to how "interesting" the cell is.
  const hotQPS = 9500, normalQPS = 95;
  log(`   read fan-out follows: hot cell ~${hotQPS} QPS vs a normal cell ~${normalQPS} QPS → ${(hotQPS / normalQPS).toFixed(0)}× read skew`);

  // Fix 1 — REPLICATE across read replicas so reads load-balance.
  const REPLICAS = 5;
  log(`   + REPLICATE ×${REPLICAS}: reads spread → ${(hotQPS / REPLICAS).toFixed(0)} QPS/replica (from ${hotQPS})`);

  // Fix 2 — SUB-SHARD just this cell at finer precision (6→8) so entities spread out.
  const FINE = 8;
  const subCounts = new Map<string, number>();
  for (const e of byCell.get(hotCell) ?? []) {
    const sc = encode(e.lat, e.lng, FINE);
    subCounts.set(sc, (subCounts.get(sc) ?? 0) + 1);
  }
  const maxSub = Math.max(...subCounts.values());
  log(`   + SUB-SHARD 6→${FINE} here only: ${hotCount} entities → ${subCounts.size} finer cells, busiest holds ${maxSub} (${(hotCount / maxSub).toFixed(0)}× lighter)`);

  // Fix 3 — CACHE the popular cell's candidate set with a short TTL. Replay a stream
  // of repeated hot-cell queries and count cache hits (deterministic interarrivals).
  const TTL_MS = 1000;
  const qrng = mulberry32(7);
  let now = 0, expiry = -1, hits = 0, misses = 0;
  const QUERIES = 40;
  for (let i = 0; i < QUERIES; i++) {
    if (now < expiry) hits++; else { misses++; expiry = now + TTL_MS; } // miss → recompute + set TTL
    now += 20 + Math.floor(qrng() * 80); // 20–100ms between hot-cell queries
  }
  log(`   + CACHE candidate set (TTL ${TTL_MS}ms): ${QUERIES} repeated hot-cell queries → ${hits} hits / ${misses} misses = ${((hits / QUERIES) * 100).toFixed(0)}% hit ratio`);

  // ════════════════════════════════════════════════════════════════════════
  // D) RETRIEVE → RANK — distance gets the SET; ranking is a product blend
  // ════════════════════════════════════════════════════════════════════════
  log("");
  log("═══ D) Retrieve → rank: same candidates, distance-only vs blended ═══");
  // The retrieved candidate set (distance already filtered these IN). Now rank them.
  interface Cand { name: string; distKm: number; rating: number; reviews: number; sponsored: boolean }
  const cands: Cand[] = [
    { name: "QuickBite",   distKm: 0.1, rating: 3.0, reviews: 40,   sponsored: false },
    { name: "Nook",        distKm: 0.3, rating: 4.9, reviews: 25,   sponsored: false },
    { name: "Luigi's",     distKm: 0.5, rating: 4.5, reviews: 600,  sponsored: false },
    { name: "Bella",       distKm: 0.8, rating: 4.8, reviews: 1200, sponsored: false },
    { name: "SponsorCafe", distKm: 1.1, rating: 4.1, reviews: 300,  sponsored: true  },
  ];
  // Blend: proximity (decays with distance) + quality (rating², punishes 3★) + popularity
  // (log reviews) + a sponsored placement boost. Weights are the product's to tune.
  const blend = (c: Cand) => {
    const proximity = Math.exp(-c.distKm / 0.6);
    const quality = (c.rating / 5) ** 2;
    const popularity = Math.log10(c.reviews) / 4;
    const sponsoredBoost = c.sponsored ? 0.08 : 0;
    return 0.30 * proximity + 0.50 * quality + 0.20 * popularity + sponsoredBoost;
  };
  const byDistance = [...cands].sort((a, b) => a.distKm - b.distKm);
  const byBlend = [...cands].sort((a, b) => blend(b) - blend(a));
  log(`   distance-only : ${byDistance.map((c) => c.name).join(" > ")}`);
  log(`   blended score : ${byBlend.map((c) => `${c.name}(${blend(c).toFixed(2)})`).join(" > ")}`);
  log(`   → Bella (4.8★, 800m) beats QuickBite (3.0★, 100m); SponsorCafe is injected up the list.`);
  log("   Distance is retrieval; the money is in the blend — same shape as search/ads ranking.");

  // ════════════════════════════════════════════════════════════════════════
  // E) SURGE — per-cell demand/supply heatmap, rolled up the cell hierarchy
  // ════════════════════════════════════════════════════════════════════════
  log("");
  log("═══ E) Surge: open-requests : drivers per cell → multiplier, rolled up ═══");
  // A sliding-window snapshot per fine cell. multiplier smooths & clamps the ratio.
  const surge = (req: number, drv: number) => Math.min(3.0, Math.max(1.0, 1 + (req / Math.max(1, drv) - 1) * 0.5));
  const zones: Array<{ name: string; p: Point; req: number; drivers: number }> = [
    { name: "Financial District", p: { name: "FiDi", lat: 37.7946, lng: -122.3999 }, req: 180, drivers: 20 },
    { name: "Union Square",       p: { name: "USq",  lat: 37.7880, lng: -122.4074 }, req: 90,  drivers: 30 },
    { name: "Mission",            p: { name: "Mis",  lat: 37.7599, lng: -122.4148 }, req: 40,  drivers: 35 },
    { name: "Outer Sunset",       p: { name: "Sun",  lat: 37.7558, lng: -122.4949 }, req: 12,  drivers: 40 },
  ];
  log(`   per-cell (precision ${P}, cached per cell, short TTL — eventual/approximate):`);
  for (const z of zones) {
    const cell = encode(z.p.lat, z.p.lng, P);
    log(`     ${z.name.padEnd(19)} ${cell}  req ${String(z.req).padStart(3)} : drv ${String(z.drivers).padStart(2)}  → ${surge(z.req, z.drivers).toFixed(2)}× ${z.req > z.drivers ? "🔥" : ""}`);
  }
  // Roll UP to a coarser surge-cell (precision 5 parent) by aggregating children.
  const COARSE = 5;
  const roll = new Map<string, { req: number; drivers: number }>();
  for (const z of zones) {
    const parent = encode(z.p.lat, z.p.lng, COARSE);
    const agg = roll.get(parent) ?? { req: 0, drivers: 0 };
    agg.req += z.req; agg.drivers += z.drivers; roll.set(parent, agg);
  }
  log(`   rolled up to precision ${COARSE} surge-cells (the hierarchical-cell aggregate):`);
  for (const [parent, agg] of roll)
    log(`     ${parent}  req ${String(agg.req).padStart(3)} : drv ${String(agg.drivers).padStart(2)}  → ${surge(agg.req, agg.drivers).toFixed(2)}×`);
  log("   The heatmap is approximate; the price QUOTED to a rider is pinned to their trip,");
  log("   not re-read from this live estimate.");

  log("");
  log("Every line above sits OUTSIDE the geohash index. The index just returned a");
  log("candidate set; scale, tails, hot keys, ranking, and surge are the seams around");
  log("it — and naming them is the difference between the easy 20% and a Staff answer.");
  process.exit(0);
}

main();
