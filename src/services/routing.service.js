/**
 * ETA estimation. Two sources, always labelled so the UI never presents a guess as a measurement:
 *   "route"    — driving time from Mapbox Directions (needs MAPBOX_ACCESS_TOKEN on the server)
 *   "estimate" — straight-line distance with a detour factor and an average urban speed (no network, always available)
 * A routing failure NEVER fails a location update or a status change: it silently falls back to the estimate.
 */
const EARTH_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat); const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const DETOUR_FACTOR = 1.35;   // roads are longer than the crow flies
const AVG_SPEED_KMH = 22;     // two-wheeler in city traffic
export const estimateMinutes = (km) => Math.max(1, Math.round(((km * DETOUR_FACTOR) / AVG_SPEED_KMH) * 60));

/** Total minutes through the given points, in order. Pure — no network. */
export function estimateLocal(points) {
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i]);
  return { minutes: estimateMinutes(km), source: "estimate" };
}

export function createRoutingService({ accessToken = "", fetchImpl = globalThis.fetch, logger, timeoutMs = 4000 } = {}) {
  return {
    hasRouting: !!accessToken,
    estimateLocal,
    /** @param {{lat:number,lng:number}[]} points  current position → (pickup →) customer */
    async eta(points) {
      const pts = points.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
      if (pts.length < 2) return null;
      if (accessToken && fetchImpl) {
        try {
          const coords = pts.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
          const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?overview=false&access_token=${encodeURIComponent(accessToken)}`;
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
          if (res.ok) {
            const body = await res.json();
            const seconds = body?.routes?.[0]?.duration;
            if (Number.isFinite(seconds)) return { minutes: Math.max(1, Math.round(seconds / 60)), source: "route" };
          }
        } catch (err) {
          logger?.warn?.("routing failed, using estimate", { error: err?.message });
        }
      }
      return estimateLocal(pts);
    },
  };
}
