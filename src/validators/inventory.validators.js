import { z } from "zod";
import { PAYMENT_METHOD_IDS } from "../config/delivery.js";

const text = (max) => z.string().trim().max(max);
const idSlug = z.string().min(1).max(80);

export const adjustBody = z.object({
  productId: idSlug, variantId: z.string().max(30).nullable().optional(), branch: idSlug,
  delta: z.number().int().refine((n) => n !== 0, "Enter a non-zero amount"),
  reason: text(200).min(1, "Enter a reason for this adjustment"),
});

export const transferBody = z.object({
  productId: idSlug, variantId: z.string().max(30).nullable().optional(),
  fromBranch: idSlug, toBranch: idSlug, qty: z.number().int().min(1),
}).refine((b) => b.fromBranch !== b.toBranch, { message: "Choose two different stores", path: ["toBranch"] });

export const movementsQuery = z.object({ productId: idSlug.optional(), branch: idSlug.optional(), limit: z.coerce.number().int().min(1).max(300).default(100) });
export const lowStockQuery = z.object({ branch: idSlug.optional() });

const poLine = z.object({ productId: idSlug, qty: z.number().int().min(1), purchasePrice: z.number().min(0) });
export const createPOBody = z.object({
  supplierId: idSlug, branch: idSlug, invoiceNumber: text(60).nullable().optional(),
  lines: z.array(poLine).min(1).max(100),
});
export const poIdParams = z.object({ id: z.string().uuid() });

const receiveLine = z.object({ productId: idSlug, qty: z.number().int().min(1), purchasePrice: z.number().min(0), batch: text(40).min(1), expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD") });
export const receivePOBody = z.object({ lines: z.array(receiveLine).min(1).max(100) });

const saleLine = z.object({ productId: idSlug, variantId: z.string().max(30).nullable().optional(), qty: z.number().int().min(1), batch: text(40).nullable().optional() });
export const posSaleBody = z.object({
  branch: idSlug, items: z.array(saleLine).min(1).max(100), paymentMethod: z.enum(PAYMENT_METHOD_IDS), customerName: text(100).nullable().optional(),
});
