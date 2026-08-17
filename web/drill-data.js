/** Drill data — mined from Core Course/29-geospatial-systems.md. Loaded by index.html's Drill panel. */
window.DRILL = {
  module: "Module 29 — Geospatial Systems",
  source: "Core Course/29-geospatial-systems.md",
  cheats: [
    "Recognize 'find nearby' / 'within X km' / 'ETA' / 'match' as geospatial — then name <b>index → routing → matching</b>, in that order.",
    "<b>Geohash + Redis</b> is the default: a 1-D key any KV indexes, <code>GEOSEARCH</code> native, precision 6 (~1 km) + <b>9-cell neighbor scan</b>, re-rank by Haversine.",
    "<b>S2 / H3</b> when you need hierarchical cells (roll up dispatch cells to surge cells), region cover, or Hilbert-curve locality at Google/Uber scale.",
    "<b>QuadTree</b> for wildly non-uniform density — self-balancing in-memory, but awkward to shard (shard by city instead).",
    "<b>R-tree / PostGIS</b> when the objects are polygons/extents and the question is point-in-polygon, not nearest.",
    "Why a B-tree fails: no 1-D ordering keeps both axes local — a radius query scans a planet-wide latitude stripe. A <em>space-filling curve</em> fixes it.",
    "The boundary problem: adjacent points across a cell border share no prefix — query the <b>cell + 8 neighbors</b>, and say it <em>unprompted</em>.",
    "Uber write-path: 3M drivers / 4 s pings ≈ <b>750k writes/sec</b> — in-memory geo-index fed by a city-partitioned stream, DB off the hot path, TTL ages out stale drivers.",
    "Backpressure lever: <em>widen the ping interval</em> (4 s → 8 s) — halves the write rate for slightly staler positions; drop stale pings, latest wins.",
    "Hot cells: Times Square is a hot key — <b>replicate the cell</b>, sub-shard it finer, cache its candidate set with a short TTL.",
    "Routing ladder: Dijkstra (too slow) → A* (heuristic) → <b>Contraction Hierarchies</b> (offline shortcuts → sub-ms) → <b>CRP</b> (topology vs traffic metric → cheap live-traffic re-customize).",
    "Dispatch: <b>batched global min-cost matching</b> over a 2–5 s window, not greedy nearest — better marketplace outcome and it dissolves the double-assignment race.",
    "The <b>atomic driver-claim</b> is a CAS: <code>available → offered</code> only if still available; accept-timeout releases the claim and re-dispatches.",
    "Signature line: <em>separate the location firehose (eventual, in-memory, lossy) from the transactional core (trip↔driver assignment, strongly consistent)</em> — that separation is the whole design."
  ],
  cards: [
    {
      topic: "index choice",
      q: "Geohash vs. S2 vs. QuadTree — which do you pick and why?",
      a: "Geohash by default because it is a 1-D key that is KV/Redis-native and operationally trivial: precision 6 plus the 9-cell neighbor scan answers nearest-k. Revisit to S2/H3 if you need hierarchical cells (roll dispatch cells up to surge cells by bit-truncation), region cover for geo-fences, or Hilbert locality at Google/Uber scale. Revisit to QuadTree if density is wildly non-uniform — it self-balances so every leaf holds roughly equal entities, at the cost of being a stateful in-memory tree you shard by city. Decide on geohash, then name the triggers for the others."
    },
    {
      topic: "B-tree failure",
      q: "Why can't a B-tree on (lat, lng) serve a 'drivers within 2 km' query?",
      a: "A B-tree imposes a 1-D total order: it narrows on latitude, then row-scans the entire latitude band filtering longitude — a planet-wide horizontal stripe, not a local box. No 1-D ordering of 2-D points keeps both axes local. The fix is a space-filling-curve key (geohash/S2) that bakes 2-D proximity into a sortable 1-D value, so a radius search becomes a few range scans."
    },
    {
      topic: "boundary problem",
      q: "What is the geohash edge/boundary problem and how do you fix it?",
      a: "Two physically adjacent points can straddle a cell border and share no prefix, so a single-prefix query silently drops the nearest result. Fix: compute the query cell plus its 8 neighbors (the 3x3 neighbors() technique), scan all 9, then re-rank candidates by true Haversine distance. Name it unprompted — it is the cleanest geohash depth signal."
    },
    {
      topic: "write-path",
      q: "How do you ingest millions of driver location pings per second?",
      a: "You don't write them to a database — ~750k pings/sec (3M drivers / 4 s) stream over WebSocket into a city-partitioned log feeding an in-memory geo-index that holds only the current position with a TTL. The DB persists trips, not breadcrumbs; the trail is batched and downsampled async to cold storage. The index is derived state, rebuildable by replaying the stream; under load, widen the ping interval as the backpressure lever."
    },
    {
      topic: "hot cells",
      q: "How do you handle a hot cell like Times Square?",
      a: "It is a hot key: one cell with 100x the entities and 100x the read fan-out. Layer the fixes — replicate the cell across read replicas, sub-shard it into finer cells just there, and cache its candidate result set with a short TTL because the query is asked thousands of times a second and changes slowly. Detect hotness with a per-cell QPS counter and promote automatically."
    },
    {
      topic: "dispatch",
      q: "Greedy nearest-driver or something better for dispatch?",
      a: "Batched global min-cost matching, not greedy: buffer requests per region over a 2-5 s window, build a cost matrix (ETA + idle time + fairness), and solve the assignment via min-cost flow over the sparse candidate graph — Hungarian is only the balanced-square O(n^3) special case, not what runs at city scale. It beats greedy on total rider wait and dissolves the double-assignment race because a single writer commits the batch. Greedy only in ultra-low-density regions where there is nothing to batch."
    },
    {
      topic: "atomic claim",
      q: "How do you prevent the same driver being assigned to two trips?",
      a: "An atomic conditional-write driver-claim: transition available -> offered only if still available — first writer wins, the loser takes the next candidate. Pair it with an accept-timeout that releases the claim and re-dispatches, plus match-then-confirm to catch ghost drivers whose TTL has not yet expired. This CAS is the strongly-consistent kernel of an otherwise eventually-consistent system."
    },
    {
      topic: "routing",
      q: "How does routing scale to continental distances in milliseconds?",
      a: "Naive Dijkstra re-explores the whole graph per query; A* with a distance heuristic still touches millions of nodes on long routes. Contraction Hierarchies preprocess the graph offline, adding shortcut edges so a query runs a bidirectional upward search touching low thousands of nodes — sub-millisecond. For live traffic, CRP splits the rarely-changing topology from the constantly-changing traffic metric, so a traffic update is a cheap re-customization rather than a full re-preprocess."
    },
    {
      topic: "surge",
      q: "How is surge pricing computed?",
      a: "A per-geo-cell demand heatmap: over a sliding window, the ratio of open requests to available drivers per cell maps to a multiplier, cached short-TTL and aggregated up a cell hierarchy — the S2/H3 hierarchical-cell use case. It is eventually consistent and approximate, but quote-then-honor: the displayed estimate is eventual while the committed quote is pinned to the trip record. Surge both rations scarce supply and steers drivers toward demand."
    },
    {
      topic: "consistency boundary",
      q: "Where is the strong/eventual consistency boundary in a ride-hailing system?",
      a: "The only strongly consistent thing is the trip-driver assignment and the trip state machine — atomic claim, idempotent transitions, source of truth in the Trip DB. Everything geospatial (driver location, nearby results, surge multiplier, ETA) is eventually consistent and approximate by design. Articulating that boundary, and why the firehose must stay off the transactional path, is the judgment the whole design hinges on."
    }
  ]
};
