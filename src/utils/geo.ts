/** Great-circle distance between two lat/lng points, in kilometers
 *  (standard Haversine formula — accurate enough for "how far apart are
 *  these two users" without needing any external mapping API). */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371; // Earth's mean radius in km
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

/** Persian-language, human-friendly distance string. */
export function formatDistanceFa(km: number): string {
  if (km < 1) return "کمتر از ۱ کیلومتر";
  return `${Math.round(km)} کیلومتر`;
}
