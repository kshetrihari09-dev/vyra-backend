const WITH_APPLICANT = "SELECT a.*, u.full_name AS applicant_name, u.email AS applicant_email FROM rider_applications a JOIN users u ON u.id = a.user_id";

export function createRiderApplicationsRepository() {
  return {
    async insert(db, a) {
      const { rows } = await db.query(
        `INSERT INTO rider_applications (user_id, phone, vehicle_type, vehicle_number, license_number_enc) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [a.userId, a.phone, a.vehicleType, a.vehicleNumber ?? null, a.licenseNumberEnc ?? null]);
      return this.getById(db, rows[0].id);
    },
    async getById(db, id, { forUpdate = false } = {}) {
      // FOR UPDATE OF a: lock the application row only, never the users row the join reads.
      const { rows } = await db.query(`${WITH_APPLICANT} WHERE a.id = $1${forUpdate ? " FOR UPDATE OF a" : ""}`, [id]);
      return rows[0] || null;
    },
    async listMine(db, userId) {
      const { rows } = await db.query(`${WITH_APPLICANT} WHERE a.user_id = $1 ORDER BY a.created_at DESC`, [userId]);
      return rows;
    },
    async listAll(db, { status } = {}) {
      const { rows } = await db.query(`${WITH_APPLICANT} ${status ? "WHERE a.status = $1" : ""} ORDER BY (a.status = 'under_review') DESC, a.created_at DESC LIMIT 200`, status ? [status] : []);
      return rows;
    },
    async replaceFields(db, id, a) {
      await db.query(`UPDATE rider_applications SET phone = $2, vehicle_type = $3, vehicle_number = $4, license_number_enc = $5 WHERE id = $1`,
        [id, a.phone, a.vehicleType, a.vehicleNumber ?? null, a.licenseNumberEnc ?? null]);
    },
    async decide(db, id, d) {
      await db.query(
        `UPDATE rider_applications SET status = $2, needs_correction = $3, rejection_reason = $4, rider_id = COALESCE($5, rider_id),
                decided_by = $6, decided_at = $7 WHERE id = $1`,
        [id, d.status, d.needsCorrection ?? false, d.rejectionReason ?? null, d.riderId ?? null, d.decidedBy ?? null, d.decidedAt ?? null]);
      return this.getById(db, id);
    },
    async insertDocuments(db, applicationId, docs) {
      for (const d of docs) {
        await db.query(`INSERT INTO rider_application_documents (application_id, type, file_key, file_name, mime_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)`,
          [applicationId, d.type, d.fileKey, d.fileName, d.mimeType, d.sizeBytes]);
      }
    },
    async replaceDocuments(db, applicationId, docs) {
      await db.query("DELETE FROM rider_application_documents WHERE application_id = $1", [applicationId]);
      return this.insertDocuments(db, applicationId, docs);
    },
    async documentsFor(db, applicationId) {
      const { rows } = await db.query("SELECT * FROM rider_application_documents WHERE application_id = $1 ORDER BY created_at", [applicationId]);
      return rows;
    },
    async documentsForMany(db, ids) {
      const m = new Map();
      if (!ids.length) return m;
      const { rows } = await db.query("SELECT * FROM rider_application_documents WHERE application_id = ANY($1::uuid[]) ORDER BY created_at", [ids]);
      for (const r of rows) { if (!m.has(r.application_id)) m.set(r.application_id, []); m.get(r.application_id).push(r); }
      return m;
    },
    async getDocumentById(db, id) {
      const { rows } = await db.query("SELECT * FROM rider_application_documents WHERE id = $1", [id]);
      return rows[0] || null;
    },
  };
}
