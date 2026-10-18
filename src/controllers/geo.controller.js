import { ok } from "../utils/http.js";

export function createGeoController({ services }) {
  return { async locate(req, res) { ok(res, await services.geo.locate(req.valid.query.lat, req.valid.query.lng)); } };
}
