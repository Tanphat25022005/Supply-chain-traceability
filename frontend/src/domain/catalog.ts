import type {
  Actor,
  ActorRole,
  Batch,
  CatalogView,
  ConversionFactor,
  FieldDef,
  FieldSchema,
  ProcessRatio,
  ProductCategory,
  ProductType,
  ReferenceData,
  Stage,
  StageKind,
  Unit,
  Workflow,
  WorkflowStep,
} from '../api/client'
import { STAGE_LABELS } from '../api/client'

/**
 * The catalog as the browser uses it (backend migrations 015–019): stage
 * kinds, workflow rules, product types and their units, field schemas,
 * reference data. The workflow rules mirror backend/src/domain/workflow.ts —
 * the server decides, this only shapes the forms so people aren't offered
 * what would be refused.
 */

/** Rules of one workflow version. Positions are 1-based; 0 = no stage yet. */
export class WorkflowRules {
  private readonly byStage: Map<string, WorkflowStep>

  constructor(
    readonly workflow: Workflow,
    private readonly kindOf: (stage: string) => StageKind,
  ) {
    this.byStage = new Map(workflow.steps.map((s) => [s.stage, s]))
  }

  get steps(): WorkflowStep[] {
    return this.workflow.steps
  }

  has(stage: string): boolean {
    return this.byStage.has(stage)
  }

  position(stage: string | null | undefined): number {
    if (!stage) return 0
    return this.byStage.get(stage)?.position ?? 0
  }

  get lastPosition(): number {
    return Math.max(0, ...this.workflow.steps.map((s) => s.position))
  }

  isFinal(stage: string | null | undefined): boolean {
    const p = this.position(stage)
    return p > 0 && p === this.lastPosition
  }

  kind(stage: string): StageKind {
    return this.kindOf(stage)
  }

  isRequiredFor(step: WorkflowStep, batch?: Pick<Batch, 'metadata'>): boolean {
    return step.required || (this.kind(step.stage) === 'INSPECTION' && batch?.metadata?.reinspect === true)
  }

  /** What may come next after `fromPos`: up to and including the first required step. */
  nextCandidates(fromPos: number, batch?: Pick<Batch, 'metadata'>): WorkflowStep[] {
    const out: WorkflowStep[] = []
    for (const s of [...this.steps].filter((x) => x.position > fromPos).sort((a, b) => a.position - b.position)) {
      out.push(s)
      if (this.isRequiredFor(s, batch)) break
    }
    return out
  }

  rolesForNext(fromPos: number, batch?: Pick<Batch, 'metadata'>): Set<ActorRole> {
    return new Set(this.nextCandidates(fromPos, batch).flatMap((s) => s.roles))
  }

  /** Only the foreign buyer can come next (after EXPORT) — no in-house hand-over. */
  nextIsExternal(fromPos: number, batch?: Pick<Batch, 'metadata'>): boolean {
    const roles = this.rolesForNext(fromPos, batch)
    return roles.size > 0 && [...roles].every((r) => r === 'IMPORTER')
  }

  /** The steps this role may record next on this lot (ADMIN: any next step). Receipt steps belong to the buyer's link. */
  recordable(batch: Pick<Batch, 'currentStage' | 'metadata'>, role: ActorRole): WorkflowStep[] {
    return this.nextCandidates(this.position(batch.currentStage), batch).filter(
      (s) => this.kind(s.stage) !== 'RECEIPT' && (role === 'ADMIN' || s.roles.includes(role)),
    )
  }

  /** Required steps skipped by recording `stage` now. */
  skippedRequired(batch: Pick<Batch, 'currentStage' | 'metadata'>, stage: string): WorkflowStep[] {
    const from = this.position(batch.currentStage)
    const to = this.position(stage)
    return this.steps.filter((s) => s.position > from && s.position < to && this.isRequiredFor(s, batch))
  }
}

const DEFAULT_SETTINGS = { transitLossTolerance: 0.01, maxBackdateDays: 7, source: 'Mặc định hệ thống' }

export class Catalog {
  private readonly stagesByCode: Map<string, Stage>
  private readonly workflowsById: Map<string, Workflow>
  private readonly typesById: Map<string, ProductType>
  private readonly rulesCache = new Map<string, WorkflowRules>()

  constructor(
    readonly view: CatalogView,
    readonly reference?: ReferenceData,
  ) {
    this.stagesByCode = new Map(view.stages.map((s) => [s.code, s]))
    this.workflowsById = new Map(view.workflows.map((w) => [w.id, w]))
    this.typesById = new Map(view.productTypes.map((t) => [t.id, t]))
  }

  // ── Stages & workflows ──

  stageLabel(code: string | null | undefined): string {
    if (!code) return 'Chưa bắt đầu'
    return this.stagesByCode.get(code)?.label ?? STAGE_LABELS[code] ?? code
  }

  stageKind(code: string): StageKind {
    return this.stagesByCode.get(code)?.kind ?? 'RECORD'
  }

  workflow(id: string | undefined): Workflow | undefined {
    return id ? this.workflowsById.get(id) : undefined
  }

  rules(workflowId: string | undefined): WorkflowRules | undefined {
    const wf = this.workflow(workflowId)
    if (!wf) return undefined
    let rules = this.rulesCache.get(wf.id)
    if (!rules) {
      rules = new WorkflowRules(wf, (s) => this.stageKind(s))
      this.rulesCache.set(wf.id, rules)
    }
    return rules
  }

  /** Latest active version of each template usable for a product group (generic ones included). */
  workflowsFor(categoryCode: string | undefined): Workflow[] {
    const latest = new Map<string, Workflow>()
    for (const w of this.view.workflows) {
      if (!w.active) continue
      if (w.categoryCode && w.categoryCode !== categoryCode) continue
      const prev = latest.get(w.code)
      if (!prev || prev.version < w.version) latest.set(w.code, w)
    }
    return [...latest.values()].sort((a, b) => Number(!!b.categoryCode) - Number(!!a.categoryCode) || a.name.localeCompare(b.name))
  }

  // ── Products & units ──

  get categories(): ProductCategory[] {
    return this.view.categories
  }

  productType(id: string | undefined): ProductType | undefined {
    return id ? this.typesById.get(id) : undefined
  }

  productTypesByCategory(): Array<{ category: ProductCategory; types: ProductType[] }> {
    return this.view.categories
      .map((category) => ({ category, types: this.view.productTypes.filter((t) => t.active && t.categoryCode === category.code) }))
      .filter((g) => g.types.length > 0)
  }

  /** Generic units for the product's base unit, then its own packaging units. */
  unitsFor(productTypeId: string | undefined): Unit[] {
    const pt = this.productType(productTypeId)
    if (!pt) return []
    return this.view.units.filter((u) => u.productTypeId === pt.id || (u.productTypeId === null && u.baseUnit === pt.baseUnit))
  }

  categoryOf(batch: Pick<Batch, 'productTypeId'>): string | undefined {
    return this.productType(batch.productTypeId)?.categoryCode
  }

  // ── Field schemas ──

  schemaById(id: number | undefined): FieldSchema | undefined {
    return id ? this.view.fieldSchemas.find((s) => s.id === id) : undefined
  }

  /** The current schema for a product group and stage: the group's own, else the generic one. */
  currentSchema(categoryCode: string | undefined, stage: string): FieldSchema | undefined {
    const forStage = this.view.fieldSchemas.filter((s) => s.stage === stage)
    const newest = (list: FieldSchema[]) => [...list].sort((a, b) => b.version - a.version)[0]
    return (categoryCode ? newest(forStage.filter((s) => s.categoryCode === categoryCode)) : undefined) ?? newest(forStage.filter((s) => s.categoryCode === null))
  }

  /** The fields an event was recorded with (its own schema version, else the current one). */
  fieldsForEvent(event: { stage: string; fieldSchemaId?: number }, categoryCode?: string): FieldDef[] {
    return (this.schemaById(event.fieldSchemaId) ?? this.currentSchema(categoryCode, event.stage))?.fields ?? []
  }

  // ── Reference data (tenant override first) ──

  settingsFor(productTypeId: string | undefined): { transitLossTolerance: number; maxBackdateDays: number; source: string } {
    const rows = (this.reference?.productSettings ?? []).filter((r) => r.productTypeId === productTypeId)
    return rows.find((r) => r.tenantId) ?? rows.find((r) => !r.tenantId) ?? DEFAULT_SETTINGS
  }

  conversion(fromTypeId: string | undefined, toTypeId: string | undefined): ConversionFactor | undefined {
    const rows = (this.reference?.conversionFactors ?? []).filter((r) => r.fromTypeId === fromTypeId && r.toTypeId === toTypeId)
    return rows.find((r) => r.tenantId) ?? rows[0]
  }

  processRatio(kind: ProcessRatio['kind'], categoryCode: string | undefined): ProcessRatio | undefined {
    const rows = (this.reference?.processRatios ?? []).filter((r) => r.kind === kind && (!r.categoryCode || r.categoryCode === categoryCode))
    const rank = (r: ProcessRatio) => (r.tenantId ? 0 : 2) + (r.categoryCode ? 0 : 1)
    return [...rows].sort((a, b) => rank(a) - rank(b))[0]
  }
}

// ── Lots ────────────────────────────────────────────────────────────────────

/** Whether `actor` is the one expected to act on the lot now: ACTIVE, not finished, theirs (or unclaimed), a next step their role records. */
export function canActOn(actor: Pick<Actor, 'id' | 'role'>, batch: Batch, catalog: Catalog | undefined): boolean {
  if (batch.status !== 'ACTIVE') return false
  const rules = catalog?.rules(batch.workflowId)
  if (!rules || rules.isFinal(batch.currentStage)) return false
  if (actor.role === 'ADMIN') return true
  if (batch.assignedToActorId && batch.assignedToActorId !== actor.id) return false
  return rules.recordable(batch, actor.role).length > 0
}

/** The next step(s) of a lot as a short label, or null once its journey is over. */
export function nextStepLabel(batch: Batch, catalog: Catalog | undefined): string | null {
  const rules = catalog?.rules(batch.workflowId)
  if (!rules) return null
  if (rules.isFinal(batch.currentStage)) return null
  const next = rules.nextCandidates(rules.position(batch.currentStage), batch)
  if (next.length === 0) return null
  return next.map((s) => catalog!.stageLabel(s.stage)).join(' hoặc ')
}

// ── Field values ────────────────────────────────────────────────────────────

/** Keys of events written before field schemas, and the ones the server adds. */
const EXTRA_LABELS: Record<string, string> = {
  harvestDate: 'Ngày thu hoạch',
  shelfDate: 'Ngày lên kệ',
  outputQuantity: 'Sản lượng sau chế biến',
  lateReason: 'Lý do ghi muộn',
  reason: 'Lý do',
  sourceLotId: 'Lô nguồn',
  toActorId: 'Người nhận',
  transferId: 'Mã bàn giao',
  quantity: 'Khối lượng',
  receivedQuantity: 'Khối lượng thực nhận',
  unit: 'Đơn vị',
  vehicle: 'Phương tiện',
  packageCount: 'Số kiện',
  documentNo: 'Số chứng từ',
  recordNo: 'Số biên bản',
  method: 'Phương thức',
  witness: 'Người chứng kiến',
}

export function formatFieldValue(field: FieldDef | undefined, value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (field?.type === 'select') return field.options?.find((o) => o.value === value)?.label ?? String(value)
  if ((field?.type === 'date' || !field) && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-')
    return `${d}/${m}/${y}`
  }
  if (typeof value === 'boolean') return value ? 'Có' : 'Không'
  const text = typeof value === 'number' ? value.toLocaleString('vi-VN') : String(value)
  return field?.unit && field.type === 'number' ? `${text} ${field.unit}` : text
}

/** An event's facts as label/value rows, in the schema's field order (other keys last). */
export function describeEventData(
  fields: FieldDef[],
  data: Record<string, unknown>,
  opts: { publicOnly?: boolean; hide?: string[] } = {},
): Array<{ key: string; label: string; value: string }> {
  const hide = new Set(opts.hide ?? [])
  const known = fields
    .filter((f) => !opts.publicOnly || f.public)
    .filter((f) => data[f.key] !== undefined && data[f.key] !== '' && !hide.has(f.key))
    .map((f) => ({ key: f.key, label: f.label, value: formatFieldValue(f, data[f.key]) }))
  if (opts.publicOnly) return known
  const extra = Object.keys(data)
    .filter((k) => !fields.some((f) => f.key === k) && !hide.has(k))
    .map((k) => ({ key: k, label: EXTRA_LABELS[k] ?? k, value: formatFieldValue(undefined, data[k]) }))
  return [...known, ...extra]
}

/** Form values (strings) → the `data` payload: numbers parsed, booleans read, blanks dropped. */
export function toEventData(fields: FieldDef[], values: Record<string, string>): Record<string, string | number | boolean> {
  const data: Record<string, string | number | boolean> = {}
  for (const field of fields) {
    const raw = values[field.key]?.trim()
    if (!raw) continue
    data[field.key] = field.type === 'number' ? Number(raw) : field.type === 'boolean' ? raw === 'true' : raw
  }
  return data
}

/** Whether a field must be filled given the other values (required, or requiredWhen matches). */
export function isFieldRequired(field: FieldDef, values: Record<string, string>): boolean {
  if (field.required) return true
  if (field.requiredWhen) return field.requiredWhen.in.includes(values[field.requiredWhen.key] ?? '')
  return false
}

// ── Time ────────────────────────────────────────────────────────────────────

export function daysSince(iso: string | undefined): number | null {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000))
}

/** "hôm nay", "hôm qua", "3 ngày trước" — for "how long has this been waiting". */
export function relativeDays(iso: string | undefined): string {
  const d = daysSince(iso)
  if (d === null) return ''
  if (d <= 0) return 'hôm nay'
  if (d === 1) return 'hôm qua'
  return `${d} ngày trước`
}

/** A Date as the value of an <input type="datetime-local"> (local time, minutes). */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** "dd/mm/yyyy hh:mm" in Vietnamese locale. */
export function formatDateTime(iso: string | Date): string {
  return new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
