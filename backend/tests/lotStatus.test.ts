import { Actor, Batch } from '../src/domain/types';
import { ConflictError, ForbiddenError, ValidationError } from '../src/errors';
import { acceptHandOver, asAttacker, coffeeCherry, createActor, createTenant, STAGE_DATA, step, TestDb, useTestDatabase } from './helpers/testDb';

/**
 * docs/SPEC_PHASE1_5.md §0 — lot status, two-way hand-over, recall along the
 * lineage, failed inspection, occurred-at time.
 */
const getDb = useTestDatabase();
const HOUR = 3600 * 1000;
const ago = (h: number) => new Date(Date.now() - h * HOUR);

async function people(t: TestDb) {
  const tenant = await createTenant(t);
  const farmer = await createActor(t, tenant, 'FARMER', { organization: 'HTX Cầu Đất' });
  const collector = await createActor(t, tenant, 'COLLECTOR', { organization: 'Đại lý A' });
  const processor = await createActor(t, tenant, 'PROCESSOR', { organization: 'Nhà máy B' });
  const inspector = await createActor(t, tenant, 'INSPECTOR', { organization: 'Trung tâm KĐ' });
  const exporter = await createActor(t, tenant, 'EXPORTER', { organization: 'XNK C' });
  const admin = await createActor(t, tenant, 'ADMIN');
  return { tenant, farmer, collector, processor, inspector, exporter, admin, svc: t.ctx.supplyChainService, lineage: t.ctx.lineageService };
}

/** A coffee cherry lot harvested and held by the processor. */
async function cherryAtMill(t: TestDb, p: Awaited<ReturnType<typeof people>>, kg = 1000, name = 'Quả tươi'): Promise<Batch> {
  const lot = await p.svc.createBatch(p.farmer, { ...coffeeCherry, productName: name, quantity: kg });
  await step(t, p.farmer, lot.id, 'HARVEST', { data: { variety: 'ROBUSTA' }, assignNextTo: p.processor });
  return p.svc.getBatch(p.admin, lot.id);
}

async function anomalies(t: TestDb, admin: Actor, batchId: string) {
  return (await t.ctx.traceService.trace(batchId, 'forward', admin)).anomalies;
}

describe('two-way hand-over (§0.4)', () => {
  it('the receiver weighs what arrived: a shortfall within tolerance is just recorded loss, beyond it an alert', async () => {
    const t = getDb();
    const p = await people(t);
    // Fresh cherry: 2% tolerance.
    const ok = await p.svc.createBatch(p.farmer, coffeeCherry);
    await p.svc.recordEvent(p.farmer, { batchId: ok.id, stage: 'HARVEST', location: 'x', data: { variety: 'ROBUSTA' }, assignNextTo: p.collector.id });
    const { batch: accepted } = await acceptHandOver(t, p.collector, ok.id, 985);
    expect(accepted).toMatchObject({ status: 'ACTIVE', assignedToActorId: p.collector.id, lostQuantity: 15 });
    expect(await anomalies(t, p.admin, ok.id)).toHaveLength(0);

    const short = await p.svc.createBatch(p.farmer, coffeeCherry);
    await p.svc.recordEvent(p.farmer, { batchId: short.id, stage: 'HARVEST', location: 'x', data: { variety: 'ROBUSTA' }, assignNextTo: p.collector.id });
    await acceptHandOver(t, p.collector, short.id, 950);
    expect(await anomalies(t, p.admin, short.id)).toEqual([expect.objectContaining({ type: 'QUANTITY_DISCREPANCY', severity: 'HIGH' })]);

    // Remaining quantity follows: 1000 − 50 lost.
    const merged = await p.lineage.createTransformation(p.collector, {
      kind: 'MERGE',
      stage: 'COLLECTION',
      location: 'x',
      data: STAGE_DATA.COLLECTION,
      inputs: [
        { lotId: ok.id, quantity: 985 },
        { lotId: short.id, quantity: 950 },
      ],
      outputs: [{ productName: 'Gộp', productType: 'Cà phê quả tươi', quantity: 1935, unit: 'kg' }],
    });
    expect(merged.anomalies).toHaveLength(0);
    expect((await p.svc.getBatch(p.admin, short.id)).status).toBe('CONSUMED');
  });

  it('only the receiver answers; more than was sent is refused; rejecting returns the lot to the sender', async () => {
    const t = getDb();
    const p = await people(t);
    const lot = await p.svc.createBatch(p.farmer, coffeeCherry);
    await p.svc.recordEvent(p.farmer, { batchId: lot.id, stage: 'HARVEST', location: 'x', data: { variety: 'ROBUSTA' }, assignNextTo: p.processor.id });
    const [pending] = await p.svc.listIncomingTransfers(p.processor);

    await expect(p.svc.respondTransfer(p.collector, pending.id, { accept: true, receivedQuantity: 1000 })).rejects.toThrow(ForbiddenError);
    await expect(p.svc.respondTransfer(p.processor, pending.id, { accept: true, receivedQuantity: 1001 })).rejects.toThrow(ValidationError);
    await expect(p.svc.respondTransfer(p.processor, pending.id, { accept: false })).rejects.toThrow(/reason is required/);

    const { batch, transfer } = await p.svc.respondTransfer(p.processor, pending.id, { accept: false, reason: 'Quả xanh quá nhiều' });
    expect(transfer).toMatchObject({ status: 'REJECTED', responseReason: 'Quả xanh quá nhiều' });
    expect(batch).toMatchObject({ status: 'ACTIVE', assignedToActorId: p.farmer.id });
    await expect(p.svc.respondTransfer(p.processor, pending.id, { accept: true, receivedQuantity: 1 })).rejects.toThrow(/already been answered/);

    // The farmer may hand it to someone else now.
    const again = await p.svc.createTransfer(p.farmer, lot.id, { toActorId: p.collector.id, vehicle: '49C-123.45' });
    expect(again).toMatchObject({ status: 'PENDING', vehicle: '49C-123.45', quantity: 1000 });
    // ...and withdraw it before it's answered.
    await expect(p.svc.cancelTransfer(p.collector, again.id)).rejects.toThrow(/Only the sender/);
    const { batch: back } = await p.svc.cancelTransfer(p.farmer, again.id);
    expect(back.status).toBe('ACTIVE');

    const kinds = (await t.ctx.traceService.trace(lot.id, 'forward', p.admin)).events.map((e) => e.kind);
    expect(kinds).toEqual(['OBSERVE', 'TRANSFER_OUT', 'TRANSFER_REJECT', 'TRANSFER_OUT', 'TRANSFER_CANCEL']);
  });

  it('a hand-over goes only to someone who can do what comes next', async () => {
    const t = getDb();
    const p = await people(t);
    const lot = await p.svc.createBatch(p.farmer, coffeeCherry);
    await expect(
      p.svc.recordEvent(p.farmer, { batchId: lot.id, stage: 'HARVEST', location: 'x', data: { variety: 'ROBUSTA' }, assignNextTo: p.exporter.id }),
    ).rejects.toThrow(/cannot handle stage/);
    // Collector (optional COLLECTION) and processor (required PROCESSING) both may.
    await p.svc.recordEvent(p.farmer, { batchId: lot.id, stage: 'HARVEST', location: 'x', data: { variety: 'ROBUSTA' }, assignNextTo: p.collector.id });
    expect((await p.svc.listIncomingTransfers(p.collector)).map((x) => x.batchId)).toEqual([lot.id]);
  });
});

describe('recall along the lineage (§0.2)', () => {
  /**
   *  a ─┐                ┌─ s1 (ACTIVE)
   *     ├─ merged ─ green┤
   *  b ─┘   (other: co-input of a later merge)
   *                      └─ s2 → shipped (ACTIVE)
   */
  async function graph(t: TestDb) {
    const p = await people(t);
    const a = await cherryAtMill(t, p, 1000, 'A');
    const b = await cherryAtMill(t, p, 1000, 'B');
    const merged = (
      await p.lineage.createTransformation(p.processor, {
        kind: 'MERGE',
        stage: 'PROCESSING',
        location: 'x',
        data: { method: 'WET' },
        inputs: [
          { lotId: a.id, quantity: 1000 },
          { lotId: b.id, quantity: 1000 },
        ],
        outputs: [{ productName: 'Gộp', productType: 'Cà phê quả tươi', quantity: 2000, unit: 'kg' }],
      })
    ).outputs[0];
    const green = (
      await p.lineage.createTransformation(p.processor, {
        kind: 'TRANSFORM',
        stage: 'PROCESSING',
        location: 'x',
        data: { method: 'DRY' },
        inputs: [{ lotId: merged.id, quantity: 2000 }],
        outputs: [{ productName: 'Nhân', productType: 'Cà phê nhân xanh', quantity: 400, unit: 'kg' }],
      })
    ).outputs[0];
    const [s1, s2] = (
      await p.lineage.createTransformation(p.processor, {
        kind: 'SPLIT',
        stage: 'PROCESSING',
        location: 'x',
        data: { method: 'SORTING' },
        inputs: [{ lotId: green.id, quantity: 400 }],
        outputs: [
          { productName: 'S1', productType: 'Cà phê nhân xanh', quantity: 200, unit: 'kg' },
          { productName: 'S2', productType: 'Cà phê nhân xanh', quantity: 200, unit: 'kg' },
        ],
      })
    ).outputs;
    // s2 is on its way to the inspector when the recall comes.
    await p.svc.createTransfer(p.processor, s2.id, { toActorId: p.inspector.id });
    return { p, a, b, merged, green, s1, s2 };
  }

  it('recalling a farm lot puts everything made from it on hold, three levels down, and flags its siblings', async () => {
    const t = getDb();
    const { p, a, b, merged, green, s1, s2 } = await graph(t);
    const result = await p.svc.recall(p.inspector, a.id, { reason: 'Dư lượng thuốc BVTV' });

    expect(result.batch.status).toBe('RECALLED');
    // merged and green are consumed: nothing to hold — their goods live in s1, s2.
    expect(result.heldLotIds.sort()).toEqual([s1.id, s2.id].sort());
    expect(result.recalledLotIds).toEqual([]);
    const after = async (x: Batch) => (await p.svc.getBatch(p.admin, x.id)).status;
    expect(await after(s1)).toBe('ON_HOLD');
    expect(await after(s2)).toBe('ON_HOLD'); // held in transit
    expect(await after(merged)).toBe('CONSUMED');
    expect(await after(green)).toBe('CONSUMED');
    // b was merged with a: not an ancestor, not made from a — untouched, unflagged.
    expect(await anomalies(t, p.admin, b.id)).toHaveLength(0);
    expect(result.flaggedLotIds).toEqual([]);

    // Held lots take nothing until an inspector releases them, with a reason.
    await expect(p.svc.recordEvent(p.processor, { batchId: s1.id, stage: 'WAREHOUSING', location: 'x', data: STAGE_DATA.WAREHOUSING })).rejects.toThrow(
      /on hold/,
    );
    const [s2Transfer] = await p.svc.listIncomingTransfers(p.inspector);
    await expect(p.svc.respondTransfer(p.inspector, s2Transfer.id, { accept: true, receivedQuantity: 200 })).rejects.toThrow(/on hold/);
    await expect(p.svc.releaseBatch(p.processor, s1.id, 'ok')).rejects.toThrow(ForbiddenError);
    const released = await p.svc.releaseBatch(p.inspector, s1.id, 'Mẫu lưu của S1 đạt');
    expect(released.status).toBe('ACTIVE');
    // s2 goes back to being in transit, and the inspector can then take it.
    expect((await p.svc.releaseBatch(p.admin, s2.id, 'ok')).status).toBe('IN_TRANSIT');
    await acceptHandOver(t, p.inspector, s2.id);

    // The consumer of a product made from a recalled lot is told so.
    const pub = await t.ctx.traceService.publicTrace(s1.id);
    expect(pub.recalledInputs).toEqual([{ productName: 'A', reason: 'Dư lượng thuốc BVTV' }]);
    // Every status change is on the ledger.
    const kinds = (await t.ctx.traceService.trace(s1.id, 'forward', p.admin)).events.map((e) => e.kind);
    expect(kinds).toEqual(['SPLIT', 'HOLD', 'RELEASE']);
  });

  it('recalling an intermediate lot flags what it came from; cascade recalls everything made from it', async () => {
    const t = getDb();
    const { p, a, b, merged, green, s1, s2 } = await graph(t);
    const result = await p.svc.recall(p.admin, green.id, { reason: 'Ochratoxin A', cascade: true });
    expect(result.batch.status).toBe('RECALLED'); // a CONSUMED lot can still be recalled
    expect(result.recalledLotIds.sort()).toEqual([s1.id, s2.id].sort());
    expect(result.flaggedLotIds.sort()).toEqual([a.id, b.id, merged.id].sort());
    for (const x of [s1, s2]) expect((await p.svc.getBatch(p.admin, x.id)).status).toBe('RECALLED');
    expect(await anomalies(t, p.admin, a.id)).toEqual([expect.objectContaining({ type: 'RECALL_INVESTIGATION' })]);
    // The transfer of s2 was closed by its recall.
    expect(await p.svc.listIncomingTransfers(p.inspector)).toEqual([]);
    await expect(p.svc.recall(p.admin, green.id, { reason: 'again' })).rejects.toThrow(/already been recalled/);
  });
});

describe('failed inspection (§0.3)', () => {
  async function inspected(t: TestDb, result: 'PASS' | 'FAIL' | 'PASS_WITH_CONDITIONS', extra: Record<string, string | number> = {}) {
    const p = await people(t);
    const cherry = await cherryAtMill(t, p);
    const green = (
      await p.lineage.createTransformation(p.processor, {
        kind: 'TRANSFORM',
        stage: 'PROCESSING',
        location: 'x',
        data: { method: 'DRY' },
        inputs: [{ lotId: cherry.id, quantity: 1000 }],
        outputs: [{ productName: 'Nhân', productType: 'Cà phê nhân xanh', quantity: 200, unit: 'kg' }],
        assignNextTo: p.inspector.id,
      })
    ).outputs[0];
    await acceptHandOver(t, p.inspector, green.id);
    await step(t, p.inspector, green.id, 'QUALITY_CHECK', {
      data: { result, moisture: result === 'FAIL' ? 14.5 : 12.3, ...extra },
      assignNextTo: result === 'FAIL' ? p.processor : p.exporter,
    });
    return { p, green: await p.svc.getBatch(p.admin, green.id) };
  }

  it('FAIL rejects the lot: no further steps, no packing, only rework, downgrade or disposal', async () => {
    const t = getDb();
    const { p, green } = await inspected(t, 'FAIL');
    expect(green).toMatchObject({ status: 'REJECTED', assignedToActorId: p.processor.id });
    await expect(
      p.svc.recordEvent(p.processor, { batchId: green.id, stage: 'WAREHOUSING', location: 'x', data: STAGE_DATA.WAREHOUSING }),
    ).rejects.toThrow(/failed inspection/);
    await expect(
      p.lineage.createTransformation(p.processor, {
        kind: 'SPLIT',
        stage: 'PROCESSING',
        location: 'x',
        data: { method: 'SORTING' },
        inputs: [{ lotId: green.id, quantity: 200 }],
        outputs: [
          { productName: '1', productType: 'Cà phê nhân xanh', quantity: 100, unit: 'kg' },
          { productName: '2', productType: 'Cà phê nhân xanh', quantity: 100, unit: 'kg' },
        ],
      }),
    ).rejects.toThrow(/only rework, downgrade or disposal/);

    // Rework: back to a step before inspection — the new lot must pass inspection again.
    await expect(
      p.lineage.createTransformation(p.admin, {
        kind: 'REWORK',
        stage: 'QUALITY_CHECK',
        location: 'x',
        data: { result: 'PASS', moisture: 12 },
        inputs: [{ lotId: green.id, quantity: 200 }],
        outputs: [{ productName: 'Sấy lại', productType: 'Cà phê nhân xanh', quantity: 196, unit: 'kg' }],
      }),
    ).rejects.toThrow(/Rework happens at a step before/);
    const reworked = (
      await p.lineage.createTransformation(p.processor, {
        kind: 'REWORK',
        stage: 'PROCESSING',
        location: 'x',
        data: { method: 'REDRY', moisture: 12.2 },
        inputs: [{ lotId: green.id, quantity: 200 }],
        outputs: [{ productName: 'Sấy lại', productType: 'Cà phê nhân xanh', quantity: 196, unit: 'kg' }],
        assignNextTo: p.inspector.id,
      })
    );
    expect(reworked.anomalies).toHaveLength(0); // 0.98 within the 0.85–1.0 rework range
    const again = reworked.outputs[0];
    expect(again.metadata).toMatchObject({ reinspect: true });
    expect((await p.svc.getBatch(p.admin, green.id)).status).toBe('CONSUMED');
    await acceptHandOver(t, p.inspector, again.id);
    // Even an admin can't skip the re-inspection.
    await expect(
      p.svc.recordEvent(p.admin, { batchId: again.id, stage: 'CONTAINER_STUFFING', location: 'x', data: STAGE_DATA.CONTAINER_STUFFING }),
    ).rejects.toThrow(/Required stage .*QUALITY_CHECK/);
  });

  it('a downgrade re-grades the rejected lot at inspection and lets it go on', async () => {
    const t = getDb();
    const { p, green } = await inspected(t, 'FAIL');
    await expect(
      p.lineage.createTransformation(p.inspector, {
        kind: 'DOWNGRADE',
        stage: 'QUALITY_CHECK',
        location: 'x',
        data: { result: 'FAIL', moisture: 12 },
        inputs: [{ lotId: green.id, quantity: 200 }],
        outputs: [{ productName: 'Loại 2', productType: 'Cà phê nhân xanh', quantity: 190, unit: 'kg' }],
      }),
    ).rejects.toThrow(/Not been handed off|record result PASS/i);
    const grade2 = (
      await p.lineage.createTransformation(p.admin, {
        kind: 'DOWNGRADE',
        stage: 'QUALITY_CHECK',
        location: 'x',
        data: { result: 'PASS', grade: 'G2', moisture: 12.4 },
        inputs: [{ lotId: green.id, quantity: 200 }],
        outputs: [{ productName: 'Nhân xanh loại 2', productType: 'Cà phê nhân xanh', quantity: 190, unit: 'kg' }],
      })
    ).outputs[0];
    expect(grade2).toMatchObject({ status: 'ACTIVE', currentStage: 'QUALITY_CHECK', metadata: { downgradedFrom: green.id } });
    // Past inspection: it goes on to container stuffing.
    await step(t, p.admin, grade2.id, 'CONTAINER_STUFFING');
  });

  it('a rejected lot is destroyed with a record; its holder may do it', async () => {
    const t = getDb();
    const { p, green } = await inspected(t, 'FAIL');
    await expect(p.svc.disposeBatch(p.farmer, green.id, { recordNo: 'BB-1', method: 'Đốt', witness: 'X' })).rejects.toThrow(ForbiddenError);
    const destroyed = await p.svc.disposeBatch(p.processor, green.id, { recordNo: 'BB-1', method: 'Đốt', witness: 'Chi cục QLCL' });
    expect(destroyed).toMatchObject({ status: 'DESTROYED', lostQuantity: 200, assignedToActorId: undefined });
    await expect(p.svc.recallBatch(p.admin, green.id, 'x')).rejects.toThrow(/destroyed/);
    const last = (await t.ctx.traceService.trace(green.id, 'backward', p.admin)).events[0];
    expect(last).toMatchObject({ kind: 'DISPOSE', data: expect.objectContaining({ recordNo: 'BB-1', witness: 'Chi cục QLCL', quantity: 200 }) });
  });

  it('PASS_WITH_CONDITIONS needs the conditions and opens an alert until they are met', async () => {
    const t = getDb();
    await expect(inspected(t, 'PASS_WITH_CONDITIONS')).rejects.toThrow(/conditions is required/);
    const { p, green } = await inspected(t, 'PASS_WITH_CONDITIONS', { conditions: 'Sấy về 12,5% trong 3 ngày', conditionDueDate: '2026-12-01' });
    expect(green.status).toBe('ACTIVE');
    expect(await anomalies(t, p.admin, green.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'QC_CONDITION', severity: 'LOW' })]),
    );
  });

  it('warns when the inspector belongs to the organization that processed the lot', async () => {
    const t = getDb();
    const p = await people(t);
    const inHouse = await createActor(t, p.tenant, 'INSPECTOR', { organization: 'Nhà máy B' });
    const lot = await cherryAtMill(t, p);
    await step(t, p.processor, lot.id, 'PROCESSING', { data: { method: 'DRY' }, assignNextTo: inHouse });
    await step(t, inHouse, lot.id, 'QUALITY_CHECK', { data: { result: 'PASS', moisture: 12 }, assignNextTo: p.exporter });
    expect(await anomalies(t, p.admin, lot.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'CONFLICT_OF_INTEREST', severity: 'MEDIUM' })]),
    );
  });
});

describe('when it happened vs when it was recorded (§0.5)', () => {
  it('refuses the future and going back before what the lot went through', async () => {
    const t = getDb();
    const p = await people(t);
    const lot = await p.svc.createBatch(p.farmer, coffeeCherry);
    const harvest = (occurredAt: Date) =>
      p.svc.recordEvent(p.farmer, { batchId: lot.id, stage: 'HARVEST', location: 'x', data: { variety: 'ROBUSTA' }, occurredAt, assignNextTo: p.processor.id });
    await expect(harvest(new Date(Date.now() + HOUR))).rejects.toThrow(/future/);
    const tenHoursAgo = ago(10);
    const e = await harvest(tenHoursAgo);
    expect(e).toMatchObject({ hashVersion: 4, occurredAt: tenHoursAgo });
    expect(e.timestamp.getTime()).toBeGreaterThan(e.occurredAt.getTime());
    await acceptHandOver(t, p.processor, lot.id, undefined, ago(9));
    await expect(
      p.svc.recordEvent(p.processor, { batchId: lot.id, stage: 'PROCESSING', location: 'x', data: { method: 'DRY' }, occurredAt: ago(12) }),
    ).rejects.toThrow(/earlier than what this lot already went through/);
    // The database refuses it too.
    await expect(
      t.db.withTenant(p.tenant.id, () =>
        t.db.query(
          `INSERT INTO trace_events (id, batch_id, tenant_id, stage, actor_id, location, data, hash, prev_hash, sequence_number,
                                     hash_version, claim_salts, timestamp, occurred_at)
           SELECT gen_random_uuid(), b.id, b.tenant_id, 'PROCESSING', $2, 'x', '{}', repeat('e', 64), b.head_hash, b.event_count,
                  4, '{}'::jsonb, now(), now() - interval '20 hours'
             FROM batches b WHERE b.id = $1`,
          [lot.id, p.processor.id],
        ),
      ),
    ).rejects.toThrow(/earlier than the previous event/);
  });

  it('past the product limit a reason is required, and the entry is flagged LATE_ENTRY', async () => {
    const t = getDb();
    const p = await people(t);
    const lot = await p.svc.createBatch(p.farmer, coffeeCherry); // fresh cherry: 3 days
    const late = { batchId: lot.id, stage: 'HARVEST', location: 'x', data: { variety: 'ROBUSTA' }, occurredAt: ago(24 * 5), assignNextTo: p.processor.id };
    await expect(p.svc.recordEvent(p.farmer, late)).rejects.toMatchObject({ issues: [expect.objectContaining({ field: 'lateReason' })] });
    const e = await p.svc.recordEvent(p.farmer, { ...late, lateReason: 'Mất sóng trên rẫy' });
    expect(e.data).toMatchObject({ lateReason: 'Mất sóng trên rẫy' });
    expect(await anomalies(t, p.admin, lot.id)).toEqual([expect.objectContaining({ type: 'LATE_ENTRY' })]);
  });

  it('occurredAt is part of the v4 hash: changing it in the database breaks the chain', async () => {
    const t = getDb();
    const p = await people(t);
    const lot = await p.svc.createBatch(p.farmer, coffeeCherry);
    await p.svc.recordEvent(p.farmer, { batchId: lot.id, stage: 'HARVEST', location: 'x', data: { variety: 'ROBUSTA' }, occurredAt: ago(10), assignNextTo: p.processor.id });
    expect((await t.ctx.traceService.trace(lot.id, 'forward', p.admin)).isValid).toBe(true);
    await asAttacker(t, "UPDATE trace_events SET occurred_at = occurred_at - interval '1 day' WHERE batch_id = $1 AND sequence_number = 0", [lot.id]);
    expect((await t.ctx.traceService.trace(lot.id, 'forward', p.admin)).isValid).toBe(false);
  });
});

describe('ConflictError surface', () => {
  it('names the reason a lot can take no step', async () => {
    const t = getDb();
    const p = await people(t);
    const lot = await p.svc.createBatch(p.farmer, coffeeCherry);
    await p.svc.holdBatch(p.inspector, lot.id, 'Nghi vấn');
    await expect(p.svc.recordEvent(p.farmer, { batchId: lot.id, stage: 'HARVEST', location: 'x', data: { variety: 'ROBUSTA' } })).rejects.toThrow(
      ConflictError,
    );
    await expect(p.svc.holdBatch(p.inspector, lot.id, 'again')).rejects.toThrow(/cannot be put on hold/);
    await expect(p.svc.holdBatch(p.farmer, lot.id, 'x')).rejects.toThrow(ForbiddenError);
  });
});
