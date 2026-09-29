import { maskTail } from "../utils/encryption.js";

const toDocumentDto = (d) => ({
  id: d.id, type: d.type, fileName: d.file_name, mimeType: d.mime_type, sizeBytes: d.size_bytes,
  fileUrl: `/api/seller-applications/${d.application_id}/documents/${d.id}/file`,
  verificationStatus: d.verification_status, rejectionReason: d.rejection_reason ?? null,
});

/**
 * `settlement` is always the fully decrypted { accountNumber, walletNumber } — computed server-side either
 * way, since even the masked form ("•••• 4410") needs the real digits to build. `reveal` decides whether the
 * *caller* gets the full number or just the mask; only the one endpoint ops uses to actually action a payout
 * ever passes `reveal: true` (see sellers.service#getSettlement). Nothing here ever logs or persists the full
 * number a second time.
 */
export function toApplicationDto(r, { documents = [], settlement = {}, reveal = false } = {}) {
  return {
    id: r.id, userId: r.user_id, ownerName: r.owner_name ?? null, ownerEmail: r.owner_email ?? null, status: r.status, needsCorrection: r.needs_correction,
    shopName: r.shop_name, shopType: r.shop_type, shopContact: r.shop_contact, shopEmail: r.shop_email ?? null, shopDescription: r.shop_description ?? null,
    address: { line: r.address_line, provinceId: r.province_id, districtId: r.district_id, municipalityId: r.municipality_id, ward: r.ward, landmark: r.landmark ?? null, lat: r.lat ?? null, lng: r.lng ?? null },
    pharmacy: r.shop_type === "pharmacy" ? {
      licenseNumber: r.pharmacy_license_number, licenseIssued: r.pharmacy_license_issued, licenseExpires: r.pharmacy_license_expires,
      pharmacistName: r.pharmacist_name, pharmacistRegNumber: r.pharmacist_reg_number,
    } : null,
    operations: r.operations,
    settlement: {
      accountHolder: r.settlement_account_holder, bankName: r.settlement_bank_name ?? null, branch: r.settlement_branch ?? null,
      walletProvider: r.settlement_wallet_provider ?? null,
      accountNumber: reveal ? (settlement.accountNumber ?? null) : maskTail(settlement.accountNumber),
      walletNumber: reveal ? (settlement.walletNumber ?? null) : maskTail(settlement.walletNumber),
    },
    documents: documents.map(toDocumentDto),
    sellerId: r.seller_id ?? null, rejectionReason: r.rejection_reason ?? null,
    submittedAt: r.submitted_at, decidedAt: r.decided_at ?? null, decidedBy: r.decided_by ?? null,
  };
}
