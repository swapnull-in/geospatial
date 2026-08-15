/**
 * Phase 8 — THE WRITE PATH: real-time location ingestion (Uber, §9).
 * Run: node src/phase8/write-path.ts
 *
 * The read path (kNN dispatch) got all the attention in phases 3–4. The write
 * path is the part Grokking hand-waves, and it's the actual differentiator:
 *
 *   ~3,000,000 online drivers, each pinging every 4s  ≈  750,000 writes/sec.
 *
 * You cannot put 750k writes/sec on Postgres. So you don't. The decisive
 * insight is that a live location is EVENTUALLY CONSISTENT, LOSSY, and
 * DISPOSABLE — it isn't a transaction. It lives in an IN-MEMORY, city-
 * partitioned geo-index fed by a stream, NOT synchronously written to a durable
 * DB on every ping. The database persists trips (strongly consistent); the
 * location firehose is kept well away from that transactional core.
 *
 * The in-memory index is a Map from geohash-CELL → the drivers in that cell
 * (reusing the phase-2 cell idea). Each driver record is
 * {id, lat, lng, cell, lastSeenTick}. We simulate discrete ticks and watch six
 * behaviours that make the firehose survivable:
 *
 *   A) IN-PLACE UPDATE   — most pings don't cross a cell edge, so the update is
 *                          a cheap O(1) overwrite of the driver's position
 *                          (last-write-wins). This is the common path.
 *   B) CELL-CROSSING     — when a driver DOES cross a cell boundary, the index
 *                          must MOVE it: remove from the old cell + add to the
 *                          new one (Redis "ZREM old + GEOADD new"). The minority.
 *   C) TTL / HEARTBEAT   — a driver that stops pinging must AGE OUT after a TTL,
 *                          or a "ghost driver" keeps getting dispatched.
 *   D) LWW / DROP STALE  — an OLDER ping arriving after a newer one (out of
 *                          order) is dropped; a queued old breadcrumb is worthless.
 *   E) BACKPRESSURE      — under load, WIDEN the ping interval (4s → 8s) to halve
 *                          the write rate, trading freshness for survival.
 *   F) REBUILDABLE       — the index is DERIVED STATE. On crash, replay the
 *                          recent stream to rebuild it. Nothing durable is lost.
 *
 * TAKEAWAY: you do NOT write 750k pings/sec to a database. Location lives in an
 * in-memory, city-partitioned, TTL'd geo-index — last-write-wins, most pings a
 * cheap in-place update, cell-crossings a remove+add, stale drivers age out —
 * and it is rebuildable from the stream. The only strongly-consistent thing is
 * the trip↔driver assignment. Separating the location firehose from the
 * transactional core is the single most important decision on the write path.
 */

import { haversineKm } from "../lib/geo.ts";
import { log } from "../lib/log.ts";

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Reuse the phase-2 geohash cell: the index is keyed by this string. */
function geocell(lat: number, lng: number, precision = 6): string {
  let latR = [-90, 90], lngR = [-180, 180];
  let hash = "", bits = 0, bit = 0, even = true;
  while (hash.length < precision) {
    if (even) { const mid = (lngR[0] + lngR[1]) / 2; if (lng >= mid) { bits = bits * 2 + 1; lngR[0] = mid; } else { bits *= 2; lngR[1] = mid; } }
    else { const mid = (latR[0] + latR[1]) / 2; if (lat >= mid) { bits = bits * 2 + 1; latR[0] = mid; } else { bits *= 2; latR[1] = mid; } }
    even = !even;
    if (++bit === 5) { hash += BASE32[bits]; bits = 0; bit = 0; }
  }
  return hash;
}

/** Deterministic PRNG — seeded mulberry32, so runs are reproducible (no Math.random). */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Driver { id: string; lat: number; lng: number; cell: string; lastSeenTick: number }

/** One ping as it travels the stream: capture-time (tick) rides along for LWW. */
interface Ping { id: string; lat: number; lng: number; tick: number }

type PingResult = "new" | "in-place" | "crossing" | "stale-dropped";

/**
 * The in-memory geo-index. Two maps:
 *   cells:   geohash cell  → set of driver ids in that cell (the spatial bucket)
 *   drivers: driver id     → the driver record (position + lastSeenTick, for LWW)
 * Both live in RAM. Nothing here is written through to a durable DB.
 */
class GeoIndex {
  private cells = new Map<string, Set<string>>();
  private drivers = new Map<string, Driver>();
  inPlace = 0;
  crossings = 0;
  dropped = 0;

  private addToCell(cell: string, id: string): void {
    let set = this.cells.get(cell);
    if (!set) { set = new Set(); this.cells.set(cell, set); }
    set.add(id);
  }

  /** Apply one ping. This is the hot path — it runs 750k times a second. */
  ping(p: Ping, precision = 6): PingResult {
    const cell = geocell(p.lat, p.lng, precision);
    const existing = this.drivers.get(p.id);

    // (D) LAST-WRITE-WINS: an out-of-order ping older than what we have is junk.
    if (existing && p.tick <= existing.lastSeenTick) { this.dropped++; return "stale-dropped"; }

    if (!existing) {
      this.drivers.set(p.id, { id: p.id, lat: p.lat, lng: p.lng, cell, lastSeenTick: p.tick });
      this.addToCell(cell, p.id);
      return "new";
    }

    if (cell === existing.cell) {
      // (A) IN-PLACE: same bucket — just overwrite the position. O(1), no churn.
      existing.lat = p.lat; existing.lng = p.lng; existing.lastSeenTick = p.tick;
      this.inPlace++;
      return "in-place";
    }

    // (B) CELL-CROSSING: ZREM from old cell, GEOADD to new cell, then overwrite.
    this.cells.get(existing.cell)!.delete(p.id);
    this.addToCell(cell, p.id);
    existing.cell = cell; existing.lat = p.lat; existing.lng = p.lng; existing.lastSeenTick = p.tick;
    this.crossings++;
    return "crossing";
  }

  /** (C) TTL sweep: drop any driver whose last heartbeat is older than the TTL. */
  evictStale(nowTick: number, ttlTicks: number): string[] {
    const evicted: string[] = [];
    for (const [id, d] of this.drivers) {
      if (nowTick - d.lastSeenTick > ttlTicks) {
        this.cells.get(d.cell)!.delete(id);
        this.drivers.delete(id);
        evicted.push(id);
      }
    }
    return evicted;
  }

  /** Dispatch would only ever match a live driver — so "active" is what matters. */
  activeIds(): string[] { return [...this.drivers.keys()].sort(); }
  size(): number { return this.drivers.size; }
  cellOf(id: string): string | undefined { return this.drivers.get(id)?.cell; }
}

const CITY = "SF"; // one index per city partition; a second city is a second shard.
const PRECISION = 6; // ~1.2km × 0.6km cells — small enough that motion crosses edges.

function main(): void {
  log(`═══ Phase 8 — the location WRITE PATH (${CITY} partition) ═══`);
  log("   3,000,000 drivers × 1 ping / 4s ≈ 750,000 writes/sec — this NEVER touches Postgres.");
  log("   It lands in an in-memory, city-partitioned, geohash-cell geo-index instead.");

  const idx = new GeoIndex();
  const rng = mulberry32(20260816);
  const stream: Ping[] = []; // the durable-ish replay buffer (Kafka-style), for (F).

  // Seed a small fleet in a ~0.05° box around downtown SF.
  const FLEET = 8;
  const drivers = Array.from({ length: FLEET }, (_, i) => ({
    id: `drv-${String(i).padStart(2, "0")}`,
    lat: 37.77 + rng() * 0.05,
    lng: -122.44 + rng() * 0.05,
  }));

  let tick = 0;
  const accept = (p: Ping) => { const r = idx.ping(p, PRECISION); if (r !== "stale-dropped") stream.push(p); return r; };
  for (const d of drivers) accept({ id: d.id, lat: d.lat, lng: d.lng, tick });

  // ─── (A)+(B) Run the firehose: each tick every driver pings after moving a little ──
  log("");
  log("═══ (A) in-place vs (B) cell-crossing — the shape of the firehose ═══");
  const MOVE = 0.0025; // per-tick jitter; usually stays in-cell, occasionally crosses.
  const TICKS = 12;
  for (let t = 0; t < TICKS; t++) {
    tick++;
    for (const d of drivers) {
      d.lat += (rng() - 0.5) * MOVE;
      d.lng += (rng() - 0.5) * MOVE;
      const r = accept({ id: d.id, lat: d.lat, lng: d.lng, tick });
      if (r === "crossing") log(`   tick ${String(tick).padStart(2)}  ${d.id} CROSSED a cell → ZREM old + GEOADD ${idx.cellOf(d.id)}`);
    }
  }
  const moves = idx.inPlace + idx.crossings;
  const pct = ((idx.inPlace / moves) * 100).toFixed(1);
  log(`   ${moves} position updates: ${idx.inPlace} in-place (O(1) overwrite), ${idx.crossings} cell-crossings.`);
  log(`   → ${pct}% were cheap in-place writes; cell-churn is the minority. That's why it scales.`);

  // ─── (C) TTL / heartbeat: a driver goes dark and must age out ──────────────────
  log("");
  log("═══ (C) TTL / heartbeat — evict the ghost driver ═══");
  const TTL = 3; // a driver unseen for > 3 ticks is considered offline.
  const ghost = drivers[0].id;
  const ghostLastSeen = tick; // its final heartbeat was the last tick of the firehose loop.
  log(`   ${ghost} stops pinging (radio dead). Everyone else keeps heartbeating.`);
  const others = drivers.slice(1);
  for (let s = 0; s < TTL + 1; s++) {
    tick++;
    for (const d of others) { d.lat += (rng() - 0.5) * MOVE; d.lng += (rng() - 0.5) * MOVE; accept({ id: d.id, lat: d.lat, lng: d.lng, tick }); }
  }
  log(`   ${ghost} last seen tick ${ghostLastSeen}, now tick ${tick} → stale by ${tick - ghostLastSeen} > ${TTL} ticks.`);
  const beforeEvict = idx.size();
  const evicted = idx.evictStale(tick, TTL);
  log(`   evictStale() removed: ${evicted.join(", ") || "(none)"} — index ${beforeEvict} → ${idx.size()} drivers.`);
  log(`   Without the TTL, dispatch would keep matching ${ghost} and send a rider to a dead car.`);

  // ─── (D) LWW: an out-of-order stale ping is dropped ────────────────────────────
  log("");
  log("═══ (D) last-write-wins — drop the out-of-order stale ping ═══");
  const victim = others[0];
  tick++;
  const freshTick = tick;
  accept({ id: victim.id, lat: victim.lat, lng: victim.lng, tick: freshTick });
  log(`   ${victim.id} newest ping accepted at tick ${freshTick} (${victim.lat.toFixed(4)}, ${victim.lng.toFixed(4)}).`);
  const droppedBefore = idx.dropped;
  // A breadcrumb from 2 ticks ago arrives late (network reorder) — worthless.
  const stalePos = { lat: victim.lat - 0.02, lng: victim.lng - 0.02 };
  const late = idx.ping({ id: victim.id, ...stalePos, tick: freshTick - 2 }, PRECISION);
  const wouldJumpKm = haversineKm(victim, stalePos);
  log(`   a late breadcrumb (tick ${freshTick - 2}) then arrives → result: ${late} (dropped total: ${idx.dropped}, +${idx.dropped - droppedBefore}).`);
  log(`   accepting it would have teleported ${victim.id} ${wouldJumpKm.toFixed(2)}km backwards — LWW keeps the index honest.`);

  // ─── (E) Backpressure lever: widen the ping interval to halve the write rate ───
  log("");
  log("═══ (E) backpressure — widen the ping interval to shed load ═══");
  const drivers3M = 3_000_000;
  const rateAt = (intervalSec: number) => Math.round(drivers3M / intervalSec);
  const normal = rateAt(4);
  const shed = rateAt(8);
  log(`   normal:     ping every 4s → ${normal.toLocaleString()} writes/sec.`);
  log(`   overloaded: LEVER → ping every 8s → ${shed.toLocaleString()} writes/sec (${(normal / shed).toFixed(0)}× lower).`);
  log(`   Graceful degradation: positions get up to 4s staler, and the firehose survives.`);

  // ─── (F) Rebuildable: the index is derived state — replay the stream ───────────
  log("");
  log("═══ (F) rebuildable — the index is DERIVED STATE, not the source of truth ═══");
  log(`   The process crashes. RAM is gone. The DB never stored these breadcrumbs.`);
  const rebuilt = new GeoIndex();
  for (const p of stream) rebuilt.ping(p, PRECISION); // replay the recent stream…
  rebuilt.evictStale(tick, TTL); // …then re-apply the same TTL at the current tick.
  const match = JSON.stringify(rebuilt.activeIds()) === JSON.stringify(idx.activeIds());
  log(`   replayed ${stream.length} pings from the stream → ${rebuilt.size()} active drivers.`);
  log(`   matches the live index (${idx.size()} drivers): ${match ? "✓ yes" : "❌ no"} — nothing durable was lost.`);

  log("");
  log("You do NOT write 750k pings/sec to a database. Location lives in an in-memory,");
  log("city-partitioned, TTL'd geo-index (last-write-wins; most pings a cheap in-place");
  log("update; cell-crossings a remove+add; stale drivers age out), rebuildable from the");
  log("stream. The only strongly-consistent thing is the trip↔driver assignment. Keeping");
  log("the location firehose off the transactional core is the whole game.");
  process.exit(0);
}

main();
