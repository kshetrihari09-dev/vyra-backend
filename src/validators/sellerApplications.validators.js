import { z } from "zod";
import { mobile, optionalEmail } from "./common.js";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // matches the shared FileUpload component's 5 MB cap
const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const SHOP_TYPES = ["pharmacy", "grocery", "general", "beauty", "electronics", "fashion", "restaurant", "medical_equipment", "other"];
const DOCUMENT_TYPES = ["business_reg", "pan_vat", "shop_license", "owner_id", "pharmacy_license", "pharmacist_certificate", "other"];

const dayHours = z.object({ open: z.string().max(5), close: z.string().max(5), closed: z.boolean() });
const operations = z.object({
  hours: z.record(z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]), dayHours),
  deliveryAvailable: z.boolean(), pickupAvailable: z.boolean(),
  deliveryRadiusKm: z.number().min(0).max(100).optional(),
  deliveryFee: z.number().min(0).max(10000).optional(),
  freeDeliveryAbove: z.number().min(0).max(100000).optional(),
  minOrderAmount: z.number().min(0).max(100000).optional(),
  prepTimeMinutes: z.number().int().min(0).max(1440).optional(),
});

const address = z.object({
  line: z.string().trim().min(1).max(200),
  provinceId: z.string().trim().min(1).max(40),
  districtId: z.string().trim().min(1).max(40),
  municipalityId: z.string().trim().min(1).max(40),
  ward: z.string().trim().min(1).max(10),
  landmark: z.string().trim().max(150).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

const pharmacy = z.object({
  licenseNumber: z.string().trim().min(1).max(60),
  licenseIssued: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  licenseExpires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  pharmacistName: z.string().trim().min(1).max(120),
  pharmacistRegNumber: z.string().trim().min(1).max(60),
});

const settlement = z.object({
  accountHolder: z.string().trim().min(1).max(120),
  bankName: z.string().trim().max(120).optional(),
  branch: z.string().trim().max(120).optional(),
  walletProvider: z.string().trim().max(60).optional(),
  accountNumber: z.string().trim().max(40).optional(),
  walletNumber: z.string().trim().max(40).optional(),
}).refine((s) => s.accountNumber || s.walletNumber, { message: "Provide a bank account number or a wallet number" });

const document = z.object({
  type: z.enum(DOCUMENT_TYPES),
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(ACCEPTED_MIME_TYPES, { errorMap: () => ({ message: "Only JPG, PNG, WEBP or PDF files are accepted" }) }),
  dataBase64: z.string().min(1).max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 1024, "Each file must be under 5 MB"),
});

const base = {
  shopName: z.string().trim().min(1).max(150),
  shopType: z.enum(SHOP_TYPES),
  shopContact: mobile,
  shopEmail: optionalEmail,
  shopDescription: z.string().trim().max(1000).optional(),
  address,
  pharmacy: pharmacy.optional(),
  operations,
  settlement,
  documents: z.array(document).max(6).optional(),
};

export const submitBody = z.object(base).refine(
  (b) => b.shopType !== "pharmacy" || !!b.pharmacy,
  { message: "Pharmacy license and pharmacist details are required for a pharmacy shop", path: ["pharmacy"] },
);
export const resubmitBody = submitBody;

export const idParams = z.object({ id: z.string().uuid() });
export const documentParams = z.object({ id: z.string().uuid(), documentId: z.string().uuid() });

export const listQuery = z.object({ status: z.enum(["under_review", "approved", "rejected", "suspended"]).optional() });

export const decisionBody = z.object({
  decision: z.enum(["approve", "reject", "request_correction", "suspend"]),
  reason: z.string().trim().max(500).optional(),
  commissionRate: z.number().min(0).max(100).optional(),
});

export const documentVerifyBody = z.object({
  status: z.enum(["verified", "rejected"]),
  reason: z.string().trim().max(500).optional(),
});
