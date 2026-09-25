/** Delivery addresses. Every function is already scoped to a user_id (never trust a client-supplied one alone). */
export function createAddressesRepository() {
  return {
    async list(db, userId) {
      return (await db.query("SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at", [userId])).rows;
    },
    async get(db, userId, id) {
      return (await db.query("SELECT * FROM addresses WHERE id = $1 AND user_id = $2", [id, userId])).rows[0] || null;
    },
    async clearDefault(db, userId) {
      await db.query("UPDATE addresses SET is_default = false WHERE user_id = $1 AND is_default", [userId]);
    },
    async insert(db, userId, a) {
      const { rows } = await db.query(
        `INSERT INTO addresses (user_id, label, name, phone, line1, line2, city, zip, province_id, district_id, municipality_id, ward, instructions, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [userId, a.label, a.name, a.phone, a.line1, a.line2 ?? null, a.city ?? null, a.zip ?? null, a.provinceId ?? null, a.districtId ?? null, a.municipalityId ?? null, a.ward ?? null, a.instructions ?? null, !!a.isDefault],
      );
      return rows[0];
    },
    async update(db, userId, id, a) {
      const { rows } = await db.query(
        `UPDATE addresses SET label=$3, name=$4, phone=$5, line1=$6, line2=$7, city=$8, zip=$9, province_id=$10, district_id=$11, municipality_id=$12, ward=$13, instructions=$14, is_default=$15
          WHERE id=$1 AND user_id=$2 RETURNING *`,
        [id, userId, a.label, a.name, a.phone, a.line1, a.line2 ?? null, a.city ?? null, a.zip ?? null, a.provinceId ?? null, a.districtId ?? null, a.municipalityId ?? null, a.ward ?? null, a.instructions ?? null, !!a.isDefault],
      );
      return rows[0] || null;
    },
    async setDefault(db, userId, id) {
      const { rows } = await db.query("UPDATE addresses SET is_default = true WHERE id = $1 AND user_id = $2 RETURNING *", [id, userId]);
      return rows[0] || null;
    },
    async remove(db, userId, id) {
      const { rowCount } = await db.query("DELETE FROM addresses WHERE id = $1 AND user_id = $2", [id, userId]);
      return rowCount > 0;
    },
  };
}
