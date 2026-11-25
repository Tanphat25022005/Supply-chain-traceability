import type { AppContext } from './bootstrap';
import { Actor, Batch } from './domain/types';

/**
 * Demo data that tells the platform's story (docs/SPEC_PHASE1_5.md):
 *
 *  1. Cà phê xuất khẩu — the deep case: three farm lots from mapped plots are
 *     collected (one arrives short → QUANTITY_DISCREPANCY), merged, hulled
 *     into green coffee, FAIL inspection on moisture, re-dried (REWORK),
 *     pass, are stuffed into a container, exported, and the buyer in Hamburg
 *     confirms receipt through a link.
 *  2. A recall along the lineage: green coffee found with mould is recalled;
 *     the lots split from it go ON_HOLD, the lots it came from are flagged.
 *  3. Sầu riêng — fresh fruit through a cold chain, passed on conditions.
 *  4. Lúa gạo — paddy dried and milled into rice, waiting at the distributor.
 *  5. Small cases: a late entry, a lot destroyed after failing inspection,
 *     and two legacy-workflow lots with naturally detected anomalies.
 *
 * Times are declared in the past (occurredAt) so durations and reports look
 * real; each product's back-dating limit is respected, so no LATE_ENTRY is
 * raised except where one is meant to be.
 */

const HOUR = 3600 * 1000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 24 * HOUR).toISOString().slice(0, 10);

type Find = (email: string) => Promise<Actor | null>;

export async function seedSampleBatches(ctx: AppContext, demoTenantId: string, findActorByEmail: Find): Promise<void> {
  const { supplyChainService: sc, lineageService: lineage, plotService } = ctx;
  if (await sc.tenantHasBatches(demoTenantId)) return;

  const cache = new Map<string, Actor>();
  const as = async (email: string): Promise<Actor> => {
    let a = cache.get(email);
    if (!a) {
      const found = await findActorByEmail(email);
      if (!found) throw new Error(`Sample data expects demo account ${email} to already be seeded`);
      a = found;
      cache.set(email, a);
    }
    return a;
  };
  const accept = async (lot: Batch | string, email: string, hoursAgo: number, receivedQuantity?: number) => {
    const receiver = await as(email);
    const id = typeof lot === 'string' ? lot : lot.id;
    const t = (await sc.listIncomingTransfers(receiver)).find((x) => x.batchId === id);
    if (!t) throw new Error(`No hand-over of ${id} waiting for ${email}`);
    await sc.respondTransfer(receiver, t.id, { accept: true, receivedQuantity: receivedQuantity ?? t.quantity, occurredAt: ago(hoursAgo) });
  };
  const record = async (email: string, lot: Batch, stage: string, hoursAgo: number, location: string, data: Record<string, string | number | boolean> = {}, assignTo?: string, notes?: string) => {
    await sc.recordEvent(await as(email), {
      batchId: lot.id,
      stage,
      location,
      data,
      notes,
      occurredAt: ago(hoursAgo),
      assignNextTo: assignTo ? (await as(assignTo)).id : undefined,
    });
  };

  const farmer = await as('farmer@demo.com');
  const farmer2 = await as('farmer2@demo.com');

  // ── Plots (EUDR geolocation) ──
  const plot = async (owner: Actor, code: string, name: string, lng: number, lat: number, areaHa: number) =>
    plotService.create(owner, { code, name, geometry: { type: 'Point', coordinates: [lng, lat] }, declaredAreaHa: areaHa });
  const cd01 = await plot(farmer, 'CD-01', 'Vườn Cầu Đất 1', 108.5571, 11.8786, 1.8);
  const cd02 = await plot(farmer, 'CD-02', 'Vườn Cầu Đất 2', 108.5612, 11.8742, 1.6);
  const ld01 = await plot(farmer2, 'LD-01', "Vườn K'Bông – Lạc Dương", 108.4398, 12.0012, 1.2);
  const ld02 = await plot(farmer2, 'LD-02', "Vườn K'Bông – Đạ Sar", 108.4721, 12.0298, 1.4);

  // ── 1. Cà phê xuất khẩu ──
  const cherry = async (owner: Actor, plotId: string, name: string, origin: string, kg: number, hoursAgo: number, cultivar: string) => {
    const lot = await sc.createBatch(owner, { productName: name, productType: 'Cà phê quả tươi', origin, quantity: kg, unit: 'kg', plotId });
    await record(owner.email, lot, 'HARVEST', hoursAgo, origin, { variety: 'ARABICA', cultivar, cultivation: 'VIETGAP', ripeRate: 92 }, 'collector@demo.com');
    return lot;
  };
  const a = await cherry(farmer, cd01.id, 'Cà phê quả tươi CD-01', 'Cầu Đất, Đà Lạt, Lâm Đồng', 1200, 70, 'Catimor');
  const b = await cherry(farmer2, ld01.id, 'Cà phê quả tươi LD-01', 'Lạc Dương, Lâm Đồng', 900, 69, 'Typica');
  const c = await cherry(farmer, cd02.id, 'Cà phê quả tươi CD-02', 'Cầu Đất, Đà Lạt, Lâm Đồng', 1000, 68, 'Catimor');
  await accept(a, 'collector@demo.com', 66, 1188); // 1% lighter: within the 2% allowed for fresh cherry
  await accept(b, 'collector@demo.com', 65);
  await accept(c, 'collector@demo.com', 64, 970); // 3% short → QUANTITY_DISCREPANCY

  const collector = await as('collector@demo.com');
  const merged = (
    await lineage.createTransformation(collector, {
      kind: 'MERGE',
      stage: 'COLLECTION',
      location: 'Đại lý thu mua Cầu Đất',
      data: { collectionPoint: 'Đại lý Cầu Đất, Xuân Trường', moisture: 62, purchasePrice: 26000 },
      inputs: [
        { lotId: a.id, quantity: 1188 },
        { lotId: b.id, quantity: 900 },
        { lotId: c.id, quantity: 970 },
      ],
      outputs: [{ productName: 'Cà phê quả tươi gộp Cầu Đất', productType: 'Cà phê quả tươi', quantity: 3058, unit: 'kg' }],
      assignNextTo: (await as('processor@demo.com')).id,
      occurredAt: ago(60),
    })
  ).outputs[0];
  await accept(merged, 'processor@demo.com', 56);

  const processor = await as('processor@demo.com');
  const green = (
    await lineage.createTransformation(processor, {
      kind: 'TRANSFORM',
      stage: 'PROCESSING',
      location: 'Xưởng chế biến An Giang',
      notes: 'Phơi khô trên giàn 18 ngày rồi xát vỏ',
      data: { method: 'DRY', moisture: 13.8 },
      inputs: [{ lotId: merged.id, quantity: 3058 }],
      outputs: [{ productName: 'Cà phê nhân xanh Arabica Cầu Đất', productType: 'Cà phê nhân xanh', quantity: 610, unit: 'kg' }],
      occurredAt: ago(40),
    })
  ).outputs[0];
  await record('processor@demo.com', green, 'WAREHOUSING', 39, 'Kho xưởng An Giang', { warehouseName: 'Kho xưởng An Giang', storageLocation: 'Dãy B-04', moisture: 13.6 }, 'inspector@demo.com');
  await accept(green, 'inspector@demo.com', 37);
  // FAIL: moisture above the 12.5% allowed for export green coffee → REJECTED, back to the mill.
  await record('inspector@demo.com', green, 'QUALITY_CHECK', 36, 'Trung tâm kiểm định VN', {
    result: 'FAIL',
    moisture: 14.5,
    defectRate: 4.1,
    standard: 'TCVN 4193:2014',
    certificateNo: 'KĐ-2026-1006',
  }, 'processor@demo.com', 'Độ ẩm 14,5% vượt mức 12,5% cho cà phê nhân xuất khẩu');
  await accept(green, 'processor@demo.com', 34);

  const redried = (
    await lineage.createTransformation(processor, {
      kind: 'REWORK',
      stage: 'PROCESSING',
      location: 'Xưởng chế biến An Giang',
      notes: 'Sấy lại 6 giờ ở 45°C',
      data: { method: 'REDRY', moisture: 12.3 },
      inputs: [{ lotId: green.id, quantity: 610 }],
      outputs: [{ productName: 'Cà phê nhân xanh Arabica Cầu Đất (sấy lại)', productType: 'Cà phê nhân xanh', quantity: 596, unit: 'kg' }],
      occurredAt: ago(30),
    })
  ).outputs[0];
  await record('processor@demo.com', redried, 'WAREHOUSING', 29, 'Kho xưởng An Giang', { warehouseName: 'Kho xưởng An Giang', storageLocation: 'Dãy B-05', moisture: 12.3 }, 'inspector@demo.com');
  await accept(redried, 'inspector@demo.com', 28);
  await record('inspector@demo.com', redried, 'QUALITY_CHECK', 26, 'Trung tâm kiểm định VN', {
    result: 'PASS',
    grade: 'G1',
    screenSize: 'S16',
    moisture: 12.3,
    defectRate: 3.2,
    foreignMatter: 0.4,
    standard: 'TCVN 4193:2014',
    certificateNo: 'KĐ-2026-1008',
  }, 'exporter@demo.com');
  await accept(redried, 'exporter@demo.com', 24);
  await record('exporter@demo.com', redried, 'CONTAINER_STUFFING', 20, 'Cảng Cát Lái, TP.HCM', {
    containerNo: 'MSKU1234567',
    sealNo: 'VN-778812',
    bagCount: 10,
  });
  await record('exporter@demo.com', redried, 'EXPORT', 12, 'Cảng Cát Lái, TP.HCM', {
    customsDeclarationNo: '305123456789',
    containerNo: 'MSKU1234567',
    sealNo: 'VN-778812',
    billOfLading: 'MAEU-2610-55821',
    phytoCertNo: 'KDTV-2026-11872',
    certificateOfOrigin: 'VN-DE-26-0042183',
    coForm: 'EUR1',
    icoMark: '145/0123/0456',
    portOfLoading: 'Cát Lái, TP.HCM',
    portOfDischarge: 'Hamburg, Đức',
    importerName: 'Hamburg Coffee Imports GmbH',
  });
  const exporter = await as('exporter@demo.com');
  const link = await sc.createReceiptLink(exporter, redried.id, 'Hamburg Coffee Imports GmbH', 30);
  await sc.recordImportReceipt(redried.id, link.token, { receivedQuantity: 596, condition: 'GOOD', location: 'Cảng Hamburg, Đức' });

  // ── 2. Recall along the lineage ──
  const d = await sc.createBatch(farmer2, { productName: 'Cà phê quả tươi LD-02', productType: 'Cà phê quả tươi', origin: 'Đạ Sar, Lạc Dương', quantity: 800, unit: 'kg', plotId: ld02.id });
  await record('farmer2@demo.com', d, 'HARVEST', 50, 'Đạ Sar, Lạc Dương', { variety: 'ARABICA', cultivation: 'CONVENTIONAL' }, 'processor@demo.com');
  await accept(d, 'processor@demo.com', 48);
  const e = await sc.createBatch(farmer, { productName: 'Cà phê quả tươi CD-01 (đợt 2)', productType: 'Cà phê quả tươi', origin: 'Cầu Đất, Đà Lạt, Lâm Đồng', quantity: 700, unit: 'kg', plotId: cd01.id });
  await record('farmer@demo.com', e, 'HARVEST', 49, 'Cầu Đất, Đà Lạt, Lâm Đồng', { variety: 'ARABICA', cultivation: 'VIETGAP' }, 'processor@demo.com');
  await accept(e, 'processor@demo.com', 47);
  const lacDuong = (
    await lineage.createTransformation(processor, {
      kind: 'MERGE',
      stage: 'PROCESSING',
      location: 'Xưởng chế biến An Giang',
      data: { method: 'WET' },
      inputs: [
        { lotId: d.id, quantity: 800 },
        { lotId: e.id, quantity: 700 },
      ],
      outputs: [{ productName: 'Cà phê quả tươi gộp Lạc Dương', productType: 'Cà phê quả tươi', quantity: 1500, unit: 'kg' }],
      occurredAt: ago(45),
    })
  ).outputs[0];
  const greenLD = (
    await lineage.createTransformation(processor, {
      kind: 'TRANSFORM',
      stage: 'PROCESSING',
      location: 'Xưởng chế biến An Giang',
      data: { method: 'WET', moisture: 12.4, fermentationHours: 36 },
      inputs: [{ lotId: lacDuong.id, quantity: 1500 }],
      outputs: [{ productName: 'Cà phê nhân xanh Lạc Dương', productType: 'Cà phê nhân xanh', quantity: 300, unit: 'kg' }],
      occurredAt: ago(44),
    })
  ).outputs[0];
  await lineage.createTransformation(processor, {
    kind: 'SPLIT',
    stage: 'PROCESSING',
    location: 'Xưởng chế biến An Giang',
    data: { method: 'SORTING' },
    inputs: [{ lotId: greenLD.id, quantity: 300 }],
    outputs: [
      { productName: 'Nhân xanh Lạc Dương – lô A', productType: 'Cà phê nhân xanh', quantity: 150, unit: 'kg' },
      { productName: 'Nhân xanh Lạc Dương – lô B', productType: 'Cà phê nhân xanh', quantity: 150, unit: 'kg' },
    ],
    occurredAt: ago(43),
  });
  await sc.recall(await as('inspector@demo.com'), greenLD.id, {
    reason: 'Mẫu lưu phát hiện độc tố nấm mốc Ochratoxin A vượt ngưỡng',
    cascade: false,
  });

  // ── 3. Sầu riêng: fresh fruit, cold chain, passed on conditions ──
  const durian = await sc.createBatch(farmer, { productName: 'Sầu riêng Ri6', productType: 'Sầu riêng', origin: 'Krông Pắc, Đắk Lắk', quantity: 600, unit: 'kg' });
  await record('farmer@demo.com', durian, 'HARVEST', 40, 'Krông Pắc, Đắk Lắk', { variety: 'Ri6', cultivation: 'GLOBALGAP' }, 'processor@demo.com');
  await accept(durian, 'processor@demo.com', 38);
  await record('processor@demo.com', durian, 'PACKAGING', 36, 'Cơ sở đóng gói Krông Pắc', { packageType: 'CARTON', packageCount: 40, packingHouseCode: 'VN-DL-PH-0123', expiryDate: day(10) }, 'inspector@demo.com');
  await accept(durian, 'inspector@demo.com', 35);
  await record('inspector@demo.com', durian, 'QUALITY_CHECK', 34, 'Trung tâm kiểm định VN', {
    result: 'PASS_WITH_CONDITIONS',
    conditions: 'Bảo quản 12–14°C, bán trong 5 ngày',
    conditionDueDate: day(5),
    pesticideResidue: 'PASS',
    brix: 30,
    size: 'Loại 1 (3–5 kg/quả)',
    certificateNo: 'KĐ-2026-1011',
  }, 'distributor@demo.com');
  await accept(durian, 'distributor@demo.com', 33);
  await record('distributor@demo.com', durian, 'COLD_CHAIN', 30, 'Kho lạnh Thủ Đức', { destination: 'Siêu thị XYZ, Quận 1', vehicle: '51C-123.45', temperature: 13 }, 'retailer@demo.com');
  await accept(durian, 'retailer@demo.com', 26, 594);
  await record('retailer@demo.com', durian, 'RETAIL', 24, 'Siêu thị XYZ, Quận 1', { storeName: 'Siêu thị XYZ Quận 1' });

  // ── 4. Lúa gạo: paddy → rice, waiting at the distributor ──
  const paddy = await sc.createBatch(farmer, { productName: 'Lúa ST25 Sóc Trăng', productType: 'Lúa (thóc)', origin: 'Mỹ Xuyên, Sóc Trăng', quantity: 5000, unit: 'kg' });
  await record('farmer@demo.com', paddy, 'HARVEST', 100, 'Mỹ Xuyên, Sóc Trăng', { variety: 'ST25', season: 'HE_THU', cultivation: 'VIETGAP' }, 'processor@demo.com');
  await accept(paddy, 'processor@demo.com', 96);
  await record('processor@demo.com', paddy, 'DRYING', 90, 'Lò sấy Mỹ Xuyên', { method: 'MACHINE', moisture: 14 });
  const rice = (
    await lineage.createTransformation(processor, {
      kind: 'TRANSFORM',
      stage: 'MILLING',
      location: 'Nhà máy xay xát Mỹ Xuyên',
      data: { millType: 'Máy xát trắng 2 lượt', brokenRate: 8 },
      inputs: [{ lotId: paddy.id, quantity: 5000 }],
      outputs: [{ productName: 'Gạo ST25', productType: 'Gạo', quantity: 3300, unit: 'kg' }],
      assignNextTo: (await as('inspector@demo.com')).id,
      occurredAt: ago(80),
    })
  ).outputs[0];
  await accept(rice, 'inspector@demo.com', 75);
  await record('inspector@demo.com', rice, 'QUALITY_CHECK', 70, 'Trung tâm kiểm định VN', { result: 'PASS', moisture: 13.5, brokenRate: 8, grade: 'Gạo thơm loại 1', certificateNo: 'KĐ-2026-0998' }, 'processor@demo.com');
  await accept(rice, 'processor@demo.com', 68);
  // Handed to the distributor, who hasn't confirmed yet — it shows in their task list.
  await record('processor@demo.com', rice, 'PACKAGING', 60, 'Nhà máy xay xát Mỹ Xuyên', { packageType: 'BAG_50KG', packageCount: 66, expiryDate: day(365) }, 'distributor@demo.com');

  // ── 5. Small cases ──
  // Recorded four days late (the limit for fresh tea is two) — LATE_ENTRY, with the reason.
  const tea = await sc.createBatch(farmer, { productName: 'Chè búp tươi Tân Cương', productType: 'Chè búp tươi', origin: 'Tân Cương, Thái Nguyên', quantity: 150, unit: 'kg' });
  await sc.recordEvent(farmer, {
    batchId: tea.id,
    stage: 'HARVEST',
    location: 'Tân Cương, Thái Nguyên',
    data: { variety: 'Trung du lá nhỏ', cultivation: 'VIETGAP' },
    occurredAt: ago(96),
    lateReason: 'Mất sóng điện thoại trên đồi chè, ghi bù khi về xưởng',
    assignNextTo: processor.id,
  });

  // Failed inspection, then destroyed with a record.
  const admin = await as('admin@demo.com');
  const inspector = await as('inspector@demo.com');
  const pepper = await sc.createBatch(farmer, { productName: 'Hồ tiêu Phú Quốc', productType: 'Hồ tiêu', origin: 'Phú Quốc, Kiên Giang', quantity: 100, unit: 'kg' });
  await record('farmer@demo.com', pepper, 'HARVEST', 120, 'Phú Quốc, Kiên Giang', { variety: 'Tiêu Phú Quốc' }, 'processor@demo.com');
  await accept(pepper, 'processor@demo.com', 118);
  await record('processor@demo.com', pepper, 'PROCESSING', 110, 'Xưởng chế biến An Giang', { method: 'DRYING', moisture: 12 }, 'inspector@demo.com');
  await accept(pepper, 'inspector@demo.com', 100);
  await record('inspector@demo.com', pepper, 'QUALITY_CHECK', 98, 'Trung tâm kiểm định VN', { result: 'FAIL', certificateNo: 'KĐ-2026-0990' }, undefined, 'Dư lượng thuốc bảo vệ thực vật vượt ngưỡng cho phép');
  await sc.disposeBatch(inspector, pepper.id, {
    recordNo: 'BB-HUY-2026-031',
    method: 'Tiêu huỷ tại lò đốt chất thải nông nghiệp',
    witness: 'Đại diện Chi cục Quản lý chất lượng Nông Lâm Thủy sản',
    reason: 'Dư lượng thuốc BVTV vượt ngưỡng',
    occurredAt: ago(90),
  });

  // Legacy workflow (no required steps) — anomalies detected from the record itself.
  const orange = await sc.createBatch(admin, { productName: 'Cam sành', productType: 'Trái cây tươi', origin: 'Bắc Quang, Hà Giang', quantity: 350, unit: 'kg', workflowCode: 'GENERIC_RETAIL' });
  await sc.recordEvent(admin, { batchId: orange.id, stage: 'HARVEST', location: 'Bắc Quang, Hà Giang', occurredAt: ago(30) });
  // Skips PROCESSING and the inspection → STAGE_SKIPPED (HIGH: inspection skipped).
  await sc.recordEvent(admin, { batchId: orange.id, stage: 'PACKAGING', location: 'Xưởng chế biến An Giang', data: { packageType: 'CARTON', packageCount: 35 }, occurredAt: ago(20) });
  const coconut = await sc.createBatch(admin, { productName: 'Dừa xiêm', productType: 'Trái cây tươi', origin: 'Bến Tre', quantity: 800, unit: 'kg', workflowCode: 'GENERIC_RETAIL' });
  await sc.recordEvent(admin, { batchId: coconut.id, stage: 'HARVEST', location: 'Bến Tre', occurredAt: ago(30) });
  // Recorded twice by mistake → DUPLICATE_STAGE.
  await sc.recordEvent(admin, { batchId: coconut.id, stage: 'HARVEST', location: 'Bến Tre', occurredAt: ago(29) });
}
