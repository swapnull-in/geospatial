# Study Guide — Geospatial Systems

This repo pairs with **Core Course / 29-geospatial-systems.md**. Study loop: run a phase (`npm run phaseN`), read the annotated source in `src/phaseN/` until every printed number makes sense, then open the Geo Lab (`npm run web`) and hit the **Drill** tab for active-recall cards, and finally re-read the matching module section to lock the staff-level framing. Each phase is small, deterministic, and dependency-free — the point is to *see* the mechanism the module argues about.

## Phase → module mapping

| Phase | What it builds | Module section | The staff insight |
|---|---|---|---|
| 1 | Haversine distance + O(n) brute-force kNN baseline | §2 The core problem | "Correct, and O(n) per query... catastrophic for 10 million driver locations at 100k queries/sec." |
| 2 | Geohash encoding, boundary problem, 8-neighbor fix | §3 Geohash | "Two points can be meters apart... their geohashes diverge at the very first character and share NO prefix." |
| 3 | Quadtree with adaptive splits and range-query pruning | §5 QuadTree | "That pruning turns O(n) into roughly O(log n + hits) — the entire reason to use an index." |
| 4 | In-memory grid + expanding-ring kNN with safe termination | §8 Proximity at scale | "Once you have K candidates, you can't stop immediately: a point in the NEXT ring might still be closer." |
| 5 | Geofencing — point-in-polygon via ray casting | §6 R-tree (containment) | "Containment asks 'am I INSIDE this zone'... using a proximity index for it is a classic mistake." |
| 6 | Hilbert vs Z-order locality, hierarchical cells, region cover | §4 Google S2 | "The Hilbert curve NEVER jumps: consecutive cells are always edge-adjacent." |
| 7 | R-tree — MBR pruning to find which of many zones contains a point | §6 R-tree / R*-tree | "Find WHICH zone(s) contain it — without ray-casting all million polygons." |
| 8 | The write-path firehose: in-memory index, TTL, LWW, backpressure | §9 The Uber write-path | "A live location is EVENTUALLY CONSISTENT, LOSSY, and DISPOSABLE — it isn't a transaction." |
| 9 | Routing — Dijkstra → A* → Contraction Hierarchies | §10 Routing on a road graph | "With no idea where the target is it expands outward in ALL directions like a growing circle." |
| 10 | Dispatch — greedy vs batched min-cost matching + atomic claim | §11 Matching / dispatch | "Dispatch is the step after, and it is NOT a lookup — it is the Uber/Lyft core." |
| 11 | Scatter-gather, tail latency, hot cells, retrieve→rank, surge heatmap | §8 Proximity at scale | "The interview is won in the SEAMS around the index — sharded, hammered by real traffic, powering a product ranking." |

## Go deeper

- **Deep Dives/01-redis.md** — the `GEOADD`/`GEOSEARCH` commands are geohash-in-a-sorted-set under the hood; see why "geohash + Redis" is the boring-correct default.
- **Core Course/16-pattern-scaling-reads.md** — hot cells are hot keys: the replicate/sub-shard/cache-short-TTL playbook from Phase 11 is the general read-scaling pattern.
- **Core Course/31-design-matching-engine.md** — Phase 10's batched matching and atomic claim, generalized: matching as an optimization problem with a single-writer commit.
- **Core Course/18c-design-marketplace-money.md** — what rides on top of dispatch: the trip state machine's `Completed → Paid` saga, the ledger, and the strong/eventual boundary.
- **Core Course/07-search.md** — Phase 11's retrieve→rank two-stage pattern is the same shape as search and ads: cheap wide retrieval, expensive narrow ranking.
- **Core Course/09-realtime-systems.md** — the WebSocket gateway tier that carries Phase 8's ping firehose from millions of drivers.

