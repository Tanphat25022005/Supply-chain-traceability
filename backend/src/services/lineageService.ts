import { v4 as uuidv4 } from 'uuid';
import { Database } from '../db/database';
import { validateEventData } from '../domain/fieldSchema';
import {
  Actor,
  Anomaly,
  AnomalySeverity,
  AnomalyType,
  Batch,
  CreateTransformationDTO,
  EventLink,
  LineageGraph,
  remainingOf,
  TraceEvent,
  TransformationKind,
  TransformationResult,
} from '../domain/types';
import { WorkflowRules } from '../domain/workflow';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { GENESIS_HASH, sortLinks } from '../ledger/hashChain';
import { IActorRepo, IAnomalyRepo, IAuditLogRepo, IBatchRepo, IEventRepo } from '../repository/interfaces';
import { PostgresCatalogRepo, ProductType, Unit } from '../repository/postgres/catalogRepo';
import { PostgresCustodyRepo } from '../repository/postgres/custodyRepo';
import { PostgresLineageRepo } from '../repository/postgres/lineageRepo';
import { CatalogContext } from './catalogContext';
import { resolveNextAssignee } from './custody';
import { checkOccurredAt } from './eventTime';
import { LedgerWriter } from './ledgerWriter';
import { SupplyChainService } from './supplyChainService';

export interface LineageRepos {
  batchRepo: IBatchRepo;
  eventRepo: IEventRepo;
  anomalyRepo: IAnomalyRepo;
  auditLogRepo: IAuditLogRepo;
  actorRepo: IActorRepo;
  lineageRepo: PostgresLineageRepo;
  catalogRepo: PostgresCatalogRepo;
  custodyRepo: PostgresCustodyRepo;
}

/** Roles that may perform each kind of transformation (ADMIN always may). */
const KIND_ROLES: Record<TransformationKind, Actor['role'][]> = {
  MERGE: ['COLLECTOR', 'PROCESSOR', 'WAREHOUSE', 'EXPORTER', 'DISTRIBUTOR', 'ADMIN'],
  SPLIT: ['COLLECTOR', 'PROCESSOR', 'WAREHOUSE', 'EXPORTER', 'DISTRIBUTOR', 'ADMIN'],
  TRANSFORM: ['PROCESSOR', 'ADMIN'],
  // The two remedies after a failed inspection (docs/SPEC_PHASE1_5.md §0.3).
  REWORK: ['PROCESSOR', 'ADMIN'],
  DOWNGRADE: ['PROCESSOR', 'INSPECTOR', 'ADMIN'],
};

/** Rounding slack so 100.0000001 kg out of 100 kg isn't an alarm. */
const EPSILON = 1e-6;

function originOf(inputs: Batch[]): string {
  const unique = [...new Set(inputs.map((b) => b.origin))];
  const text = unique.length <= 3 ? unique.join('; ') : `${unique.slice(0, 3).join('; ')}… (${unique.length} vùng)`;
  return text.slice(0, 200);
}

interface ResolvedOutput {
  productName: string;
  productType: ProductType;
  unit: Unit;
  quantity: number;
}

/**
 * Merging, splitting, transforming, reworking and downgrading lots
 * (docs/SPEC_PHASE1.md §3, SPEC_PHASE1_5.md §0.3) and the lineage graph they
 * produce. Each output lot is born with a hash-chained first event whose
 * `links` commit to the inputs' chain heads, so integrity propagates through
 * the whole graph.
 *
 *   MERGE / SPLIT — same product, ACTIVE inputs;
 *   TRANSFORM     — one product into another, checked against the conversion factor;
 *   REWORK        — a lot that failed inspection is processed again (re-dried,
 *                   re-sorted) into a new lot that must pass inspection again;
 *   DOWNGRADE     — a lot that failed inspection is re-graded at the inspection
 *                   step into a new, lower-grade lot that may go on.
 */
export class LineageService {
  private readonly ledger: LedgerWriter;
  private readonly catalogCtx: CatalogContext;

  constructor(
    private readonly db: Database,
    private readonly repos: LineageRepos,
    /** For hand-overs of the outputs (the receiver confirms) — optional so tooling can run without it. */
    private readonly supplyChain?: Pick<SupplyChainService, 'transferInScope' | 'notifyTransfer'>,
  ) {
    this.ledger = new LedgerWriter(repos.eventRepo);
    this.catalogCtx = new CatalogContext(repos.catalogRepo);
  }

  async createTransformation(actor: Actor, dto: CreateTransformationDTO): Promise<TransformationResult> {
    if (!KIND_ROLES[dto.kind].includes(actor.role)) {
      throw new ForbiddenError(`Role ${actor.role} cannot perform ${dto.kind}`);
    }
    const inputIds = dto.inputs.map((i) => i.lotId);
    if (new Set(inputIds).size !== inputIds.length) throw new ConflictError('The same input lot is listed twice');
    if (dto.kind === 'MERGE' && (dto.inputs.length < 2 || dto.outputs.length !== 1)) {
      throw new ConflictError('A merge takes at least two input lots and produces exactly one');
    }
    if (dto.kind === 'SPLIT' && (dto.inputs.length !== 1 || dto.outputs.length < 2)) {
      throw new ConflictError('A split takes one input lot and produces at least two');
    }
    if ((dto.kind === 'REWORK' || dto.kind === 'DOWNGRADE') && (dto.inputs.length !== 1 || dto.outputs.length !== 1)) {
      throw new ConflictError(`${dto.kind} takes one rejected lot and produces exactly one`);
    }

    const result = await this.db.withTenant(actor.tenantId, async () => {
      // Lock inputs in id order — two concurrent transformations over
      // overlapping lots can then never deadlock, and each sees the other's
      // consumption.
      const inputs: Batch[] = [];
      for (const id of [...inputIds].sort()) {
        const lot = await this.repos.batchRepo.findByIdForUpdate(id);
        if (!lot || lot.tenantId !== actor.tenantId) throw new NotFoundError('Batch not found');
        inputs.push(lot);
      }
      const byId = new Map(inputs.map((b) => [b.id, b]));

      const workflowIds = new Set(inputs.map((b) => b.workflowId));
      if (workflowIds.size !== 1) throw new ConflictError('Input lots follow different workflows and cannot be combined');
      const rules = await this.catalogCtx.rules(inputs[0].workflowId);
      if (!rules.has(dto.stage)) throw new ConflictError(`Stage ${dto.stage} is not part of this lot's workflow`);
      if (dto.kind !== 'DOWNGRADE' && !rules.canRecord(actor.role, dto.stage)) {
        throw new ForbiddenError(`Role ${actor.role} is not permitted to record stage ${dto.stage}`);
      }
      const stagePos = rules.position(dto.stage)!;

      for (const { lotId, quantity } of dto.inputs) {
        this.checkInput(byId.get(lotId)!, actor, rules, dto, stagePos, quantity);
      }

      // ── Products and units of the outputs ──
      const outputs = await this.resolveOutputs(dto, inputs);

      // ── Field data for the stage, validated against the output product's schema ──
      const category = outputs[0].productType.categoryCode;
      const schema = await this.repos.catalogRepo.currentSchema(category, dto.stage);
      const data: Record<string, unknown> = { ...(dto.data ?? {}) };
      const issues = validateEventData(schema, data);
      if (issues.length > 0) throw new ValidationError(`Invalid event data: ${issues.map((i) => i.message).join('; ')}`, issues);
      if (dto.kind === 'DOWNGRADE' && data.result !== 'PASS' && data.result !== 'PASS_WITH_CONDITIONS') {
        throw new ConflictError('A downgrade re-grades the lot so it can go on — record result PASS with the new grade');
      }

      // ── When it happened: not before anything the inputs went through ──
      const settings = await this.repos.catalogRepo.productSettings(inputs[0].productTypeId);
      const time = checkOccurredAt(
        dto.occurredAt,
        new Date(),
        await this.repos.eventRepo.lastOccurredAtAmong(inputIds),
        settings.maxBackdateDays,
        dto.lateReason,
      );
      if (time.late) data.lateReason = dto.lateReason!.trim();

      // Outputs stay with the actor unless handed on — to someone who works this
      // stage (e.g. merge at the collector, then transform at the mill) or a next one.
      const reinspect = dto.kind === 'REWORK';
      const nextAssignee = await resolveNextAssignee(this.repos.actorRepo, actor, rules, stagePos, dto.assignNextTo, {
        sameStageAllowed: true,
        batch: { metadata: { reinspect } },
      });

      const transformationId = uuidv4();
      const now = new Date();
      await this.repos.lineageRepo.createTransformation({
        id: transformationId,
        tenantId: actor.tenantId,
        kind: dto.kind,
        stage: dto.stage,
        actorId: actor.id,
        location: dto.location,
        notes: dto.notes,
        createdAt: now,
      });

      const links: EventLink[] = sortLinks(
        dto.inputs.map(({ lotId, quantity }) => {
          const lot = byId.get(lotId)!;
          return { lotId, quantity, unit: lot.unit, headHash: lot.headHash, eventCount: lot.eventCount };
        }),
      );
      for (const link of links) {
        await this.repos.lineageRepo.addInput({ transformationId, tenantId: actor.tenantId, ...link });
      }

      const created: Batch[] = [];
      const genesisEvents: TraceEvent[] = [];
      for (const out of outputs) {
        const metadata: Record<string, unknown> = { transformationId };
        if (reinspect) metadata.reinspect = true;
        if (dto.kind === 'DOWNGRADE') metadata.downgradedFrom = inputs[0].id;
        const lot = await this.repos.batchRepo.create({
          id: uuidv4(),
          productName: out.productName,
          productType: out.productType.name,
          productTypeId: out.productType.id,
          baseUnit: out.productType.baseUnit,
          unitFactor: out.unit.factor,
          origin: originOf(inputs),
          quantity: out.quantity,
          unit: out.unit.code,
          createdAt: now,
          createdBy: actor.id,
          tenantId: actor.tenantId,
          currentStage: null,
          metadata,
          assignedToActorId: actor.id,
          workflowId: inputs[0].workflowId,
        });
        await this.repos.lineageRepo.addOutput(transformationId, actor.tenantId, lot.id);
        const event = await this.ledger.append(lot, {
          stage: dto.stage,
          kind: dto.kind,
          actor,
          location: dto.location,
          notes: dto.notes,
          data,
          occurredAt: time.occurredAt,
          links,
          fieldSchemaId: schema?.id,
        });
        if (event.prevHash !== GENESIS_HASH) throw new Error('a new lot must start at genesis');
        await this.repos.batchRepo.advanceStage(lot.id, dto.stage, actor.id);
        genesisEvents.push(event);
        created.push(lot);
      }

      const anomalies = await this.checkMassBalance(dto, inputs, outputs, created, genesisEvents);
      for (const [i, lot] of created.entries()) {
        if (time.late) {
          anomalies.push(
            await this.flag(lot, 'LATE_ENTRY', 'MEDIUM', `${dto.kind} ghi ${time.daysLate} ngày sau khi xảy ra (giới hạn ${settings.maxBackdateDays} ngày). Lý do: ${data.lateReason}`, genesisEvents[i].id),
          );
        }
        if (data.result === 'PASS_WITH_CONDITIONS') {
          anomalies.push(
            await this.flag(lot, 'QC_CONDITION', 'LOW', `Đạt có điều kiện: ${data.conditions} — hạn ${data.conditionDueDate}`, genesisEvents[i].id),
          );
        }
      }
      await this.audit(actor, 'TRANSFORMATION_RECORDED', transformationId, {
        kind: dto.kind,
        inputs: links.map((l) => l.lotId),
        outputs: created.map((o) => o.id),
      });

      // Handing the outputs on is a transfer the receiver confirms, like any other — same transaction.
      const transfers = [];
      if (nextAssignee && nextAssignee !== actor.id) {
        if (!this.supplyChain) throw new Error('LineageService needs SupplyChainService to hand outputs on');
        for (const lot of created) {
          transfers.push(await this.supplyChain.transferInScope(actor, lot.id, nextAssignee, { location: dto.location, occurredAt: time.occurredAt }));
        }
      }
      return { transformationId, outputIds: created.map((o) => o.id), anomalies, transfers };
    });

    for (const t of result.transfers) this.supplyChain?.notifyTransfer(t);
    const outputs = await this.db.withTenant(actor.tenantId, () => this.repos.batchRepo.findByIds(result.outputIds));
    const order = new Map(result.outputIds.map((id, i) => [id, i]));
    outputs.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    return { transformationId: result.transformationId, outputs, anomalies: result.anomalies };
  }

  /** Everything that must hold for one input lot before it may be consumed. */
  private checkInput(lot: Batch, actor: Actor, rules: WorkflowRules, dto: CreateTransformationDTO, stagePos: number, quantity: number): void {
    const remedy = dto.kind === 'REWORK' || dto.kind === 'DOWNGRADE';
    if (lot.status === 'RECALLED') throw new ConflictError(`Lot ${lot.productName} has been recalled`);
    if (lot.status === 'DESTROYED') throw new ConflictError(`Lot ${lot.productName} has been destroyed`);
    if (lot.status === 'IN_TRANSIT') throw new ConflictError(`Lot ${lot.productName} is in transit — the receiver must accept it first`);
    if (lot.status === 'ON_HOLD') throw new ConflictError(`Lot ${lot.productName} is on hold pending investigation`);
    if (remedy && lot.status !== 'REJECTED') throw new ConflictError(`${dto.kind} is for a lot that failed inspection — ${lot.productName} did not`);
    if (!remedy && lot.status === 'REJECTED') {
      throw new ConflictError(`Lot ${lot.productName} failed inspection — only rework, downgrade or disposal remain`);
    }
    if (lot.eventCount === 0) throw new ConflictError(`Lot ${lot.productName} has no recorded event yet`);
    if (!lot.productTypeId || !lot.unitFactor) {
      throw new ConflictError(`Lot ${lot.productName} is not linked to the product catalog yet — an admin must map it first`);
    }
    if (actor.role !== 'ADMIN' && lot.assignedToActorId && lot.assignedToActorId !== actor.id) {
      throw new ForbiddenError('This batch has not been handed off to you yet');
    }

    const lotPos = rules.position(lot.currentStage) ?? 0;
    if (dto.kind === 'REWORK') {
      // Back to a step before the inspection it failed, and through inspection again.
      if (stagePos >= lotPos || rules.kind(dto.stage) === 'INSPECTION') {
        throw new ConflictError(`Rework happens at a step before ${lot.currentStage}, not at ${dto.stage}`);
      }
    } else if (dto.kind === 'DOWNGRADE') {
      if (dto.stage !== lot.currentStage) throw new ConflictError(`A downgrade is recorded at the inspection the lot failed (${lot.currentStage})`);
    } else {
      if (lotPos > stagePos) throw new ConflictError(`Lot ${lot.productName} is already past stage ${dto.stage}`);
      const skipped = rules.skippedRequired(lotPos, stagePos, lot);
      if (skipped.length > 0) {
        throw new ConflictError(`Required stage ${skipped.map((s) => s.stage).join(', ')} must be recorded before ${dto.stage}`);
      }
    }
    // Physically impossible — reject outright (the DB CHECK is the backstop).
    const remaining = remainingOf(lot);
    if (quantity > remaining + EPSILON) throw new ConflictError(`Only ${remaining} ${lot.unit} of ${lot.productName} remain`);
  }

  private async resolveOutputs(dto: CreateTransformationDTO, inputs: Batch[]): Promise<ResolvedOutput[]> {
    const outputs: ResolvedOutput[] = [];
    for (const o of dto.outputs) {
      const productType = await this.catalogCtx.resolveProductType(o.productTypeId, o.productType);
      const unit = await this.repos.catalogRepo.unitFor(productType, o.unit);
      if (!unit) {
        throw new ValidationError(`Unit "${o.unit}" is not valid for ${productType.name}`, [
          { field: 'unit', code: 'invalid_option', message: `unit must be one of the units of ${productType.code}` },
        ]);
      }
      outputs.push({ productName: o.productName, productType, unit, quantity: o.quantity });
    }

    const inputTypes = new Set(inputs.map((b) => b.productTypeId));
    const outputTypes = new Set(outputs.map((o) => o.productType.id));
    if (dto.kind === 'TRANSFORM') {
      if (inputTypes.size !== 1 || outputTypes.size !== 1) {
        throw new ConflictError('A transformation turns one product type into one other product type');
      }
      if ([...inputTypes][0] === [...outputTypes][0]) throw new ConflictError('A transformation changes the product type — use rework or a merge/split');
    } else if (dto.kind === 'DOWNGRADE') {
      const from = await this.repos.catalogRepo.productTypeById(inputs[0].productTypeId!);
      if (from && from.categoryCode !== outputs[0].productType.categoryCode) {
        throw new ConflictError('A downgrade stays within the same product group');
      }
    } else {
      const all = new Set([...inputTypes, ...outputTypes]);
      if (all.size !== 1) throw new ConflictError('Merge, split and rework keep the product type — use a transformation to change it');
    }
    return outputs;
  }

  /**
   * SPEC §5 level 1, both ways: what comes out can't exceed what went in ×
   * the maximum ratio (goods appearing from nowhere), and shouldn't fall below
   * the minimum (an unusual loss — diverted goods?). The bounds come from the
   * catalog reference data with their source, the tenant's override first.
   */
  private async checkMassBalance(
    dto: CreateTransformationDTO,
    inputs: Batch[],
    outputs: ResolvedOutput[],
    created: Batch[],
    events: TraceEvent[],
  ): Promise<Anomaly[]> {
    const byId = new Map(inputs.map((b) => [b.id, b]));
    if (inputs.some((b) => b.baseUnit !== 'kg') || outputs.some((o) => o.productType.baseUnit !== 'kg')) return []; // counted goods
    const inKg = dto.inputs.reduce((sum, i) => sum + i.quantity * (byId.get(i.lotId)!.unitFactor ?? 0), 0);
    const outKg = outputs.reduce((sum, o) => sum + o.quantity * o.unit.factor, 0);

    let bounds: { min: number; max: number; source: string } | null;
    let label: string;
    if (dto.kind === 'TRANSFORM') {
      bounds = await this.repos.catalogRepo.conversionFactor(inputs[0].productTypeId!, outputs[0].productType.id);
      label = `${inputs[0].productType} → ${outputs[0].productType.name}`;
    } else {
      bounds = await this.repos.catalogRepo.processRatio(dto.kind, outputs[0].productType.categoryCode);
      label = { MERGE: 'gộp lô', SPLIT: 'tách lô', REWORK: 'chế biến lại', DOWNGRADE: 'hạ loại' }[dto.kind];
    }
    if (!bounds) return []; // no reference to judge against
    const fmt = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
    let message: string | null = null;
    let severity: AnomalySeverity = 'HIGH';
    if (outKg > inKg * bounds.max + EPSILON) {
      message = `Cân bằng khối lượng: đầu ra ${fmt(outKg)} kg vượt mức cho phép từ ${fmt(inKg)} kg đầu vào (${label} tối đa ${bounds.max}; nguồn: ${bounds.source})`;
    } else if (outKg < inKg * bounds.min - EPSILON) {
      severity = 'MEDIUM';
      message = `Hao hụt bất thường: đầu ra ${fmt(outKg)} kg từ ${fmt(inKg)} kg đầu vào, thấp hơn tỉ lệ tối thiểu ${bounds.min} (${label}; nguồn: ${bounds.source})`;
    }
    if (!message) return [];
    const stored: Anomaly[] = [];
    for (const [i, lot] of created.entries()) {
      stored.push(await this.flag(lot, 'MASS_BALANCE_VIOLATION', severity, message, events[i].id));
    }
    return stored;
  }

  /** Both directions of the lot graph around `lotId`. */
  async lineage(actor: Actor, lotId: string): Promise<LineageGraph> {
    return this.db.withTenant(actor.tenantId, () => this.lineageInScope(lotId, actor.tenantId));
  }

  /** Same, for callers already inside the lot's tenant scope (the public page). */
  async lineageInScope(lotId: string, tenantId: string): Promise<LineageGraph> {
    const self = await this.repos.batchRepo.findById(lotId);
    if (!self || self.tenantId !== tenantId) throw new NotFoundError('Batch not found');
    const [upstream, downstream] = await Promise.all([
      this.repos.lineageRepo.edges(lotId, 'up'),
      this.repos.lineageRepo.edges(lotId, 'down'),
    ]);
    const ids = new Set<string>([lotId]);
    for (const e of [...upstream, ...downstream]) {
      ids.add(e.fromLotId);
      ids.add(e.toLotId);
    }
    const lots: LineageGraph['lots'] = {};
    const fetched = await this.repos.batchRepo.findByIds([...ids].filter((id) => id !== lotId));
    for (const b of [self, ...fetched]) {
      lots[b.id] = {
        id: b.id,
        productName: b.productName,
        productType: b.productType,
        origin: b.origin,
        quantity: b.quantity,
        unit: b.unit,
        currentStage: b.currentStage,
        status: b.status,
        isRecalled: b.isRecalled,
        plotId: b.plotId,
        consumedQuantity: b.consumedQuantity,
        lostQuantity: b.lostQuantity,
      };
    }
    const produced = new Set(upstream.map((e) => e.toLotId));
    const upstreamLots = new Set([lotId, ...upstream.map((e) => e.fromLotId)]);
    const rootLotIds = [...upstreamLots].filter((id) => !produced.has(id));
    return { lotId, lots, upstream, downstream, rootLotIds };
  }

  private async flag(lot: Pick<Batch, 'id' | 'tenantId'>, type: AnomalyType, severity: AnomalySeverity, message: string, eventId?: string): Promise<Anomaly> {
    return this.repos.anomalyRepo.create({
      id: uuidv4(),
      type,
      severity,
      message,
      batchId: lot.id,
      tenantId: lot.tenantId,
      eventId,
      detectedAt: new Date(),
      resolved: false,
    });
  }

  private async audit(actor: Actor, action: string, entityId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.repos.auditLogRepo.create({
      id: uuidv4(),
      actorId: actor.id,
      tenantId: actor.tenantId,
      action,
      entityType: 'transformation',
      entityId,
      metadata,
      createdAt: new Date(),
    });
  }
}
