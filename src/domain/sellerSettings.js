import { round2 } from "../utils/text.js";

/**
 * Shop settings: defaults, normalisation, and the two rules checkout actually enforces (minimum order, accepted payment
 * methods). Pure functions — no database — so they're easy to test and the same rules run in cart preview and order placement.
 */
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const DEFAULT_HOURS = Object.fromEntries(DAYS.map((d) => [d, { open: "09:00", close: "18:00", closed: d === "Sun" }]));
export const DEFAULTS = {
  logo: null, banner: null, phone: "", email: "", address: "", city: "", landmark: "",
  hours: DEFAULT_HOURS,
  delivery: { available: true, pickup: true, radiusKm: 5, fee: 0, freeAbove: 0, minOrder: 0, prepMinutes: 30 },
  payments: { cod: true, card: true, upi: true, netbanking: false },
  tax: { registration: "", inclusive: true, defaultRate: 0 },
  notifications: { newOrder: true, lowStock: true, payout: true, reviews: false, email: true, sms: false },
};

/** Stored JSON (possibly empty, older or partial) merged over the defaults — callers never see a missing key. */
export function normalizeSettings(stored) {
  const s = stored && typeof stored === "object" ? stored : {};
  const section = (k) => ({ ...DEFAULTS[k], ...(s[k] && typeof s[k] === "object" ? s[k] : {}) });
  const hours = { ...DEFAULT_HOURS };
  for (const d of DAYS) if (s.hours?.[d]) hours[d] = { ...DEFAULT_HOURS[d], ...s.hours[d] };
  return {
    logo: s.logo ?? null, banner: s.banner ?? null,
    phone: s.phone ?? "", email: s.email ?? "", address: s.address ?? "", city: s.city ?? "", landmark: s.landmark ?? "",
    hours, delivery: section("delivery"), payments: section("payments"), tax: section("tax"), notifications: section("notifications"),
  };
}

/** What the owner's settings screen shows: name + description from their own columns, the rest from `settings`. */
export const settingsView = (row) => ({ name: row.name, description: row.description ?? "", saved: Object.keys(row.settings ?? {}).length > 0, ...normalizeSettings(row.settings) });

const PAYMENT_LABEL = { cod: "cash on delivery", card: "card", upi: "UPI / wallet", netbanking: "net banking" };

/**
 * One issue per shop whose items in this cart add up to less than that shop's minimum order. `rows` are `{ id, name, settings }`.
 * Measured on the shop's own undiscounted line totals, so a coupon can't be used to dodge it and other shops' items don't count.
 */
export function minOrderIssues(lines, rows) {
  const issues = [];
  for (const row of rows) {
    const min = Number(normalizeSettings(row.settings).delivery.minOrder) || 0;
    if (min <= 0) continue;
    const subtotal = round2(lines.filter((l) => l.sellerId === row.id).reduce((s, l) => s + l.lineTotal, 0));
    if (subtotal > 0 && subtotal < min) {
      issues.push({ type: "seller_min_order", sellerId: row.id, min, subtotal,
        message: `${row.name} has a minimum order of ${min}. Add ${round2(min - subtotal)} more from this shop.` });
    }
  }
  return issues;
}

/** The first shop in the cart that doesn't accept `method`, or null. A shop that never saved settings accepts the defaults. */
export function paymentRejection(rows, method) {
  for (const row of rows) {
    if (normalizeSettings(row.settings).payments[method] === false) {
      return { sellerId: row.id, message: `${row.name} doesn't accept ${PAYMENT_LABEL[method] ?? method}. Please choose another payment method.` };
    }
  }
  return null;
}

/** Notification preference lookups used before telling a shop owner something. Missing = on (the defaults). */
export const wantsNotification = (settings, key) => normalizeSettings(settings).notifications[key] !== false;
