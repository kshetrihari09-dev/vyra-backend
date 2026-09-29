const COLUMNS = [
  "shopName", "shopType", "shopContact", "shopEmail", "shopDescription",
  "addressLine", "provinceId", "districtId", "municipalityId", "ward", "landmark", "lat", "lng",
  "pharmacyLicenseNumber", "pharmacyLicenseIssued", "pharmacyLicenseExpires", "pharmacistName", "pharmacistRegNumber",
  "settlementAccountHolder", "settlementBankName", "settlementBranch", "settlementWalletProvider",
];
const COLUMN_SQL = {
  shopName: "shop_name", shopType: "shop_type", shopContact: "shop_contact", shopEmail: "shop_email", shopDescription: "shop_description",
  addressLine: "address_line", provinceId: "province_id", districtId: "district_id", municipalityId: "municipality_id", ward: "ward", landmark: "landmark", lat: "lat", lng: "lng",
  pharmacyLicenseNumber: "pharmacy_license_number", pharmacyLicenseIssued: "pharmacy_license_issued", pharmacyLicenseExpires: "pharmacy_license_expires",
  pharmacistName: "pharmacist_name", pharmacistRegNumber: "pharmacist_reg_number",
  settlementAccountHolder: "settlement_account_holder", settlementBankName: "settlement_bank_name", settlementBranch: "settlement_branch", settlementWalletProvider: "settlement_wallet_provider",
};

const WITH_OWNER = "SELECT a.*, u.full_name AS owner_name, u.email AS owner_email FROM seller_applications a JOIN users u ON u.id = a.user_id";

export function createSellerApplicationsRepository() {
  return {
    async insert(db, a) {
      const cols = ["user_id", "operations", "settlement_account_number_enc", "settlement_wallet_number_enc", ...COLUMNS.map((k) => COLUMN_SQL[k])];
      const values = [a.userId, JSON.stringify(a.operations), a.settlementAccountNumberEnc ?? null, a.settlementWalletNumberEnc ?? null, ...COLUMNS.map((k) => a[k] ?? null)];
      const placeholders = values.map((_, i) => (i === 1 ? `$${i + 1}::jsonb` : `$${i + 1}`));
      const { rows } = await db.query(`INSERT INTO seller_applications (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`, values);
      return rows[0];
    },

    async getById(db, id, { forUpdate = false } = {}) {
      // FOR UPDATE can't lock a joined row set cleanly, so the locking read is the bare table; the joined read adds the owner's name.
      if (forUpdate) return (await db.query("SELECT * FROM seller_applications WHERE id = $1 FOR UPDATE", [id])).rows[0] || null;
      return (await db.query(`${WITH_OWNER} WHERE a.id = $1`, [id])).rows[0] || null;
    },

    async listMine(db, userId) {
      return (await db.query(`${WITH_OWNER} WHERE a.user_id = $1 ORDER BY a.created_at DESC`, [userId])).rows;
    },

    async listAll(db, { status } = {}) {
      return (await db.query(`${WITH_OWNER} ${status ? "WHERE a.status = $1" : ""} ORDER BY a.created_at DESC`, status ? [status] : [])).rows;
    },

    async insertDocuments(db, applicationId, docs) {
      const rows = [];
      for (const d of docs) {
        const { rows: r } = await db.query(
          `INSERT INTO seller_application_documents (application_id, type, file_key, file_name, mime_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [applicationId, d.type, d.fileKey, d.fileName, d.mimeType, d.sizeBytes],
        );
        rows.push(r[0]);
      }
      return rows;
    },

    async documentsFor(db, applicationId) {
      return (await db.query("SELECT * FROM seller_application_documents WHERE application_id = $1 ORDER BY created_at", [applicationId])).rows;
    },

    async documentsForMany(db, applicationIds) {
      if (!applicationIds.length) return new Map();
      const { rows } = await db.query("SELECT * FROM seller_application_documents WHERE application_id = ANY($1::uuid[]) ORDER BY created_at", [applicationIds]);
      const m = new Map();
      for (const r of rows) { if (!m.has(r.application_id)) m.set(r.application_id, []); m.get(r.application_id).push(r); }
      return m;
    },

    async getDocumentById(db, id) {
      const { rows } = await db.query("SELECT * FROM seller_application_documents WHERE id = $1", [id]);
      return rows[0] || null;
    },

    async verifyDocument(db, id, { verificationStatus, rejectionReason }) {
      const { rows } = await db.query(
        "UPDATE seller_application_documents SET verification_status = $2, rejection_reason = $3 WHERE id = $1 RETURNING *",
        [id, verificationStatus, rejectionReason ?? null],
      );
      return rows[0] || null;
    },

    /** Resubmission replaces every field wholesale — simplest correct model for "fix and try again". */
    async replaceFields(db, id, a) {
      const sets = ["operations = $2::jsonb", "settlement_account_number_enc = $3", "settlement_wallet_number_enc = $4"];
      const values = [id, JSON.stringify(a.operations), a.settlementAccountNumberEnc ?? null, a.settlementWalletNumberEnc ?? null];
      for (const k of COLUMNS) { values.push(a[k] ?? null); sets.push(`${COLUMN_SQL[k]} = $${values.length}`); }
      const { rows } = await db.query(`UPDATE seller_applications SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, values);
      return rows[0] || null;
    },

    async replaceDocuments(db, applicationId, docs) {
      await db.query("DELETE FROM seller_application_documents WHERE application_id = $1", [applicationId]);
      return this.insertDocuments(db, applicationId, docs);
    },

    async decide(db, id, patch) {
      const sets = [];
      const values = [id];
      const map = { status: "status", needsCorrection: "needs_correction", sellerId: "seller_id", rejectionReason: "rejection_reason", decidedBy: "decided_by", decidedAt: "decided_at" };
      for (const [k, col] of Object.entries(map)) {
        if (patch[k] !== undefined) { values.push(patch[k]); sets.push(`${col} = $${values.length}`); }
      }
      const { rows } = await db.query(`UPDATE seller_applications SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, values);
      return rows[0] || null;
    },
  };
}
