import { ActorRole, Batch, Stage, StageKind, SupplyChainStage, Workflow, WorkflowStep } from './types';

/**
 * The rules of one workflow template version (migration 016), as pure
 * functions over its steps — no database access, so they can be reasoned
 * about and tested on their own.
 *
 * Positions are 1-based; position 0 means "before the first step" (a lot with
 * no event yet).
 */
export class WorkflowRules {
  private readonly byStage: Map<string, WorkflowStep>;

  constructor(
    readonly workflow: Workflow,
    private readonly stageCatalog: Map<string, Stage>,
  ) {
    this.byStage = new Map(workflow.steps.map((s) => [s.stage, s]));
  }

  get steps(): WorkflowStep[] {
    return this.workflow.steps;
  }

  has(stage: SupplyChainStage): boolean {
    return this.byStage.has(stage);
  }

  step(stage: SupplyChainStage): WorkflowStep | undefined {
    return this.byStage.get(stage);
  }

  /** 0 for "no stage yet"; undefined when the stage isn't part of this workflow. */
  position(stage: SupplyChainStage | null | undefined): number | undefined {
    if (!stage) return 0;
    return this.byStage.get(stage)?.position;
  }

  kind(stage: SupplyChainStage): StageKind {
    return this.stageCatalog.get(stage)?.kind ?? 'RECORD';
  }

  label(stage: SupplyChainStage): string {
    return this.stageCatalog.get(stage)?.label ?? stage;
  }

  get lastPosition(): number {
    return Math.max(0, ...this.workflow.steps.map((s) => s.position));
  }

  /** Whether the lot has reached the last step — its journey is over. */
  isFinal(stage: SupplyChainStage | null | undefined): boolean {
    const p = this.position(stage);
    return p !== undefined && p > 0 && p === this.lastPosition;
  }

  canRecord(role: ActorRole, stage: SupplyChainStage): boolean {
    if (role === 'ADMIN') return this.has(stage);
    return this.byStage.get(stage)?.roles.includes(role) ?? false;
  }

  /**
   * Whether a step must not be jumped over for this lot. A lot remade after a
   * failed inspection (rework) must pass inspection again even where the
   * template leaves inspection optional.
   */
  isRequiredFor(step: WorkflowStep, batch?: Pick<Batch, 'metadata'>): boolean {
    if (step.required) return true;
    return this.kind(step.stage) === 'INSPECTION' && batch?.metadata?.reinspect === true;
  }

  /** Steps strictly between two positions — what recording `toPos` next would skip. */
  between(fromPos: number, toPos: number): WorkflowStep[] {
    return this.steps.filter((s) => s.position > fromPos && s.position < toPos);
  }

  /** Required steps a lot at `fromPos` would skip by recording the step at `toPos` now. */
  skippedRequired(fromPos: number, toPos: number, batch?: Pick<Batch, 'metadata'>): WorkflowStep[] {
    return this.between(fromPos, toPos).filter((s) => this.isRequiredFor(s, batch));
  }

  /**
   * The steps that may legitimately come next after `fromPos`: every step up
   * to and including the first required one (optional steps may be skipped).
   */
  nextCandidates(fromPos: number, batch?: Pick<Batch, 'metadata'>): WorkflowStep[] {
    const out: WorkflowStep[] = [];
    for (const s of this.steps.filter((x) => x.position > fromPos).sort((a, b) => a.position - b.position)) {
      out.push(s);
      if (this.isRequiredFor(s, batch)) break;
    }
    return out;
  }

  /** Roles that could take the lot next. */
  rolesForNext(fromPos: number, batch?: Pick<Batch, 'metadata'>): Set<ActorRole> {
    return new Set(this.nextCandidates(fromPos, batch).flatMap((s) => s.roles));
  }

  /** True when only an external party (the foreign importer) can come next — no in-house hand-off needed. */
  nextIsExternal(fromPos: number, batch?: Pick<Batch, 'metadata'>): boolean {
    const roles = this.rolesForNext(fromPos, batch);
    return roles.size > 0 && [...roles].every((r) => r === 'IMPORTER');
  }
}

/**
 * GENERIC_RETAIL v1 exactly as migration 016 creates it — the six stages of
 * the original system, none required. For callers without a database at hand
 * (unit tests, tooling); services always use the template the lot pins.
 */
export const GENERIC_RETAIL_V1: Workflow = {
  id: 'generic-retail-v1',
  code: 'GENERIC_RETAIL',
  version: 1,
  name: 'Chuỗi chung (bán lẻ trong nước)',
  description: '',
  categoryCode: null,
  active: true,
  steps: [
    { position: 1, stage: 'HARVEST', required: false, roles: ['FARMER'] },
    { position: 2, stage: 'PROCESSING', required: false, roles: ['PROCESSOR'] },
    { position: 3, stage: 'QUALITY_CHECK', required: false, roles: ['INSPECTOR'] },
    { position: 4, stage: 'PACKAGING', required: false, roles: ['PROCESSOR'] },
    { position: 5, stage: 'DISTRIBUTION', required: false, roles: ['DISTRIBUTOR'] },
    { position: 6, stage: 'RETAIL', required: false, roles: ['RETAILER'] },
  ],
};

const STATIC_STAGES: Stage[] = [
  { code: 'HARVEST', label: 'Thu hoạch', kind: 'RECORD', sortOrder: 10 },
  { code: 'PROCESSING', label: 'Chế biến', kind: 'RECORD', sortOrder: 40 },
  { code: 'QUALITY_CHECK', label: 'Kiểm định chất lượng', kind: 'INSPECTION', sortOrder: 80 },
  { code: 'PACKAGING', label: 'Đóng gói', kind: 'RECORD', sortOrder: 90 },
  { code: 'DISTRIBUTION', label: 'Phân phối', kind: 'RECORD', sortOrder: 130 },
  { code: 'RETAIL', label: 'Bán lẻ', kind: 'RECORD', sortOrder: 140 },
];

export function genericRetailRules(): WorkflowRules {
  return new WorkflowRules(GENERIC_RETAIL_V1, new Map(STATIC_STAGES.map((s) => [s.code, s])));
}
