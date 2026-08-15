# Learn Geospatial Systems in TypeScript

A hands-on, runnable project for understanding location systems at a Staff/EM
level — spatial indexes, nearest-neighbour search, and geofencing, all from
scratch.

Every phase is a small script you can run and read. No build step: modern Node
runs the TypeScript directly. No external services.

> Built to match a Staff-level study path. The through-line: geo is **two
> different problems — name which one you have first**: **proximity** ("what's
> NEAR me" → spatial index + kNN) and **containment** ("am I INSIDE the zone" →
> point-in-polygon). Using a proximity index for containment is a classic mistake.

## Setup

```bash
npm install   # dev types only
```

## The lessons

| Command | What you learn | Problem |
|---|---|---|
| `npm run phase1` | **Haversine distance** + the O(n) brute-force kNN baseline | proximity |
| `npm run phase2` | **Geohash** — prefix proximity, the boundary problem & neighbor fix | proximity |
| `npm run phase3` | **Quadtree** — an adaptive spatial index with range-query pruning | proximity |
| `npm run phase4` | **Expanding-ring kNN** on a grid — the "nearest drivers" query + termination | proximity |
| `npm run phase5` | **Geofencing** — point-in-polygon (ray casting), containment at scale | containment |
| `npm run phase6` | **S2 / Hilbert** — Hilbert vs Z-order locality, hierarchical cells, region cover | index |
| `npm run phase7` | **R-tree** — MBR pruning for polygons/extents; the PostGIS point-in-polygon path | containment |
| `npm run phase8` | **Write-path** — the 750k-pings/sec firehose, in-memory index, TTL, LWW, backpressure | ingestion |
| `npm run phase9` | **Routing** — Dijkstra → A* → Contraction Hierarchies (settled-node counts, same cost) | routing |
| `npm run phase10` | **Dispatch** — greedy vs batched min-cost matching + the atomic driver-claim | matching |
| `npm run phase11` | **At scale** — scatter-gather, tail/deadline, hot cells, retrieve→rank, surge heatmap | scale |

> **Phases 6–11 fold in the Staff-level depth** the module is built around — the
> three pillars are **index → routing → matching**, and the interview is won in the
> seams (the write-path firehose, hot cells, the atomic claim). Phases 1–5 build
> the index; 6–11 build everything around it. All dependency-free and deterministic.

## What each phase proves (the money quotes)

- **Phase 2** — two points **24m apart** land in different geohash cells; an
  exact-cell lookup misses one, and the **8-neighbor search** catches it.
- **Phase 3** — a range query over 5,000 points examines just **14** of them
  (99.7% pruned) by skipping quadrants that can't intersect the query box.
- **Phase 4** — finds the 5 nearest of 2,000 points scanning **49 grid cells**,
  and demonstrates *why you can't stop as soon as you have K*: the Kth-nearest
  must be closer than any unscanned ring before it's safe to terminate.
- **Phase 5** — a point visually "in the middle" of an L-shaped zone is correctly
  **outside** (it's in the notch) — the non-convex case a radius check gets wrong.
- **Phase 6** — walking a 16×16 grid, the Z-order curve makes **127 long jumps**
  (worst 16 cells) where the "Z" snaps back; the **Hilbert** curve makes **0** —
  its consecutive cells are always edge-adjacent, so S2's ranges are tighter.
- **Phase 8** — of 96 pings, **80%** are cheap in-place overwrites and ~20% are
  cell-crossings (remove+add); a silent driver **ages out** via TTL; backpressure
  widens the interval to halve the write rate.
- **Phase 9** — the same query settles **Dijkstra > A\* > CH** nodes for an
  *identical* path cost — CH does the heavy work once offline (shortcuts).
- **Phase 10** — on one batch, **batched min-cost** matching beats **greedy**
  nearest on total rider wait *and* dissolves the double-assignment race; the
  atomic claim (`available → offered` CAS) lets exactly one writer win.

## Interactive Geo Lab

Every phase is also a live, **drawn** instrument in the browser — drag a query
across an SF map and watch brute-force kNN, straddle a geohash cell edge to see
the boundary miss, prune a quadtree, compare the Hilbert and Z-order curves,
crash-and-rebuild the write-path index, race Dijkstra against Contraction
Hierarchies, and match a batch of riders without a race.

```bash
npm run web        # serves web/index.html at http://localhost:8080 (no deps)
```

One self-contained static page (SVG visuals, self-hosted fonts), grouped by tier
and deep-linkable. To host it on **Cloudflare Pages**: connect this repo in the
dashboard with build output `web` (auto-deploys on push), or run
`npx wrangler login` then `npm run deploy`.

## The index picker (from the notes)

| Index | One-liner |
|---|---|
| **Geohash** | 2D → sortable string; prefix = proximity; great on any KV/B-tree (Redis GEO) |
| **Quadtree** | adaptive grid; splits only where dense; good for skewed data |
| **R-tree** | quadtree idea for arbitrary rectangles (roads, footprints); PostGIS |
| **In-memory grid** | fixed cells + expanding-ring kNN; Uber-style high-write dispatch |

## Project layout

```
src/
  lib/log.ts   ·  lib/geo.ts   (haversine + sample data)
  phase1/  haversine + brute-force kNN
  phase2/  geohash + boundary fix
  phase3/  quadtree + range pruning
  phase4/  in-memory grid + expanding-ring kNN
  phase5/  geofencing (point-in-polygon)
  phase6/  S2 / Hilbert curve + hierarchical cells + region cover
  phase7/  R-tree (MBR pruning for polygons)
  phase8/  real-time write-path (in-memory index, TTL, LWW, backpressure)
  phase9/  routing — Dijkstra / A* / Contraction Hierarchies
  phase10/ dispatch — greedy vs batched min-cost matching + atomic claim
  phase11/ proximity at scale — scatter-gather, hot cells, surge
web/
  index.html  ·  serve.mjs   (the interactive Geo Lab — npm run web)
```

## License

MIT — use it, fork it, learn from it.
