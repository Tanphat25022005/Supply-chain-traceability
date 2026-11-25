-- 015: Product catalog and unit conversion (docs/SPEC_PHASE1_5.md §1 — "Đợt 1").
--
-- Until now a lot's product type was free text and its unit an arbitrary
-- word: "Cà phê nhân xanh" and "cà phê nhân xanh " were two products, and a
-- lot counted in "bao" could not be weighed at all. Now:
--   • product_types — a two-level catalog: platform rows (tenant_id NULL) that
--     every tenant reads, plus each tenant's own additions;
--   • units — how many base units (kg, or "cái" for counted goods) one unit is
--     worth: generic weight units, plus packaging units per product type;
--   • a lot snapshots the conversion it was created with (unit_factor), so a
--     later catalog edit never re-weighs history. quantity_base is derived.

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Name comparison that ignores case, Vietnamese diacritics and spacing.
-- IMMUTABLE (with the dictionary named explicitly) so it can back an index.
CREATE FUNCTION catalog_norm(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(regexp_replace(trim(public.unaccent('public.unaccent'::regdictionary, coalesce(t, ''))), '\s+', ' ', 'g'))
$$;

-- ── Categories (platform reference data) ────────────────────────────────────
CREATE TABLE product_categories (
  code        TEXT PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

INSERT INTO product_categories (code, name, sort_order) VALUES
  ('COFFEE', 'Cà phê',          10),
  ('RICE',   'Lúa gạo',         20),
  ('FRUIT',  'Trái cây',        30),
  ('TEA',    'Chè',             40),
  ('SPICE',  'Gia vị',          50),
  ('RUBBER', 'Cao su',          60),
  ('OTHER',  'Nông sản khác',   90);

-- ── Product types (platform + tenant) ───────────────────────────────────────
CREATE TABLE product_types (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID REFERENCES tenants(id),
  category_code          TEXT NOT NULL REFERENCES product_categories(code),
  code                   TEXT NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  name                   TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  base_unit              TEXT NOT NULL CHECK (base_unit IN ('kg', 'cái')),
  -- GS1 Global Trade Item Number (GTIN-8/12/13/14). Optional for now; kept
  -- so lots can later be exported as EPCIS events with standard identifiers.
  gtin                   TEXT CHECK (gtin IS NULL OR gtin ~ '^([0-9]{8}|[0-9]{12,14})$'),
  default_workflow_code  TEXT,
  -- Exact alternative spellings accepted when resolving a name (curated, not fuzzy).
  aliases                TEXT[] NOT NULL DEFAULT '{}',
  active                 BOOLEAN NOT NULL DEFAULT true,
  created_by             UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (created_by, tenant_id) REFERENCES actors (id, tenant_id),
  CONSTRAINT product_types_platform_has_no_creator CHECK (tenant_id IS NOT NULL OR created_by IS NULL)
);

-- Unique per scope (a tenant's own rows, or the platform's): code and normalised name.
CREATE UNIQUE INDEX uq_product_types_code ON product_types (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
CREATE UNIQUE INDEX uq_product_types_name ON product_types (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), catalog_norm(name));
CREATE INDEX idx_product_types_tenant ON product_types (tenant_id);

INSERT INTO product_types (category_code, code, name, base_unit, default_workflow_code, aliases) VALUES
  ('COFFEE', 'COFFEE_CHERRY',    'Cà phê quả tươi',  'kg', 'COFFEE_EXPORT',   '{"Cà phê chín","Cà phê tươi"}'),
  ('COFFEE', 'COFFEE_DRY_CHERRY','Cà phê quả khô',   'kg', 'COFFEE_EXPORT',   '{"Cà phê phơi khô"}'),
  ('COFFEE', 'COFFEE_PARCHMENT', 'Cà phê thóc',      'kg', 'COFFEE_EXPORT',   '{"Cà phê thóc (parchment)"}'),
  ('COFFEE', 'COFFEE_UNSORTED',  'Cà phê nhân xô',   'kg', 'COFFEE_EXPORT',   '{}'),
  ('COFFEE', 'COFFEE_GREEN',     'Cà phê nhân xanh', 'kg', 'COFFEE_EXPORT',   '{"Cà phê nhân"}'),
  ('COFFEE', 'COFFEE_ROASTED',   'Cà phê rang',      'kg', 'COFFEE_DOMESTIC', '{"Cà phê rang xay"}'),
  ('RICE',   'RICE_PADDY',       'Lúa (thóc)',       'kg', 'RICE',            '{"Lúa","Thóc"}'),
  ('RICE',   'RICE_MILLED',      'Gạo',              'kg', 'RICE',            '{"Lúa gạo","Gạo trắng"}'),
  ('FRUIT',  'FRUIT_FRESH',      'Trái cây tươi',    'kg', 'FRESH_FRUIT',     '{"Trái cây","Hoa quả"}'),
  ('FRUIT',  'FRUIT_DURIAN',     'Sầu riêng',        'kg', 'FRESH_FRUIT',     '{}'),
  ('FRUIT',  'FRUIT_DRAGON',     'Thanh long',       'kg', 'FRESH_FRUIT',     '{}'),
  ('TEA',    'TEA_FRESH',        'Chè búp tươi',     'kg', 'GENERIC_RETAIL',  '{"Chè tươi"}'),
  ('TEA',    'TEA_DRY',          'Chè khô',          'kg', 'GENERIC_RETAIL',  '{"Chè","Trà"}'),
  ('SPICE',  'SPICE_PEPPER',     'Hồ tiêu',          'kg', 'GENERIC_RETAIL',  '{"Gia vị","Tiêu"}'),
  ('RUBBER', 'RUBBER_LATEX',     'Mủ cao su nước',   'kg', 'GENERIC_RETAIL',  '{}'),
  ('RUBBER', 'RUBBER_BLOCK',     'Cao su khối',      'kg', 'GENERIC_RETAIL',  '{}'),
  ('OTHER',  'OTHER_PRODUCE',    'Nông sản khác',    'kg', 'GENERIC_RETAIL',  '{"Nông sản","Khác","Rau củ"}');

-- ── Units ───────────────────────────────────────────────────────────────────
-- product_type_id NULL = a generic unit for every product of that base unit.
CREATE TABLE units (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID REFERENCES tenants(id),
  product_type_id  UUID REFERENCES product_types(id),
  base_unit        TEXT NOT NULL CHECK (base_unit IN ('kg', 'cái')),
  code             TEXT NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 30),
  label            TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 60),
  factor           NUMERIC NOT NULL CHECK (factor > 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_units_scope_code ON units (
  COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(product_type_id, '00000000-0000-0000-0000-000000000000'::uuid),
  catalog_norm(code)
);

INSERT INTO units (product_type_id, base_unit, code, label, factor) VALUES
  (NULL, 'kg',  'kg',   'kg',   1),
  (NULL, 'kg',  'tấn',  'tấn',  1000),
  (NULL, 'cái', 'cái',  'cái',  1);

-- Packaging units whose weight is a trade convention for that product.
INSERT INTO units (product_type_id, base_unit, code, label, factor)
SELECT pt.id, 'kg', u.code, u.label, u.factor
  FROM (VALUES
    ('COFFEE_GREEN',    'bao',    'Bao 60 kg',   60),
    ('COFFEE_UNSORTED', 'bao',    'Bao 60 kg',   60),
    ('COFFEE_ROASTED',  'túi',    'Túi 1 kg',    1),
    ('COFFEE_ROASTED',  'túi500', 'Túi 500 g',   0.5),
    ('RICE_MILLED',     'bao',    'Bao 50 kg',   50),
    ('RICE_MILLED',     'túi5',   'Túi 5 kg',    5),
    ('SPICE_PEPPER',    'bao',    'Bao 50 kg',   50),
    ('FRUIT_FRESH',     'thùng',  'Thùng 10 kg', 10),
    ('FRUIT_DRAGON',    'thùng',  'Thùng 10 kg', 10)
  ) AS u(type_code, code, label, factor)
  JOIN product_types pt ON pt.code = u.type_code AND pt.tenant_id IS NULL;

-- ── Lots reference the catalog ──────────────────────────────────────────────
ALTER TABLE batches ADD COLUMN product_type_id UUID REFERENCES product_types(id);
ALTER TABLE batches ADD COLUMN base_unit TEXT CHECK (base_unit IS NULL OR base_unit IN ('kg', 'cái'));
ALTER TABLE batches ADD COLUMN unit_factor NUMERIC CHECK (unit_factor IS NULL OR unit_factor > 0);
ALTER TABLE batches ADD COLUMN quantity_base NUMERIC GENERATED ALWAYS AS (quantity * unit_factor) STORED;
CREATE INDEX idx_batches_product_type ON batches (product_type_id);

-- Existing lots: only exact (normalised) names or curated aliases are matched —
-- no guessing. Whatever doesn't match waits for an admin (mapping queue).
UPDATE batches b
   SET product_type_id = pt.id,
       product_type    = pt.name,
       base_unit       = pt.base_unit
  FROM product_types pt
 WHERE pt.tenant_id IS NULL
   AND (catalog_norm(b.product_type) = catalog_norm(pt.name)
        OR catalog_norm(b.product_type) IN (SELECT catalog_norm(a) FROM unnest(pt.aliases) a));

UPDATE batches b
   SET unit_factor = (
         SELECT u.factor FROM units u
          WHERE u.tenant_id IS NULL
            AND u.base_unit = b.base_unit
            AND (u.product_type_id = b.product_type_id OR u.product_type_id IS NULL)
            AND catalog_norm(u.code) = catalog_norm(b.unit)
          ORDER BY u.product_type_id NULLS LAST
          LIMIT 1)
 WHERE b.product_type_id IS NOT NULL;

-- A lot may only use a product type of its own tenant or of the platform.
-- (RLS hides other tenants' rows from the application role, so "not found"
-- covers both a missing and a foreign product type.)
CREATE FUNCTION batches_check_product_type() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_type_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM product_types pt
        WHERE pt.id = NEW.product_type_id
          AND (pt.tenant_id IS NULL OR pt.tenant_id = NEW.tenant_id)
     ) THEN
    RAISE EXCEPTION 'batch %: product type % is not in this tenant''s catalog', NEW.id, NEW.product_type_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER batches_check_product_type BEFORE INSERT OR UPDATE OF product_type_id ON batches
  FOR EACH ROW EXECUTE FUNCTION batches_check_product_type();

-- The catalog link and the conversion are set once (at creation, or by the
-- admin mapping an old lot) and never change afterwards.
CREATE FUNCTION batches_guard_catalog() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.product_type_id IS NOT NULL AND NEW.product_type_id IS DISTINCT FROM OLD.product_type_id THEN
    RAISE EXCEPTION 'batch %: product type cannot change once set', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.product_type_id IS NOT NULL AND NEW.product_type IS DISTINCT FROM OLD.product_type THEN
    RAISE EXCEPTION 'batch %: product type name cannot change once linked to the catalog', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.unit_factor IS NOT NULL AND NEW.unit_factor IS DISTINCT FROM OLD.unit_factor THEN
    RAISE EXCEPTION 'batch %: unit conversion cannot change once set', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.base_unit IS NOT NULL AND NEW.base_unit IS DISTINCT FROM OLD.base_unit THEN
    RAISE EXCEPTION 'batch %: base unit cannot change once set', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.unit IS DISTINCT FROM OLD.unit OR NEW.quantity IS DISTINCT FROM OLD.quantity THEN
    RAISE EXCEPTION 'batch %: quantity and unit are part of the record', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER batches_guard_catalog BEFORE UPDATE ON batches
  FOR EACH ROW EXECUTE FUNCTION batches_guard_catalog();

-- ── GS1 location numbers (optional, for a later EPCIS export) ───────────────
ALTER TABLE actors ADD COLUMN gln TEXT CHECK (gln IS NULL OR gln ~ '^[0-9]{13}$');
ALTER TABLE plots  ADD COLUMN gln TEXT CHECK (gln IS NULL OR gln ~ '^[0-9]{13}$');

-- ── Privileges + row-level security ─────────────────────────────────────────
GRANT SELECT ON product_categories TO tracechain_app;
GRANT SELECT, INSERT ON product_types, units TO tracechain_app;
GRANT UPDATE (name, gtin, default_workflow_code, aliases, active) ON product_types TO tracechain_app;
-- The admin mapping queue links old lots to the catalog (set-once, see trigger).
GRANT UPDATE (product_type_id, product_type, base_unit, unit_factor) ON batches TO tracechain_app;
GRANT UPDATE (gln) ON actors TO tracechain_app;

ALTER TABLE product_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE units         ENABLE ROW LEVEL SECURITY;

-- Everyone reads the platform rows; a tenant reads and writes only its own.
CREATE POLICY catalog_read   ON product_types FOR SELECT USING (tenant_id IS NULL OR tenant_id = app_current_tenant());
CREATE POLICY catalog_insert ON product_types FOR INSERT WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY catalog_update ON product_types FOR UPDATE
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

CREATE POLICY catalog_read   ON units FOR SELECT USING (tenant_id IS NULL OR tenant_id = app_current_tenant());
CREATE POLICY catalog_insert ON units FOR INSERT WITH CHECK (tenant_id = app_current_tenant());
