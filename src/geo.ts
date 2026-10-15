// Great-circle distance and the travel-time estimate used in every answer.

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Island roads wind: straight-line km x 1.35 at 35 km/h, rounded to 5 minutes, at least 5. */
export const ROAD_FACTOR = 1.35;
export const AVG_SPEED_KMH = 35;

export function travelMinutes(km: number): number {
  const minutes = ((km * ROAD_FACTOR) / AVG_SPEED_KMH) * 60;
  return Math.max(5, Math.round(minutes / 5) * 5);
}

export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
