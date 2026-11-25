import { validateEventData } from '../src/domain/fieldSchema';
import { genericRetailRules } from '../src/domain/workflow';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/errors';
import { acceptHandOver, asAttacker, coffeeCherry, createActor, createTenant, sampleBatch, STAGE_DATA, step, TestDb, useTestDatabase } from './helpers/testDb';

/** docs/SPEC_PHASE1_5.md §1–§4 — catalog, field schemas, reference data, workflow templates. */
const getDb = useTestDatabase();

async function people(t: TestDb) {
  const tenant = await createTenant(t);
  const farmer = await createActor(t, tenant, 'FARMER');
  const collector = await createActor(t, tenant, 'COLLECTOR');
  const processor = await createActor(t, tenant, 'PROCESSOR');
  const warehouse = await createActor(t, tenant, 'WAREHOUSE');
  const inspector = await createActor(t, tenant, 'INSPECTOR');
  const exporter = await createActor(t, tenant, 'EXPORTER');
  const retailer = await createActor(t, tenant, 'RETAILER');
  const admin = await createActor(t, tenant, 'ADMIN');
  return { tenant, farmer, collector, processor, warehouse, inspector, exporter, retailer, admin, svc: t.ctx.supplyChainService };
}

describe('product catalog and units (§1)', () => {
  it('resolves names, codes and aliases; refuses what the catalog does not know; converts units to kg', async () => {
    const t = getDb();
    const p = await people(t);
    const green = await p.svc.createBatch(p.farmer, { ...sampleBatch, productType: '  cà phê NHÂN xanh ', quantity: 20, unit: 'bao' });
    expect(green).toMatchObject({ productType: 'Cà phê nhân xanh', unit: 'bao', unitFactor: 60, quantityBase: 1200, baseUnit: 'kg' });
    const byCode = await p.svc.createBatch(p.farmer, { ...sampleBatch, productType: 'RICE_MILLED', quantity: 2, unit: 'tấn' });
    expect(byCode).toMatchObject({ productType: 'Gạo', quantityBase: 2000 });
    const byAlias = await p.svc.createBatch(p.farmer, { ...sampleBatch, productType: 'Lúa gạo', quantity: 3, unit: 'bao' });
    expect(byAlias).toMatchObject({ productType: 'Gạo', quantityBase: 150 }); // rice bags are 50 kg

    await expect(p.svc.createBatch(p.farmer, { ...sampleBatch, productType: 'Cà phê chồn' })).rejects.toThrow(ValidationError);
    // "bao" means 60 kg of green coffee, but fresh cherry has no bag convention.
    await expect(p.svc.createBatch(p.farmer, { ...coffeeCherry, unit: 'bao' })).rejects.toThrow(/Unit "bao" is not valid/);
  });

  it('a tenant adds its own product types and units — invisible to other tenants, unable to shadow platform ones', async () => {
    const t = getDb();
    const p = await people(t);
    const catalog = t.ctx.catalogService;
    await expect(catalog.createProductType(p.farmer, { categoryCode: 'FRUIT', code: 'X', name: 'X', baseUnit: 'kg' })).rejects.toThrow(ForbiddenError);
    await expect(
      catalog.createProductType(p.admin, { categoryCode: 'FRUIT', code: 'DURIAN2', name: 'sầu riêng', baseUnit: 'kg' }),
    ).rejects.toThrow(/already exists/);
    const mango = await catalog.createProductType(p.admin, {
      categoryCode: 'FRUIT',
      code: 'mango_hoa_loc',
      name: 'Xoài cát Hòa Lộc',
      baseUnit: 'kg',
      defaultWorkflowCode: 'FRESH_FRUIT',
      aliases: ['Xoài Hòa Lộc'],
    });
    expect(mango).toMatchObject({ tenantId: p.tenant.id, code: 'MANGO_HOA_LOC' });
    await expect(
      catalog.createProductType(p.admin, { categoryCode: 'FRUIT', code: 'M2', name: 'M2', baseUnit: 'kg', defaultWorkflowCode: 'RICE' }),
    ).rejects.toThrow(/another product group/);
    const crate = await catalog.createUnit(p.admin, { productTypeId: mango.id, code: 'sọt', label: 'Sọt 25 kg', factor: 25 });
    expect(crate.factor).toBe(25);

    const lot = await p.svc.createBatch(p.farmer, { ...sampleBatch, productType: 'Xoài Hòa Lộc', quantity: 4, unit: 'sọt' });
    expect(lot).toMatchObject({ productTypeId: mango.id, quantityBase: 100 });
    const rules = await t.ctx.catalogService.tenantCatalog(p.farmer);
    expect(rules.productTypes.some((x) => x.id === mango.id)).toBe(true);

    const outsider = await createActor(t, await createTenant(t), 'ADMIN');
    const theirs = await t.ctx.catalogService.tenantCatalog(outsider);
    expect(theirs.productTypes.some((x) => x.id === mango.id)).toBe(false);
    await expect(t.ctx.supplyChainService.createBatch(outsider, { ...sampleBatch, productTypeId: mango.id })).rejects.toThrow(ValidationError);
    // The public catalog has only platform rows.
    expect((await t.ctx.catalogService.publicCatalog()).productTypes.every((x) => x.tenantId === null)).toBe(true);
  });

  it('old lots wait in the mapping queue until an admin says what they are', async () => {
    const t = getDb();
    const p = await people(t);
    const workflow = "(SELECT id FROM workflow_templates WHERE code = 'GENERIC_RETAIL')";
    await asAttacker(
      t,
      `INSERT INTO batches (id, product_name, product_type, origin, quantity, unit, created_by, tenant_id, workflow_id)
       VALUES (gen_random_uuid(), 'Cũ 1', 'Hàng tự gõ', 'x', 4, 'thùng', $1, $2, ${workflow}),
              (gen_random_uuid(), 'Cũ 2', 'Hàng tự gõ', 'x', 6, 'thùng', $1, $2, ${workflow})`,
      [p.farmer.id, p.tenant.id],
    );
    expect(await t.ctx.catalogService.unmapped(p.admin)).toEqual([{ productType: 'Hàng tự gõ', unit: 'thùng', batchCount: 2, productTypeId: undefined }]);
    const fruit = (await t.ctx.catalogService.publicCatalog()).productTypes.find((x) => x.code === 'FRUIT_FRESH')!;
    // "thùng" is 10 kg for fresh fruit in the catalog; for something else an explicit factor is required.
    const rice = (await t.ctx.catalogService.publicCatalog()).productTypes.find((x) => x.code === 'RICE_PADDY')!;
    await expect(
      t.ctx.catalogService.mapUnmapped(p.admin, { productType: 'Hàng tự gõ', unit: 'thùng', productTypeId: rice.id }),
    ).rejects.toThrow(/unitFactor is required/);
    const { mapped } = await t.ctx.catalogService.mapUnmapped(p.admin, { productType: 'Hàng tự gõ', unit: 'thùng', productTypeId: fruit.id });
    expect(mapped).toBe(2);
    expect(await t.ctx.catalogService.unmapped(p.admin)).toEqual([]);
    const { items } = await p.svc.listBatchesPage(p.admin, { page: 1, pageSize: 10 });
    expect(items.map((b) => [b.productType, b.quantityBase]).sort()).toEqual([
      ['Trái cây tươi', 40],
      ['Trái cây tươi', 60],
    ]);
    // Set once: the mapping can't be redone behind the catalog's back.
    await expect(
      t.db.withTenant(p.tenant.id, () => t.db.query('UPDATE batches SET unit_factor = 1 WHERE tenant_id = $1', [p.tenant.id])),
    ).rejects.toThrow(/cannot change once set/);
  });
});

describe('field schemas checked by the server (§2)', () => {
  it('validates required, conditional, typed and unknown fields', () => {
    const schema = {
      id: 1,
      categoryCode: null,
      stage: 'QUALITY_CHECK',
      version: 1,
      fields: [
        { key: 'result', label: 'Kết quả', type: 'select' as const, required: true, options: [{ value: 'PASS', label: 'Đạt' }, { value: 'PASS_WITH_CONDITIONS', label: 'x' }] },
        { key: 'conditions', label: 'Điều kiện', type: 'text' as const, requiredWhen: { key: 'result', in: ['PASS_WITH_CONDITIONS'] } },
        { key: 'moisture', label: 'Độ ẩm', type: 'number' as const, min: 0, max: 100 },
        { key: 'due', label: 'Hạn', type: 'date' as const },
      ],
    };
    expect(validateEventData(schema, { result: 'PASS' })).toEqual([]);
    const codes = (data: Record<string, unknown>) => validateEventData(schema, data).map((i) => `${i.field}:${i.code}`);
    expect(codes({})).toEqual(['result:required']);
    expect(codes({ result: 'MAYBE' })).toEqual(['result:invalid_option']);
    expect(codes({ result: 'PASS_WITH_CONDITIONS' })).toEqual(['conditions:required']);
    expect(codes({ result: 'PASS', moisture: 140, due: '31/12/2026', secret: 1 })).toEqual([
      'secret:unknown_field',
      'moisture:above_max',
      'due:not_a_date',
    ]);
  });

  it('each event records the schema version it was validated against; product groups get their own fields', async () => {
    const t = getDb();
    const p = await people(t);
    const coffee = await p.svc.createBatch(p.farmer, coffeeCherry);
    // Coffee HARVEST: variety is a required select.
    await expect(
      p.svc.recordEvent(p.farmer, { batchId: coffee.id, stage: 'HARVEST', location: 'x', data: { variety: 'Robusta TR4' }, assignNextTo: p.collector.id }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ field: 'variety', code: 'invalid_option' })] });
    const e = await p.svc.recordEvent(p.farmer, { batchId: coffee.id, stage: 'HARVEST', location: 'x', data: { variety: 'ROBUSTA', cultivar: 'TR4' }, assignNextTo: p.collector.id });
    const catalog = await t.ctx.catalogService.publicCatalog();
    const schema = catalog.fieldSchemas.find((s) => s.id === e.fieldSchemaId)!;
    expect(schema).toMatchObject({ categoryCode: 'COFFEE', stage: 'HARVEST', version: 1 });
  });
});

describe('reference data with sources and tenant overrides (§3)', () => {
  it("a tenant's override wins for its own lots only, is audited, and can be dropped", async () => {
    const t = getDb();
    const p = await people(t);
    const cat = await t.ctx.catalogService.publicCatalog();
    const id = (code: string) => cat.productTypes.find((x) => x.code === code)!.id;
    const before = await t.ctx.catalogService.referenceData(p.admin);
    const platform = before.conversionFactors.find((c) => c.fromTypeId === id('COFFEE_CHERRY') && c.toTypeId === id('COFFEE_GREEN'))!;
    expect(platform).toMatchObject({ tenantId: null, min: 0.15, max: 0.23, source: expect.stringMatching(/World Bank/) });

    await expect(
      t.ctx.catalogService.setConversionFactor(p.admin, { fromTypeId: id('COFFEE_CHERRY'), toTypeId: id('COFFEE_GREEN'), min: 0.3, max: 0.2, source: 'x x x' }),
    ).rejects.toThrow(ValidationError);
    const after = await t.ctx.catalogService.setConversionFactor(p.admin, {
      fromTypeId: id('COFFEE_CHERRY'),
      toTypeId: id('COFFEE_GREEN'),
      min: 0.17,
      max: 0.21,
      source: 'Đo thực tế 3 vụ tại nhà máy B',
    });
    const override = after.conversionFactors.find((c) => c.tenantId === p.tenant.id)!;
    expect(override).toMatchObject({ min: 0.17, max: 0.21, updatedBy: p.admin.id });

    // Their transform at 0.22 is now out of range; another tenant's isn't.
    const yieldOf = async (actor: typeof p.processor, farmer: typeof p.farmer) => {
      const lot = await t.ctx.supplyChainService.createBatch(farmer, coffeeCherry);
      await step(t, farmer, lot.id, 'HARVEST', { data: { variety: 'ROBUSTA' }, assignNextTo: actor });
      return t.ctx.lineageService.createTransformation(actor, {
        kind: 'TRANSFORM',
        stage: 'PROCESSING',
        location: 'x',
        data: { method: 'DRY' },
        inputs: [{ lotId: lot.id, quantity: 1000 }],
        outputs: [{ productName: 'N', productType: 'Cà phê nhân xanh', quantity: 220, unit: 'kg' }],
      });
    };
    expect((await yieldOf(p.processor, p.farmer)).anomalies[0].message).toMatch(/Đo thực tế 3 vụ/);
    const other = await createTenant(t);
    const r2 = await yieldOf(await createActor(t, other, 'PROCESSOR'), await createActor(t, other, 'FARMER'));
    expect(r2.anomalies).toHaveLength(0);

    const { items } = await t.ctx.adminService.listAuditLogs(p.admin, 1, 50);
    expect(items.some((x) => x.action === 'REFERENCE_DATA_CHANGED')).toBe(true);
    const dropped = await t.ctx.catalogService.deleteOverride(p.admin, 'conversion_factors', override.id);
    expect(dropped.conversionFactors.some((c) => c.tenantId === p.tenant.id)).toBe(false);
    await expect(t.ctx.catalogService.deleteOverride(p.admin, 'conversion_factors', platform.id)).rejects.toThrow(NotFoundError);
    // Nor can the app role touch platform values directly.
    const res = await t.db.withTenant(p.tenant.id, () => t.db.query('UPDATE conversion_factors SET max_ratio = 9 WHERE tenant_id IS NULL'));
    expect(res.rowCount).toBe(0);
  });

  it('yield caps pick the most specific region', async () => {
    const t = getDb();
    const p = await people(t);
    const plot = async (code: string, lng: number) =>
      t.ctx.plotService.create(p.farmer, { code, name: code, geometry: { type: 'Point', coordinates: [lng, 21.3] }, declaredAreaHa: 1 });
    const sonLa = await plot('SL-1', 103.9);
    const tayNguyen = await plot('TN-1', 104.2);
    const green = (plotId: string, origin: string, kg: number) =>
      t.ctx.supplyChainService.createBatch(p.farmer, { ...sampleBatch, productType: 'Cà phê nhân xanh', origin, quantity: kg, plotId });
    // 5 t on 1 ha: fine under the national 6 t cap, over the 4 t Sơn La cap.
    const a = await green(sonLa.id, 'Mai Sơn, Sơn La', 5000);
    const b = await green(tayNguyen.id, 'Krông Năng, Đắk Lắk', 5000);
    expect((await t.ctx.traceService.trace(a.id, 'forward', p.admin)).anomalies).toEqual([
      expect.objectContaining({ type: 'MASS_BALANCE_VIOLATION', message: expect.stringMatching(/4\.000 kg\/ha/) }),
    ]);
    expect((await t.ctx.traceService.trace(b.id, 'forward', p.admin)).anomalies).toHaveLength(0);
  });
});

describe('workflow templates (§4)', () => {
  it('a required step cannot be skipped — not even by an admin; an optional one only raises a LOW alert', async () => {
    const t = getDb();
    const p = await people(t);
    const lot = await p.svc.createBatch(p.farmer, coffeeCherry);
    await step(t, p.farmer, lot.id, 'HARVEST', { data: { variety: 'ROBUSTA' }, assignNextTo: p.processor });
    await expect(p.svc.recordEvent(p.admin, { batchId: lot.id, stage: 'QUALITY_CHECK', location: 'x', data: { result: 'PASS', moisture: 12 } })).rejects.toThrow(
      /Required stage PROCESSING must be recorded before QUALITY_CHECK/,
    );
    // COLLECTION is optional: straight to the mill is allowed, noted LOW.
    await step(t, p.processor, lot.id, 'PROCESSING', { data: { method: 'DRY' }, assignNextTo: p.inspector });
    const found = (await t.ctx.traceService.trace(lot.id, 'forward', p.admin)).anomalies;
    expect(found).toEqual([expect.objectContaining({ type: 'STAGE_SKIPPED', severity: 'LOW' })]);
  });

  it('roles come from the step: the collector collects, the warehouse stores, the exporter stuffs and exports', async () => {
    const t = getDb();
    const p = await people(t);
    const lot = await p.svc.createBatch(p.farmer, coffeeCherry);
    await step(t, p.farmer, lot.id, 'HARVEST', { data: { variety: 'ROBUSTA' }, assignNextTo: p.collector });
    await expect(p.svc.recordEvent(p.collector, { batchId: lot.id, stage: 'PROCESSING', location: 'x', data: { method: 'DRY' } })).rejects.toThrow(
      /not permitted to record stage PROCESSING/,
    );
    await step(t, p.collector, lot.id, 'COLLECTION', { assignNextTo: p.processor });
    await step(t, p.processor, lot.id, 'PROCESSING', { data: { method: 'DRY' }, assignNextTo: p.warehouse });
    await step(t, p.warehouse, lot.id, 'WAREHOUSING', { assignNextTo: p.inspector });
    await step(t, p.inspector, lot.id, 'QUALITY_CHECK', { data: { result: 'PASS', moisture: 12 }, assignNextTo: p.exporter });
    await step(t, p.exporter, lot.id, 'CONTAINER_STUFFING'); // keeps it: the exporter also does the next step
    await step(t, p.exporter, lot.id, 'EXPORT');
    expect(await p.svc.getBatch(p.admin, lot.id)).toMatchObject({ currentStage: 'EXPORT', assignedToActorId: p.exporter.id, status: 'ACTIVE' });
    // A stage from another workflow is refused, by the service and by the database.
    await expect(p.svc.recordEvent(p.admin, { batchId: lot.id, stage: 'RETAIL', location: 'x', data: STAGE_DATA.RETAIL })).rejects.toThrow(
      /not part of this lot's workflow/,
    );
  });

  it('the lot pins its template; a template for another product group is refused', async () => {
    const t = getDb();
    const p = await people(t);
    await expect(p.svc.createBatch(p.farmer, { ...coffeeCherry, workflowCode: 'RICE' })).rejects.toThrow(/not for Cà phê quả tươi/);
    const domestic = await p.svc.createBatch(p.farmer, { ...coffeeCherry, workflowCode: 'COFFEE_DOMESTIC' });
    const rules = await t.ctx.catalogService.publicCatalog();
    expect(rules.workflows.find((w) => w.id === domestic.workflowId)).toMatchObject({ code: 'COFFEE_DOMESTIC', version: 1 });
    await expect(
      t.db.withTenant(p.tenant.id, () =>
        t.db.query("UPDATE batches SET workflow_id = (SELECT id FROM workflow_templates WHERE code = 'RICE') WHERE id = $1", [domestic.id]),
      ),
    ).rejects.toThrow();
    // Only the first step's roles start a lot.
    await expect(p.svc.createBatch(p.retailer, coffeeCherry)).rejects.toThrow(ForbiddenError);
  });

  it('the legacy rules still read like the original six stages', () => {
    const rules = genericRetailRules();
    expect(rules.steps.map((s) => s.stage)).toEqual(['HARVEST', 'PROCESSING', 'QUALITY_CHECK', 'PACKAGING', 'DISTRIBUTION', 'RETAIL']);
    expect(rules.isFinal('RETAIL')).toBe(true);
    expect([...rules.rolesForNext(1)].sort()).toEqual(['DISTRIBUTOR', 'INSPECTOR', 'PROCESSOR', 'RETAILER']);
  });
});

describe('the foreign buyer confirms receipt by link (§4)', () => {
  async function exported(t: TestDb) {
    const p = await people(t);
    const lot = await p.svc.createBatch(p.farmer, { ...sampleBatch, productType: 'Cà phê nhân xanh', quantity: 600 });
    await step(t, p.farmer, lot.id, 'HARVEST', { data: { variety: 'ROBUSTA' }, assignNextTo: p.processor });
    await step(t, p.processor, lot.id, 'PROCESSING', { data: { method: 'DRY' }, assignNextTo: p.inspector });
    await step(t, p.inspector, lot.id, 'QUALITY_CHECK', { data: { result: 'PASS', moisture: 12 }, assignNextTo: p.exporter });
    return { p, lot };
  }

  it('only after EXPORT; the importer cannot sign in; the receipt closes the chain and is checked against what shipped', async () => {
    const t = getDb();
    const { p, lot } = await exported(t);
    await step(t, p.exporter, lot.id, 'CONTAINER_STUFFING');
    await expect(p.svc.createReceiptLink(p.exporter, lot.id, 'Hamburg GmbH', 30)).rejects.toThrow(/not been exported/);
    await step(t, p.exporter, lot.id, 'EXPORT');
    await expect(p.svc.createReceiptLink(p.farmer, lot.id, 'Hamburg GmbH', 30)).rejects.toThrow(ForbiddenError);
    const link = await p.svc.createReceiptLink(p.exporter, lot.id, 'Hamburg Coffee Imports GmbH', 30);

    const info = await p.svc.receiptInfo(lot.id, link.token);
    expect(info).toMatchObject({ productName: lot.productName, quantity: 600, importer: 'Hamburg Coffee Imports GmbH', alreadyReceived: false });
    expect(info.exportData).toMatchObject({ billOfLading: 'BL-1' });
    await expect(p.svc.receiptInfo(lot.id, 'forged')).rejects.toThrow(/invalid or has expired/);

    await expect(p.svc.recordImportReceipt(lot.id, link.token, { receivedQuantity: 700, condition: 'GOOD', location: 'Hamburg' })).rejects.toThrow(
      /More was received than was shipped/,
    );
    const receipt = await p.svc.recordImportReceipt(lot.id, link.token, { receivedQuantity: 594, condition: 'GOOD', location: 'Hamburg' });
    expect(receipt).toMatchObject({ stage: 'IMPORT_RECEIPT', actorId: link.importerActorId, hashVersion: 4 });
    expect(await p.svc.getBatch(p.admin, lot.id)).toMatchObject({ currentStage: 'IMPORT_RECEIPT', lostQuantity: 6 });
    await expect(p.svc.recordImportReceipt(lot.id, link.token, { receivedQuantity: 1, condition: 'GOOD', location: 'x' })).rejects.toThrow(
      /already been confirmed/,
    );
    // The importer account exists for attribution only.
    await expect(t.ctx.authService.login({ email: `importer-${link.importerActorId}@receipt.tracechain.local`, password: '!' })).rejects.toThrow();
  });
});

describe('database guards added in 015–019', () => {
  it('status transitions follow the lifecycle; a destroyed lot is final', async () => {
    const t = getDb();
    const p = await people(t);
    const lot = await p.svc.createBatch(p.farmer, sampleBatch);
    const set = (status: string) => t.db.withTenant(p.tenant.id, () => t.db.query('UPDATE batches SET status = $2 WHERE id = $1', [lot.id, status]));
    await expect(set('CONSUMED')).resolves.toBeDefined();
    await expect(set('ACTIVE')).rejects.toThrow(/status cannot change from CONSUMED to ACTIVE/);
    await expect(set('ON_HOLD')).rejects.toThrow(/from CONSUMED to ON_HOLD/);
  });

  it('an answered transfer and a released hold are immutable; nothing can be deleted', async () => {
    const t = getDb();
    const p = await people(t);
    const lot = await p.svc.createBatch(p.farmer, sampleBatch);
    await p.svc.recordEvent(p.farmer, { batchId: lot.id, stage: 'HARVEST', location: 'x', assignNextTo: p.processor.id });
    const { transfer } = await acceptHandOver(t, p.processor, lot.id, 990);
    const q = (sql: string) => t.db.withTenant(p.tenant.id, () => t.db.query(sql, [transfer.id]));
    await expect(q('UPDATE transfers SET received_quantity = 1000 WHERE id = $1')).rejects.toThrow(/already ACCEPTED/);
    await expect(q('DELETE FROM transfers WHERE id = $1')).rejects.toThrow();
    // The app role can't fake a smaller loss either: lost quantity only grows.
    await expect(
      t.db.withTenant(p.tenant.id, () => t.db.query('UPDATE batches SET lost_quantity = 0 WHERE id = $1', [lot.id])),
    ).rejects.toThrow(/lost quantity cannot decrease/);
  });
});
