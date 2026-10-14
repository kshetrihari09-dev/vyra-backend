import { z } from "zod";
import { pagination } from "./common.js";

export const idParams = z.object({ id: z.string().min(1).max(80) });

export const listQuery = z.object({
  status: z.enum(["pending", "active", "suspended", "rejected"]).optional(),
  q: z.string().trim().max(150).optional(),
  ...pagination,
});

export const statusBody = z.object({ status: z.enum(["pending", "active", "suspended", "rejected"]) });
export const payoutMethodLabelBody = z.object({ label: z.string().trim().min(1).max(120) });

// ---------------------------------------------------------------- shop settings
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const day = z.object({ open: time, close: time, closed: z.boolean() }).strict()
  .refine((h) => h.closed || h.open < h.close, { message: "Closing time must be after opening time" });
const image = (maxChars) => z.string().max(maxChars, "Image is too large").regex(/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/, "Upload a PNG, JPG or WebP image").nullable();
const money = (max) => z.number().min(0).max(max);

export const shopSettingsBody = z.object({
  name: z.string().trim().min(1, "Enter your shop name").max(150),
  description: z.string().trim().max(1000).default(""),
  logo: image(600_000), banner: image(900_000),
  phone: z.string().trim().max(30).refine((v) => v === "" || (v.replace(/\D/g, "").length >= 7 && v.replace(/\D/g, "").length <= 15), "Enter a valid phone number"),
  email: z.string().trim().max(254).refine((v) => v === "" || /^\S+@\S+\.\S+$/.test(v), "Enter a valid email address"),
  address: z.string().trim().max(200), city: z.string().trim().max(100), landmark: z.string().trim().max(150),
  hours: z.object({ Mon: day, Tue: day, Wed: day, Thu: day, Fri: day, Sat: day, Sun: day }).strict(),
  delivery: z.object({
    available: z.boolean(), pickup: z.boolean(), radiusKm: z.number().min(0.1).max(100),
    fee: money(100_000), freeAbove: money(10_000_000), minOrder: money(10_000_000), prepMinutes: z.number().int().min(0).max(1440),
  }).strict(),
  payments: z.object({ cod: z.boolean(), card: z.boolean(), upi: z.boolean(), netbanking: z.boolean() }).strict()
    .refine((p) => p.cod || p.card || p.upi || p.netbanking, { message: "Accept at least one payment method" }),
  tax: z.object({ registration: z.string().trim().max(50), inclusive: z.boolean(), defaultRate: z.number().min(0).max(100) }).strict(),
  notifications: z.object({ newOrder: z.boolean(), lowStock: z.boolean(), payout: z.boolean(), reviews: z.boolean(), email: z.boolean(), sms: z.boolean() }).strict(),
}).strict();
