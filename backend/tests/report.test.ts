import { acceptHandOver, createActor, createTenant, step, useTestDatabase } from './helpers/testDb';

const getDb = useTestDatabase();

describe('StatsService.report — Reports dashboard aggregates', () => {
  it('computes KPIs, funnel, durations and breakdowns for the filtered window only', async () => {
    const t = getDb();
    const tenant = await createTenant(t);
    const farmer = await createActor(t, tenant, 'FARMER', { organization: 'HTX A' });
    const processor = await createActor(t, tenant, 'PROCESSOR', { organization: 'Nhà máy B' });
    const admin = await createActor(t, tenant, 'ADMIN');
    const svc = t.ctx.supplyChainService;
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000);

    // 2 t green coffee + 500 kg green coffee + 10 bags of rice (50 kg each, catalog unit).
    const coffee = await svc.createBatch(farmer, { productName: 'C1', productType: 'Cà phê nhân xanh', origin: 'Cầu Đất', quantity: 2, unit: 'tấn' });
    const coffee2 = await svc.createBatch(farmer, { productName: 'C2', productType: 'Cà phê nhân xanh', origin: 'Bảo Lộc', quantity: 500, unit: 'kg' });
    const rice = await svc.createBatch(admin, { productName: 'R', productType: 'Lúa gạo', origin: 'Sóc Trăng', quantity: 10, unit: 'bao' });
    await step(t, farmer, coffee.id, 'HARVEST', { data: { variety: 'ROBUSTA' }, occurredAt: hoursAgo(30), assignNextTo: processor });
    await step(t, processor, coffee.id, 'PROCESSING', { data: { method: 'DRY' }, occurredAt: hoursAgo(20) });
    await step(t, admin, rice.id, 'HARVEST', { data: { variety: 'ST25' } });
    await svc.recallBatch(admin, coffee2.id, 'test');

    // Noise in another tenant must not leak.
    const outsider = await createActor(t, await createTenant(t), 'ADMIN');
    await svc.createBatch(outsider, { productName: 'X', productType: 'Cà phê nhân xanh', origin: 'x', quantity: 1, unit: 'kg' });

    const r = await t.ctx.statsService.report(tenant.id, {});
    expect(r.kpis.batches.value).toBe(3);
    expect(r.kpis.volumeKg.value).toBe(3000); // 2 t + 500 kg + 10 × 50 kg — every unit now converts
    expect(r.kpis.recallRate.value).toBeCloseTo(100 / 3);
    expect(r.kpis.batches.previous).toBe(0);
    expect(r.kpis.batches.trend).toHaveLength(12);
    expect(r.kpis.batches.trend.reduce((a, b) => a + b, 0)).toBe(3);

    // Funnel over the stages of the lots' own workflows (coffee export + rice), in display order.
    const funnel = Object.fromEntries(r.funnel.map((f) => [f.stage, f.batches]));
    expect(funnel.HARVEST).toBe(2); // coffee and rice reached it; the recalled coffee never did
    expect(funnel.PROCESSING).toBe(1);
    expect(funnel.MILLING).toBe(0);
    expect(r.funnel[0].stage).toBe('HARVEST');

    // Durations use when things happened: 30 h → 20 h ago = 10 h.
    expect(r.stageDurations).toEqual([expect.objectContaining({ from: 'HARVEST', to: 'PROCESSING', samples: 1 })]);
    expect(r.stageDurations[0].avgHours).toBeCloseTo(10, 0);

    expect(r.byProductType).toEqual([
      { productType: 'Cà phê nhân xanh', batches: 2, volumeKg: 2500 },
      { productType: 'Gạo', batches: 1, volumeKg: 500 },
    ]);
    expect(r.statusBreakdown).toEqual(expect.arrayContaining([{ status: 'ACTIVE', batches: 2 }, { status: 'RECALLED', batches: 1 }]));
    expect(r.organizations.map((o) => o.organization)).toEqual(expect.arrayContaining(['HTX A', 'Nhà máy B']));
    expect(r.monthly.reduce((a, m) => a + m.batches, 0)).toBe(3);
    expect(r.options.productTypes).toEqual(['Cà phê nhân xanh', 'Gạo']);
    expect(r.options.workflows.map((w) => w.code).sort()).toEqual(['COFFEE_EXPORT', 'RICE']);

    const onlyCoffee = await t.ctx.statsService.report(tenant.id, { productType: 'Cà phê nhân xanh', origin: 'cầu' });
    expect(onlyCoffee.kpis.batches.value).toBe(1);
    const onlyRice = await t.ctx.statsService.report(tenant.id, { workflowCode: 'RICE' });
    expect(onlyRice.kpis.batches.value).toBe(1);
    const past = await t.ctx.statsService.report(tenant.id, { from: new Date('2020-01-01'), to: new Date('2020-06-01') });
    expect(past.kpis.batches.value).toBe(0);
    expect(past.monthly).toHaveLength(5);
  });

  it('reports losses per process against the reference range, transit shortfall and disposals', async () => {
    const t = getDb();
    const tenant = await createTenant(t);
    const farmer = await createActor(t, tenant, 'FARMER');
    const processor = await createActor(t, tenant, 'PROCESSOR');
    const inspector = await createActor(t, tenant, 'INSPECTOR');
    const svc = t.ctx.supplyChainService;

    const cherries = await svc.createBatch(farmer, { productName: 'Q', productType: 'Cà phê quả tươi', origin: 'x', quantity: 1000, unit: 'kg' });
    await svc.recordEvent(farmer, { batchId: cherries.id, stage: 'HARVEST', location: 'x', data: { variety: 'ROBUSTA' }, assignNextTo: processor.id });
    await acceptHandOver(t, processor, cherries.id, 990); // 1% short — within the 2% tolerance
    const green = (
      await t.ctx.lineageService.createTransformation(processor, {
        kind: 'TRANSFORM',
        stage: 'PROCESSING',
        location: 'x',
        data: { method: 'DRY' },
        inputs: [{ lotId: cherries.id, quantity: 990 }],
        outputs: [{ productName: 'N', productType: 'Cà phê nhân xanh', quantity: 198, unit: 'kg' }], // 0.20
      })
    ).outputs[0];
    await svc.disposeBatch(inspector, green.id, { recordNo: 'BB-1', method: 'Đốt', witness: 'Chi cục' });

    const r = await t.ctx.statsService.report(tenant.id, {});
    expect(r.losses.processes).toEqual([
      expect.objectContaining({ kind: 'TRANSFORM', fromType: 'Cà phê quả tươi', toType: 'Cà phê nhân xanh', count: 1, min: 0.15, max: 0.23, outOfRange: 0 }),
    ]);
    expect(r.losses.processes[0].avgRatio).toBeCloseTo(0.2);
    expect(r.losses.processes[0].source).toMatch(/World Bank/);
    expect(r.losses.transit).toMatchObject({ accepted: 1, sentKg: 1000, shortfallKg: 10, discrepancies: 0 });
    expect(r.losses.disposedKg).toBe(198);
  });
});
