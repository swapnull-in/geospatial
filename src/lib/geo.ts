/** Shared geo primitives. */

export interface Point { name: string; lat: number; lng: number }

/** Great-circle distance between two lat/lng points, in kilometers (haversine). */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371; // Earth radius km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** A few San Francisco landmarks to query against. */
export const SF_PLACES: Point[] = [
  { name: "Ferry Building", lat: 37.7955, lng: -122.3937 },
  { name: "Coit Tower", lat: 37.8024, lng: -122.4058 },
  { name: "Union Square", lat: 37.7880, lng: -122.4074 },
  { name: "Chinatown Gate", lat: 37.7908, lng: -122.4056 },
  { name: "Oracle Park", lat: 37.7786, lng: -122.3893 },
  { name: "Painted Ladies", lat: 37.7762, lng: -122.4327 },
  { name: "Golden Gate Park", lat: 37.7694, lng: -122.4862 },
  { name: "Twin Peaks", lat: 37.7544, lng: -122.4477 },
  { name: "Fisherman's Wharf", lat: 37.8080, lng: -122.4177 },
  { name: "Mission Dolores", lat: 37.7645, lng: -122.4269 },
];
