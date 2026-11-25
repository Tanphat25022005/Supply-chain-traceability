import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { Database } from '../db/database';
import { validateEventData } from '../domain/fieldSchema';
import {
  Actor,
  Anomaly,
  AnomalySeverity,
  AnomalyType,
  Batch,
  BatchHold,
  BatchListQuery,
  CreateBatchDTO,
  CreateTransferDTO,
  DisposeDTO,
  isStageEvent,
  RecallDTO,
  RecallResult,
  RecordEventDTO,
  remainingOf,
  RespondTransferDTO,
  TraceEvent,
  Transfer,
} from '../domain/types';
import { WorkflowRules } from '../domain/workflow';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { BatchExportFilters, IActorRepo, IAnomalyRepo, IAuditLogRepo, IBatchRepo, IEventRepo } from '../repository/interfaces';
import { PostgresCatalogRepo } from '../repository/postgres/catalogRepo';
import { IncomingTransfer, PostgresCustodyRepo } from '../repository/postgres/custodyRepo';
import { PostgresLineageRepo } from '../repository/postgres/lineageRepo';
import { PostgresPlotRepo } from '../repository/postgres/plotRepo';
import { detectNewAnomalies } from './anomalyDetector';
import { CatalogContext } from './catalogContext';
import { resolveNextAssignee } from './custody';
import { checkOccurredAt } from './eventTime';
import { LedgerWriter } from './ledgerWriter';
import { getInvolvedActorIds } from './notificationScope';

export { ConflictError, ForbiddenError, NotFoundError };

export interface RealtimeEmitter {
  emitAnomaly(anomaly: Anomaly, recipientActorIds: string[]): void;
  emitRecall(batch: Batch, recipientActorIds: string[]): void;
  emitTransfer?(transfer: Transfer, recipientActorIds: string[]): void;
}

export interface SupplyChainRepos {
  batchRepo: IBatchRepo;
  eventRepo: IEventRepo;
  anomalyRepo: IAnomalyRepo;
  auditLogRepo: IAuditLogRepo;
  actorRepo: IActorRepo;
  plotRepo: PostgresPlotRepo;
  lineageRepo: PostgresLineageRepo;
  catalogRepo: PostgresCatalogRepo;
  custodyRepo: PostgresCustodyRepo;
}

/** ADMIN and INSPECTOR may freeze, release and recall lots — whoever finds a problem acts on it. */
const OVERSIGHT_ROLES: Actor['role'][] = ['ADMIN', 'INSPECTOR'];
const RECEIPT_TOKEN_TYPE = 'import-receipt';
/** Rounding slack for quantity comparisons. */
const EPSILON = 1e-9;

export interface ReceiptLink {
  token: string;
  expiresAt: Date;
  importerActorId: string;
}

/** What a foreign buyer sees when opening a receipt link. */
export interface ReceiptInfo {
  batchId: string;
  productName: string;
  quantity: number;
  unit: string;
  exporter: string;
  importer: string;
  exportData: Record<string, unknown>;
  alreadyReceived: boolean;
  expiresAt?: Date;
}

export interface ImportReceiptDTO {
  receivedQuantity: number;
  condition: 'GOOD' | 'DAMAGED' | 'REJECTED';
  location: string;
  notes?: string;
}

/** Stage reached, recorded fields etc. are not repeated here — see TraceService. This is the custody side of one lot. */
export interface CustodyView {
  transfers: Transfer[];
  holds: BatchHold[];
}

export class SupplyChainService {
  private readonly ledger: LedgerWriter;
  private readonly catalogCtx: CatalogContext;

  constructor(
    private readonly db: Database,
    private readonly repos: SupplyChainRepos,
    private readonly realtime?: RealtimeEmitter,
    /** Signs import-receipt links. */
    private readonly tokenSecret: string = '',
  ) {
    this.ledger = new LedgerWriter(repos.eventRepo);
    this.catalogCtx = new CatalogContext(repos.catalogRepo);
  }

  // ── Lots ──────────────────────────────────────────────────────────────────

  async createBatch(actor: Actor, dto: CreateBatchDTO): Promise<Batch> {
    return this.db.withTenant(actor.tenantId, async () => {
      if (dto.plotId) {
        const plot = await this.repos.plotRepo.findById(dto.plotId);
        if (!plot || plot.tenantId !== actor.tenantId) throw new NotFoundError('Plot not found');
        if (actor.role !== 'ADMIN' && plot.ownerActorId !== actor.id) throw new ForbiddenError('This plot is not yours');
      }
      const productType = await this.catalogCtx.resolveProductType(dto.productTypeId, dto.productType);
      const unit = await this.repos.catalogRepo.unitFor(productType, dto.unit);
      if (!unit) {
        throw new ValidationError(`Unit "${dto.unit}" is not valid for ${productType.name}`, [
          { field: 'unit', code: 'invalid_option', message: `unit must be one of the units of ${productType.code}` },
        ]);
      }
      const workflow = await this.catalogCtx.workflowForNewLot(productType, dto.workflowCode);
      const rules = await this.catalogCtx.rules(workflow.id);
      const first = rules.steps[0];
      if (actor.role !== 'ADMIN' && !first.roles.includes(actor.role)) {
        throw new ForbiddenError(`Role ${actor.role} cannot start a lot in workflow ${workflow.code}`);
      }

      const batch = await this.repos.batchRepo.create({
        id: uuidv4(),
        productName: dto.productName,
        productType: productType.name,
        productTypeId: productType.id,
        baseUnit: productType.baseUnit,
        unitFactor: unit.factor,
        origin: dto.origin,
        quantity: dto.quantity,
        unit: unit.code,
        createdAt: new Date(),
        createdBy: actor.id,
        tenantId: actor.tenantId,
        currentStage: null,
        metadata: dto.metadata ?? {},
        // The creator is who's expected to record the first event (they're the
        // one who actually has the physical goods in hand right now).
        assignedToActorId: actor.id,
        plotId: dto.plotId,
        workflowId: workflow.id,
      });
      await this.audit(actor, 'BATCH_CREATED', 'batch', batch.id, {
        productName: batch.productName,
        productTypeId: productType.id,
        workflow: `${workflow.code}@${workflow.version}`,
        plotId: dto.plotId,
      });
      if (dto.plotId) await this.checkPlotYield(batch, dto.plotId);
      return batch;
    });
  }

  /**
   * SPEC §5 level 2: everything harvested from one plot in the last 365 days
   * can't exceed its area × the product's yield cap for the region ("a 2 ha
   * garden selling 30 t"). Weighed in kg via the catalog conversion.
   */
  private async checkPlotYield(batch: Batch, plotId: string): Promise<void> {
    if (batch.baseUnit !== 'kg' || !batch.productTypeId) return;
    const [plot, cap] = await Promise.all([
      this.repos.plotRepo.findById(plotId),
      this.repos.catalogRepo.yieldCap(batch.productTypeId, batch.origin),
    ]);
    if (!plot || !cap) return;
    const harvests = await this.repos.lineageRepo.plotHarvests(plotId, batch.createdAt);
    let totalKg = 0;
    for (const h of harvests.filter((x) => x.productTypeId === batch.productTypeId)) {
      if (h.quantityBase === null) return; // an unmapped old lot can't be weighed
      totalKg += h.quantityBase;
    }
    const limitKg = plot.areaHa * cap.maxKgPerHa;
    if (totalKg <= limitKg) return;
    const anomaly = await this.flag(
      batch,
      'MASS_BALANCE_VIOLATION',
      'HIGH',
      `Cân bằng khối lượng: lô đất ${plot.code} (${plot.areaHa} ha) đã khai ${totalKg.toLocaleString('vi-VN')} kg ${batch.productType} trong 12 tháng, vượt năng suất tối đa ${limitKg.toLocaleString('vi-VN')} kg (${cap.maxKgPerHa.toLocaleString('vi-VN')} kg/ha — ${cap.source})`,
    );
    this.realtime?.emitAnomaly(anomaly, [batch.createdBy]);
  }

  /** Whether a tenant has any batch at all — used to keep demo seeding idempotent. */
  async tenantHasBatches(tenantId: string): Promise<boolean> {
    return this.db.withTenant(tenantId, () => this.repos.batchRepo.hasAnyInTenant(tenantId));
  }

  async listBatchesPage(actor: Actor, query: BatchListQuery) {
    return this.db.withTenant(actor.tenantId, () => this.repos.batchRepo.findPageByTenant(actor.tenantId, query));
  }

  /**
   * The actor's work queue: open lots not yet at the end of their workflow
   * that they hold (to record, hand on, or — after a failed inspection —
   * rework or dispose of), or that nobody holds and whose next step is theirs.
   * Incoming hand-overs are listed separately (listIncomingTransfers).
   */
  async listPendingForActor(actor: Actor): Promise<Batch[]> {
    return this.db.withTenant(actor.tenantId, () =>
      this.repos.batchRepo.findPendingFor(actor.tenantId, actor.id, actor.role, actor.role === 'ADMIN'),
    );
  }

  /** Lots this actor can use as inputs to a merge/split/transform. */
  async listInCustody(actor: Actor): Promise<Batch[]> {
    return this.db.withTenant(actor.tenantId, () =>
      this.repos.batchRepo.findInCustody(actor.tenantId, actor.id, actor.role === 'ADMIN'),
    );
  }

  /** Batches filtered by creation date range and/or origin, for compliance/reporting export. */
  async exportBatches(actor: Actor, filters: BatchExportFilters): Promise<Batch[]> {
    return this.db.withTenant(actor.tenantId, () => this.repos.batchRepo.findForExport(actor.tenantId, filters));
  }

  async getBatch(actor: Actor, id: string): Promise<Batch> {
    return this.db.withTenant(actor.tenantId, async () => {
      const batch = await this.repos.batchRepo.findById(id);
      // Same NotFoundError for "doesn't exist" and "exists but belongs to
      // another tenant" — a 403 would confirm the batch exists to someone
      // who has no business knowing that. (RLS already hides other tenants'
      // rows; the explicit check documents the intent.)
      if (!batch || batch.tenantId !== actor.tenantId) throw new NotFoundError('Batch not found');
      return batch;
    });
  }

  async custodyOf(actor: Actor, id: string): Promise<CustodyView> {
    return this.db.withTenant(actor.tenantId, async () => {
      const batch = await this.repos.batchRepo.findById(id);
      if (!batch || batch.tenantId !== actor.tenantId) throw new NotFoundError('Batch not found');
      const [transfers, holds] = await Promise.all([this.repos.custodyRepo.transfersOf(id), this.repos.custodyRepo.holdsOf(id)]);
      return { transfers, holds };
    });
  }

  // ── Recording a workflow step ───────────────────────────────────────────

  /**
   * One transaction, one row lock: the batch row is locked FOR UPDATE, so
   * concurrent recordings on the same batch — from this process or any other
   * replica — serialise, and each sees the head left by the previous one.
   * The ledger trigger re-validates the linkage at INSERT time as a backstop.
   * Realtime pushes happen only after COMMIT, so nobody is ever notified
   * about an event that was rolled back.
   *
   * Beyond the stage record itself (docs/SPEC_PHASE1_5.md):
   *   • the stage must belong to the lot's workflow, be the actor's to record,
   *     and not jump over a required step;
   *   • `data` must satisfy the field schema of the product group × stage;
   *   • `occurredAt` may lie in the past, with a reason past the product's limit;
   *   • an inspection with result FAIL rejects the lot; PASS_WITH_CONDITIONS
   *     opens a QC_CONDITION alert; an inspector from the organization that
   *     worked the lot raises CONFLICT_OF_INTEREST;
   *   • handing the lot to someone else opens a transfer they must accept.
   */
  async recordEvent(actor: Actor, dto: RecordEventDTO): Promise<TraceEvent> {
    const { event, newAnomalies, recipients, transfer } = await this.db.withTenant(actor.tenantId, async () => {
      const batch = await this.lockBatch(actor, dto.batchId);
      this.assertWorkable(batch);
      this.assertCustody(actor, batch);

      const rules = await this.catalogCtx.rulesFor(batch);
      if (!rules.has(dto.stage)) throw new ConflictError(`Stage ${dto.stage} is not part of this lot's workflow`);
      if (!rules.canRecord(actor.role, dto.stage)) {
        throw new ForbiddenError(`Role ${actor.role} is not permitted to record stage ${dto.stage}`);
      }
      const currentPos = rules.position(batch.currentStage) ?? 0;
      const newPos = rules.position(dto.stage)!;
      const advancing = newPos > currentPos;
      if (advancing) {
        const skipped = rules.skippedRequired(currentPos, newPos, batch);
        if (skipped.length > 0) {
          throw new ConflictError(`Required stage ${skipped.map((s) => s.stage).join(', ')} must be recorded before ${dto.stage}`);
        }
      }

      // Field schema of this product group × stage.
      const category = await this.catalogCtx.categoryOf(batch);
      const schema = await this.repos.catalogRepo.currentSchema(category, dto.stage);
      const data: Record<string, unknown> = { ...(dto.data ?? {}) };
      const issues = validateEventData(schema, data);
      if (issues.length > 0) throw new ValidationError(`Invalid event data: ${issues.map((i) => i.message).join('; ')}`, issues);

      // When it happened.
      const settings = await this.repos.catalogRepo.productSettings(batch.productTypeId);
      const time = checkOccurredAt(
        dto.occurredAt,
        new Date(),
        await this.repos.eventRepo.lastOccurredAt(batch.id),
        settings.maxBackdateDays,
        dto.lateReason,
      );
      if (time.late) data.lateReason = dto.lateReason!.trim();

      // Who holds the lot afterwards — resolved (and validated) before anything is written.
      const stageKind = rules.kind(dto.stage);
      const result = stageKind === 'INSPECTION' ? String(data.result ?? '') : '';
      const failed = result === 'FAIL';
      const custodian = batch.assignedToActorId ?? actor.id;
      let next: string | null = batch.assignedToActorId ?? null;
      if (failed) {
        // The rejected goods go back to whoever will rework or dispose of them — or stay put.
        next = dto.assignNextTo ? await this.validateParty(actor, dto.assignNextTo) : custodian;
      } else if (advancing) {
        if (rules.isFinal(dto.stage)) next = null;
        else if (rules.nextIsExternal(newPos, batch)) next = custodian; // e.g. after EXPORT: the buyer confirms by link
        else next = await resolveNextAssignee(this.repos.actorRepo, actor, rules, newPos, dto.assignNextTo, { batch });
      }
      const handOver = next !== null && next !== custodian;

      const event = await this.ledger.append(batch, {
        stage: dto.stage,
        kind: 'OBSERVE',
        actor,
        location: dto.location,
        notes: dto.notes,
        data,
        occurredAt: time.occurredAt,
        fieldSchemaId: schema?.id,
      });

      const allEvents = await this.repos.eventRepo.findByBatchId(batch.id);
      const stored: Anomaly[] = [];
      for (const anomaly of detectNewAnomalies(allEvents, rules)) {
        stored.push(await this.repos.anomalyRepo.create({ ...anomaly, tenantId: batch.tenantId }));
      }
      const label = rules.label(dto.stage);
      if (time.late) {
        stored.push(
          await this.flag(batch, 'LATE_ENTRY', 'MEDIUM', `Khâu "${label}" được ghi ${time.daysLate} ngày sau khi xảy ra (giới hạn ${settings.maxBackdateDays} ngày). Lý do: ${data.lateReason}`, event.id),
        );
      }
      if (stageKind === 'INSPECTION') {
        if (result === 'PASS_WITH_CONDITIONS') {
          stored.push(
            await this.flag(batch, 'QC_CONDITION', 'LOW', `Đạt có điều kiện: ${data.conditions} — hạn ${data.conditionDueDate}. Xử lý cảnh báo này khi điều kiện đã được đáp ứng.`, event.id),
          );
        }
        const conflict = await this.inspectionConflict(actor, allEvents, event.id);
        if (conflict) {
          stored.push(
            await this.flag(batch, 'CONFLICT_OF_INTEREST', 'MEDIUM', `Kiểm định do "${conflict}" thực hiện — cùng đơn vị đã xử lý lô ở khâu trước`, event.id),
          );
        }
      }

      const holder = handOver ? custodian : next;
      if (advancing) {
        await this.repos.batchRepo.advanceStage(batch.id, dto.stage, holder);
        batch.currentStage = dto.stage;
        batch.assignedToActorId = holder ?? undefined;
      } else if (failed && holder !== (batch.assignedToActorId ?? null)) {
        await this.repos.batchRepo.reassign(batch.id, holder);
        batch.assignedToActorId = holder ?? undefined;
      }
      if (failed) batch.status = (await this.repos.batchRepo.setStatus(batch.id, 'REJECTED')).status;

      let transfer: Transfer | undefined;
      // The hand-over happens as the step ends — same moment.
      if (handOver) transfer = await this.openTransfer(batch, actor, custodian, next!, { location: dto.location, occurredAt: time.occurredAt });

      await this.audit(actor, 'EVENT_RECORDED', 'trace_event', event.id, { batchId: batch.id, stage: dto.stage, result: result || undefined });

      const recipients =
        stored.length > 0 ? getInvolvedActorIds(allEvents, { createdBy: batch.createdBy, assignedToActorId: next ?? undefined }) : [];
      return { event, newAnomalies: stored, recipients, transfer };
    });

    for (const anomaly of newAnomalies) this.realtime?.emitAnomaly(anomaly, recipients);
    if (transfer) this.realtime?.emitTransfer?.(transfer, [transfer.toActorId]);
    return event;
  }

  /** The organization of an earlier recorder of this lot that the inspector also belongs to, if any. */
  private async inspectionConflict(inspector: Actor, events: TraceEvent[], inspectionEventId: string): Promise<string | null> {
    const org = inspector.organization.trim().toLowerCase();
    if (!org) return null;
    const others = new Set(events.filter((e) => e.id !== inspectionEventId && isStageEvent(e.kind) && e.actorId !== inspector.id).map((e) => e.actorId));
    for (const id of others) {
      const a = await this.repos.actorRepo.findById(id);
      if (a && a.role !== 'INSPECTOR' && a.organization.trim().toLowerCase() === org) return inspector.organization;
    }
    return null;
  }

  // ── Hand-over with receiver confirmation ────────────────────────────────

  /**
   * Hands a lot to someone without recording a stage — e.g. the mill kept the
   * green beans after a transformation and now passes them to QC, or a
   * rejected lot goes back to the processor for rework. The lot is IN_TRANSIT
   * until the receiver accepts (with the quantity they weighed) or rejects it.
   */
  async createTransfer(actor: Actor, batchId: string, dto: CreateTransferDTO): Promise<Transfer> {
    const transfer = await this.db.withTenant(actor.tenantId, async () => {
      const batch = await this.lockBatch(actor, batchId);
      if (batch.status === 'IN_TRANSIT') throw new ConflictError('A hand-over is already waiting for the receiver');
      if (batch.status !== 'REJECTED') this.assertWorkable(batch);
      if (remainingOf(batch) <= EPSILON) throw new ConflictError('Batch has been fully consumed by a merge, split or transformation');
      this.assertCustody(actor, batch);

      const rules = await this.catalogCtx.rulesFor(batch);
      let to: string;
      if (batch.status === 'REJECTED') {
        to = await this.validateParty(actor, dto.toActorId);
      } else {
        if (rules.isFinal(batch.currentStage)) throw new ConflictError('Batch has completed its journey');
        const position = rules.position(batch.currentStage) ?? 0;
        to = (await resolveNextAssignee(this.repos.actorRepo, actor, rules, position, dto.toActorId, { sameStageAllowed: true, batch }))!;
      }
      const custodian = batch.assignedToActorId ?? actor.id;
      if (to === custodian) throw new ConflictError('The lot is already with this person');
      const occurredAt = await this.declaredTime(batch, dto.occurredAt, dto.lateReason);
      return this.openTransfer(batch, actor, custodian, to, { ...dto, occurredAt });
    });
    this.realtime?.emitTransfer?.(transfer, [transfer.toActorId]);
    return transfer;
  }

  /**
   * For another service already inside the tenant's transaction: hand a lot
   * to a receiver it has validated. The caller notifies (notifyTransfer) after
   * its transaction commits.
   */
  async transferInScope(actor: Actor, batchId: string, toActorId: string, opts: Partial<CreateTransferDTO> = {}): Promise<Transfer> {
    const batch = await this.lockBatch(actor, batchId);
    return this.openTransfer(batch, actor, batch.assignedToActorId ?? actor.id, toActorId, opts);
  }

  notifyTransfer(transfer: Transfer): void {
    this.realtime?.emitTransfer?.(transfer, [transfer.toActorId]);
  }

  /** Backward-compatible name for createTransfer (POST /batches/:id/handoff). */
  async handOff(actor: Actor, id: string, toActorId: string): Promise<Batch> {
    await this.createTransfer(actor, id, { toActorId });
    return this.getBatch(actor, id);
  }

  /** Writes TRANSFER_OUT, opens the transfer and puts the lot IN_TRANSIT. Caller holds the lot's lock. */
  private async openTransfer(
    batch: Batch,
    actor: Actor,
    fromActorId: string,
    toActorId: string,
    opts: Partial<CreateTransferDTO>,
  ): Promise<Transfer> {
    if (batch.status !== 'ACTIVE' && batch.status !== 'REJECTED') throw new ConflictError(`Batch is ${batch.status} and cannot be handed over`);
    if (await this.repos.custodyRepo.pendingTransferFor(batch.id)) throw new ConflictError('A hand-over is already waiting for the receiver');
    const rules = await this.catalogCtx.rulesFor(batch);
    const quantity = remainingOf(batch);
    const data: Record<string, unknown> = { toActorId, quantity, unit: batch.unit };
    if (opts.packageCount) data.packageCount = opts.packageCount;
    if (opts.vehicle) data.vehicle = opts.vehicle;
    if (opts.documentNo) data.documentNo = opts.documentNo;
    const event = await this.ledger.append(batch, {
      stage: batch.currentStage ?? rules.steps[0].stage,
      kind: 'TRANSFER_OUT',
      actor,
      location: opts.location || actor.organization || '—',
      notes: opts.notes,
      data,
      occurredAt: opts.occurredAt ?? (await this.custodyTime(batch)),
    });
    const transfer = await this.repos.custodyRepo.createTransfer({
      id: uuidv4(),
      tenantId: batch.tenantId,
      batchId: batch.id,
      fromActorId,
      toActorId,
      previousStatus: batch.status,
      quantity,
      unit: batch.unit,
      packageCount: opts.packageCount,
      vehicle: opts.vehicle,
      documentNo: opts.documentNo,
      createdAt: event.timestamp,
      outEventId: event.id,
    });
    batch.status = (await this.repos.batchRepo.setStatus(batch.id, 'IN_TRANSIT')).status;
    await this.audit(actor, 'TRANSFER_CREATED', 'batch', batch.id, { transferId: transfer.id, from: fromActorId, to: toActorId, quantity });
    return transfer;
  }

  /**
   * The receiver answers a hand-over. Accepting moves custody and records the
   * weighed quantity — a shortfall becomes lost quantity, and beyond the
   * product's tolerance a QUANTITY_DISCREPANCY alert. Rejecting returns the
   * lot to the sender. Either way the answer is a ledger event.
   */
  async respondTransfer(actor: Actor, transferId: string, dto: RespondTransferDTO): Promise<{ transfer: Transfer; batch: Batch }> {
    const { transfer, batch, anomaly, recipients } = await this.db.withTenant(actor.tenantId, async () => {
      const pending = await this.repos.custodyRepo.findTransferForUpdate(transferId);
      if (!pending || pending.tenantId !== actor.tenantId) throw new NotFoundError('Transfer not found');
      if (pending.status !== 'PENDING') throw new ConflictError('Transfer has already been answered');
      if (actor.role !== 'ADMIN' && pending.toActorId !== actor.id) throw new ForbiddenError('This transfer is not addressed to you');
      const lot = await this.lockBatch(actor, pending.batchId);
      if (lot.status === 'ON_HOLD') throw new ConflictError('Batch is on hold pending investigation');
      if (lot.status !== 'IN_TRANSIT') throw new ConflictError(`Batch is ${lot.status}, not in transit`);
      const rules = await this.catalogCtx.rulesFor(lot);
      const stage = lot.currentStage ?? rules.steps[0].stage;
      const location = dto.location || actor.organization || '—';
      const occurredAt = await this.declaredTime(lot, dto.occurredAt, dto.lateReason);

      let anomaly: Anomaly | undefined;
      let answered: Transfer;
      if (dto.accept) {
        const received = dto.receivedQuantity;
        if (received === undefined || !Number.isFinite(received) || received < 0) {
          throw new ValidationError('receivedQuantity is required to accept', [
            { field: 'receivedQuantity', code: 'required', message: 'receivedQuantity is required to accept' },
          ]);
        }
        if (received > pending.quantity + EPSILON) {
          throw new ValidationError('More was received than was sent', [
            { field: 'receivedQuantity', code: 'above_max', message: `receivedQuantity must be at most ${pending.quantity}` },
          ]);
        }
        const event = await this.ledger.append(lot, {
          stage,
          kind: 'TRANSFER_ACCEPT',
          actor,
          location,
          data: { transferId: pending.id, receivedQuantity: received, unit: pending.unit },
          occurredAt,
        });
        const shortfall = pending.quantity - received;
        const updated = await this.repos.batchRepo.setStatus(lot.id, pending.previousStatus, {
          assignedToActorId: pending.toActorId,
          addLost: shortfall > EPSILON ? shortfall : undefined,
        });
        Object.assign(lot, updated);
        const settings = await this.repos.catalogRepo.productSettings(lot.productTypeId);
        if (shortfall > pending.quantity * settings.transitLossTolerance + EPSILON) {
          const pct = ((shortfall / pending.quantity) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
          const tol = (settings.transitLossTolerance * 100).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
          anomaly = await this.flag(
            lot,
            'QUANTITY_DISCREPANCY',
            'HIGH',
            `Bàn giao thiếu ${shortfall.toLocaleString('vi-VN')} ${pending.unit} (${pct}%) — gửi ${pending.quantity.toLocaleString('vi-VN')}, nhận ${received.toLocaleString('vi-VN')}; mức cho phép ${tol}%`,
            event.id,
          );
        }
        answered = await this.repos.custodyRepo.respond(pending.id, 'ACCEPTED', {
          receivedQuantity: received,
          respondedAt: event.timestamp,
          responseEventId: event.id,
        });
        await this.audit(actor, 'TRANSFER_ACCEPTED', 'batch', lot.id, { transferId: pending.id, receivedQuantity: received, shortfall });
      } else {
        const reason = dto.reason?.trim();
        if (!reason) {
          throw new ValidationError('A reason is required to reject', [{ field: 'reason', code: 'required', message: 'reason is required to reject' }]);
        }
        const event = await this.ledger.append(lot, {
          stage,
          kind: 'TRANSFER_REJECT',
          actor,
          location,
          data: { transferId: pending.id, reason },
          occurredAt,
        });
        Object.assign(lot, await this.repos.batchRepo.setStatus(lot.id, pending.previousStatus));
        answered = await this.repos.custodyRepo.respond(pending.id, 'REJECTED', { reason, respondedAt: event.timestamp, responseEventId: event.id });
        await this.audit(actor, 'TRANSFER_REJECTED', 'batch', lot.id, { transferId: pending.id, reason });
      }
      return { transfer: answered, batch: lot, anomaly, recipients: [pending.fromActorId, pending.toActorId] };
    });
    if (anomaly) this.realtime?.emitAnomaly(anomaly, recipients);
    this.realtime?.emitTransfer?.(transfer, [transfer.fromActorId]);
    return { transfer, batch };
  }

  /** The sender (or ADMIN) withdraws a hand-over the receiver hasn't answered. */
  async cancelTransfer(actor: Actor, transferId: string): Promise<{ transfer: Transfer; batch: Batch }> {
    return this.db.withTenant(actor.tenantId, async () => {
      const pending = await this.repos.custodyRepo.findTransferForUpdate(transferId);
      if (!pending || pending.tenantId !== actor.tenantId) throw new NotFoundError('Transfer not found');
      if (pending.status !== 'PENDING') throw new ConflictError('Transfer has already been answered');
      if (actor.role !== 'ADMIN' && pending.fromActorId !== actor.id) throw new ForbiddenError('Only the sender can cancel this transfer');
      const lot = await this.lockBatch(actor, pending.batchId);
      if (lot.status === 'ON_HOLD') throw new ConflictError('Batch is on hold pending investigation');
      const rules = await this.catalogCtx.rulesFor(lot);
      const event = await this.ledger.append(lot, {
        stage: lot.currentStage ?? rules.steps[0].stage,
        kind: 'TRANSFER_CANCEL',
        actor,
        location: actor.organization || '—',
        data: { transferId: pending.id },
        occurredAt: await this.custodyTime(lot),
      });
      Object.assign(lot, await this.repos.batchRepo.setStatus(lot.id, pending.previousStatus));
      const transfer = await this.repos.custodyRepo.respond(pending.id, 'CANCELLED', { respondedAt: event.timestamp, responseEventId: event.id });
      await this.audit(actor, 'TRANSFER_CANCELLED', 'batch', lot.id, { transferId: pending.id });
      return { transfer, batch: lot };
    });
  }

  async listIncomingTransfers(actor: Actor): Promise<IncomingTransfer[]> {
    return this.db.withTenant(actor.tenantId, () =>
      this.repos.custodyRepo.incoming(actor.tenantId, actor.id, actor.role === 'ADMIN'),
    );
  }

  async listOutgoingTransfers(actor: Actor): Promise<Transfer[]> {
    return this.db.withTenant(actor.tenantId, () => this.repos.custodyRepo.outgoing(actor.tenantId, actor.id));
  }

  // ── Holds ───────────────────────────────────────────────────────────────

  /** Freezes a lot pending investigation (ADMIN/INSPECTOR). */
  async holdBatch(actor: Actor, id: string, reason: string): Promise<Batch> {
    if (!OVERSIGHT_ROLES.includes(actor.role)) throw new ForbiddenError('Only an admin or inspector can put a lot on hold');
    return this.db.withTenant(actor.tenantId, async () => {
      const batch = await this.lockBatch(actor, id);
      await this.placeHold(batch, actor, reason.trim());
      return batch;
    });
  }

  /** Caller holds the lot's lock. */
  private async placeHold(batch: Batch, actor: Actor, reason: string, sourceBatchId?: string): Promise<BatchHold> {
    if (batch.status !== 'ACTIVE' && batch.status !== 'IN_TRANSIT' && batch.status !== 'REJECTED') {
      throw new ConflictError(`Batch is ${batch.status} and cannot be put on hold`);
    }
    const rules = await this.catalogCtx.rulesFor(batch);
    const data: Record<string, unknown> = { reason };
    if (sourceBatchId) data.sourceLotId = sourceBatchId;
    const event = await this.ledger.append(batch, {
      stage: batch.currentStage ?? rules.steps[0].stage,
      kind: 'HOLD',
      actor,
      location: actor.organization || '—',
      data,
      occurredAt: await this.custodyTime(batch),
    });
    const hold = await this.repos.custodyRepo.createHold({
      id: uuidv4(),
      tenantId: batch.tenantId,
      batchId: batch.id,
      reason,
      sourceBatchId,
      previousStatus: batch.status,
      heldBy: actor.id,
      heldAt: event.timestamp,
      holdEventId: event.id,
    });
    batch.status = (await this.repos.batchRepo.setStatus(batch.id, 'ON_HOLD')).status;
    await this.audit(actor, 'BATCH_HELD', 'batch', batch.id, { reason, sourceBatchId });
    return hold;
  }

  /** Ends a hold (ADMIN/INSPECTOR, with a reason): the lot returns to the status it had. */
  async releaseBatch(actor: Actor, id: string, reason: string): Promise<Batch> {
    if (!OVERSIGHT_ROLES.includes(actor.role)) throw new ForbiddenError('Only an admin or inspector can release a hold');
    return this.db.withTenant(actor.tenantId, async () => {
      const batch = await this.lockBatch(actor, id);
      if (batch.status !== 'ON_HOLD') throw new ConflictError('Batch is not on hold');
      const hold = await this.repos.custodyRepo.openHold(batch.id);
      if (!hold) throw new ConflictError('Batch is not on hold');
      const rules = await this.catalogCtx.rulesFor(batch);
      const event = await this.ledger.append(batch, {
        stage: batch.currentStage ?? rules.steps[0].stage,
        kind: 'RELEASE',
        actor,
        location: actor.organization || '—',
        data: { reason: reason.trim() },
        occurredAt: await this.custodyTime(batch),
      });
      await this.repos.custodyRepo.releaseHold(hold.id, { releasedBy: actor.id, reason: reason.trim(), at: event.timestamp, eventId: event.id });
      const updated = await this.repos.batchRepo.setStatus(batch.id, hold.previousStatus);
      await this.audit(actor, 'BATCH_RELEASED', 'batch', batch.id, { reason: reason.trim() });
      return updated;
    });
  }

  // ── Recall, along the lineage ───────────────────────────────────────────

  /** Backward-compatible: recall without cascading, returning just the lot. */
  async recallBatch(actor: Actor, id: string, reason: string): Promise<Batch> {
    return (await this.recall(actor, id, { reason })).batch;
  }

  /**
   * "One step back, one step forward" (EU 178/2002 art. 18 — the GS1 recall
   * guideline): recalling a lot also deals with every lot made from it —
   * put ON_HOLD for investigation, or recalled outright with `cascade` — and
   * flags the lots it came from and its siblings for investigation. Lots that
   * were only merged together with it are untouched: they don't contain it.
   * Everything happens in one transaction; every status change is a ledger event.
   */
  async recall(actor: Actor, id: string, dto: RecallDTO): Promise<RecallResult> {
    const reason = dto.reason.trim();
    const outcome = await this.db.withTenant(actor.tenantId, async () => {
      const lot = await this.lockBatch(actor, id);
      if (lot.status === 'RECALLED') throw new ConflictError('Batch has already been recalled');
      if (lot.status === 'DESTROYED') throw new ConflictError('Batch has been destroyed');

      const [down, up] = await Promise.all([this.repos.lineageRepo.edges(lot.id, 'down'), this.repos.lineageRepo.edges(lot.id, 'up')]);
      const descendants = [...new Set(down.map((e) => e.toLotId))].filter((x) => x !== lot.id).sort();
      const ancestors = new Set(up.map((e) => e.fromLotId));
      const parents = [...new Set(up.filter((e) => e.toLotId === lot.id).map((e) => e.fromLotId))];
      const siblings = new Set<string>();
      for (const p of parents) {
        for (const e of await this.repos.lineageRepo.edges(p, 'down')) {
          if (e.fromLotId === p && e.toLotId !== lot.id && !descendants.includes(e.toLotId)) siblings.add(e.toLotId);
        }
      }

      const recalled: Batch[] = [];
      const recalledIds: string[] = [];
      const heldIds: string[] = [];
      const flagged: Anomaly[] = [];

      await this.recallOne(lot, actor, reason);
      recalled.push(lot);

      // Forward: everything made from it.
      for (const dId of descendants) {
        const d = await this.repos.batchRepo.findByIdForUpdate(dId);
        if (!d || d.status === 'RECALLED' || d.status === 'DESTROYED') continue;
        const why = `Lô nguyên liệu "${lot.productName}" bị thu hồi: ${reason}`;
        if (dto.cascade) {
          await this.recallOne(d, actor, why, lot.id);
          recalled.push(d);
          recalledIds.push(d.id);
        } else if (d.status === 'ACTIVE' || d.status === 'IN_TRANSIT' || d.status === 'REJECTED') {
          await this.placeHold(d, actor, why, lot.id);
          heldIds.push(d.id);
        }
      }

      // Backward and sideways: investigate, don't block.
      const toFlag = [...new Set([...ancestors, ...siblings])].filter((x) => x !== lot.id && !descendants.includes(x));
      for (const fId of toFlag.sort()) {
        const f = await this.repos.batchRepo.findById(fId);
        if (!f || f.status === 'RECALLED' || f.status === 'DESTROYED') continue;
        const relation = ancestors.has(fId) ? 'được dùng làm nguyên liệu cho' : 'cùng nguồn với';
        flagged.push(
          await this.flag(
            f,
            'RECALL_INVESTIGATION',
            'MEDIUM',
            `Lô này ${relation} lô "${lot.productName}" vừa bị thu hồi (${reason}) — cần điều tra`,
          ),
        );
      }

      const affected = [...recalled, ...(await this.repos.batchRepo.findByIds(heldIds))];
      const events = await this.repos.eventRepo.findByBatchIds(affected.map((b) => b.id));
      const recipients = [...new Set(affected.flatMap((b) => getInvolvedActorIds(events.filter((e) => e.batchId === b.id), b)))];
      const fresh = await this.repos.batchRepo.findById(lot.id);
      return {
        result: { batch: fresh!, recalledLotIds: recalledIds, heldLotIds: heldIds, flaggedLotIds: flagged.map((a) => a.batchId) },
        recalled: await this.repos.batchRepo.findByIds(recalled.map((b) => b.id)),
        flagged,
        recipients,
      };
    });
    for (const b of outcome.recalled) this.realtime?.emitRecall(b, outcome.recipients);
    for (const a of outcome.flagged) this.realtime?.emitAnomaly(a, outcome.recipients);
    return outcome.result;
  }

  /** RECALL on one lot: closes a pending hand-over or an open hold first. Caller holds the lock. */
  private async recallOne(batch: Batch, actor: Actor, reason: string, sourceBatchId?: string): Promise<void> {
    const rules = await this.catalogCtx.rulesFor(batch);
    const data: Record<string, unknown> = { reason };
    if (sourceBatchId) data.sourceLotId = sourceBatchId;
    const event = await this.ledger.append(batch, {
      stage: batch.currentStage ?? rules.steps[0].stage,
      kind: 'RECALL',
      actor,
      location: actor.organization || '—',
      data,
      occurredAt: await this.custodyTime(batch),
    });
    const pending = await this.repos.custodyRepo.pendingTransferFor(batch.id);
    if (pending) {
      await this.repos.custodyRepo.respond(pending.id, 'CANCELLED', { reason: 'Lô bị thu hồi', respondedAt: event.timestamp, responseEventId: event.id });
    }
    const hold = await this.repos.custodyRepo.openHold(batch.id);
    if (hold) {
      await this.repos.custodyRepo.releaseHold(hold.id, { releasedBy: actor.id, reason: 'Lô bị thu hồi', at: event.timestamp, eventId: event.id });
    }
    Object.assign(batch, await this.repos.batchRepo.setStatus(batch.id, 'RECALLED', { recallReason: reason }));
    // Kept as the action name the notification feed reads (adminService).
    await this.audit(actor, 'BATCH_RECALLED', 'batch', batch.id, { reason, sourceBatchId });
  }

  // ── Disposal ────────────────────────────────────────────────────────────

  /**
   * Destroys what remains of a lot, with a record (biên bản): number, method,
   * witness. ADMIN/INSPECTOR always; the custodian of a lot that failed
   * inspection too. The remainder becomes lost quantity; the lot is final.
   */
  async disposeBatch(actor: Actor, id: string, dto: DisposeDTO): Promise<Batch> {
    return this.db.withTenant(actor.tenantId, async () => {
      const batch = await this.lockBatch(actor, id);
      const allowed =
        OVERSIGHT_ROLES.includes(actor.role) || (batch.status === 'REJECTED' && batch.assignedToActorId === actor.id);
      if (!allowed) throw new ForbiddenError('Only an admin, an inspector, or the holder of a rejected lot can dispose of it');
      if (!['ACTIVE', 'REJECTED', 'ON_HOLD', 'RECALLED'].includes(batch.status)) {
        throw new ConflictError(`Batch is ${batch.status} and cannot be disposed of`);
      }
      const remaining = remainingOf(batch);
      const rules = await this.catalogCtx.rulesFor(batch);
      const settings = await this.repos.catalogRepo.productSettings(batch.productTypeId);
      const time = checkOccurredAt(dto.occurredAt, new Date(), await this.repos.eventRepo.lastOccurredAt(batch.id), settings.maxBackdateDays, dto.reason);
      const data: Record<string, unknown> = {
        recordNo: dto.recordNo.trim(),
        method: dto.method.trim(),
        witness: dto.witness.trim(),
        quantity: remaining,
        unit: batch.unit,
      };
      if (dto.reason?.trim()) data.reason = dto.reason.trim();
      const event = await this.ledger.append(batch, {
        stage: batch.currentStage ?? rules.steps[0].stage,
        kind: 'DISPOSE',
        actor,
        location: actor.organization || '—',
        data,
        occurredAt: time.occurredAt,
      });
      const hold = await this.repos.custodyRepo.openHold(batch.id);
      if (hold) {
        await this.repos.custodyRepo.releaseHold(hold.id, { releasedBy: actor.id, reason: 'Lô đã được huỷ', at: event.timestamp, eventId: event.id });
      }
      const updated = await this.repos.batchRepo.setStatus(batch.id, 'DESTROYED', {
        addLost: remaining > EPSILON ? remaining : undefined,
        assignedToActorId: null,
      });
      await this.audit(actor, 'BATCH_DISPOSED', 'batch', batch.id, { recordNo: data.recordNo, quantity: remaining });
      return updated;
    });
  }

  // ── The foreign buyer confirms arrival (no account) ─────────────────────

  /**
   * After EXPORT, the exporter issues a time-limited link for the buyer. The
   * buyer becomes an IMPORTER actor of this tenant (no password — it can't
   * sign in) so their confirmation is an ordinary, attributable ledger event.
   */
  async createReceiptLink(actor: Actor, batchId: string, importerName: string, days: number): Promise<ReceiptLink> {
    if (actor.role !== 'EXPORTER' && actor.role !== 'ADMIN') throw new ForbiddenError('Only the exporter can issue a receipt link');
    return this.db.withTenant(actor.tenantId, async () => {
      const batch = await this.lockBatch(actor, batchId);
      const rules = await this.catalogCtx.rulesFor(batch);
      if (!batch.currentStage || rules.kind(batch.currentStage) !== 'EXPORT') throw new ConflictError('The lot has not been exported yet');
      const receipt = rules.steps.find((s) => rules.kind(s.stage) === 'RECEIPT');
      if (!receipt) throw new ConflictError("This lot's workflow has no receipt step");
      if (batch.status !== 'ACTIVE') throw new ConflictError(`Batch is ${batch.status}`);

      const importerId = uuidv4();
      const name = importerName.trim();
      await this.repos.actorRepo.create({
        id: importerId,
        name,
        email: `importer-${importerId}@receipt.tracechain.local`,
        passwordHash: '!', // never a valid bcrypt hash: this account cannot sign in
        role: 'IMPORTER',
        organization: name,
        tenantId: actor.tenantId,
        createdAt: new Date(),
        isActive: true,
      });
      const expiresInSeconds = Math.round(days * 24 * 60 * 60);
      const token = jwt.sign({ typ: RECEIPT_TOKEN_TYPE, bid: batch.id, tid: batch.tenantId, aid: importerId }, this.tokenSecret, {
        expiresIn: expiresInSeconds,
      });
      await this.audit(actor, 'RECEIPT_LINK_CREATED', 'batch', batch.id, { importer: name, importerActorId: importerId, days });
      return { token, expiresAt: new Date(Date.now() + expiresInSeconds * 1000), importerActorId: importerId };
    });
  }

  private verifyReceiptToken(batchId: string, token: string): { tenantId: string; importerId: string; expiresAt?: Date } {
    try {
      const c = jwt.verify(token, this.tokenSecret) as { typ?: string; bid?: string; tid?: string; aid?: string; exp?: number };
      if (c.typ === RECEIPT_TOKEN_TYPE && c.bid === batchId && c.tid && c.aid) {
        return { tenantId: c.tid, importerId: c.aid, expiresAt: c.exp ? new Date(c.exp * 1000) : undefined };
      }
    } catch {
      // fall through
    }
    throw new ForbiddenError('Receipt link is invalid or has expired');
  }

  async receiptInfo(batchId: string, token: string): Promise<ReceiptInfo> {
    const { tenantId, importerId, expiresAt } = this.verifyReceiptToken(batchId, token);
    return this.db.withTenant(tenantId, async () => {
      const batch = await this.repos.batchRepo.findById(batchId);
      if (!batch) throw new NotFoundError('Batch not found');
      const rules = await this.catalogCtx.rulesFor(batch);
      const events = await this.repos.eventRepo.findByBatchId(batchId);
      const exportEvent = [...events].reverse().find((e) => e.kind === 'OBSERVE' && rules.kind(e.stage) === 'EXPORT');
      const exporter = exportEvent ? await this.repos.actorRepo.findById(exportEvent.actorId) : null;
      const importer = await this.repos.actorRepo.findById(importerId);
      return {
        batchId,
        productName: batch.productName,
        quantity: remainingOf(batch),
        unit: batch.unit,
        exporter: exporter?.organization ?? '',
        importer: importer?.organization ?? '',
        exportData: exportEvent?.data ?? {},
        alreadyReceived: !!batch.currentStage && rules.kind(batch.currentStage) === 'RECEIPT',
        expiresAt,
      };
    });
  }

  async recordImportReceipt(batchId: string, token: string, dto: ImportReceiptDTO): Promise<TraceEvent> {
    const { tenantId, importerId } = this.verifyReceiptToken(batchId, token);
    const { event, anomaly, recipients } = await this.db.withTenant(tenantId, async () => {
      const importer = await this.repos.actorRepo.findById(importerId);
      if (!importer || importer.role !== 'IMPORTER' || !importer.isActive) throw new ForbiddenError('Receipt link is invalid or has expired');
      const batch = await this.lockBatch(importer, batchId);
      const rules = await this.catalogCtx.rulesFor(batch);
      if (batch.currentStage && rules.kind(batch.currentStage) === 'RECEIPT') throw new ConflictError('Receipt has already been confirmed');
      if (!batch.currentStage || rules.kind(batch.currentStage) !== 'EXPORT') throw new ConflictError('The lot has not been exported yet');
      this.assertWorkable(batch);
      const step = rules.steps.find((s) => rules.kind(s.stage) === 'RECEIPT')!;

      const category = await this.catalogCtx.categoryOf(batch);
      const schema = await this.repos.catalogRepo.currentSchema(category, step.stage);
      const data: Record<string, unknown> = { receivedQuantity: dto.receivedQuantity, condition: dto.condition };
      const issues = validateEventData(schema, data);
      if (issues.length > 0) throw new ValidationError(`Invalid event data: ${issues.map((i) => i.message).join('; ')}`, issues);
      const shipped = remainingOf(batch);
      if (dto.receivedQuantity > shipped + EPSILON) {
        throw new ValidationError('More was received than was shipped', [
          { field: 'receivedQuantity', code: 'above_max', message: `receivedQuantity must be at most ${shipped}` },
        ]);
      }

      const event = await this.ledger.append(batch, {
        stage: step.stage,
        kind: 'OBSERVE',
        actor: importer,
        location: dto.location,
        notes: dto.notes,
        data,
        occurredAt: await this.custodyTime(batch),
        fieldSchemaId: schema?.id,
      });
      await this.repos.batchRepo.advanceStage(batch.id, step.stage, null);
      const shortfall = shipped - dto.receivedQuantity;
      let anomaly: Anomaly | undefined;
      if (shortfall > EPSILON) {
        await this.repos.batchRepo.setStatus(batch.id, 'ACTIVE', { addLost: shortfall });
        const settings = await this.repos.catalogRepo.productSettings(batch.productTypeId);
        if (shortfall > shipped * settings.transitLossTolerance + EPSILON) {
          anomaly = await this.flag(
            batch,
            'QUANTITY_DISCREPANCY',
            'HIGH',
            `Bên nhập khẩu nhận ${dto.receivedQuantity.toLocaleString('vi-VN')} / ${shipped.toLocaleString('vi-VN')} ${batch.unit} — thiếu vượt mức cho phép`,
            event.id,
          );
        }
      }
      await this.audit(importer, 'IMPORT_RECEIVED', 'batch', batch.id, { receivedQuantity: dto.receivedQuantity, condition: dto.condition });
      const events = await this.repos.eventRepo.findByBatchId(batch.id);
      return { event, anomaly, recipients: getInvolvedActorIds(events, batch) };
    });
    if (anomaly) this.realtime?.emitAnomaly(anomaly, recipients);
    return event;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async lockBatch(actor: Pick<Actor, 'tenantId'>, id: string): Promise<Batch> {
    const batch = await this.repos.batchRepo.findByIdForUpdate(id);
    // Same tenant check regardless of role — ADMIN is scoped to its own
    // tenant, not a cross-tenant platform role.
    if (!batch || batch.tenantId !== actor.tenantId) throw new NotFoundError('Batch not found');
    return batch;
  }

  /** Only an ACTIVE lot with goods left can take a stage record or a hand-over. */
  private assertWorkable(batch: Batch): void {
    switch (batch.status) {
      case 'RECALLED':
        throw new ConflictError('Batch has been recalled — no further events allowed');
      case 'DESTROYED':
        throw new ConflictError('Batch has been destroyed');
      case 'CONSUMED':
        throw new ConflictError('Batch has been fully consumed by a merge, split or transformation');
      case 'IN_TRANSIT':
        throw new ConflictError('Batch is in transit — the receiver must accept it first');
      case 'ON_HOLD':
        throw new ConflictError('Batch is on hold pending investigation');
      case 'REJECTED':
        throw new ConflictError('Batch failed inspection — rework, downgrade or dispose of it');
      default:
        if (remainingOf(batch) <= EPSILON) throw new ConflictError('Batch has been fully consumed by a merge, split or transformation');
    }
  }

  /** Throws unless `actor` is the batch's current custodian (or ADMIN, which overrides). */
  private assertCustody(actor: Actor, batch: Pick<Batch, 'assignedToActorId'>): void {
    if (actor.role === 'ADMIN') return;
    if (batch.assignedToActorId && batch.assignedToActorId !== actor.id) {
      throw new ForbiddenError('This batch has not been handed off to you yet');
    }
  }

  /** Someone in the tenant who can physically take goods (not an external importer). */
  private async validateParty(actor: Actor, actorId: string): Promise<string> {
    const other = await this.repos.actorRepo.findById(actorId);
    if (!other || other.tenantId !== actor.tenantId) throw new NotFoundError('Assigned actor not found');
    if (!other.isActive) throw new ConflictError('Assigned actor account is inactive');
    if (other.role === 'IMPORTER') throw new ConflictError('IMPORTER cannot handle stage — use a receipt link');
    return other.id;
  }

  /** A declared time for a custody event, checked like a stage's (defaults to now). */
  private async declaredTime(batch: Batch, declared: Date | undefined, lateReason: string | undefined): Promise<Date> {
    if (!declared) return this.custodyTime(batch);
    const settings = await this.repos.catalogRepo.productSettings(batch.productTypeId);
    return checkOccurredAt(declared, new Date(), await this.repos.eventRepo.lastOccurredAt(batch.id), settings.maxBackdateDays, lateReason).occurredAt;
  }

  /** "Now" for a custody/status event — never before the lot's latest event (clock skew). */
  private async custodyTime(batch: Batch): Promise<Date> {
    const now = new Date();
    const last = await this.repos.eventRepo.lastOccurredAt(batch.id);
    return last && last > now ? last : now;
  }

  private async flag(
    batch: Pick<Batch, 'id' | 'tenantId'>,
    type: AnomalyType,
    severity: AnomalySeverity,
    message: string,
    eventId?: string,
  ): Promise<Anomaly> {
    return this.repos.anomalyRepo.create({
      id: uuidv4(),
      type,
      severity,
      message,
      batchId: batch.id,
      tenantId: batch.tenantId,
      eventId,
      detectedAt: new Date(),
      resolved: false,
    });
  }

  private async audit(
    actor: Actor,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.repos.auditLogRepo.create({
      id: uuidv4(),
      actorId: actor.id,
      tenantId: actor.tenantId,
      action,
      entityType,
      entityId,
      metadata,
      createdAt: new Date(),
    });
  }
}

export type { WorkflowRules };
