# TraceChain — Hệ thống Truy xuất Nguồn gốc Chuỗi Cung ứng

Hệ thống quản lý và truy xuất nguồn gốc sản phẩm trong chuỗi cung ứng, sử dụng **hash-chain ledger** (sổ cái chuỗi băm) để đảm bảo dữ liệu bất biến và có thể kiểm chứng. Cách lưu trữ, bảo mật dữ liệu và đặc tả hash: xem [docs/DATABASE.md](docs/DATABASE.md).

## Tính năng cốt lõi

- **Hash-chain bất biến, tự kiểm chứng được** — mỗi sự kiện được băm SHA-256 (JSON chuẩn hoá RFC 8785, có salt) nối với sự kiện trước; ai cũng tự tính lại được mà không cần khoá bí mật. Database tự chặn sửa/xoá sổ cái và kiểm tra liên kết khi ghi
- **Cách ly tenant bằng PostgreSQL** — row-level security + khoá ngoại theo tenant; API chạy bằng role quyền tối thiểu
- **RBAC** — 10 vai trò (Nông dân, Thương lái, Nhà chế biến, Kho, Kiểm định viên, Xuất khẩu, Phân phối, Bán lẻ, Nhập khẩu, Admin); mỗi khâu của quy trình ghi rõ vai trò nào được ghi
- **Truy xuất 2 chiều** — thuận chiều (từ nông trại → kệ hàng) và ngược chiều
- **Cảnh báo bất thường** — bỏ khâu, ghi trùng, ghi muộn, cân thiếu khi bàn giao, hao hụt chế biến ngoài khoảng tham chiếu, xung đột lợi ích khi kiểm định
- **Thu hồi lô hàng** — khoá lô, tạm giữ lô làm ra từ nó, gắn cờ điều tra lô cùng nguồn
- **Trang công khai** — người tiêu dùng quét QR, xem nguồn gốc không cần đăng nhập

## Giai đoạn 1: chuỗi nhiều bên, kiểm chứng trên blockchain

- **Gộp / tách / chế biến lô** (kiểu GS1 EPCIS) — truy ngược từ một container về từng lô đất
- **Vùng trồng có toạ độ** (PostGIS) — ranh giới hoặc điểm, xuất GeoJSON theo yêu cầu EUDR
- **Cân bằng khối lượng** — phát hiện chế biến "ra nhiều hơn vào" và lô đất khai vượt năng suất
- **Neo Merkle root lên blockchain** (hợp đồng `TraceAnchor`) — trang `/verify` tự đối chiếu với chain, không cần tin máy chủ
- **Tiết lộ chọn lọc** (hash v3) — công khai mà không lộ dữ liệu nội bộ; link kiểm chứng đầy đủ có thời hạn cho kiểm toán viên

Chi tiết: [docs/PHASE1.md](docs/PHASE1.md) · Đặc tả: [docs/SPEC_PHASE1.md](docs/SPEC_PHASE1.md)

## Giai đoạn 1.5: nghiệp vụ khớp thực tế

- **Danh mục sản phẩm hai cấp** — cà phê, lúa gạo, trái cây, chè, tiêu, cao su…; đơn vị và quy cách đóng gói quy đổi về kg
- **Quy trình mẫu theo sản phẩm** — cà phê xuất khẩu, cà phê nội địa, trái cây tươi, lúa gạo; khâu bắt buộc không bỏ qua được
- **Bàn giao hai chiều** — hàng chỉ đổi chủ khi bên nhận cân lại và xác nhận; trạng thái lô do database kiểm soát
- **Kiểm định đạt / không đạt** — lô không đạt chỉ được chế biến lại, hạ loại hoặc huỷ
- **Thời điểm xảy ra** tách khỏi thời điểm ghi (hash v4); ghi muộn phải có lý do
- **Dữ liệu tham chiếu có nguồn** (World Bank, FAO/ICO, IRRI, VICOFA), doanh nghiệp ghi đè bằng số liệu thực đo
- **Bên nhập khẩu xác nhận nhận hàng** qua link, không cần tài khoản

Đặc tả: [docs/SPEC_PHASE1_5.md](docs/SPEC_PHASE1_5.md)

## Cấu trúc dự án

```
tracechain/
├── backend/                    # API + nghiệp vụ (Node.js + TypeScript)
│   ├── src/
│   │   ├── domain/types.ts     # Domain model
│   │   ├── db/                 # Kết nối, transaction theo tenant, migrator
│   │   ├── ledger/             # Hash-chain (v3 tiết lộ chọn lọc), cây Merkle, JCS RFC 8785
│   │   ├── anchor/             # Worker neo Merkle root lên blockchain
│   │   ├── repository/         # Tầng lưu trữ PostgreSQL
│   │   ├── services/           # Business logic
│   │   └── api/                # HTTP routes + middleware
│   ├── tests/                  # Test trên PostgreSQL thật (Testcontainers)
│   └── migrations/             # SQL migration có đánh số, chạy bằng `npm run migrate`
├── frontend/                   # React 18 + Vite + Tailwind CSS
│   └── src/
│       ├── pages/              # Login, Dashboard, RecordEvent, BatchDetail, Provenance
│       ├── components/         # Timeline, LineagePanel, VerifyPanel, RecallDialog...
│       ├── lib/verify/         # Bộ xác minh chạy trên trình duyệt (hash, Merkle, đọc hợp đồng)
│       ├── context/            # AuthContext (JWT)
│       └── api/client.ts       # REST client + domain types
├── contracts/                  # Hợp đồng TraceAnchor (Solidity + Hardhat)
├── docs/                       # Tài liệu dự án, đặc tả, test vector
├── docker-compose.yml
└── .gitignore
```

## Chạy nhanh

### Cách nhanh nhất: Docker Compose

```bash
docker compose up --build
```

Lệnh này dựng PostgreSQL + PostGIS, chạy migration, một chuỗi EVM cục bộ (`anvil`, cổng 8545) cùng hợp đồng `TraceAnchor`, backend (kèm worker neo) và frontend. Mở http://localhost:5173 và đăng nhập bằng tài khoản demo bên dưới. Neo lên testnet công khai: xem [docs/PHASE1.md](docs/PHASE1.md#trien-khai-len-testnet).

### Backend chạy ngoài Docker

Cần PostgreSQL 16 có PostGIS, ví dụ chỉ bật service `postgres`: `docker compose up -d postgres`. Service này mở ra máy bạn ở cổng **55432**, không dùng 5432 để tránh đụng PostgreSQL cài sẵn trên máy; đổi được bằng biến `POSTGRES_HOST_PORT`.

```bash
cd backend
npm install
cp .env.example .env  # điền JWT_SECRET
npm run migrate       # áp dụng migration bằng role chủ schema
npm run dev           # khởi động server trên :3000 (kết nối bằng role tracechain_app)
npm test              # cần Docker (Testcontainers) hoặc đặt TEST_DATABASE_URL
```

### Frontend

```bash
cd frontend
npm install
npm run dev           # Khởi động trên :5173 (proxy đến :3000)
```

## Tài khoản demo

| Email                   | Vai trò       | Mật khẩu  |
|-------------------------|---------------|-----------|
| farmer@demo.com         | Nông dân      | demo1234  |
| farmer2@demo.com        | Nông dân      | demo1234  |
| collector@demo.com      | Thương lái    | demo1234  |
| processor@demo.com      | Nhà chế biến  | demo1234  |
| warehouse@demo.com      | Kho           | demo1234  |
| inspector@demo.com      | Kiểm định     | demo1234  |
| exporter@demo.com       | Xuất khẩu     | demo1234  |
| distributor@demo.com    | Phân phối     | demo1234  |
| retailer@demo.com       | Bán lẻ        | demo1234  |
| admin@demo.com          | Admin         | demo1234  |

## Tài liệu

- [Cơ sở dữ liệu: migration, RLS, sổ cái, đặc tả hash, vận hành](docs/DATABASE.md)
- [Đặc tả giai đoạn 1.5: danh mục, quy trình, trạng thái lô, bàn giao, hash v4](docs/SPEC_PHASE1_5.md)
- [Blueprint tổng quan](docs/README.md)
- [Kế hoạch 2 người](docs/KEHOACH_2NGUOI.md)
- [Đặc tả màn hình](docs/MANHINH_THEO_VAITRO.md)
- [Tính năng nâng cao](docs/TINHNANG_NANGCAO.md)
