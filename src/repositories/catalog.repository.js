/** Categories and brands. All SQL parameterised; every function takes the executor `db` first. */
export function createCatalogRepository() {
  return {
    // ------------------------------------------------------------------ categories
    /** Every category with the number of live products in its whole subtree (children included). */
    async listCategories(db, { includeInactive = false } = {}) {
      const { rows } = await db.query(
        `WITH RECURSIVE tree(root_id, id) AS (
           SELECT id, id FROM categories
           UNION
           SELECT t.root_id, c.id FROM categories c JOIN tree t ON c.parent_id = t.id
         )
         SELECT c.*, COALESCE(pc.n, 0) AS product_count
           FROM categories c
           LEFT JOIN (
             SELECT t.root_id, count(*) AS n
               FROM tree t JOIN products p ON p.category_id = t.id AND p.status = 'active' AND p.deleted_at IS NULL
              GROUP BY t.root_id
           ) pc ON pc.root_id = c.id
          WHERE ($1::boolean OR c.status = 'active')
          ORDER BY c.parent_id NULLS FIRST, c.sort_order, c.id`,
        [includeInactive],
      );
      return rows;
    },

    async getCategory(db, id) {
      const { rows } = await db.query("SELECT * FROM categories WHERE id = $1", [id]);
      return rows[0] || null;
    },

    /** The category and all of its descendants (ids only). */
    async categoryTreeIds(db, id) {
      const { rows } = await db.query(
        `WITH RECURSIVE tree AS (
           SELECT id FROM categories WHERE id = $1
           UNION
           SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id
         ) SELECT id FROM tree`,
        [id],
      );
      return rows.map((r) => r.id);
    },

    /** Category plus its ancestors, nearest first — used to resolve inherited attribute schemas / modules. */
    async categoryAncestry(db, id) {
      const { rows } = await db.query(
        `WITH RECURSIVE up AS (
           SELECT c.*, 0 AS depth FROM categories c WHERE c.id = $1
           UNION
           SELECT p.*, up.depth + 1 FROM categories p JOIN up ON p.id = up.parent_id
         ) SELECT * FROM up ORDER BY depth`,
        [id],
      );
      return rows;
    },

    async insertCategory(db, c) {
      const { rows } = await db.query(
        `INSERT INTO categories (id, name, slug, parent_id, description, icon, image_shape, tint, fg, sort_order, status, unit_label, attributes, modules)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) RETURNING *`,
        [c.id, c.name, c.slug, c.parent ?? null, c.description ?? null, c.icon ?? null, c.image ?? null, c.tint ?? null, c.fg ?? null,
         c.order ?? 0, c.status ?? "active", c.unitLabel ?? null, c.attributes == null ? null : JSON.stringify(c.attributes), c.modules ?? null],
      );
      return rows[0];
    },

    async updateCategory(db, id, c) {
      const { rows } = await db.query(
        `UPDATE categories SET name=$2, slug=$3, parent_id=$4, description=$5, icon=$6, image_shape=$7, tint=$8, fg=$9,
                sort_order=$10, status=$11, unit_label=$12, attributes=$13::jsonb, modules=$14
          WHERE id=$1 RETURNING *`,
        [id, c.name, c.slug, c.parent ?? null, c.description ?? null, c.icon ?? null, c.image ?? null, c.tint ?? null, c.fg ?? null,
         c.order ?? 0, c.status, c.unitLabel ?? null, c.attributes == null ? null : JSON.stringify(c.attributes), c.modules ?? null],
      );
      return rows[0] || null;
    },

    async setCategoryStatus(db, id, status) {
      const { rows } = await db.query("UPDATE categories SET status=$2 WHERE id=$1 RETURNING *", [id, status]);
      return rows[0] || null;
    },

    async getBranch(db, id) {
      return (await db.query("SELECT * FROM branches WHERE id = $1", [id])).rows[0] || null;
    },

    async categoryHasProducts(db, id) {
      const { rows } = await db.query("SELECT 1 FROM products WHERE category_id = $1 AND deleted_at IS NULL LIMIT 1", [id]);
      return rows.length > 0;
    },

    // ------------------------------------------------------------------ brands
    async listBrands(db, { includeInactive = false } = {}) {
      const { rows } = await db.query(
        `SELECT * FROM brands WHERE ($1::boolean OR status = 'active') ORDER BY lower(name)`, [includeInactive]);
      return rows;
    },

    async getBrand(db, id) {
      const { rows } = await db.query("SELECT * FROM brands WHERE id = $1", [id]);
      return rows[0] || null;
    },

    async findBrandByName(db, name) {
      const { rows } = await db.query("SELECT * FROM brands WHERE lower(name) = lower($1)", [name.trim()]);
      return rows[0] || null;
    },

    async insertBrand(db, b) {
      const { rows } = await db.query(
        "INSERT INTO brands (id, name, tint, fg, status) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [b.id, b.name, b.tint ?? null, b.fg ?? null, b.status ?? "active"]);
      return rows[0];
    },

    async updateBrand(db, id, b) {
      const { rows } = await db.query(
        "UPDATE brands SET name=$2, tint=$3, fg=$4, status=$5 WHERE id=$1 RETURNING *",
        [id, b.name, b.tint ?? null, b.fg ?? null, b.status]);
      return rows[0] || null;
    },
  };
}
