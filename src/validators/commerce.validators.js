import { z } from "zod";
import { DELIVERY_OPTION_IDS, PAYMENT_METHOD_IDS } from "../config/delivery.js";

const text = (max) => z.string().trim().max(max);
const phone = z.string().regex(/^[+\d][\d\s-]{7,16}$/, "Enter a valid phone number");

export const addressBody = z.object({
  label: text(40).min(1).default("Address"),
  name: text(100).min(1, "Enter a name"),
  phone,
  line1: text(200).min(1, "Enter a street address"),
  line2: text(200).nullable().optional(),
  city: text(80).nullable().optional(),
  zip: text(20).nullable().optional(),
  provinceId: text(40).nullable().optional(),
  districtId: text(40).nullable().optional(),
  municipalityId: text(40).nullable().optional(),
  ward: text(20).nullable().optional(),
  instructions: text(500).nullable().optional(),
  isDefault: z.boolean().default(false),
});

export const addressIdParams = z.object({ id: z.string().uuid() });

const lineItem = z.object({
  productId: text(80).min(1),
  variantId: z.string().max(30).nullable().optional(),
  qty: z.number().int().min(1).max(1000),
});

export const cartPriceBody = z.object({
  items: z.array(lineItem).min(1).max(100),
  couponCode: text(40).nullable().optional(),
  deliveryOptionId: z.enum(DELIVERY_OPTION_IDS).default("standard"),
  branch: z.string().min(1).optional(),
});

export const createOrderBody = z.object({
  items: z.array(lineItem).min(1).max(100),
  addressId: z.string().uuid(),
  paymentMethod: z.enum(PAYMENT_METHOD_IDS),
  deliveryOptionId: z.enum(DELIVERY_OPTION_IDS).default("standard"),
  slot: text(60).nullable().optional(),
  couponCode: text(40).nullable().optional(),
  notes: text(500).nullable().optional(),
  instructions: text(500).nullable().optional(),
  branch: z.string().min(1).optional(),
});

export const orderIdParams = z.object({ id: z.string().uuid() });

export const orderStatusBody = z.object({
  status: z.enum(["confirmed", "preparing", "packed", "assigned", "out_for_delivery", "delivered"]),
  partner: z.object({ name: text(100), phone: text(30), vehicle: text(60) }).nullable().optional(),
});

export const orderCancelBody = z.object({ reason: text(300).nullable().optional() });

export const orderListQuery = z.object({ status: z.string().max(30).optional() });

export const wishlistParams = z.object({ productId: z.string().min(1).max(80) });
