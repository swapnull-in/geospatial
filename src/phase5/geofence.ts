/**
 * Phase 5 — GEOFENCING: point-in-polygon (containment, NOT proximity). Run: npm run phase5
 *
 * The other half of geo. Proximity (Phases 1–4) asks "what's NEAR me". CONTAINMENT
 * asks "am I INSIDE this zone" — a delivery area, a surge-pricing region, a
 * restricted airspace, a "you've arrived" trigger. It is a completely different
 * query and using a proximity index for it is a classic mistake.
 *
 * The core primitive is POINT-IN-POLYGON via RAY CASTING: shoot a ray from the
 * point in any fixed direction (we use "straight right") and count how many
 * polygon edges it crosses. ODD crossings ⇒ inside; EVEN ⇒ outside. (Intuition:
 * every time you cross the border you flip between out and in; starting outside,
 * an odd number of flips leaves you inside.)
 *
 * At scale (1M zones), you don't ray-cast against every polygon — you first use a
 * spatial index on the polygons' bounding boxes to get the few candidate zones,
 * THEN ray-cast only those. Index to narrow, exact test to confirm.
 */

import { log } from "../lib/log.ts";

interface Pt { x: number; y: number }

/** Ray-casting point-in-polygon (even-odd rule). Polygon = ordered vertices. */
function pointInPolygon(pt: Pt, polygon: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    // Does a rightward ray from pt cross edge a–b?
    const straddles = (a.y > pt.y) !== (b.y > pt.y);
    if (straddles) {
      const xCross = a.x + ((pt.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (pt.x < xCross) inside = !inside; // crossing to the right → flip
    }
  }
  return inside;
}

/** Quick reject with a bounding box before the exact test (what you'd index on). */
function boundingBox(poly: Pt[]) {
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function main() {
  // An L-shaped delivery zone (non-convex, to make ray casting earn its keep).
  const zone: Pt[] = [
    { x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 6 }, { x: 0, y: 6 },
  ];

  log("═══ Is each point inside the L-shaped delivery zone? ═══");
  const tests: Array<[string, Pt]> = [
    ["customer A", { x: 1, y: 1 }],   // inside the base
    ["customer B", { x: 1, y: 5 }],   // inside the left arm
    ["customer C", { x: 5, y: 5 }],   // in the notch — OUTSIDE despite being 'central'
    ["customer D", { x: 5, y: 2 }],   // inside the base's right part
    ["driver E",   { x: 7, y: 1 }],   // clearly outside
  ];
  const bb = boundingBox(zone);
  for (const [name, p] of tests) {
    const inBox = p.x >= bb.minX && p.x <= bb.maxX && p.y >= bb.minY && p.y <= bb.maxY;
    const inside = inBox && pointInPolygon(p, zone);
    log(`   ${name.padEnd(11)} (${p.x},${p.y}) → ${inside ? "✓ INSIDE" : "✗ outside"}${!inBox ? " (bbox-rejected, no ray cast)" : ""}`);
  }

  log("");
  log("Note customer C at (5,5): visually 'in the middle' but sitting in the L's");
  log("NOTCH — correctly outside. That non-convex case is exactly why you need real");
  log("ray casting, not just a bounding box or a radius check.");
  log("");
  log("Scale plan for 1M zones: index every zone's bounding box (Phase 2/3), fetch");
  log("the handful whose box contains the point, then ray-cast only those. That's");
  log("the generalized geofence-entry pattern — containment, not proximity.");
  process.exit(0);
}

main();
