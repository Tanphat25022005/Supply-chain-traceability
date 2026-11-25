-- 019: Mass-balance reference data keyed by catalog product, with sources and
-- tenant overrides (docs/SPEC_PHASE1_5.md §3 — "Đợt 3").
--
-- Migration 014 matched conversion factors and yield caps by product-type
-- NAME and carried no source. Now every number:
--   • points at a catalog product type (or product group);
--   • says where it comes from (`source`) — a reviewer will ask;
--   • exists once at platform level (tenant_id NULL, read-only to the app)
--     and may be overridden by a tenant for its own lots (audited in the
--     tenant's audit log). Deleting an override falls back to the platform value.

DROP TABLE conversion_factors;
DROP TABLE yield_caps;

-- ── Transform: product A → product B ────────────────────────────────────────
CREATE TABLE conversion_factors (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID REFERENCES tenants(id),
  from_type_id   UUID NOT NULL REFERENCES product_types(id),
  to_type_id     UUID NOT NULL REFERENCES product_types(id),
  min_ratio      NUMERIC NOT NULL CHECK (min_ratio > 0),
  max_ratio      NUMERIC NOT NULL CHECK (max_ratio >= min_ratio),
  source         TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 3 AND 500),
  updated_by     UUID,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_type_id <> to_type_id),
  FOREIGN KEY (updated_by, tenant_id) REFERENCES actors (id, tenant_id)
);
CREATE UNIQUE INDEX uq_conversion_factors_scope ON conversion_factors (
  COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), from_type_id, to_type_id
);

-- ── Same-product processes: merge, split, rework, downgrade ─────────────────
CREATE TABLE process_ratios (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID REFERENCES tenants(id),
  kind           TEXT NOT NULL CHECK (kind IN ('MERGE', 'SPLIT', 'REWORK', 'DOWNGRADE')),
  category_code  TEXT REFERENCES product_categories(code),   -- NULL = every product group
  min_ratio      NUMERIC NOT NULL CHECK (min_ratio > 0),
  max_ratio      NUMERIC NOT NULL CHECK (max_ratio >= min_ratio AND max_ratio <= 1),
  source         TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 3 AND 500),
  updated_by     UUID,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (updated_by, tenant_id) REFERENCES actors (id, tenant_id)
);
CREATE UNIQUE INDEX uq_process_ratios_scope ON process_ratios (
  COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, COALESCE(category_code, '*')
);

-- ── Yield per hectare and year, optionally per region ───────────────────────
CREATE TABLE yield_caps (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID REFERENCES tenants(id),
  product_type_id  UUID NOT NULL REFERENCES product_types(id),
  -- Matched against the lot's origin text (e.g. "Sơn La"); NULL = anywhere.
  region           TEXT CHECK (region IS NULL OR length(trim(region)) BETWEEN 2 AND 100),
  max_kg_per_ha    NUMERIC NOT NULL CHECK (max_kg_per_ha > 0),
  source           TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 3 AND 500),
  updated_by       UUID,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (updated_by, tenant_id) REFERENCES actors (id, tenant_id)
);
CREATE UNIQUE INDEX uq_yield_caps_scope ON yield_caps (
  COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), product_type_id, COALESCE(catalog_norm(region), '*')
);

-- ── Per-product operating limits ────────────────────────────────────────────
CREATE TABLE product_settings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID REFERENCES tenants(id),
  product_type_id         UUID NOT NULL REFERENCES product_types(id),
  -- Shortfall a receiver may weigh without it being an anomaly (0.005 = 0.5%).
  transit_loss_tolerance  NUMERIC NOT NULL CHECK (transit_loss_tolerance >= 0 AND transit_loss_tolerance <= 0.5),
  -- Recording an event more than this many days after it happened needs a reason.
  max_backdate_days       INTEGER NOT NULL CHECK (max_backdate_days BETWEEN 0 AND 365),
  source                  TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 3 AND 500),
  updated_by              UUID,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (updated_by, tenant_id) REFERENCES actors (id, tenant_id)
);
CREATE UNIQUE INDEX uq_product_settings_scope ON product_settings (
  COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), product_type_id
);

-- ── Platform values ─────────────────────────────────────────────────────────
INSERT INTO conversion_factors (from_type_id, to_type_id, min_ratio, max_ratio, source)
SELECT f.id, t.id, v.min_ratio, v.max_ratio, v.source
  FROM (VALUES
    ('COFFEE_CHERRY',     'COFFEE_DRY_CHERRY', 0.40, 0.50,
       'Ước tính kỹ thuật: quả tươi ẩm ~60–65% phơi/sấy về ~12,5% còn 40–50% khối lượng'),
    ('COFFEE_DRY_CHERRY', 'COFFEE_UNSORTED',   0.45, 0.55,
       'FAO và ICO dùng hệ số 50% khi quy đổi quả khô sang nhân (trích theo luận văn UPLB, Philippines)'),
    ('COFFEE_CHERRY',     'COFFEE_PARCHMENT',  0.18, 0.24,
       'Quy ước 5:1 quả tươi → cà phê thóc (luận văn UPLB, Philippines); dao động theo độ chín'),
    ('COFFEE_PARCHMENT',  'COFFEE_UNSORTED',   0.78, 0.82,
       'World Bank – Coffee data sheet: cà phê thóc chế biến ướt cho trung bình 80% khối lượng là nhân'),
    ('COFFEE_CHERRY',     'COFFEE_UNSORTED',   0.15, 0.23,
       'World Bank – Coffee data sheet: nhân sạch ≈16,5% khối lượng quả chín (arabica), ≈21% (robusta)'),
    ('COFFEE_CHERRY',     'COFFEE_GREEN',      0.15, 0.23,
       'World Bank – Coffee data sheet: nhân sạch ≈16,5% khối lượng quả chín (arabica), ≈21% (robusta)'),
    ('COFFEE_UNSORTED',   'COFFEE_GREEN',      0.85, 0.98,
       'Ước tính kỹ thuật: phân loại loại bỏ hạt lỗi, đen, vỡ và tạp chất theo hạng TCVN 4193:2014 — doanh nghiệp nên hiệu chỉnh'),
    ('COFFEE_GREEN',      'COFFEE_ROASTED',    0.76, 0.90,
       'Hao hụt khi rang 10–24% tuỳ mức rang và độ ẩm nhân (Sweet Maria''s, Royal Coffee)'),
    ('RICE_PADDY',        'RICE_MILLED',       0.55, 0.72,
       'Tỉ lệ thu hồi gạo xát 59–71% tuỳ loại máy (tài liệu xay xát PhilRice/IRRI; máy một lượt thấp nhất)'),
    ('RUBBER_LATEX',      'RUBBER_BLOCK',      0.28, 0.40,
       'Ước tính theo hàm lượng cao su khô (DRC) của mủ nước 28–40% — doanh nghiệp nên hiệu chỉnh theo DRC đo được'),
    ('TEA_FRESH',         'TEA_DRY',           0.18, 0.25,
       'Ước tính kỹ thuật: khoảng 4–5,5 kg búp tươi cho 1 kg chè khô — doanh nghiệp nên hiệu chỉnh')
  ) AS v(from_code, to_code, min_ratio, max_ratio, source)
  JOIN product_types f ON f.code = v.from_code AND f.tenant_id IS NULL
  JOIN product_types t ON t.code = v.to_code AND t.tenant_id IS NULL;

INSERT INTO process_ratios (kind, category_code, min_ratio, max_ratio, source) VALUES
  ('MERGE',     NULL, 0.97, 1.00, 'Gộp lô không làm tăng khối lượng; cho phép sai số cân tới 3% (mặc định hệ thống)'),
  ('SPLIT',     NULL, 0.97, 1.00, 'Tách lô không làm tăng khối lượng; cho phép sai số cân tới 3% (mặc định hệ thống)'),
  ('REWORK',    NULL, 0.85, 1.00, 'Chế biến lại (sấy lại, phân loại lại) hao hụt tối đa 15% (mặc định hệ thống, doanh nghiệp nên hiệu chỉnh)'),
  ('DOWNGRADE', NULL, 0.90, 1.00, 'Hạ loại chỉ loại bỏ phần hỏng, hao hụt tối đa 10% (mặc định hệ thống, doanh nghiệp nên hiệu chỉnh)');

INSERT INTO yield_caps (product_type_id, region, max_kg_per_ha, source)
SELECT pt.id, v.region, v.max_kg, v.source
  FROM (VALUES
    ('COFFEE_GREEN',  NULL,      6000,
       'Năng suất cà phê VN bình quân 2,7–2,9 tấn nhân/ha (VICOFA 2023); trần ≈ 2 lần bình quân cho vườn thâm canh'),
    ('COFFEE_GREEN',  'Sơn La',  4000,
       'Arabica Sơn La năng suất thấp hơn robusta Tây Nguyên; trần ước tính — doanh nghiệp nên hiệu chỉnh'),
    ('COFFEE_CHERRY', NULL,      30000,
       'Quy từ trần 6 tấn nhân/ha với hệ số quả tươi → nhân ≈ 0,2 (World Bank – Coffee data sheet)'),
    ('COFFEE_CHERRY', 'Sơn La',  20000,
       'Quy từ trần 4 tấn nhân/ha arabica với hệ số quả tươi → nhân ≈ 0,2'),
    ('RICE_PADDY',    NULL,      25000,
       'Ước tính: tối đa 3 vụ/năm × ~8 tấn thóc/ha/vụ ở ruộng thâm canh — doanh nghiệp nên hiệu chỉnh'),
    ('RUBBER_LATEX',  NULL,      6000,
       'Giữ nguyên trần của phiên bản trước (migration 014) — cần bổ sung nguồn')
  ) AS v(type_code, region, max_kg, source)
  JOIN product_types pt ON pt.code = v.type_code AND pt.tenant_id IS NULL;

-- Tolerances are policy, not physics: a sensible default each tenant tunes to its contracts.
INSERT INTO product_settings (product_type_id, transit_loss_tolerance, max_backdate_days, source)
SELECT pt.id, v.tolerance, v.backdate, v.source
  FROM (VALUES
    ('COFFEE_CHERRY',     0.02,  3, 'Mặc định hệ thống: quả tươi mất nước nhanh khi vận chuyển; phải ghi trong 3 ngày'),
    ('COFFEE_DRY_CHERRY', 0.01,  7, 'Mặc định hệ thống'),
    ('COFFEE_PARCHMENT',  0.01,  7, 'Mặc định hệ thống'),
    ('COFFEE_UNSORTED',   0.005, 7, 'Mặc định hệ thống: hàng khô đóng bao, sai số cân 0,5%'),
    ('COFFEE_GREEN',      0.005, 7, 'Mặc định hệ thống: hàng khô đóng bao, sai số cân 0,5%'),
    ('COFFEE_ROASTED',    0.005, 7, 'Mặc định hệ thống'),
    ('RICE_PADDY',        0.01,  7, 'Mặc định hệ thống'),
    ('RICE_MILLED',       0.005, 7, 'Mặc định hệ thống: hàng khô đóng bao, sai số cân 0,5%'),
    ('FRUIT_FRESH',       0.03,  2, 'Mặc định hệ thống: trái cây tươi hao hụt nhanh; phải ghi trong 2 ngày'),
    ('FRUIT_DURIAN',      0.03,  2, 'Mặc định hệ thống: trái cây tươi hao hụt nhanh; phải ghi trong 2 ngày'),
    ('FRUIT_DRAGON',      0.03,  2, 'Mặc định hệ thống: trái cây tươi hao hụt nhanh; phải ghi trong 2 ngày'),
    ('TEA_FRESH',         0.03,  2, 'Mặc định hệ thống'),
    ('TEA_DRY',           0.005, 7, 'Mặc định hệ thống'),
    ('SPICE_PEPPER',      0.005, 7, 'Mặc định hệ thống'),
    ('RUBBER_LATEX',      0.02,  3, 'Mặc định hệ thống'),
    ('RUBBER_BLOCK',      0.005, 7, 'Mặc định hệ thống'),
    ('OTHER_PRODUCE',     0.01,  7, 'Mặc định hệ thống')
  ) AS v(type_code, tolerance, backdate, source)
  JOIN product_types pt ON pt.code = v.type_code AND pt.tenant_id IS NULL;

-- ── Privileges + row-level security ─────────────────────────────────────────
GRANT SELECT, INSERT, DELETE ON conversion_factors, process_ratios, yield_caps, product_settings TO tracechain_app;
GRANT UPDATE (min_ratio, max_ratio, source, updated_by, updated_at) ON conversion_factors, process_ratios TO tracechain_app;
GRANT UPDATE (max_kg_per_ha, source, updated_by, updated_at) ON yield_caps TO tracechain_app;
GRANT UPDATE (transit_loss_tolerance, max_backdate_days, source, updated_by, updated_at) ON product_settings TO tracechain_app;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversion_factors', 'process_ratios', 'yield_caps', 'product_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY reference_read ON %I FOR SELECT USING (tenant_id IS NULL OR tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY reference_insert ON %I FOR INSERT WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY reference_update ON %I FOR UPDATE USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY reference_delete ON %I FOR DELETE USING (tenant_id = app_current_tenant())', t);
  END LOOP;
END;
$$;
