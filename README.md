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
```

## License

MIT — use it, fork it, learn from it.
