import { DELIVERY_DISTANCE, deliveryFeeFor } from "../config/delivery.js";
import { haversineKm } from "../services/routing.service.js";
import { round2 } from "../utils/text.js";

/**
 * Delivery fee = the option's base fee + a distance charge. Pure: same inputs, same answer — which is what lets the cart
 * quote and the placed order agree to the cent. See config/delivery.js (DELIVERY_DISTANCE) for the rules and the tier table.
 */

/** Fail at startup, not at 2 a.m., if the tier table is malformed. */
export function assertDistanceConfig(cfg = DELIVERY_DISTANCE) {
  const { tiers, maxKm, roadFactor, unknownDistanceFee } = cfg;
  if (!(roadFactor >= 1)) throw new Error("DELIVERY_DISTANCE.roadFactor must be >= 1");
  if (!(unknownDistanceFee >= 0)) throw new Error("DELIVERY_DISTANCE.unknownDistanceFee must be >= 0");
  if (!Array.isArray(tiers) || tiers.length === 0) throw new Error("DELIVERY_DISTANCE.tiers must not be empty");
  let prev = 0;
  for (const t of tiers) {
    if (!(t.upToKm > prev)) throw new Error("DELIVERY_DISTANCE.tiers must be strictly ascending by upToKm");
    if (!(t.fee >= 0)) throw new Error("DELIVERY_DISTANCE tier fees must be >= 0");
    prev = t.upToKm;
  }
  if (maxKm !== tiers[tiers.length - 1].upToKm) throw new Error("DELIVERY_DISTANCE.maxKm must equal the last tier's upToKm");
  return cfg;
}
assertDistanceConfig();

/** A coordinate counts only if it is actually a number. Careful: Number(null) === 0 and Number("") === 0, which would turn
 *  "no pin" (NULL in the database) into a point on the equator — so null / empty / non-numeric are rejected explicitly. */
const isCoord = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) && Number.isFinite(Number(v));
const isPoint = (p) => p != null && isCoord(p.lat) && isCoord(p.lng) && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180;
const pt = (p) => ({ lat: Number(p.lat), lng: Number(p.lng) });
/** Rounded UP to 0.1 km — and tolerant of float noise, so exactly 2 km never becomes "2.0000000001 → 2.1". */
const ceil1 = (km) => Math.ceil(km * 10 - 1e-9) / 10;

/** The tier table as people read it: [{ fromKm, toKm, fee }]. */
export function tierTable(cfg = DELIVERY_DISTANCE) {
  let from = 0;
  return cfg.tiers.map((t) => { const row = { fromKm: from, toKm: t.upToKm, fee: t.fee }; from = t.upToKm; return row; });
}

/**
 * @param {{ optionId: string, taxable: number, branch: {lat,lng}|null, destination: {lat,lng}|null }} input
 * @returns {{
 *   base: number, distanceFee: number|null, fee: number, distanceKm: number|null,
 *   basis: "address_pin"|"no_pin"|"branch_unlocated", deliverable: boolean,
 *   tier: {fromKm:number,toKm:number,fee:number}|null, maxKm: number
 * }}
 */
export function quoteDelivery({ optionId, taxable, branch = null, destination = null }, cfg = DELIVERY_DISTANCE) {
  const base = deliveryFeeFor(optionId, taxable);
  const common = { base, maxKm: cfg.maxKm };

  if (!isPoint(destination) || !isPoint(branch)) {
    const basis = isPoint(destination) ? "branch_unlocated" : "no_pin";
    return { ...common, distanceFee: cfg.unknownDistanceFee, fee: round2(base + cfg.unknownDistanceFee), distanceKm: null, basis, deliverable: true, tier: null };
  }

  const distanceKm = ceil1(haversineKm(pt(branch), pt(destination)) * cfg.roadFactor);
  if (distanceKm > cfg.maxKm) return { ...common, distanceFee: null, fee: base, distanceKm, basis: "address_pin", deliverable: false, tier: null };

  const table = tierTable(cfg);
  const tier = table.find((t) => distanceKm <= t.toKm);
  return { ...common, distanceFee: tier.fee, fee: round2(base + tier.fee), distanceKm, basis: "address_pin", deliverable: true, tier };
}

export const outOfRangeMessage = (q, branchName = "the store") =>
  `This address is about ${q.distanceKm} km from ${branchName}. We deliver within ${q.maxKm} km.`;
