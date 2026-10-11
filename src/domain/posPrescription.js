import { badRequest } from "../utils/errors.js";
import { RX_MAX_AGE_DAYS } from "../config/pos.js";

/* Rules for dispensing a prescription-required product at the till. Pure (no database, no clock of its own) — unit-tested in posPrescription.test.js.

   The storefront already refuses these medicines without an APPROVED prescription (decision D5, orders.service). The till used to skip that
   check entirely. At the counter the pharmacist can see the paper prescription, so there are two ways to satisfy the same rule:
     in_store — the pharmacist records what the paper prescription says and confirms they checked the original;
     online   — the customer's prescription that was uploaded and APPROVED through the app is attached (it must cover every medicine sold). */

const DAY = 86_400_000;
const clean = (v, max) => { const s = String(v ?? "").trim().replace(/\s+/g, " "); return s ? s.slice(0, max) : null; };

/** → { patientName, prescriberName, prescriberRegNo, issuedOn, notes } or throws a 400 the cashier can act on. `now` is a Date (injected for tests). */
export function validateInStore(input, now = new Date()) {
  const patientName = clean(input?.patientName, 100);
  const prescriberName = clean(input?.prescriberName, 100);
  if (!patientName) throw badRequest("PRESCRIPTION_INVALID", "Enter the patient's name from the prescription.");
  if (!prescriberName) throw badRequest("PRESCRIPTION_INVALID", "Enter the prescriber's name from the prescription.");
  if (input?.verified !== true) throw badRequest("PRESCRIPTION_INVALID", "Confirm that you have checked the original prescription.");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(input?.issuedOn ?? ""));
  const issued = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  if (!Number.isFinite(issued) || new Date(issued).getUTCDate() !== +m?.[3]) throw badRequest("PRESCRIPTION_INVALID", "Enter the date the prescription was issued.");
  const ageDays = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - issued) / DAY);
  if (ageDays < -1) throw badRequest("PRESCRIPTION_INVALID", "The prescription date is in the future.");   // one day of slack for timezones
  if (ageDays > RX_MAX_AGE_DAYS) throw badRequest("PRESCRIPTION_EXPIRED", `This prescription is older than ${RX_MAX_AGE_DAYS} days and can no longer be dispensed against.`);
  return { patientName, prescriberName, prescriberRegNo: clean(input?.prescriberRegNo, 40), issuedOn: input.issuedOn, notes: clean(input?.notes, 300) };
}

/**
 * An online prescription (the stored row + the product ids it covers) vs the medicines in this sale.
 * Must be approved, recent, and cover EVERY prescription-required product being sold.
 */
export function validateOnline(rx, coveredProductIds, requiredProducts, now = new Date()) {
  if (!rx) throw badRequest("PRESCRIPTION_INVALID", "That prescription could not be found.");
  if (rx.status !== "approved") throw badRequest("PRESCRIPTION_INVALID", "That prescription has not been approved by a pharmacist.");
  const covered = new Set(coveredProductIds);
  const missing = requiredProducts.filter((p) => !covered.has(p.productId));
  if (missing.length) throw badRequest("PRESCRIPTION_INVALID", `That prescription doesn't cover: ${missing.map((p) => p.name).join(", ")}.`, { productIds: missing.map((p) => p.productId) });
  const approvedAt = new Date(rx.reviewed_at ?? rx.created_at).getTime();
  if (Number.isFinite(approvedAt) && (now.getTime() - approvedAt) / DAY > RX_MAX_AGE_DAYS) throw badRequest("PRESCRIPTION_EXPIRED", `That prescription was approved more than ${RX_MAX_AGE_DAYS} days ago.`);
}
