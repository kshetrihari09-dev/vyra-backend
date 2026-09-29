export const toPrescriptionDto = (r, { items = [] } = {}) => ({
  id: r.id, userId: r.user_id, customerName: r.customer_name ?? null, // only present from prescriptions:read_all's listAll
  status: r.status, fileName: r.file_name, mimeType: r.mime_type, sizeBytes: r.size_bytes,
  fileUrl: `/api/prescriptions/${r.id}/file`, // authenticated the same as any other endpoint — see prescriptionsApi.fetchFileBlobUrl
  items, notes: r.notes ?? null, rejectionReason: r.rejection_reason ?? null,
  pharmacistId: r.pharmacist_id ?? null, reviewedAt: r.reviewed_at ?? null, uploadedAt: r.created_at,
});
