-- 017: Event fields per product group × stage, as versioned data (docs/SPEC_PHASE1_5.md §2 — "Đợt 2").
--
-- What a stage records used to live in a frontend file and was checked only
-- in the browser — a direct API call could store anything. Now the schema is
-- data the server validates against, the form is drawn from it, and every
-- event remembers the schema version it was written under so an old record
-- keeps its original labels after the schema evolves.
--
-- category_code NULL = the generic schema for that stage; a category row
-- replaces it entirely for that product group.
--
-- Field definition (one JSON object per field):
--   key          data key (letters/digits, starts with a letter)
--   label        Vietnamese label
--   type         text | number | date | select | boolean
--   required     true when the value must be present
--   requiredWhen {"key": "<other field>", "in": [values]} — conditionally required
--   public       shown on the consumer page and disclosed to public verifiers
--   unit, min, max, maxLength, placeholder, options [{value,label}]

CREATE TABLE field_schemas (
  id             SERIAL PRIMARY KEY,
  category_code  TEXT REFERENCES product_categories(code),
  stage_code     TEXT NOT NULL REFERENCES stages(code),
  version        INTEGER NOT NULL CHECK (version >= 1),
  fields         JSONB NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_field_schemas_version ON field_schemas (COALESCE(category_code, '*'), stage_code, version);

CREATE TRIGGER field_schemas_append_only BEFORE UPDATE OR DELETE ON field_schemas
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Generic schemas (every product group) ───────────────────────────────────
INSERT INTO field_schemas (category_code, stage_code, version, fields) VALUES
(NULL, 'HARVEST', 1, '[
  {"key":"variety","label":"Giống","type":"text","maxLength":100,"placeholder":"VD: Robusta TR4, ST25","public":true},
  {"key":"cultivation","label":"Tiêu chuẩn canh tác","type":"select","public":true,"options":[
    {"value":"CONVENTIONAL","label":"Thông thường"},{"value":"VIETGAP","label":"VietGAP"},
    {"value":"GLOBALGAP","label":"GlobalG.A.P."},{"value":"ORGANIC","label":"Hữu cơ"},
    {"value":"RAINFOREST","label":"Rainforest Alliance"},{"value":"4C","label":"4C"}]}
]'),
(NULL, 'COLLECTION', 1, '[
  {"key":"collectionPoint","label":"Điểm thu mua","type":"text","required":true,"maxLength":200,"public":true},
  {"key":"moisture","label":"Độ ẩm khi mua","type":"number","unit":"%","min":0,"max":100},
  {"key":"purchasePrice","label":"Giá thu mua","type":"number","unit":"đ/kg","min":0}
]'),
(NULL, 'DRYING', 1, '[
  {"key":"method","label":"Cách làm khô","type":"select","required":true,"public":true,"options":[
    {"value":"SUN","label":"Phơi nắng"},{"value":"MACHINE","label":"Sấy máy"},{"value":"MIXED","label":"Kết hợp"}]},
  {"key":"moisture","label":"Độ ẩm sau khi làm khô","type":"number","unit":"%","min":0,"max":100,"required":true}
]'),
(NULL, 'PROCESSING', 1, '[
  {"key":"method","label":"Phương pháp chế biến","type":"select","required":true,"public":true,"options":[
    {"value":"WET","label":"Chế biến ướt"},{"value":"DRY","label":"Chế biến khô (phơi nguyên trái)"},
    {"value":"HONEY","label":"Honey"},{"value":"DRYING","label":"Sấy"},{"value":"MILLING","label":"Xay xát / tách vỏ"},
    {"value":"CLEANING","label":"Sơ chế, làm sạch"},{"value":"REDRY","label":"Sấy lại"},{"value":"RESORT","label":"Phân loại lại"},
    {"value":"OTHER","label":"Khác"}]},
  {"key":"moisture","label":"Độ ẩm","type":"number","unit":"%","min":0,"max":100}
]'),
(NULL, 'MILLING', 1, '[
  {"key":"millType","label":"Loại máy xát","type":"text","maxLength":100},
  {"key":"brokenRate","label":"Tỉ lệ tấm","type":"number","unit":"%","min":0,"max":100}
]'),
(NULL, 'ROASTING', 1, '[
  {"key":"roastLevel","label":"Mức rang","type":"select","required":true,"public":true,"options":[
    {"value":"LIGHT","label":"Rang nhạt"},{"value":"MEDIUM","label":"Rang vừa"},{"value":"DARK","label":"Rang đậm"}]},
  {"key":"roastProfile","label":"Hồ sơ rang","type":"text","maxLength":200}
]'),
(NULL, 'WAREHOUSING', 1, '[
  {"key":"warehouseName","label":"Kho","type":"text","required":true,"maxLength":200,"public":true},
  {"key":"storageLocation","label":"Vị trí lưu (dãy/ô)","type":"text","maxLength":100},
  {"key":"moisture","label":"Độ ẩm khi nhập kho","type":"number","unit":"%","min":0,"max":100}
]'),
(NULL, 'QUALITY_CHECK', 1, '[
  {"key":"result","label":"Kết quả","type":"select","required":true,"public":true,"options":[
    {"value":"PASS","label":"Đạt"},{"value":"PASS_WITH_CONDITIONS","label":"Đạt có điều kiện"},{"value":"FAIL","label":"Không đạt"}]},
  {"key":"conditions","label":"Điều kiện phải đáp ứng","type":"text","maxLength":300,"public":true,
   "requiredWhen":{"key":"result","in":["PASS_WITH_CONDITIONS"]}},
  {"key":"conditionDueDate","label":"Hạn đáp ứng điều kiện","type":"date",
   "requiredWhen":{"key":"result","in":["PASS_WITH_CONDITIONS"]}},
  {"key":"grade","label":"Phân hạng","type":"text","maxLength":100,"public":true},
  {"key":"moisture","label":"Độ ẩm","type":"number","unit":"%","min":0,"max":100},
  {"key":"standard","label":"Tiêu chuẩn áp dụng","type":"text","maxLength":100,"public":true},
  {"key":"certificateNo","label":"Số phiếu / chứng nhận","type":"text","maxLength":100,"public":true}
]'),
(NULL, 'PACKAGING', 1, '[
  {"key":"packageType","label":"Quy cách đóng gói","type":"select","required":true,"public":true,"options":[
    {"value":"BAG_60KG","label":"Bao 60 kg"},{"value":"BAG_50KG","label":"Bao 50 kg"},{"value":"BAG_30KG","label":"Bao 30 kg"},
    {"value":"BAG_1KG","label":"Túi 1 kg"},{"value":"BAG_500G","label":"Túi 500 g"},{"value":"CARTON","label":"Thùng carton"},
    {"value":"OTHER","label":"Khác"}]},
  {"key":"packageCount","label":"Số lượng kiện","type":"number","required":true,"min":1},
  {"key":"expiryDate","label":"Hạn sử dụng","type":"date","public":true}
]'),
(NULL, 'CONTAINER_STUFFING', 1, '[
  {"key":"containerNo","label":"Số container","type":"text","required":true,"maxLength":20,"placeholder":"VD: MSKU1234567"},
  {"key":"sealNo","label":"Số chì niêm phong","type":"text","required":true,"maxLength":40},
  {"key":"bagCount","label":"Số bao","type":"number","required":true,"min":1},
  {"key":"sscc","label":"Mã SSCC (GS1)","type":"text","maxLength":18,"placeholder":"18 chữ số"}
]'),
(NULL, 'EXPORT', 1, '[
  {"key":"customsDeclarationNo","label":"Số tờ khai hải quan","type":"text","required":true,"maxLength":40},
  {"key":"containerNo","label":"Số container","type":"text","required":true,"maxLength":20},
  {"key":"sealNo","label":"Số chì niêm phong","type":"text","required":true,"maxLength":40},
  {"key":"billOfLading","label":"Số vận đơn (B/L)","type":"text","required":true,"maxLength":40},
  {"key":"phytoCertNo","label":"Số giấy kiểm dịch thực vật","type":"text","required":true,"maxLength":40,"public":true},
  {"key":"certificateOfOrigin","label":"Số C/O","type":"text","maxLength":40,"public":true},
  {"key":"coForm","label":"Mẫu C/O","type":"select","public":true,"options":[
    {"value":"EUR1","label":"EUR.1 (EVFTA)"},{"value":"FORM_B","label":"Mẫu B"},{"value":"FORM_E","label":"Mẫu E (ACFTA)"},
    {"value":"FORM_D","label":"Mẫu D (ATIGA)"},{"value":"OTHER","label":"Khác"}]},
  {"key":"icoMark","label":"Mã ICO (quốc gia/đơn vị xuất khẩu/lô)","type":"text","maxLength":30,"placeholder":"VD: 145/0123/0456","public":true},
  {"key":"portOfLoading","label":"Cảng đi","type":"text","required":true,"maxLength":100,"public":true},
  {"key":"portOfDischarge","label":"Cảng đến","type":"text","required":true,"maxLength":100,"public":true},
  {"key":"importerName","label":"Người nhập khẩu","type":"text","required":true,"maxLength":200,"public":true},
  {"key":"sscc","label":"Mã SSCC (GS1)","type":"text","maxLength":18}
]'),
(NULL, 'COLD_CHAIN', 1, '[
  {"key":"destination","label":"Nơi nhận","type":"text","required":true,"maxLength":200,"public":true},
  {"key":"vehicle","label":"Phương tiện / biển số","type":"text","maxLength":40},
  {"key":"temperature","label":"Nhiệt độ bảo quản","type":"number","unit":"°C","min":-40,"max":40,"required":true,"public":true}
]'),
(NULL, 'DISTRIBUTION', 1, '[
  {"key":"destination","label":"Nơi nhận","type":"text","required":true,"maxLength":200,"placeholder":"VD: Kho Bình Dương","public":true},
  {"key":"vehicle","label":"Phương tiện / biển số","type":"text","maxLength":40,"placeholder":"VD: 51C-123.45"},
  {"key":"temperature","label":"Nhiệt độ bảo quản","type":"number","unit":"°C","min":-40,"max":60}
]'),
(NULL, 'RETAIL', 1, '[
  {"key":"storeName","label":"Cửa hàng","type":"text","required":true,"maxLength":200,"public":true}
]'),
(NULL, 'IMPORT_RECEIPT', 1, '[
  {"key":"receivedQuantity","label":"Khối lượng thực nhận","type":"number","required":true,"min":0},
  {"key":"condition","label":"Tình trạng hàng","type":"select","required":true,"public":true,"options":[
    {"value":"GOOD","label":"Tốt"},{"value":"DAMAGED","label":"Hư hỏng một phần"},{"value":"REJECTED","label":"Từ chối nhận"}]}
]');

-- ── Coffee ──────────────────────────────────────────────────────────────────
INSERT INTO field_schemas (category_code, stage_code, version, fields) VALUES
('COFFEE', 'HARVEST', 1, '[
  {"key":"variety","label":"Giống cà phê","type":"select","required":true,"public":true,"options":[
    {"value":"ROBUSTA","label":"Robusta (vối)"},{"value":"ARABICA","label":"Arabica (chè)"},
    {"value":"EXCELSA","label":"Excelsa (mít)"},{"value":"LIBERICA","label":"Liberica"}]},
  {"key":"cultivar","label":"Dòng / giống cụ thể","type":"text","maxLength":100,"placeholder":"VD: TR4, Catimor"},
  {"key":"cultivation","label":"Tiêu chuẩn canh tác","type":"select","public":true,"options":[
    {"value":"CONVENTIONAL","label":"Thông thường"},{"value":"VIETGAP","label":"VietGAP"},
    {"value":"ORGANIC","label":"Hữu cơ"},{"value":"RAINFOREST","label":"Rainforest Alliance"},{"value":"4C","label":"4C"}]},
  {"key":"ripeRate","label":"Tỉ lệ quả chín","type":"number","unit":"%","min":0,"max":100}
]'),
('COFFEE', 'QUALITY_CHECK', 1, '[
  {"key":"result","label":"Kết quả","type":"select","required":true,"public":true,"options":[
    {"value":"PASS","label":"Đạt"},{"value":"PASS_WITH_CONDITIONS","label":"Đạt có điều kiện"},{"value":"FAIL","label":"Không đạt"}]},
  {"key":"conditions","label":"Điều kiện phải đáp ứng","type":"text","maxLength":300,"public":true,
   "requiredWhen":{"key":"result","in":["PASS_WITH_CONDITIONS"]}},
  {"key":"conditionDueDate","label":"Hạn đáp ứng điều kiện","type":"date",
   "requiredWhen":{"key":"result","in":["PASS_WITH_CONDITIONS"]}},
  {"key":"grade","label":"Hạng","type":"select","public":true,"options":[
    {"value":"G1","label":"Loại 1"},{"value":"G2","label":"Loại 2"},{"value":"G3","label":"Loại 3"},{"value":"SPECIALTY","label":"Đặc sản"}]},
  {"key":"screenSize","label":"Cỡ sàng","type":"select","public":true,"options":[
    {"value":"S18","label":"S18"},{"value":"S16","label":"S16"},{"value":"S13","label":"S13"},{"value":"S12","label":"S12"}]},
  {"key":"moisture","label":"Độ ẩm","type":"number","unit":"%","min":0,"max":100,"required":true},
  {"key":"defectRate","label":"Tỉ lệ hạt lỗi","type":"number","unit":"%","min":0,"max":100},
  {"key":"foreignMatter","label":"Tạp chất","type":"number","unit":"%","min":0,"max":100},
  {"key":"standard","label":"Tiêu chuẩn áp dụng","type":"text","maxLength":100,"placeholder":"VD: TCVN 4193:2014","public":true},
  {"key":"certificateNo","label":"Số phiếu / chứng nhận","type":"text","maxLength":100,"public":true}
]'),
('COFFEE', 'PROCESSING', 1, '[
  {"key":"method","label":"Phương pháp chế biến","type":"select","required":true,"public":true,"options":[
    {"value":"WET","label":"Chế biến ướt (washed)"},{"value":"DRY","label":"Chế biến khô (natural)"},
    {"value":"HONEY","label":"Honey"},{"value":"HULLING","label":"Xát khô / tách vỏ"},
    {"value":"SORTING","label":"Phân loại, đánh bóng"},{"value":"REDRY","label":"Sấy lại"},{"value":"RESORT","label":"Phân loại lại"},
    {"value":"OTHER","label":"Khác"}]},
  {"key":"moisture","label":"Độ ẩm","type":"number","unit":"%","min":0,"max":100},
  {"key":"fermentationHours","label":"Thời gian lên men","type":"number","unit":"giờ","min":0}
]');

-- ── Fruit ───────────────────────────────────────────────────────────────────
INSERT INTO field_schemas (category_code, stage_code, version, fields) VALUES
('FRUIT', 'QUALITY_CHECK', 1, '[
  {"key":"result","label":"Kết quả","type":"select","required":true,"public":true,"options":[
    {"value":"PASS","label":"Đạt"},{"value":"PASS_WITH_CONDITIONS","label":"Đạt có điều kiện"},{"value":"FAIL","label":"Không đạt"}]},
  {"key":"conditions","label":"Điều kiện phải đáp ứng","type":"text","maxLength":300,"public":true,
   "requiredWhen":{"key":"result","in":["PASS_WITH_CONDITIONS"]}},
  {"key":"conditionDueDate","label":"Hạn đáp ứng điều kiện","type":"date",
   "requiredWhen":{"key":"result","in":["PASS_WITH_CONDITIONS"]}},
  {"key":"pesticideResidue","label":"Dư lượng thuốc BVTV","type":"select","required":true,"public":true,"options":[
    {"value":"PASS","label":"Trong giới hạn cho phép"},{"value":"FAIL","label":"Vượt giới hạn"}]},
  {"key":"brix","label":"Độ ngọt","type":"number","unit":"°Brix","min":0,"max":40,"public":true},
  {"key":"size","label":"Kích cỡ / phân loại","type":"text","maxLength":60,"public":true},
  {"key":"certificateNo","label":"Số phiếu / chứng nhận","type":"text","maxLength":100,"public":true}
]'),
('FRUIT', 'PACKAGING', 1, '[
  {"key":"packageType","label":"Quy cách đóng gói","type":"select","required":true,"public":true,"options":[
    {"value":"CARTON","label":"Thùng carton"},{"value":"CRATE","label":"Sọt nhựa"},{"value":"NET_BAG","label":"Túi lưới"},{"value":"OTHER","label":"Khác"}]},
  {"key":"packageCount","label":"Số lượng kiện","type":"number","required":true,"min":1},
  {"key":"packingHouseCode","label":"Mã cơ sở đóng gói","type":"text","maxLength":40,"public":true},
  {"key":"expiryDate","label":"Hạn sử dụng","type":"date","public":true}
]');

-- ── Rice ────────────────────────────────────────────────────────────────────
INSERT INTO field_schemas (category_code, stage_code, version, fields) VALUES
('RICE', 'HARVEST', 1, '[
  {"key":"variety","label":"Giống lúa","type":"text","required":true,"maxLength":100,"placeholder":"VD: ST25, OM5451","public":true},
  {"key":"season","label":"Vụ","type":"select","public":true,"options":[
    {"value":"DONG_XUAN","label":"Đông Xuân"},{"value":"HE_THU","label":"Hè Thu"},{"value":"THU_DONG","label":"Thu Đông"}]},
  {"key":"cultivation","label":"Tiêu chuẩn canh tác","type":"select","public":true,"options":[
    {"value":"CONVENTIONAL","label":"Thông thường"},{"value":"VIETGAP","label":"VietGAP"},{"value":"ORGANIC","label":"Hữu cơ"}]}
]'),
('RICE', 'QUALITY_CHECK', 1, '[
  {"key":"result","label":"Kết quả","type":"select","required":true,"public":true,"options":[
    {"value":"PASS","label":"Đạt"},{"value":"PASS_WITH_CONDITIONS","label":"Đạt có điều kiện"},{"value":"FAIL","label":"Không đạt"}]},
  {"key":"conditions","label":"Điều kiện phải đáp ứng","type":"text","maxLength":300,"public":true,
   "requiredWhen":{"key":"result","in":["PASS_WITH_CONDITIONS"]}},
  {"key":"conditionDueDate","label":"Hạn đáp ứng điều kiện","type":"date",
   "requiredWhen":{"key":"result","in":["PASS_WITH_CONDITIONS"]}},
  {"key":"moisture","label":"Độ ẩm","type":"number","unit":"%","min":0,"max":100,"required":true},
  {"key":"brokenRate","label":"Tỉ lệ tấm","type":"number","unit":"%","min":0,"max":100,"required":true,"public":true},
  {"key":"grade","label":"Phân hạng","type":"text","maxLength":100,"public":true},
  {"key":"certificateNo","label":"Số phiếu / chứng nhận","type":"text","maxLength":100,"public":true}
]');

-- ── Events remember the schema they were validated against ──────────────────
ALTER TABLE trace_events ADD COLUMN field_schema_id INTEGER REFERENCES field_schemas(id);

GRANT SELECT ON field_schemas TO tracechain_app;
