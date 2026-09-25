-- Phase 2: catalogue — brands, categories, products, variants, images.
-- Catalogue ids are human-readable text slugs (e.g. 'basmati-rice-5kg', 'grocery-snacks') so storefront URLs and
-- imported demo data keep working. Money is numeric(12,2); the API converts to numbers.

CREATE TABLE brands (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  tint       text,
  fg         text,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_demo    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX brands_name_key ON brands (lower(name));
CREATE TRIGGER brands_set_updated_at BEFORE UPDATE ON brands FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- attributes / modules / unit_label are NULL on a subcategory that inherits them from its parent
-- (the storefront resolves the inheritance, exactly as it did with the local registry).
CREATE TABLE categories (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  slug        text NOT NULL UNIQUE,
  parent_id   text REFERENCES categories(id) ON DELETE RESTRICT,
  description text,
  icon        text,
  image_shape text,
  tint        text,
  fg          text,
  sort_order  integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  unit_label  text,
  attributes  jsonb CHECK (attributes IS NULL OR jsonb_typeof(attributes) = 'array'),
  modules     text[],
  is_demo     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX categories_parent_idx ON categories (parent_id);
CREATE TRIGGER categories_set_updated_at BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE products (
  id                    text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,80}$'),
  name                  text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  slug                  text NOT NULL,
  category_id           text NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  brand_id              text NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
  -- Owning seller (marketplace). Plain text until the sellers table exists in Phase 6, which adds the FK.
  seller_id             text,
  description           text NOT NULL DEFAULT '',
  price                 numeric(12,2) NOT NULL CHECK (price >= 0),
  sale_price            numeric(12,2) CHECK (sale_price IS NULL OR (sale_price > 0 AND sale_price <= price)),
  tax_percent           numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_percent BETWEEN 0 AND 100),
  sku                   text NOT NULL CHECK (length(btrim(sku)) BETWEEN 1 AND 64),
  barcode               text CHECK (barcode IS NULL OR length(btrim(barcode)) BETWEEN 1 AND 64),
  unit                  text NOT NULL DEFAULT 'piece',
  moq                   integer NOT NULL DEFAULT 1 CHECK (moq >= 1),
  max_qty               integer NOT NULL DEFAULT 10 CHECK (max_qty >= 1),
  -- Denormalised counters. rating/review_count come from reviews (later); sold_count is bumped by order fulfilment (Phase 3).
  rating                numeric(2,1) NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  review_count          integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  sold_count            integer NOT NULL DEFAULT 0 CHECK (sold_count >= 0),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'pending_review', 'rejected', 'draft')),
  delivery_available    boolean NOT NULL DEFAULT true,
  prescription_required boolean NOT NULL DEFAULT false,
  tags                  text[] NOT NULL DEFAULT '{}',
  art                   jsonb,
  attributes            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  composition           text,
  usage_instructions    text,
  side_effects          text,
  version               integer NOT NULL DEFAULT 1,
  is_demo               boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Soft delete: orders and stock history keep pointing at the row.
  deleted_at            timestamptz
);
-- SKU / barcode / slug are unique among products that have not been deleted.
CREATE UNIQUE INDEX products_sku_key ON products (lower(sku)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX products_barcode_key ON products (barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX products_slug_key ON products (slug) WHERE deleted_at IS NULL;
CREATE INDEX products_category_idx ON products (category_id) WHERE deleted_at IS NULL;
CREATE INDEX products_brand_idx ON products (brand_id) WHERE deleted_at IS NULL;
CREATE INDEX products_seller_idx ON products (seller_id) WHERE deleted_at IS NULL;
CREATE INDEX products_status_idx ON products (status) WHERE deleted_at IS NULL;
CREATE INDEX products_tags_idx ON products USING gin (tags);
-- Prefix search (name / sku / barcode) — text_pattern_ops makes LIKE 'abc%' index-assisted.
CREATE INDEX products_name_prefix_idx ON products (lower(name) text_pattern_ops) WHERE deleted_at IS NULL;
CREATE INDEX products_sku_prefix_idx ON products (lower(sku) text_pattern_ops) WHERE deleted_at IS NULL;
CREATE INDEX products_barcode_prefix_idx ON products (barcode text_pattern_ops) WHERE deleted_at IS NULL AND barcode IS NOT NULL;
CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A variant's id is only unique within its product ('r1', 'r5'); the pair is the key everything else references.
CREATE TABLE product_variants (
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  id         text NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$'),
  label      text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 100),
  options    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  price      numeric(12,2) NOT NULL CHECK (price >= 0),
  sale_price numeric(12,2) CHECK (sale_price IS NULL OR (sale_price > 0 AND sale_price <= price)),
  sku        text NOT NULL CHECK (length(btrim(sku)) BETWEEN 1 AND 64),
  barcode    text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, id)
);
CREATE UNIQUE INDEX product_variants_sku_key ON product_variants (lower(sku));
CREATE UNIQUE INDEX product_variants_barcode_key ON product_variants (barcode) WHERE barcode IS NOT NULL;
CREATE TRIGGER product_variants_set_updated_at BEFORE UPDATE ON product_variants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Uploaded product photos (catalogue images are public assets). The storefront currently draws products from
-- `products.art`; this table is populated once image upload lands with object storage.
CREATE TABLE product_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  alt_text    text,
  sort_order  integer NOT NULL DEFAULT 0,
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_images_product_idx ON product_images (product_id, sort_order);
CREATE UNIQUE INDEX product_images_primary_key ON product_images (product_id) WHERE is_primary;
