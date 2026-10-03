import { z } from "zod";
import { mobile } from "./common.js";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
export const VEHICLE_TYPES = ["Bike", "Scooter", "Motorbike", "Bicycle", "Car", "Van"];
export const DOCUMENT_TYPES = ["driving_license", "vehicle_registration", "citizen_id", "insurance", "other"];

const document = z.object({
  type: z.enum(DOCUMENT_TYPES),
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(ACCEPTED_MIME_TYPES, { errorMap: () => ({ message: "Only JPG, PNG, WEBP or PDF files are accepted" }) }),
  dataBase64: z.string().min(1).max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 1024, "Each file must be under 5 MB"),
});

/** The applicant is always the signed-in account: there is deliberately no userId in this body. */
export const submitBody = z.object({
  phone: mobile,
  vehicleType: z.enum(VEHICLE_TYPES),
  vehicleNumber: z.string().trim().max(40).optional(),
  licenseNumber: z.string().trim().max(40).optional(),
  documents: z.array(document).min(1, "Upload your documents").max(4),
}).strict();
export const resubmitBody = submitBody;

export const idParams = z.object({ id: z.string().uuid() });
export const documentParams = z.object({ id: z.string().uuid(), documentId: z.string().uuid() });
export const listQuery = z.object({ status: z.enum(["under_review", "approved", "rejected"]).optional(), scope: z.enum(["mine", "all"]).optional() });
export const decisionBody = z.object({
  decision: z.enum(["approve", "reject", "request_correction"]),
  reason: z.string().trim().max(500).optional(),
}).strict();
