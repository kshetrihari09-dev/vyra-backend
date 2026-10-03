import { maskTail } from "../utils/encryption.js";

/**
 * `file_key` (where the file sits in private storage) is never returned. The licence number is masked unless the caller
 * is the applicant (their own number) or a reviewer opening a single application — list views never carry it in full.
 */
export function toRiderApplicationDto(row, { documents = [], licenseNumber = null, reveal = false } = {}) {
  return {
    id: row.id, status: row.status, needsCorrection: row.needs_correction,
    applicant: { id: row.user_id, name: row.applicant_name ?? null, email: row.applicant_email ?? null },
    phone: row.phone, vehicleType: row.vehicle_type, vehicleNumber: row.vehicle_number,
    licenseNumber: licenseNumber ? (reveal ? licenseNumber : maskTail(licenseNumber)) : null,
    rejectionReason: row.rejection_reason, riderId: row.rider_id,
    decidedAt: row.decided_at, createdAt: row.created_at,
    documents: documents.map((d) => ({ id: d.id, type: d.type, fileName: d.file_name, mimeType: d.mime_type, sizeBytes: d.size_bytes })),
  };
}
