import { z } from "zod";
import { FAILURE_REASON_IDS } from "../config/delivery.js";

const text = (max) => z.string().trim().max(max);
const phone = z.string().trim().regex(/^[+\d][\d\s-]{7,16}$/, "Enter a valid phone number");

export const idParams = z.object({ id: z.string().uuid() });
export const orderIdParams = z.object({ orderId: z.string().uuid() });

export const availabilityBody = z.object({ available: z.boolean() });
export const listMineQuery = z.object({ scope: z.enum(["active", "history"]).default("active") });
export const declineBody = z.object({ reason: text(200).optional() });
export const locationBody = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).optional(),
});
/** `otp` is optional here on purpose: whether one is REQUIRED depends on the order (branch setting) — the service decides. */
export const deliverBody = z.object({
  otp: z.string().trim().regex(/^\d{4}$/, "Enter the customer's 4-digit code").optional(),
  cashCollected: z.number().min(0).max(10_000_000).optional(),
});
export const failBody = z.object({ reason: z.enum(FAILURE_REASON_IDS), note: text(300).optional() });

export const assignBody = z.object({ riderId: z.string().uuid() });
export const unassignBody = z.object({ reason: text(200).optional() });
export const createRiderBody = z.object({ userId: z.string().uuid(), phone, vehicle: text(60).min(1, "Enter a vehicle") });
export const branchIdParams = z.object({ branchId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) });
export const branchLocationBody = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
export const updateRiderBody = z.object({
  phone: phone.optional(), vehicle: text(60).min(1).optional(), status: z.enum(["active", "suspended"]).optional(),
  photoUrl: z.string().trim().url().max(500).refine((u) => u.startsWith("https://"), "Photo must be an https:// link").nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, "Nothing to update");
