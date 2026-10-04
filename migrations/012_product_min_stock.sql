-- Minimum stock level per product. The seller form always had this field, but it was never sent to or stored by the API,
-- so every product silently fell back to a hard-coded 10. It now lives on the product, and inventory.reorder_level
-- (what the admin low-stock report reads) follows it, so both views of "low stock" agree.

ALTER TABLE products ADD COLUMN min_stock integer NOT NULL DEFAULT 10 CHECK (min_stock >= 0);

-- Existing stock rows take their product's level (all 10 today, so this is a no-op for current data but keeps it consistent).
UPDATE inventory i SET reorder_level = p.min_stock FROM products p WHERE p.id = i.product_id;

-- Any new stock row (opening stock, goods received, a new branch) starts at the product's level, whichever code path creates it.
CREATE OR REPLACE FUNCTION inventory_default_reorder_level() RETURNS trigger AS $$
BEGIN
  SELECT min_stock INTO NEW.reorder_level FROM products WHERE id = NEW.product_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_reorder_level_default BEFORE INSERT ON inventory
  FOR EACH ROW EXECUTE FUNCTION inventory_default_reorder_level();
