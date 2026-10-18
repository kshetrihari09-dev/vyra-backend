import { Router } from "express";
import { validate } from "../middleware/validate.js";
import { locateQuery } from "../validators/geo.validators.js";

/** Public: it only turns a map coordinate into the public administrative area it falls in (no personal data). Rate limited per IP. */
export function geoRoutes({ controller, limiters }) {
  const r = Router();
  r.get("/geo/locate", limiters.geoLocate, validate({ query: locateQuery }), controller.locate);
  return r;
}
