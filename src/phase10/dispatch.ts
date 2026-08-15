/**
 * Phase 10 — DISPATCH: matching as OPTIMIZATION OVER A MARKETPLACE. Run: node src/phase10/dispatch.ts
 *
 * Phases 1–4 built RETRIEVAL: "find me the nearest K drivers", fast, over a live
 * fleet. That is a LOOKUP. Dispatch is the step after, and it is NOT a lookup —
 * it is the Uber/Lyft core, and getting this right is the single differentiator
 * between an engineer who indexes points and one who runs a marketplace.
 *
 * The naive answer is GREEDY NEAREST: for each incoming request, hand it the
 * closest free driver. It feels obviously correct and it is WRONG AT THE MARGIN,
 * for two separate reasons:
 *
 *   (1) A CONCURRENCY RACE. Two requests, processed "at the same time", both see
 *       the same driver as free and both grab him. Double-assignment.
 *   (2) A WORSE MARKETPLACE. Greedy is myopic: it gives request A its nearest
 *       driver even when that driver was the ONLY option for request B. B now
 *       waits much longer, or goes unmatched — while A saved a trivial amount.
 *       Locally optimal, globally poor.
 *
 * The Staff answer reframes it. Don't decide requests one at a time; collect a
 * short BATCH (a ~1–2s window of open requests), build the sparse cost matrix
 * (each request has edges only to its few NEARBY drivers, from the Phase-4 kNN),
 * and solve a GLOBAL MIN-COST BIPARTITE ASSIGNMENT — minimize the TOTAL rider
 * wait across the whole batch. Cost(rider, driver) is an ETA proxy: here the
 * Haversine distance (a real system also folds in idle-time fairness — favor the
 * driver waiting longest — and pickup-direction terms; those are extra additive
 * costs in the same matrix, not a different algorithm).
 *
 * Batching buys TWO things at once:
 *   - Better efficiency: the global optimum trades a few riders' tiny detours to
 *     rescue riders who would otherwise be stranded. Lower TOTAL wait.
 *   - It DISSOLVES the race: a SINGLE WRITER decides the whole batch, so no two
 *     assignments can pick the same driver in the first place.
 *
 * Then each assignment is COMMITTED with an atomic conditional write (CAS): flip
 * the driver available→offered ONLY IF still available. Across shards/regions two
 * matchers can still collide; the CAS makes exactly one win and the loser
 * re-dispatch. This atomic driver-claim is the strongly-consistent kernel inside
 * an otherwise eventually-consistent system. The offer then has an ACCEPT TIMEOUT:
 * decline or silence releases the claim (offered→available) and the next
 * candidate is offered — which also catches "ghost drivers" (offline, but their
 * location TTL hasn't expired yet) via match-then-confirm.
 *
 * TAKEAWAY: dispatch is BATCHED GLOBAL MIN-COST MATCHING over the sparse
 * nearby-candidate graph — min-cost FLOW at city scale; the Hungarian algorithm
 * we use below is only the O(n^3) balanced-square special case, fine for one small
 * batch but NOT how you'd run a whole city. It is NOT greedy nearest: the global
 * solve gives better marketplace efficiency AND dissolves the double-assignment
 * race, because one writer decides the batch. Each assignment is then committed
 * with an atomic conditional-write driver-claim (first writer wins, loser
 * re-dispatches) guarded by an accept-timeout. Dispatch is an optimization over a
 * marketplace, not a lookup.
 */

import { log } from "../lib/log.ts";
import { haversineKm, type Point } from "../lib/geo.ts";

// ── Deterministic placement — seeded mulberry32, no Math.random / Date.now ──────
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CITY_SPEED_KM_PER_MIN = 0.5; // ~30 km/h through-traffic → ETA(min) = km / 0.5 = km * 2
const etaMin = (km: number) => km / CITY_SPEED_KM_PER_MIN;
const RADIUS_KM = 1.5;   // a driver is a candidate for a rider only within this reach
const NO_EDGE = 1e6;     // sentinel cost: this (rider, driver) pair is not a candidate
const STRAND_PENALTY_MIN = 60; // a rider left unmatched re-enters a later batch / gives up

// ── Min-cost bipartite assignment: Hungarian (Kuhn–Munkres), O(n^3) balanced sq ─
// Minimizes the total of cost[i][assign[i]] over a SQUARE matrix. Non-candidate
// pairs carry NO_EDGE, so the optimum matches every rider it possibly can before
// it ever pays the sentinel. This is the small-batch special case; a whole city
// is a MIN-COST FLOW over the sparse candidate graph, not one dense square.
function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);   // p[j] = row currently assigned to column j
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else { minv[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const assign = new Array(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] !== 0) assign[p[j] - 1] = j - 1;
  return assign;
}

// ── The marketplace: N open requests, M available drivers, the sparse cost grid ─
interface Agent extends Point { pos: { lat: number; lng: number } }

function placeAgents(seed: number, riderCount: number, driverCount: number) {
  const rng = mulberry32(seed);
  const base = { lat: 37.773, lng: -122.42 }; // SF Mission-ish
  const spread = 0.05; // ~4–5 km box
  const spawn = (name: string): Agent => {
    const lat = base.lat + (rng() - 0.5) * spread;
    const lng = base.lng + (rng() - 0.5) * spread;
    return { name, lat, lng, pos: { lat, lng } };
  };
  const riders: Agent[] = [];
  const drivers: Agent[] = [];
  for (let i = 0; i < riderCount; i++) riders.push(spawn(`R${i}`));
  for (let j = 0; j < driverCount; j++) drivers.push(spawn(`D${j}`));
  return { riders, drivers };
}

/** cost[i][j] = ETA(min) if driver j is within RADIUS_KM of rider i, else NO_EDGE. */
function costMatrix(riders: Agent[], drivers: Agent[]): number[][] {
  return riders.map((r) =>
    drivers.map((d) => {
      const km = haversineKm(r.pos, d.pos);
      return km <= RADIUS_KM ? etaMin(km) : NO_EDGE;
    }),
  );
}

// ── A) GREEDY NEAREST — process requests in arrival order, grab nearest free ────
interface GreedyStep { rider: number; assigned: number; wanted: number; unmatched: boolean }

function greedyDispatch(cost: number[][]) {
  const n = cost.length;
  const taken = new Array(cost[0].length).fill(false);
  const steps: GreedyStep[] = [];
  for (let i = 0; i < n; i++) {
    let best = -1, bestC = Infinity;   // nearest FREE candidate
    let wanted = -1, wantedC = Infinity; // nearest candidate regardless of free
    for (let j = 0; j < cost[i].length; j++) {
      if (cost[i][j] >= NO_EDGE) continue;
      if (cost[i][j] < wantedC) { wantedC = cost[i][j]; wanted = j; }
      if (taken[j]) continue;
      if (cost[i][j] < bestC) { bestC = cost[i][j]; best = j; }
    }
    if (best === -1) steps.push({ rider: i, assigned: -1, wanted, unmatched: true });
    else { taken[best] = true; steps.push({ rider: i, assigned: best, wanted, unmatched: false }); }
  }
  return steps;
}

// ── C) ATOMIC DRIVER-CLAIM — compare-and-set. First writer wins the transition. ─
type DriverState = "available" | "offered" | "onTrip";
interface DriverRecord { name: string; state: DriverState; offeredTo: string | null }

/** The strongly-consistent kernel: flip available→offered ONLY IF still available.
 *  Real systems get this atomicity from a conditional write (DynamoDB
 *  ConditionExpression, a Redis WATCH/MULTI, or SELECT … FOR UPDATE). */
function claim(driver: DriverRecord, byMatcher: string): boolean {
  if (driver.state !== "available") return false; // CAS fails: someone else got here first
  driver.state = "offered";
  driver.offeredTo = byMatcher;
  return true;
}

function totals(costOf: (i: number) => number, n: number, unmatched: number) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += costOf(i);
  const total = sum + unmatched * STRAND_PENALTY_MIN;
  return { matchedSum: sum, total, avg: total / n };
}

function main() {
  const SEED = 32;
  const { riders, drivers } = placeAgents(SEED, 6, 6);
  const cost = costMatrix(riders, drivers);
  const n = riders.length;

  log("═══ One batch: 6 open requests, 6 available drivers (seed 32) ═══");
  log("   Sparse cost matrix — ETA minutes; '·' = driver out of reach (no edge):");
  log(`   ${"".padEnd(4)}${drivers.map((d) => d.name.padStart(6)).join("")}`);
  for (let i = 0; i < n; i++) {
    const row = cost[i].map((c) => (c >= NO_EDGE ? "·" : c.toFixed(2)).padStart(6)).join("");
    log(`   ${riders[i].name.padEnd(4)}${row}`);
  }

  // ── A) GREEDY ──────────────────────────────────────────────────────────────
  log("");
  log("═══ A) GREEDY NEAREST — one request at a time, take the nearest free driver ═══");
  const greedy = greedyDispatch(cost);
  let greedyUnmatched = 0;
  for (const s of greedy) {
    if (s.unmatched) {
      greedyUnmatched++;
      log(`   ${riders[s.rider].name} → ✗ UNMATCHED — its only reachable driver ${drivers[s.wanted].name} was already taken`);
    } else {
      const note = s.wanted !== s.assigned ? ` (wanted ${drivers[s.wanted].name}, taken → settled for ${drivers[s.assigned].name})` : "";
      log(`   ${riders[s.rider].name} → ${drivers[s.assigned].name}  ${cost[s.rider][s.assigned].toFixed(2)} min${note}`);
    }
  }
  const gT = totals((i) => (greedy[i].unmatched ? 0 : cost[i][greedy[i].assigned]), n, greedyUnmatched);
  log(`   matched-rider wait sum = ${gT.matchedSum.toFixed(2)} min  (looks cheap — but only because it ABANDONED ${greedyUnmatched})`);
  log(`   total wait incl. ${STRAND_PENALTY_MIN}-min strand penalty = ${gT.total.toFixed(2)} min · avg ${gT.avg.toFixed(2)} · unmatched ${greedyUnmatched}`);

  // ── B) BATCHED GLOBAL MIN-COST ──────────────────────────────────────────────
  log("");
  log("═══ B) BATCHED GLOBAL MIN-COST MATCHING — one writer solves the whole batch ═══");
  const assign = hungarian(cost);
  let batchUnmatched = 0;
  for (let i = 0; i < n; i++) {
    const j = assign[i];
    if (cost[i][j] >= NO_EDGE) { batchUnmatched++; log(`   ${riders[i].name} → ✗ UNMATCHED`); }
    else {
      const g = greedy[i];
      const moved = !g.unmatched && g.assigned !== j;
      const note = moved ? `  (greedy gave it ${drivers[g.assigned].name}; global solve moved it to free the sole car for a stranded rider)` : "";
      log(`   ${riders[i].name} → ${drivers[j].name}  ${cost[i][j].toFixed(2)} min${note}`);
    }
  }
  const bT = totals((i) => (cost[i][assign[i]] >= NO_EDGE ? 0 : cost[i][assign[i]]), n, batchUnmatched);
  log(`   total wait incl. penalty = ${bT.total.toFixed(2)} min · avg ${bT.avg.toFixed(2)} · unmatched ${batchUnmatched}`);
  log(`   the global optimum spends a few extra seconds on one rider to rescue another — everybody rides.`);

  // ── C) ATOMIC DRIVER-CLAIM (CAS) — two matchers race for one driver ─────────
  log("");
  log("═══ C) ATOMIC DRIVER-CLAIM — commit each assignment with a conditional write ═══");
  // Reuse the real conflict from the greedy trace: the stranded rider and the
  // single driver two requests both wanted. Two matchers (e.g. two region shards)
  // race to claim that driver; the CAS must let exactly one through.
  const contested = greedy.find((s) => s.unmatched) ?? greedy[0];
  const contestedDriver = drivers[contested.wanted];
  const rec: DriverRecord = { name: contestedDriver.name, state: "available", offeredTo: null };
  log(`   two matchers concurrently try to claim ${rec.name} (state=${rec.state})`);
  const wonAlpha = claim(rec, "matcher-α");
  const wonBeta = claim(rec, "matcher-β"); // arrives a hair later
  log(`   matcher-α CAS available→offered: ${wonAlpha ? "✓ WON" : "✗ lost"}`);
  log(`   matcher-β CAS available→offered: ${wonBeta ? "✓ WON" : "✗ lost — sees state=offered, must re-dispatch to its next candidate"}`);
  log(`   ${rec.name} is now offered to ${rec.offeredTo}. Exactly one winner — no double-assignment.`);

  // ── D) OFFER TIMEOUT & RE-DISPATCH — state machine + a deterministic clock ──
  log("");
  log("═══ D) OFFER TIMEOUT & RE-DISPATCH — a claim is a lease, not a commit ═══");
  // A driver has ACCEPT_TTL ticks to accept; on decline/silence the claim is
  // released (offered→available) and the next candidate is offered. This also
  // catches GHOST DRIVERS — offline, but their location TTL hasn't lapsed, so the
  // kNN still surfaced them. Match-then-confirm exposes the ghost: it never
  // accepts, times out, and we move on. Deterministic integer clock (no Date.now).
  const ACCEPT_TTL = 3;
  const candidateQueue = ["D-ghost (offline, TTL not expired)", "D-live"];
  const willAccept = [false, true]; // the ghost never answers; the next driver does
  let clock = 0;
  let matched = false;
  for (let c = 0; c < candidateQueue.length && !matched; c++) {
    const offeredAt = clock;
    log(`   t=${clock}: offer → ${candidateQueue[c]}  (state: available→offered, lease ${ACCEPT_TTL} ticks)`);
    for (let elapsed = 1; elapsed <= ACCEPT_TTL; elapsed++) {
      clock++;
      if (willAccept[c]) { log(`   t=${clock}: ✓ accepted (state: offered→onTrip) — dispatched`); matched = true; break; }
    }
    if (!matched) { clock = offeredAt + ACCEPT_TTL; log(`   t=${clock}: ⏱ timeout, no accept → release (offered→available), advance to next candidate`); }
  }

  // ── Comparison ──────────────────────────────────────────────────────────────
  log("");
  log("═══ COMPARISON ═══");
  log(`   GREEDY NEAREST : avg wait ${gT.avg.toFixed(2)} min · unmatched ${greedyUnmatched} · total ${gT.total.toFixed(2)} min`);
  log(`   BATCHED GLOBAL : avg wait ${bT.avg.toFixed(2)} min · unmatched ${batchUnmatched} · total ${bT.total.toFixed(2)} min`);
  log(`   batched total ${bT.total.toFixed(2)} ≤ greedy total ${gT.total.toFixed(2)} → ${bT.total <= gT.total ? "✓ batching wins" : "✗"}, and one writer per batch dissolved the race.`);
  log(`   atomic-claim race: one of {matcher-α, matcher-β} won ${rec.name}, the other re-dispatched.`);
  log("");
  log("Dispatch is batched global min-cost matching over the sparse nearby-candidate");
  log("graph (min-cost flow at city scale; Hungarian only for this small square),");
  log("committed with an atomic conditional-write driver-claim + accept-timeout.");
  log("It is an optimization over a marketplace, not a lookup.");
  process.exit(0);
}

main();
