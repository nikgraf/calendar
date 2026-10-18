/**
 * Where a place search should look first. MapKit takes a region as a
 * hint (never a filter — a strong match elsewhere still wins), and
 * without one it leans on whatever it knows of the device, which differs
 * per host. The hint comes from where the user's recent events were —
 * the densest cluster of their coordinates — else from the city of the
 * primary time zone. Never from a location permission: nothing in the
 * geo seam prompts.
 */

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

export interface GeoRegion extends GeoPoint {
  readonly radiusMeters: number;
}

/** Around the user's recent events: a city and its surroundings. */
export const HISTORY_REGION_RADIUS_METERS = 50_000;
/** Around a time zone's city: wide, since the zone says little more than the country. */
export const TIME_ZONE_REGION_RADIUS_METERS = 150_000;

const EARTH_RADIUS_METERS = 6_371_000;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance in meters. */
export const distanceMeters = (a: GeoPoint, b: GeoPoint): number => {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
};

/**
 * The region around the densest cluster of the points: the point with
 * the most others within `radiusMeters` (the first among equals, so
 * callers pass the most recent first), centered on the mean of it and
 * its neighbours. None for no points.
 */
export const densestRegion = (
  points: ReadonlyArray<GeoPoint>,
  radiusMeters: number = HISTORY_REGION_RADIUS_METERS,
): GeoRegion | undefined => {
  let best: ReadonlyArray<GeoPoint> | undefined;
  for (const point of points) {
    const cluster = points.filter((other) => distanceMeters(point, other) <= radiusMeters);
    if (best === undefined || cluster.length > best.length) {
      best = cluster;
    }
  }
  if (best === undefined) {
    return undefined;
  }
  // Longitudes average on the circle: a cluster across the antimeridian
  // (179.95° and −179.95°) is at 180°, not at 0°.
  const x = best.reduce((sum, point) => sum + Math.cos(toRadians(point.lng)), 0);
  const y = best.reduce((sum, point) => sum + Math.sin(toRadians(point.lng)), 0);
  return {
    lat: best.reduce((sum, point) => sum + point.lat, 0) / best.length,
    lng: (Math.atan2(y, x) * 180) / Math.PI,
    radiusMeters,
  };
};

/** The city a time zone is named for, or its biggest one. */
const TIME_ZONE_CITIES: Readonly<Record<string, GeoPoint>> = {
  'Africa/Cairo': { lat: 30.0444, lng: 31.2357 },
  'Africa/Johannesburg': { lat: -26.2041, lng: 28.0473 },
  'Africa/Lagos': { lat: 6.5244, lng: 3.3792 },
  'Africa/Nairobi': { lat: -1.2921, lng: 36.8219 },
  'America/Argentina/Buenos_Aires': { lat: -34.6037, lng: -58.3816 },
  'America/Bogota': { lat: 4.711, lng: -74.0721 },
  'America/Chicago': { lat: 41.8781, lng: -87.6298 },
  'America/Denver': { lat: 39.7392, lng: -104.9903 },
  'America/Lima': { lat: -12.0464, lng: -77.0428 },
  'America/Los_Angeles': { lat: 34.0522, lng: -118.2437 },
  'America/Mexico_City': { lat: 19.4326, lng: -99.1332 },
  'America/New_York': { lat: 40.7128, lng: -74.006 },
  'America/Phoenix': { lat: 33.4484, lng: -112.074 },
  'America/Santiago': { lat: -33.4489, lng: -70.6693 },
  'America/Sao_Paulo': { lat: -23.5505, lng: -46.6333 },
  'America/Toronto': { lat: 43.6532, lng: -79.3832 },
  'America/Vancouver': { lat: 49.2827, lng: -123.1207 },
  'Asia/Bangkok': { lat: 13.7563, lng: 100.5018 },
  'Asia/Dubai': { lat: 25.2048, lng: 55.2708 },
  'Asia/Hong_Kong': { lat: 22.3193, lng: 114.1694 },
  'Asia/Jakarta': { lat: -6.2088, lng: 106.8456 },
  'Asia/Jerusalem': { lat: 31.7683, lng: 35.2137 },
  'Asia/Kolkata': { lat: 19.076, lng: 72.8777 },
  'Asia/Manila': { lat: 14.5995, lng: 120.9842 },
  'Asia/Seoul': { lat: 37.5665, lng: 126.978 },
  'Asia/Shanghai': { lat: 31.2304, lng: 121.4737 },
  'Asia/Singapore': { lat: 1.3521, lng: 103.8198 },
  'Asia/Taipei': { lat: 25.033, lng: 121.5654 },
  'Asia/Tokyo': { lat: 35.6762, lng: 139.6503 },
  'Australia/Brisbane': { lat: -27.4705, lng: 153.026 },
  'Australia/Melbourne': { lat: -37.8136, lng: 144.9631 },
  'Australia/Perth': { lat: -31.9505, lng: 115.8605 },
  'Australia/Sydney': { lat: -33.8688, lng: 151.2093 },
  'Europe/Amsterdam': { lat: 52.3676, lng: 4.9041 },
  'Europe/Athens': { lat: 37.9838, lng: 23.7275 },
  'Europe/Berlin': { lat: 52.52, lng: 13.405 },
  'Europe/Brussels': { lat: 50.8503, lng: 4.3517 },
  'Europe/Bucharest': { lat: 44.4268, lng: 26.1025 },
  'Europe/Budapest': { lat: 47.4979, lng: 19.0402 },
  'Europe/Copenhagen': { lat: 55.6761, lng: 12.5683 },
  'Europe/Dublin': { lat: 53.3498, lng: -6.2603 },
  'Europe/Helsinki': { lat: 60.1699, lng: 24.9384 },
  'Europe/Istanbul': { lat: 41.0082, lng: 28.9784 },
  'Europe/Lisbon': { lat: 38.7223, lng: -9.1393 },
  'Europe/London': { lat: 51.5074, lng: -0.1278 },
  'Europe/Madrid': { lat: 40.4168, lng: -3.7038 },
  'Europe/Oslo': { lat: 59.9139, lng: 10.7522 },
  'Europe/Paris': { lat: 48.8566, lng: 2.3522 },
  'Europe/Prague': { lat: 50.0755, lng: 14.4378 },
  'Europe/Rome': { lat: 41.9028, lng: 12.4964 },
  'Europe/Stockholm': { lat: 59.3293, lng: 18.0686 },
  'Europe/Vienna': { lat: 48.2082, lng: 16.3738 },
  'Europe/Warsaw': { lat: 52.2297, lng: 21.0122 },
  'Europe/Zurich': { lat: 47.3769, lng: 8.5417 },
  'Pacific/Auckland': { lat: -36.8509, lng: 174.7645 },
};

/** The region around the time zone's city; none for a zone the table does not know. */
export const regionForTimeZone = (zone: string): GeoRegion | undefined => {
  const city = TIME_ZONE_CITIES[zone];
  return city && { ...city, radiusMeters: TIME_ZONE_REGION_RADIUS_METERS };
};
