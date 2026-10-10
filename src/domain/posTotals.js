import { badRequest } from "../utils/errors.js";

/**
 * Pure sale arithmetic — no database, no clock. Everything is done in integer cents so no floating-point error can leak into a total.
 *
 *   subtotal = Σ unit price × qty
 *   discount = percent of subtotal | fixed amount          (never more than the subtotal, so the total can't go negative)
 *   tax      = Σ per line: (line amount − its share of the discount) × the line's tax %
 *   total    = subtotal − discount + tax
 *
 * The discount is shared across lines in proportion to their value (largest-remainder, so the shares add up to the discount exactly),
 * which means tax is charged on what the customer actually pays, line by line, and a receipt's lines always add up to its footer.
 */
export const toCents = (n) => Math.round(Number(n) * 100);
export const fromCents = (c) => c / 100;

/** Splits `total` cents across `weights` proportionally; the pieces always sum to exactly `total`. */
export function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const base = exact.map(Math.floor);
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - base[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; base[i] += 1; left -= 1; }
  return base;
}

/**
 * @param {{unitPrice:number, qty:number, taxPercent?:number}[]} lines
 * @param {{type:'percent'|'fixed', value:number}|null|undefined} discount
 * @returns {{subtotal:number, discount:number, tax:number, total:number, lines:{gross:number, discount:number, tax:number}[]}} (all in currency units)
 */
export function priceSale(lines, discount) {
  const gross = lines.map((l) => toCents(l.unitPrice) * l.qty);
  const subtotal = gross.reduce((a, b) => a + b, 0);

  let discountCents = 0;
  if (discount) {
    const v = Number(discount.value);
    if (discount.type === "percent") {
      if (!Number.isFinite(v) || v <= 0 || v > 100) throw badRequest("INVALID_DISCOUNT", "A percentage discount must be between 0 and 100.");
      discountCents = Math.round((subtotal * v) / 100);
    } else if (discount.type === "fixed") {
      if (!Number.isFinite(v) || v <= 0) throw badRequest("INVALID_DISCOUNT", "Enter a discount amount greater than zero.");
      discountCents = toCents(v);
    } else {
      throw badRequest("INVALID_DISCOUNT", "Unknown discount type.");
    }
    if (discountCents > subtotal) throw badRequest("DISCOUNT_TOO_LARGE", "The discount can't be more than the sale amount.");
  }

  const shares = allocate(discountCents, gross);
  const out = gross.map((g, i) => {
    const taxable = g - shares[i];
    return { gross: g, discount: shares[i], tax: Math.round((taxable * (Number(lines[i].taxPercent) || 0)) / 100) };
  });
  const tax = out.reduce((a, l) => a + l.tax, 0);
  return {
    subtotal: fromCents(subtotal), discount: fromCents(discountCents), tax: fromCents(tax), total: fromCents(subtotal - discountCents + tax),
    lines: out.map((l) => ({ gross: fromCents(l.gross), discount: fromCents(l.discount), tax: fromCents(l.tax) })),
  };
}

/** Cash handed over vs the total → the change due, or an error when it is short. Non-cash methods are always paid exactly. */
export function settle({ method, total, amountReceived }) {
  const totalC = toCents(total);
  if (method !== "cash") return { received: total, change: 0 };
  const receivedC = amountReceived == null ? (totalC === 0 ? 0 : null) : toCents(amountReceived);
  if (receivedC == null || receivedC < totalC) {
    throw badRequest("INSUFFICIENT_PAYMENT", "The cash received is less than the total.", { total, received: amountReceived ?? null });
  }
  return { received: fromCents(receivedC), change: fromCents(receivedC - totalC) };
}
