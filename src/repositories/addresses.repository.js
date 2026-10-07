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
        `INSERT INTO addresses (user_id, label, name, phone, line1, line2, city, zip, province_id, district_id, municipality_id, ward, instructions, is_default, lat, lng)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [userId, a.label, a.name, a.phone, a.line1, a.line2 ?? null, a.city ?? null, a.zip ?? null, a.provinceId ?? null, a.districtId ?? null, a.municipalityId ?? null, a.ward ?? null, a.instructions ?? null, !!a.isDefault, a.lat ?? null, a.lng ?? null],
      );
      return rows[0];
    },
    async update(db, userId, id, a) {
      const { rows } = await db.query(
        `UPDATE addresses SET label=$3, name=$4, phone=$5, line1=$6, line2=$7, city=$8, zip=$9, province_id=$10, district_id=$11, municipality_id=$12, ward=$13, instructions=$14, is_default=$15,
                lat = CASE WHEN $16::boolean THEN $17::float8 ELSE lat END, lng = CASE WHEN $16::boolean THEN $18::float8 ELSE lng END
          WHERE id=$1 AND user_id=$2 RETURNING *`,
        [id, userId, a.label, a.name, a.phone, a.line1, a.line2 ?? null, a.city ?? null, a.zip ?? null, a.provinceId ?? null, a.districtId ?? null, a.municipalityId ?? null, a.ward ?? null, a.instructions ?? null, !!a.isDefault, a.lat !== undefined, a.lat ?? null, a.lng ?? null],
      );
      return rows[0] || null;
    },
    async setDefault(db, userId, id) {
      const { rows } = await db.query("UPDATE addresses SET is_default = true WHERE id = $1 AND user_id = $2 RETURNING *", [id, userId]);
      return rows[0] || null;
    },
    async count(db, userId) {
      return Number((await db.query("SELECT count(*) AS n FROM addresses WHERE user_id = $1", [userId])).rows[0].n);
    },
    /** Numbers (other than the login mobile) this user has confirmed with a code. */
    async isPhoneVerified(db, userId, mobile) {
      return (await db.query("SELECT 1 FROM verified_phones WHERE user_id = $1 AND mobile = $2", [userId, mobile])).rowCount > 0;
    },
    async markPhoneVerified(db, userId, mobile) {
      await db.query("INSERT INTO verified_phones (user_id, mobile) VALUES ($1, $2) ON CONFLICT (user_id, mobile) DO UPDATE SET verified_at = now()", [userId, mobile]);
    },
    /** Code requests this user started recently — caps how many texts one account can trigger. */
    async countRecentPhoneChallenges(db, userId, sinceIso) {
      const { rows } = await db.query("SELECT count(*) AS n FROM otp_challenges WHERE purpose = 'address_phone' AND payload->>'userId' = $1 AND created_at > $2", [userId, sinceIso]);
      return Number(rows[0].n);
    },
    async remove(db, userId, id) {
      const { rowCount } = await db.query("DELETE FROM addresses WHERE id = $1 AND user_id = $2", [id, userId]);
      return rowCount > 0;
    },
  };
}
