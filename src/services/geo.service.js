import { readFile } from "node:fs/promises";

/**
 * "Which province / district / municipality is this pin in?" — exact point-in-polygon against the boundaries of all 753 local
 * levels (src/data/nepalLocalLevels.json, built by scripts/build_nepal_locations.py from MIT-licensed open data).
 * Runs on the server so customers don't download ~1.4 MB of boundaries; the file is read once, on first use.
 *
 * Wards are NOT resolved: no ward-boundary dataset is bundled, so callers get the municipality's ward COUNT and the person picks the
 * ward. A pin inside a national park / reserve (no municipality) reports the area and the district instead.
 */
const M_PER_DEG = 111_320;

/** Ray casting over one flat ring [x1,y1,x2,y2,…]. */
function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** A polygon is [outer, ...holes]. */
const inPolygon = (poly, x, y) => inRing(poly[0], x, y) && !poly.slice(1).some((h) => inRing(h, x, y));
const inFeature = (f, x, y) => x >= f.b[0] && x <= f.b[2] && y >= f.b[1] && y <= f.b[3] && f.p.some((poly) => inPolygon(poly, x, y));

/** Distance in metres from a point to the nearest edge of a feature's outer rings (small-area flat-earth approximation). */
function edgeDistanceM(f, x, y) {
  const kx = Math.cos((y * Math.PI) / 180) * M_PER_DEG; let best = Infinity;
  for (const poly of f.p) {
    const r = poly[0];
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const ax = (r[j] - x) * kx, ay = (r[j + 1] - y) * M_PER_DEG, bx = (r[i] - x) * kx, by = (r[i + 1] - y) * M_PER_DEG;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

export function createGeoService({ load = () => readFile(new URL("../data/nepalLocalLevels.json", import.meta.url), "utf8").then(JSON.parse), edgeToleranceM = 250 } = {}) {
  let ready = null;
  const data = () => (ready ??= load());

  const shape = (meta, f, approximate) => {
    const dist = meta.dist[f.d];
    const out = { inNepal: true, approximate, province: { id: dist.p, name: meta.prov[dist.p] }, district: { id: f.d, name: dist.n }, municipality: null };
    if (f.m) { const m = meta.muni[f.m]; out.municipality = { id: f.m, name: m.n, wards: m.w }; } else out.area = { name: f.a, type: f.t };
    return out;
  };

  return {
    /** → { inNepal:false } | { inNepal:true, approximate, province, district, municipality|null, area? } */
    async locate(lat, lng) {
      const { meta, features } = await data();
      const hit = features.filter((f) => inFeature(f, lng, lat));
      const best = hit.find((f) => f.m) ?? hit[0]; // municipalities win over a park/reserve that overlaps them
      if (best) return shape(meta, best, false);
      // The boundaries are simplified, so a point right on a border can fall in a hairline gap: take the nearest one within a short distance.
      const pad = 0.004;
      let near = null; let nearD = Infinity;
      for (const f of features) {
        if (lng < f.b[0] - pad || lng > f.b[2] + pad || lat < f.b[1] - pad || lat > f.b[3] + pad) continue;
        const d = edgeDistanceM(f, lng, lat);
        if (d < nearD) { nearD = d; near = f; }
      }
      return near && nearD <= edgeToleranceM ? shape(meta, near, true) : { inNepal: false };
    },
  };
}
