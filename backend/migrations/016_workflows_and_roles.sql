-- 016: Workflow templates per product group, new roles (docs/SPEC_PHASE1_5.md §4 — "Đợt 4").
--
-- The six hard-coded stages (HARVEST → … → RETAIL) described domestic retail;
-- an export coffee chain goes farm → collector → mill → warehouse → export
-- QC → container → export, and fruit or rice chains differ again. Now:
--   • stages — the platform's catalog of stage codes (a superset);
--   • workflow_templates / workflow_steps — an ordered subset of stages per
--     product group, each step saying whether it may be skipped and which
--     roles may record it;
--   • every lot pins the template version it was created with, so editing a
--     template never rewrites the rules an existing lot was traced under.
-- Existing lots move to GENERIC_RETAIL v1, which is exactly the old chain.

-- ── Stage catalog ───────────────────────────────────────────────────────────
CREATE TABLE stages (
  code        TEXT PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z_]{1,40}$'),
  label       TEXT NOT NULL,
  -- RECORD: an ordinary step. INSPECTION: has a PASS/FAIL result that drives
  -- the lot's status. EXPORT: leaves the country (customs/B/L data).
  -- RECEIPT: the buyer confirms arrival (may be an external party).
  kind        TEXT NOT NULL CHECK (kind IN ('RECORD', 'INSPECTION', 'EXPORT', 'RECEIPT')),
  -- Display order when lots of different workflows are shown together (report funnel).
  sort_order  INTEGER NOT NULL
);

INSERT INTO stages (code, label, kind, sort_order) VALUES
  ('HARVEST',            'Thu hoạch',             'RECORD',      10),
  ('COLLECTION',         'Thu gom',               'RECORD',      20),
  ('DRYING',             'Phơi / sấy',            'RECORD',      30),
  ('PROCESSING',         'Chế biến',              'RECORD',      40),
  ('MILLING',            'Xay xát',               'RECORD',      50),
  ('ROASTING',           'Rang',                  'RECORD',      60),
  ('WAREHOUSING',        'Nhập kho',              'RECORD',      70),
  ('QUALITY_CHECK',      'Kiểm định chất lượng',  'INSPECTION',  80),
  ('PACKAGING',          'Đóng gói',              'RECORD',      90),
  ('CONTAINER_STUFFING', 'Đóng container',        'RECORD',     100),
  ('EXPORT',             'Xuất khẩu',             'EXPORT',     110),
  ('COLD_CHAIN',         'Vận chuyển lạnh',       'RECORD',     120),
  ('DISTRIBUTION',       'Phân phối',             'RECORD',     130),
  ('RETAIL',             'Bán lẻ',                'RECORD',     140),
  ('IMPORT_RECEIPT',     'Nhận hàng nhập khẩu',   'RECEIPT',    150);

-- ── Roles ───────────────────────────────────────────────────────────────────
-- COLLECTOR: thương lái / đại lý thu mua. WAREHOUSE: kho. EXPORTER: doanh
-- nghiệp xuất khẩu. IMPORTER: the foreign buyer — created by a receipt link,
-- never through sign-up, so it is not offered on invitations.
ALTER TABLE actors DROP CONSTRAINT actors_role_check;
ALTER TABLE actors ADD CONSTRAINT actors_role_check CHECK (
  role IN ('FARMER', 'COLLECTOR', 'PROCESSOR', 'WAREHOUSE', 'INSPECTOR', 'EXPORTER', 'DISTRIBUTOR', 'RETAILER', 'IMPORTER', 'ADMIN')
);
ALTER TABLE invitations DROP CONSTRAINT invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check CHECK (
  role IN ('FARMER', 'COLLECTOR', 'PROCESSOR', 'WAREHOUSE', 'INSPECTOR', 'EXPORTER', 'DISTRIBUTOR', 'RETAILER', 'ADMIN')
);

-- ── Templates ───────────────────────────────────────────────────────────────
CREATE TABLE workflow_templates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  version        INTEGER NOT NULL CHECK (version >= 1),
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  category_code  TEXT REFERENCES product_categories(code),
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);

CREATE TABLE workflow_steps (
  workflow_id  UUID NOT NULL REFERENCES workflow_templates(id),
  position     INTEGER NOT NULL CHECK (position >= 1),
  stage_code   TEXT NOT NULL REFERENCES stages(code),
  -- A required step can't be jumped over: recording a later step first is refused.
  required     BOOLEAN NOT NULL,
  roles        TEXT[] NOT NULL CHECK (cardinality(roles) >= 1),
  PRIMARY KEY (workflow_id, position),
  UNIQUE (workflow_id, stage_code)
);

-- Templates are reference data: a change is a new version, never an edit.
CREATE TRIGGER workflow_templates_append_only BEFORE UPDATE OR DELETE ON workflow_templates
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER workflow_steps_append_only BEFORE UPDATE OR DELETE ON workflow_steps
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

INSERT INTO workflow_templates (code, version, name, description, category_code) VALUES
  ('GENERIC_RETAIL',  1, 'Chuỗi chung (bán lẻ trong nước)',
     'Sáu khâu của hệ thống cũ, không khâu nào bắt buộc. Lô tạo trước khi có mẫu quy trình dùng mẫu này.', NULL),
  ('COFFEE_EXPORT',   1, 'Cà phê xuất khẩu',
     'Nông hộ → thương lái → nhà máy → kho → kiểm định xuất khẩu → đóng container → xuất khẩu → bên nhập khẩu xác nhận.', 'COFFEE'),
  ('COFFEE_DOMESTIC', 1, 'Cà phê rang xay nội địa',
     'Nông hộ → thu gom → sơ chế → rang → kiểm định → đóng gói → phân phối → bán lẻ.', 'COFFEE'),
  ('FRESH_FRUIT',     1, 'Trái cây tươi',
     'Thu hoạch → sơ chế, đóng gói → kiểm định dư lượng (bắt buộc) → chuỗi lạnh → bán lẻ.', 'FRUIT'),
  ('RICE',            1, 'Lúa gạo',
     'Thu hoạch → sấy → xay xát → kiểm định → đóng bao → phân phối.', 'RICE');

INSERT INTO workflow_steps (workflow_id, position, stage_code, required, roles)
SELECT t.id, s.position, s.stage_code, s.required, s.roles
  FROM (VALUES
    ('GENERIC_RETAIL', 1, 'HARVEST',            false, '{FARMER}'::text[]),
    ('GENERIC_RETAIL', 2, 'PROCESSING',         false, '{PROCESSOR}'),
    ('GENERIC_RETAIL', 3, 'QUALITY_CHECK',      false, '{INSPECTOR}'),
    ('GENERIC_RETAIL', 4, 'PACKAGING',          false, '{PROCESSOR}'),
    ('GENERIC_RETAIL', 5, 'DISTRIBUTION',       false, '{DISTRIBUTOR}'),
    ('GENERIC_RETAIL', 6, 'RETAIL',             false, '{RETAILER}'),

    ('COFFEE_EXPORT',  1, 'HARVEST',            true,  '{FARMER}'),
    ('COFFEE_EXPORT',  2, 'COLLECTION',         false, '{COLLECTOR}'),
    ('COFFEE_EXPORT',  3, 'PROCESSING',         true,  '{PROCESSOR}'),
    ('COFFEE_EXPORT',  4, 'WAREHOUSING',        false, '{WAREHOUSE,PROCESSOR,EXPORTER}'),
    ('COFFEE_EXPORT',  5, 'QUALITY_CHECK',      true,  '{INSPECTOR}'),
    ('COFFEE_EXPORT',  6, 'CONTAINER_STUFFING', true,  '{EXPORTER,WAREHOUSE}'),
    ('COFFEE_EXPORT',  7, 'EXPORT',             true,  '{EXPORTER}'),
    ('COFFEE_EXPORT',  8, 'IMPORT_RECEIPT',     false, '{IMPORTER}'),

    ('COFFEE_DOMESTIC',1, 'HARVEST',            true,  '{FARMER}'),
    ('COFFEE_DOMESTIC',2, 'COLLECTION',         false, '{COLLECTOR}'),
    ('COFFEE_DOMESTIC',3, 'PROCESSING',         true,  '{PROCESSOR}'),
    ('COFFEE_DOMESTIC',4, 'ROASTING',           true,  '{PROCESSOR}'),
    ('COFFEE_DOMESTIC',5, 'QUALITY_CHECK',      true,  '{INSPECTOR}'),
    ('COFFEE_DOMESTIC',6, 'PACKAGING',          true,  '{PROCESSOR}'),
    ('COFFEE_DOMESTIC',7, 'DISTRIBUTION',       false, '{DISTRIBUTOR}'),
    ('COFFEE_DOMESTIC',8, 'RETAIL',             false, '{RETAILER}'),

    ('FRESH_FRUIT',    1, 'HARVEST',            true,  '{FARMER}'),
    ('FRESH_FRUIT',    2, 'PACKAGING',          true,  '{PROCESSOR}'),
    ('FRESH_FRUIT',    3, 'QUALITY_CHECK',      true,  '{INSPECTOR}'),
    ('FRESH_FRUIT',    4, 'COLD_CHAIN',         true,  '{DISTRIBUTOR}'),
    ('FRESH_FRUIT',    5, 'RETAIL',             false, '{RETAILER}'),

    ('RICE',           1, 'HARVEST',            true,  '{FARMER}'),
    ('RICE',           2, 'DRYING',             false, '{PROCESSOR,COLLECTOR}'),
    ('RICE',           3, 'MILLING',            true,  '{PROCESSOR}'),
    ('RICE',           4, 'QUALITY_CHECK',      true,  '{INSPECTOR}'),
    ('RICE',           5, 'PACKAGING',          true,  '{PROCESSOR}'),
    ('RICE',           6, 'DISTRIBUTION',       false, '{DISTRIBUTOR}'),
    ('RICE',           7, 'RETAIL',             false, '{RETAILER}')
  ) AS s(code, position, stage_code, required, roles)
  JOIN workflow_templates t ON t.code = s.code AND t.version = 1;

-- ── Lots pin a template version ─────────────────────────────────────────────
ALTER TABLE batches ADD COLUMN workflow_id UUID REFERENCES workflow_templates(id);
UPDATE batches SET workflow_id = (SELECT id FROM workflow_templates WHERE code = 'GENERIC_RETAIL' AND version = 1);
ALTER TABLE batches ALTER COLUMN workflow_id SET NOT NULL;
CREATE INDEX idx_batches_workflow ON batches (workflow_id);

-- Stage columns now reference the catalog instead of a fixed list.
ALTER TABLE batches DROP CONSTRAINT batches_current_stage_check;
ALTER TABLE batches ADD CONSTRAINT batches_current_stage_fkey FOREIGN KEY (current_stage) REFERENCES stages(code);
ALTER TABLE trace_events DROP CONSTRAINT trace_events_stage_check;
ALTER TABLE trace_events ADD CONSTRAINT trace_events_stage_fkey FOREIGN KEY (stage) REFERENCES stages(code);
ALTER TABLE transformations DROP CONSTRAINT transformations_stage_check;
ALTER TABLE transformations ADD CONSTRAINT transformations_stage_fkey FOREIGN KEY (stage) REFERENCES stages(code);

-- Position of a stage in a lot's template (NULL when the stage isn't part of it).
CREATE FUNCTION workflow_position(p_workflow uuid, p_stage text) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT position FROM workflow_steps WHERE workflow_id = p_workflow AND stage_code = p_stage
$$;

-- Whether `p_stage` is the last step of the template (the lot's journey is over).
CREATE FUNCTION workflow_is_final(p_workflow uuid, p_stage text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_stage IS NOT NULL
     AND workflow_position(p_workflow, p_stage) = (SELECT max(position) FROM workflow_steps WHERE workflow_id = p_workflow)
$$;

-- ── Default workflows must exist ────────────────────────────────────────────
ALTER TABLE product_types ADD CONSTRAINT product_types_default_workflow_known CHECK (
  default_workflow_code IS NULL OR default_workflow_code ~ '^[A-Z][A-Z0-9_]{1,40}$'
);

-- ── Privileges ──────────────────────────────────────────────────────────────
GRANT SELECT ON stages, workflow_templates, workflow_steps TO tracechain_app;
