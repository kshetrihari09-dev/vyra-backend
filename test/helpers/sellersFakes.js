import { createEncryption } from "../../src/utils/encryption.js";

export function createFakeSellers({ orderItems = [] } = {}) {
  const db = {
    sellers: [],
    applications: [],
    applicationDocuments: [],
    payouts: [],
    userRoles: [], // { userId, roleKey }
    orderItems, // [{ seller_id, line_total, order_status }] — availableBalance reads these directly
    seq: 0,
  };

  const sellers = {
    async insert(_d, s) {
      const row = { id: s.id, name: s.name, first_party: false, status: "active", commission_rate: s.commissionRate, owner_user_id: s.ownerUserId ?? null, contact_email: s.contactEmail ?? null, contact_mobile: s.contactMobile ?? null, rating: null, reviews_count: 0, payout_method_label: null, joined_at: new Date() };
      db.sellers.push(row);
      return row;
    },
    async getById(_d, id) { return db.sellers.find((s) => s.id === id) ?? null; },
    async getByOwner(_d, ownerUserId) { return db.sellers.find((s) => s.owner_user_id === ownerUserId) ?? null; },
    async idExists(_d, id) { return db.sellers.some((s) => s.id === id); },
    async list(_d, { status, q } = {}) {
      let rows = db.sellers;
      if (status) rows = rows.filter((s) => s.status === status);
      if (q) rows = rows.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
      return { rows, total: rows.length };
    },
    async updateStatus(_d, id, status) { const row = db.sellers.find((s) => s.id === id); row.status = status; return row; },
    async updatePayoutMethodLabel(_d, id, label) { db.sellers.find((s) => s.id === id).payout_method_label = label; },
    async availableBalance(_d, sellerId) {
      const seller = db.sellers.find((s) => s.id === sellerId);
      if (!seller) return 0;
      const gross = db.orderItems.filter((oi) => oi.seller_id === sellerId && oi.order_status === "delivered").reduce((sum, oi) => sum + oi.line_total, 0);
      const net = gross * (1 - Number(seller.commission_rate) / 100);
      const already = db.payouts.filter((p) => p.seller_id === sellerId && p.status !== "rejected").reduce((sum, p) => sum + Number(p.amount), 0);
      return Math.max(0, net - already);
    },
  };

  const roles = {
    async addUserRole(_d, userId, roleKey) { if (!db.userRoles.some((r) => r.userId === userId && r.roleKey === roleKey)) db.userRoles.push({ userId, roleKey }); },
  };

  const sellerApplications = {
    async insert(_d, a) {
      const row = { id: `app-${++db.seq}`, user_id: a.userId, status: "under_review", needs_correction: false,
        shop_name: a.shopName, shop_type: a.shopType, shop_contact: a.shopContact, shop_email: a.shopEmail, shop_description: a.shopDescription,
        address_line: a.addressLine, province_id: a.provinceId, district_id: a.districtId, municipality_id: a.municipalityId, ward: a.ward, landmark: a.landmark, lat: a.lat, lng: a.lng,
        pharmacy_license_number: a.pharmacyLicenseNumber, pharmacy_license_issued: a.pharmacyLicenseIssued, pharmacy_license_expires: a.pharmacyLicenseExpires,
        pharmacist_name: a.pharmacistName, pharmacist_reg_number: a.pharmacistRegNumber,
        operations: a.operations, settlement_account_holder: a.settlementAccountHolder, settlement_bank_name: a.settlementBankName, settlement_branch: a.settlementBranch,
        settlement_wallet_provider: a.settlementWalletProvider, settlement_account_number_enc: a.settlementAccountNumberEnc, settlement_wallet_number_enc: a.settlementWalletNumberEnc,
        seller_id: null, rejection_reason: null, submitted_at: new Date(), decided_at: null, decided_by: null };
      db.applications.push(row);
      return row;
    },
    async getById(_d, id) { return db.applications.find((a) => a.id === id) ?? null; },
    async listMine(_d, userId) { return db.applications.filter((a) => a.user_id === userId); },
    async listAll(_d, { status } = {}) { return status ? db.applications.filter((a) => a.status === status) : db.applications; },
    async insertDocuments(_d, applicationId, docs) {
      const rows = docs.map((d) => ({ id: `doc-${++db.seq}`, application_id: applicationId, type: d.type, file_key: d.fileKey, file_name: d.fileName, mime_type: d.mimeType, size_bytes: d.sizeBytes, verification_status: "pending", rejection_reason: null, created_at: new Date() }));
      db.applicationDocuments.push(...rows);
      return rows;
    },
    async documentsFor(_d, applicationId) { return db.applicationDocuments.filter((d) => d.application_id === applicationId); },
    async documentsForMany(_d, ids) { const m = new Map(); for (const id of ids) m.set(id, db.applicationDocuments.filter((d) => d.application_id === id)); return m; },
    async getDocumentById(_d, id) { return db.applicationDocuments.find((d) => d.id === id) ?? null; },
    async verifyDocument(_d, id, { verificationStatus, rejectionReason }) { const row = db.applicationDocuments.find((d) => d.id === id); Object.assign(row, { verification_status: verificationStatus, rejection_reason: rejectionReason }); return row; },
    async replaceFields(_d, id, a) {
      const row = db.applications.find((x) => x.id === id);
      Object.assign(row, {
        shop_name: a.shopName, shop_type: a.shopType, shop_contact: a.shopContact, shop_email: a.shopEmail, shop_description: a.shopDescription,
        address_line: a.addressLine, province_id: a.provinceId, district_id: a.districtId, municipality_id: a.municipalityId, ward: a.ward, landmark: a.landmark, lat: a.lat, lng: a.lng,
        pharmacy_license_number: a.pharmacyLicenseNumber, pharmacy_license_issued: a.pharmacyLicenseIssued, pharmacy_license_expires: a.pharmacyLicenseExpires,
        pharmacist_name: a.pharmacistName, pharmacist_reg_number: a.pharmacistRegNumber, operations: a.operations,
        settlement_account_holder: a.settlementAccountHolder, settlement_bank_name: a.settlementBankName, settlement_branch: a.settlementBranch, settlement_wallet_provider: a.settlementWalletProvider,
        settlement_account_number_enc: a.settlementAccountNumberEnc, settlement_wallet_number_enc: a.settlementWalletNumberEnc,
      });
      return row;
    },
    async replaceDocuments(_d, applicationId, docs) { db.applicationDocuments = db.applicationDocuments.filter((d) => d.application_id !== applicationId); return this.insertDocuments(_d, applicationId, docs); },
    async decide(_d, id, patch) {
      const row = db.applications.find((a) => a.id === id);
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.needsCorrection !== undefined) row.needs_correction = patch.needsCorrection;
      if (patch.sellerId !== undefined) row.seller_id = patch.sellerId;
      if (patch.rejectionReason !== undefined) row.rejection_reason = patch.rejectionReason;
      if (patch.decidedBy !== undefined) row.decided_by = patch.decidedBy;
      if (patch.decidedAt !== undefined) row.decided_at = patch.decidedAt;
      return row;
    },
  };

  const sellerPayouts = {
    async insert(_d, p) {
      const row = { id: `po-${++db.seq}`, seller_id: p.sellerId, amount: p.amount, status: "requested", method_label: p.methodLabel, note: p.note, requested_by: p.requestedBy, decided_by: null, decided_at: null, paid_at: null, created_at: new Date() };
      db.payouts.push(row);
      return row;
    },
    async getById(_d, id) { return db.payouts.find((p) => p.id === id) ?? null; },
    async listForSeller(_d, sellerId) { return db.payouts.filter((p) => p.seller_id === sellerId); },
    async listAll(_d, { status } = {}) { return status ? db.payouts.filter((p) => p.status === status) : db.payouts; },
    async decide(_d, id, patch) {
      const row = db.payouts.find((p) => p.id === id);
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.decidedBy !== undefined) row.decided_by = patch.decidedBy;
      if (patch.decidedAt !== undefined) row.decided_at = patch.decidedAt;
      if (patch.paidAt !== undefined) row.paid_at = patch.paidAt;
      return row;
    },
  };

  const storage = {
    files: new Map(),
    async putObject(key, buffer) { storage.files.set(key, buffer); },
    async getObject(key) { return storage.files.get(key); },
  };

  const encryption = createEncryption(Buffer.alloc(32, 9).toString("base64"));

  return { db, repos: { sellers, sellerApplications, sellerPayouts, roles }, storage, encryption };
}

export const applicant = { id: "u-app-1", name: "Alice", roles: ["customer"], permissions: [] };
export const otherApplicant = { id: "u-app-2", name: "Bob", roles: ["customer"], permissions: [] };
export const adminActor = { id: "u-admin", name: "Admin", roles: ["admin"], permissions: ["sellers:read_all", "sellers:approve", "payouts:read_all", "payouts:approve"] };
export const accountant = { id: "u-acct", name: "Accountant", roles: ["accountant"], permissions: ["payouts:read_all", "payouts:approve"] };

export function baseApplicationBody(overrides = {}) {
  return {
    shopName: "Acme Pharmacy", shopType: "pharmacy", shopContact: "9812345678", shopEmail: "acme@example.com", shopDescription: "A neighbourhood pharmacy",
    address: { line: "123 Main St", provinceId: "p1", districtId: "d1", municipalityId: "m1", ward: "5", landmark: "Near the clock tower" },
    pharmacy: { licenseNumber: "LIC-001", licenseIssued: "2020-01-01", licenseExpires: "2030-01-01", pharmacistName: "Dr. Alice", pharmacistRegNumber: "REG-001" },
    operations: { hours: {}, deliveryAvailable: true, pickupAvailable: true },
    settlement: { accountHolder: "Alice", bankName: "Global Bank", accountNumber: "0011223344" },
    documents: [{ type: "business_reg", fileName: "reg.pdf", mimeType: "application/pdf", buffer: Buffer.from("doc-bytes") }],
    ...overrides,
  };
}
