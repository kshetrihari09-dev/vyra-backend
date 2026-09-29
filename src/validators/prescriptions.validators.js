import { z } from "zod";

// Matches the customer-facing copy on the upload screen ("JPG, PNG or PDF · up to 10 MB").
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "application/pdf"];

const base64Payload = z.string().min(1).max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 1024, "File is too large — up to 10 MB is accepted");

export const uploadBody = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(ACCEPTED_MIME_TYPES, { errorMap: () => ({ message: "Only JPG, PNG or PDF files are accepted" }) }),
  // A data URL (as the browser's FileReader already produces) or a bare base64 string — either is accepted.
  dataBase64: base64Payload,
  productIds: z.array(z.string().min(1).max(80)).max(50).optional(),
});

export const idParams = z.object({ id: z.string().uuid() });

export const listQuery = z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
});

export const reviewBody = z.object({
  status: z.enum(["approved", "rejected"]),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const fileQuery = z.object({
  token: z.string().max(200).optional(),
});
