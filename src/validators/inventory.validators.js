import { z } from "zod";
import { MAX_AMOUNT, MAX_LINE_QTY, POS_PAYMENT_METHODS } from "../config/pos.js";

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

const saleLine = z.object({ productId: idSlug, variantId: z.string().max(30).nullable().optional(), qty: z.number().int().min(1).max(MAX_LINE_QTY), batch: text(40).nullable().optional() });
const money = z.number().finite().min(0).max(MAX_AMOUNT);
export const posSaleBody = z.object({
  branch: idSlug,
  items: z.array(saleLine).min(1).max(100),
  paymentMethod: z.enum(POS_PAYMENT_METHODS),
  customerName: text(100).nullable().optional(),
  discount: z.object({ type: z.enum(["percent", "fixed"]), value: z.number().finite().positive().max(MAX_AMOUNT) }).nullable().optional(),
  amountReceived: money.nullable().optional(),
  expectedTotal: money.nullable().optional(),
  /** A fresh random id per sale attempt, reused ONLY for retries of that same attempt. The server turns it into "at most one sale". */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "Missing or malformed request id"),
});
export const posSalesQuery = z.object({ branch: idSlug.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
export const posSaleIdParams = z.object({ id: z.string().uuid() });
export const posSaleKeyParams = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });
