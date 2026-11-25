# Đặc tả nghiệp vụ — Giai đoạn 1.5: khớp nghiệp vụ với thực tế

Giai đoạn 1 chứng minh được dữ liệu **không bị sửa sau khi ghi**. Giai đoạn 1.5 xử lý
câu hỏi còn lại: dữ liệu **có mô tả đúng chuỗi cung ứng thật không**. Thay đổi chia
năm đợt; số mục dưới đây trùng số đợt (code và migration tham chiếu theo các số này).

| Mục | Nội dung | Migration | Test chính |
|---|---|---|---|
| §0 | Trạng thái lô, bàn giao hai chiều, tạm giữ / thu hồi lan truyền, kiểm định đạt/không đạt, thời điểm xảy ra (hash v4) | 018 | `lotStatus.test.ts`, `ledgerPhase1.test.ts` |
| §1 | Danh mục sản phẩm hai cấp, đơn vị và quy đổi | 015 | `workflowCatalog.test.ts`, `migrations.test.ts` |
| §2 | Bộ trường dữ liệu theo nhóm sản phẩm × khâu, có phiên bản | 017 | `workflowCatalog.test.ts` |
| §3 | Dữ liệu tham chiếu có nguồn, doanh nghiệp được ghi đè | 019 | `anomalyDetector.test.ts`, `report.test.ts` |
| §4 | Quy trình mẫu theo sản phẩm, vai trò mới, chuỗi xuất khẩu, xác nhận của bên nhập khẩu | 016 | `workflowCatalog.test.ts`, `api.integration.test.ts` |

Nguồn sự thật luôn là file migration; các bảng dưới đây là tóm tắt.

---

## §0. Trạng thái lô, quyền giữ hàng và thời điểm

### 0.1 Máy trạng thái

`batches.status`; chuyển trạng thái do trigger `batches_guard_update` thực thi, nên
code ứng dụng có bug cũng không đi sai được.

| Từ | Sang được |
|---|---|
| `ACTIVE` | IN_TRANSIT, ON_HOLD, REJECTED, RECALLED, DESTROYED, CONSUMED |
| `IN_TRANSIT` | ACTIVE, REJECTED, ON_HOLD, RECALLED, CONSUMED |
| `ON_HOLD` | ACTIVE, REJECTED, IN_TRANSIT, RECALLED, DESTROYED |
| `REJECTED` | IN_TRANSIT, ON_HOLD, RECALLED, DESTROYED, CONSUMED |
| `CONSUMED` | RECALLED |
| `RECALLED` | DESTROYED |
| `DESTROYED` | — |

- `consumed_quantity + lost_quantity ≥ quantity` ⇒ tự chuyển `CONSUMED`.
- `is_recalled` giờ là cột sinh từ `status = 'RECALLED'` (giữ tương thích API cũ).
- Trigger sổ cái từ chối ghi sự kiện vào lô `DESTROYED`, `RECALLED` hoặc đã dùng hết.

### 0.2 Tạm giữ và thu hồi lan truyền

- `batch_holds`: quản trị viên / kiểm định viên tạm giữ (`HOLD`) và gỡ (`RELEASE`), bắt
  buộc lý do; dòng tạm giữ chỉ được ghi thêm thời điểm gỡ.
- Thu hồi theo nguyên tắc **"lùi một bước, tiến một bước"**:
  - lô hậu duệ (làm ra từ lô bị thu hồi) ⇒ `ON_HOLD`; nếu chọn *lan truyền* thì `RECALLED`;
  - lô tổ tiên và lô anh em (cùng nguồn) ⇒ cảnh báo `RECALL_INVESTIGATION`, không tự khoá;
  - trang công khai của sản phẩm hiện cảnh báo khi một lô nguyên liệu đã bị thu hồi.

### 0.3 Kiểm định đạt / không đạt

Khâu loại `INSPECTION` có trường `result`:

- `FAIL` ⇒ lô `REJECTED`: không ghi tiếp khâu nào, chỉ còn ba lối ra.
- `CONDITIONAL` ⇒ cảnh báo `QC_CONDITION`, lô vẫn đi tiếp.

| Lối ra | Kết quả | Hao hụt cho phép (mặc định, §3) |
|---|---|---|
| Chế biến lại (`REWORK`): sấy lại, phân loại lại | Lô mới cùng loại, ghi tại một khâu **trước** khâu kiểm định | ≤ 15% |
| Hạ loại (`DOWNGRADE`) | Lô mới loại khác trong cùng nhóm, ghi tại chính khâu kiểm định với kết quả đạt | ≤ 10% |
| Huỷ (`DISPOSE`) | `DESTROYED`, khối lượng vào `lost_quantity` | — |

Nếu người kiểm định thuộc cùng đơn vị đã xử lý lô ở khâu trước ⇒ `CONFLICT_OF_INTEREST`.

### 0.4 Bàn giao hai chiều

Trước đây người gửi chỉ định người nhận là xong. Thực tế hàng chỉ đổi chủ khi bên nhận
**cân lại và ký nhận**. Bảng `transfers`:

1. Người gửi tạo bàn giao (khối lượng, số bao, phương tiện, số chứng từ) ⇒ lô
   `IN_TRANSIT`, sự kiện `TRANSFER_OUT`.
2. Bên nhận **xác nhận** với khối lượng thực nhận ⇒ lô `ACTIVE`, người giữ đổi,
   sự kiện `TRANSFER_ACCEPT`. Thiếu vượt `transit_loss_tolerance` của sản phẩm ⇒
   `QUANTITY_DISCREPANCY`; phần thiếu cộng vào `lost_quantity`.
3. Hoặc **từ chối** (bắt buộc lý do) ⇒ lô ở lại với người gửi (`TRANSFER_REJECT`).
4. Người gửi huỷ được khi chưa có trả lời (`TRANSFER_CANCEL`).

Mỗi lô chỉ có một bàn giao đang chờ. Bàn giao chờ quá 2 ngày (`TRANSFER_OVERDUE_DAYS`)
hiện ở Dashboard. Bên nhận / bên gửi được thông báo realtime (sự kiện Socket.IO
`transfer`). Người tự làm được khâu kế tiếp không bị bắt chỉ định người nhận.

### 0.5 Thời điểm xảy ra và hash v4

Người dùng thường ghi sau khi việc đã xảy ra (ở rẫy không có sóng, tối mới ghi).
`trace_events.occurred_at` = lúc việc xảy ra (người ghi khai), khác `timestamp` = lúc
máy chủ ghi.

Ràng buộc trong database:

- `occurred_at ≤ timestamp + 5 phút` (cho phép đồng hồ thiết bị lệch);
- `occurred_at` không sớm hơn sự kiện trước của cùng lô (trigger sổ cái);
- sự kiện `hash_version < 4`: `occurred_at = timestamp` (migration backfill).

Ở dịch vụ (`services/eventTime.ts`): thời điểm ở tương lai bị từ chối; ghi trễ hơn
`max_backdate_days` của sản phẩm (2–7 ngày, §3) phải kèm `lateReason` và bị cảnh báo
`LATE_ENTRY`.

**Hash v4** = v3 (SPEC_PHASE1.md §1.1) + khoá `occurredAt` trong phần khung luôn công khai:

```
eventHash = hex(SHA256(JCS({ v: 4, batchId, sequenceNumber, prevHash, stage, kind,
                              timestamp, occurredAt, links, claims })))
```

`occurredAt` là chuỗi ISO 8601 UTC đủ mili-giây. Mọi phần khác giữ nguyên. Test vector:
khoá `hashV4` trong [`test-vectors/phase1.json`](test-vectors/phase1.json); vector v3
không đổi. Trang `/verify` hiện riêng "xảy ra lúc" (đã cam kết trong mã băm với v4),
"ghi nhận lúc" và "đóng dấu blockchain lúc".

### 0.6 Sự kiện quyền giữ hàng

Ngoài các khâu, sổ cái ghi theo `kind`: `TRANSFER_OUT`, `TRANSFER_ACCEPT`,
`TRANSFER_REJECT`, `TRANSFER_CANCEL`, `HOLD`, `RELEASE`, `RECALL`, `DISPOSE`, cùng các
kiểu biến đổi `MERGE`, `SPLIT`, `TRANSFORM`, `REWORK`, `DOWNGRADE`. Sự kiện quyền giữ
hàng không đổi `current_stage`. Trang công khai chỉ hiện tiếp nhận, tạm giữ, gỡ tạm giữ,
thu hồi, huỷ.

---

## §1. Danh mục sản phẩm và đơn vị

**Hai cấp.** Dòng `tenant_id IS NULL` là danh mục nền tảng mọi doanh nghiệp cùng đọc;
dòng có `tenant_id` là của riêng doanh nghiệp đó. RLS: đọc được cả hai, chỉ ghi dòng
của mình.

- `product_categories`: COFFEE, RICE, FRUIT, TEA, SPICE, RUBBER, OTHER.
- `product_types`: 17 loại nền tảng. Cà phê tách theo đúng các dạng trong chế biến:
  quả tươi → quả khô / cà phê thóc → **nhân xô** (chưa phân loại) → nhân xanh → rang.
  Mỗi loại có `base_unit` (`kg` hoặc `cái`), quy trình mặc định, tên gọi khác
  (`aliases`) và GTIN tuỳ chọn.
- `units`: kg, tấn (×1000), cái, cộng quy cách đóng gói theo sản phẩm (bao 60 kg nhân
  xanh, bao 50 kg gạo / tiêu, thùng 10 kg trái cây…). Doanh nghiệp thêm quy cách riêng.

**Trên lô:** `product_type_id`, `base_unit`, `unit_factor` và cột sinh
`quantity_base = quantity × unit_factor`. Mọi phép so khối lượng (cân bằng, hao hụt,
năng suất) dùng `quantity_base`, nên 20 bao 60 kg và 1 200 kg được so đúng. Trigger
`batches_guard_catalog`: loại sản phẩm và hệ số chỉ gán **một lần**.

**Dữ liệu cũ.** Migration chỉ gán loại khi tên khớp **chính xác** (sau `unaccent` và
chuyển chữ thường) tên hoặc tên gọi khác — không đoán. Lô không khớp vào hàng chờ
"Lô cũ chưa gắn loại sản phẩm" ở `/admin/catalog`, quản trị viên gán theo nhóm. Lô
chưa gắn loại không được gộp / tách / chế biến.

`actors.gln`, `plots.gln`: mã địa điểm GS1 tuỳ chọn, chuẩn bị cho xuất EPCIS.

## §2. Bộ trường dữ liệu theo khâu

`field_schemas(category_code, stage, version, fields jsonb)`. Mỗi trường có
`key, label, type (text|number|date|select|boolean), unit, required, requiredWhen,
min, max, options, public`.

- Chọn schema: của nhóm sản phẩm nếu có, không thì schema chung (`category_code IS NULL`);
  lấy phiên bản mới nhất.
- Sự kiện lưu `field_schema_id` đã dùng ⇒ nhãn vẫn đúng khi schema đổi về sau.
- **Máy chủ kiểm tra** (`domain/fieldSchema.ts`): thiếu trường bắt buộc, sai kiểu, ngoài
  khoảng, giá trị không có trong danh sách ⇒ 422 kèm `issues: [{field, code, message}]`.
- `public: true` quyết định trường nào hiện ở trang công khai (tiết lộ chọn lọc v3/v4).
  Sự kiện cũ không có schema dùng danh sách `LEGACY_PUBLIC_KEYS`.

Ví dụ cà phê: thu hoạch (giống, tỉ lệ quả chín, mã vùng trồng), chế biến (phương pháp,
độ ẩm đầu ra, hạng), kiểm định (kết quả đạt / không đạt / có điều kiện, độ ẩm, tỉ lệ
hạt lỗi, hướng xử lý `REDRY` / `RESORT`…), xuất khẩu (số tờ khai, container, cảng).

## §3. Dữ liệu tham chiếu có nguồn

Mọi ngưỡng dùng để cảnh báo nằm trong bảng, **mỗi dòng có cột `source`**:

| Bảng | Dùng cho |
|---|---|
| `conversion_factors(from_type, to_type, min, max)` | Chế biến đổi loại: tỉ lệ ra/vào ngoài khoảng ⇒ `MASS_BALANCE_VIOLATION` |
| `process_ratios(kind, category, min, max)` | Gộp / tách 97–100%, chế biến lại 85–100%, hạ loại 90–100% |
| `yield_caps(product_type, region, max_kg_per_ha)` | Lô đất khai vượt năng suất hợp lý |
| `product_settings(product_type, transit_loss_tolerance, max_backdate_days)` | Hụt khi bàn giao, hạn ghi lùi |

Nguồn chính: World Bank – Coffee data sheet (nhân ≈ 16,5–21% khối lượng quả chín;
thóc → nhân 80%), FAO/ICO (quả khô → nhân 50%), PhilRice/IRRI (thu hồi gạo xát 59–71%),
VICOFA 2023 (2,7–2,9 tấn nhân/ha). Giá trị không có nguồn công bố được ghi rõ là
"ước tính kỹ thuật" hoặc "mặc định hệ thống" ngay trong cột `source`, và trang Danh mục
nhắc doanh nghiệp hiệu chỉnh.

**Ghi đè theo doanh nghiệp.** Doanh nghiệp đặt giá trị riêng **kèm nguồn bắt buộc**
(vd. "biên bản cân thực tế vụ 2026"); dòng nền tảng vẫn giữ. Bộ phát hiện dùng dòng của
doanh nghiệp trước, không có thì dùng dòng nền tảng; xoá dòng riêng là quay về mặc định.
Báo cáo `/reports` hiện tỉ lệ thực tế cạnh khoảng tham chiếu và nguồn của nó.

## §4. Quy trình mẫu, vai trò và chuỗi xuất khẩu

### 4.1 Khâu và quy trình

`stages` (15 khâu, có `sort_order` và `kind`): `RECORD` (khâu thường), `INSPECTION`,
`EXPORT`, `RECEIPT` (bên nhập khẩu xác nhận).

`workflow_templates` + `workflow_steps`: danh sách khâu có thứ tự, mỗi khâu ghi
`required` và các vai trò được ghi. Khâu tuỳ chọn để trong ngoặc:

| Quy trình | Chuỗi khâu |
|---|---|
| `COFFEE_EXPORT` | Thu hoạch → (Thu gom) → Chế biến → (Nhập kho) → Kiểm định → Đóng container → Xuất khẩu → (Nhận hàng nhập khẩu) |
| `COFFEE_DOMESTIC` | Thu hoạch → (Thu gom) → Chế biến → Rang → Kiểm định → Đóng gói → (Phân phối) → (Bán lẻ) |
| `FRESH_FRUIT` | Thu hoạch → Đóng gói → Kiểm định → Vận chuyển lạnh → (Bán lẻ) |
| `RICE` | Thu hoạch → (Phơi / sấy) → Xay xát → Kiểm định → Đóng gói → (Phân phối) → (Bán lẻ) |
| `GENERIC_RETAIL` | Sáu khâu cũ, đều tuỳ chọn — lô có từ trước giai đoạn 1.5 được gắn quy trình này |

Lô **ghim phiên bản quy trình** (`batches.workflow_id`, không đổi được); sửa quy trình
về sau tạo phiên bản mới, không ảnh hưởng lô cũ.

Quy tắc ghi khâu (`domain/workflow.ts`, đối chiếu thêm trong trigger sổ cái):

- khâu phải thuộc quy trình của lô (`workflow_position()` NULL ⇒ từ chối);
- không lùi khâu; ghi lại đúng khâu hiện tại ⇒ `DUPLICATE_STAGE`;
- **khâu bắt buộc không bỏ qua được** (409); bỏ qua khâu tuỳ chọn được nhưng ghi
  `STAGE_SKIPPED` mức LOW (HIGH nếu khâu bị bỏ là kiểm định);
- tới khâu cuối (`workflow_is_final()`) ⇒ lô hoàn tất hành trình.

### 4.2 Vai trò mới

`COLLECTOR` (thương lái / đại lý), `WAREHOUSE` (kho), `EXPORTER`, `IMPORTER`.
`IMPORTER` không mời được và không đăng nhập được — tài khoản chỉ được tạo từ link xác
nhận nhận hàng.

### 4.3 Xác nhận của bên nhập khẩu

1. `EXPORTER` ghi khâu Xuất khẩu (số tờ khai, container, cảng).
2. Tạo **link nhận hàng** (`POST /api/trace/{batchId}/receipt-links`): JWT mục đích
   `import-receipt`, hiệu lực 1–90 ngày.
3. Bên mua mở `/receipt?batch=…&token=…` (không cần tài khoản), nhập khối lượng nhận,
   tình trạng (`GOOD` / `DAMAGED` / `REJECTED`) và nơi nhận ⇒ khâu `IMPORT_RECEIPT` được
   ghi dưới tên bên nhập khẩu. Nhận thiếu so với lúc xuất ⇒ `QUANTITY_DISCREPANCY`.
4. Khi lô đã ở khâu nhận hàng, link không ghi thêm được nữa.

---

## Cảnh báo mới

| Loại | Khi nào |
|---|---|
| `QUANTITY_DISCREPANCY` | Bên nhận cân thiếu vượt ngưỡng hao hụt vận chuyển |
| `LATE_ENTRY` | Ghi trễ hơn `max_backdate_days` (kèm lý do) |
| `RECALL_INVESTIGATION` | Lô tổ tiên / anh em của một lô bị thu hồi |
| `QC_CONDITION` | Kiểm định đạt có điều kiện |
| `CONFLICT_OF_INTEREST` | Kiểm định viên cùng đơn vị đã xử lý lô ở khâu trước |

## API mới (OpenAPI 1.5.0, `/api/docs`)

- Danh mục: `GET /api/catalog` (công khai), `/catalog/tenant`, `/catalog/reference`,
  `/catalog/unmapped`, `POST /catalog/unmapped/map`, `POST /catalog/product-types`,
  `PATCH /catalog/product-types/{id}`, `POST /catalog/units`,
  `PUT /catalog/reference/{conversion-factors|process-ratios|yield-caps|product-settings}`,
  `DELETE /catalog/reference/{table}/{id}`.
- Lô: `POST /api/batches/{id}/transfers`, `GET /api/batches/{id}/custody`,
  `POST /api/batches/{id}/hold|release|dispose`, `POST /api/batches/{id}/recall`
  (thêm `cascade`).
- Bàn giao: `GET /api/transfers/incoming|outgoing`, `POST /api/transfers/{id}/respond`,
  `POST /api/transfers/{id}/cancel`.
- Nhận hàng: `POST /api/trace/{id}/receipt-links`, `GET|POST /api/trace/public/{id}/receipt`.
- Báo cáo: `GET /api/stats/report?workflowCode=…` thêm `statusBreakdown`, `losses`.

## Giao diện

- `/admin/catalog`: loại sản phẩm và quy cách, hàng chờ gán lô cũ, dữ liệu tham chiếu
  (đặt giá trị riêng / bỏ giá trị riêng), danh sách quy trình.
- Tạo lô: chọn loại → đơn vị theo loại → quy trình mặc định. Trường của khâu lấy từ
  schema; ô "thời điểm xảy ra" kèm lý do khi ghi muộn.
- Việc cần làm: hàng chờ xác nhận nhận, lô không đạt cần xử lý, bàn giao đang chờ.
- Chi tiết lô: tiến trình theo quy trình (khâu tuỳ chọn được đánh dấu), bàn giao, tạm
  giữ / gỡ, thu hồi lan truyền, huỷ, link nhận hàng sau xuất khẩu.
- Báo cáo: lọc theo quy trình, trạng thái lô, hao hụt so với tham chiếu có nguồn.
- Trang công khai: trạng thái thật của lô, cảnh báo khi nguyên liệu bị thu hồi.
