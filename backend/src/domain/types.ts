export type ActorRole =
  | 'FARMER'
  | 'COLLECTOR'
  | 'PROCESSOR'
  | 'WAREHOUSE'
  | 'INSPECTOR'
  | 'EXPORTER'
  | 'DISTRIBUTOR'
  | 'RETAILER'
  | 'IMPORTER'
  | 'ADMIN';

/** Roles that can be granted through an invitation (IMPORTER is created by a receipt link instead). */
export const INVITABLE_ROLES: ActorRole[] = [
  'FARMER',
  'COLLECTOR',
  'PROCESSOR',
  'WAREHOUSE',
  'INSPECTOR',
  'EXPORTER',
  'DISTRIBUTOR',
  'RETAILER',
  'ADMIN',
];

/**
 * A stage code from the platform's stage catalog (table `stages`) — e.g.
 * HARVEST, COLLECTION, QUALITY_CHECK, EXPORT. Which stages a lot goes
 * through, in which order and recorded by whom is decided by the workflow
 * template it was created under (see domain/workflow.ts), not by this type.
 */
export type SupplyChainStage = string;

export type StageKind = 'RECORD' | 'INSPECTION' | 'EXPORT' | 'RECEIPT';

export interface Stage {
  code: SupplyChainStage;
  label: string;
  kind: StageKind;
  sortOrder: number;
}

export interface WorkflowStep {
  position: number;
  stage: SupplyChainStage;
  /** A required step can't be jumped over. */
  required: boolean;
  /** Roles that may record this step (ADMIN always may). */
  roles: ActorRole[];
}

/** One version of a workflow template; lots pin the version they were created under. */
export interface Workflow {
  id: string;
  code: string;
  version: number;
  name: string;
  description: string;
  categoryCode: string | null;
  active: boolean;
  steps: WorkflowStep[];
}

/**
 * Lot lifecycle (migration 018). Transitions are enforced by the database:
 * RECALLED and DESTROYED are final, CONSUMED can still be recalled.
 */
export type LotStatus = 'ACTIVE' | 'IN_TRANSIT' | 'ON_HOLD' | 'REJECTED' | 'RECALLED' | 'DESTROYED' | 'CONSUMED';

/** Statuses in which the goods are still physically there to work with. */
export const OPEN_STATUSES: LotStatus[] = ['ACTIVE', 'IN_TRANSIT', 'ON_HOLD', 'REJECTED'];

/**
 * A SaaS customer boundary — completely isolated from every other tenant.
 * NOT the same thing as `Actor.organization`: multiple organizations
 * (farmer co-op, processor, distributor...) belong to the SAME tenant and
 * legitimately collaborate on the same batch as custody passes between them.
 * Tenants must never see each other's actors/batches/stats.
 */
export interface Tenant {
  id: string;
  slug: string;
  name: string;
  createdAt: Date;
}

export interface Actor {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: ActorRole;
  organization: string;
  tenantId: string;
  createdAt: Date;
  isActive: boolean;
}

export interface Batch {
  id: string;
  productName: string;
  productType: string;
  origin: string;
  quantity: number;
  unit: string;
  createdAt: Date;
  createdBy: string;
  tenantId: string;
  currentStage: SupplyChainStage | null;
  status: LotStatus;
  /** Derived from `status` — kept for older clients and reports. */
  isRecalled: boolean;
  recallReason?: string;
  metadata: Record<string, unknown>;
  /**
   * The one actor currently authorized to record the batch's next event —
   * the chain-of-custody hand-off. Set to the creator on `createBatch`, then
   * re-assigned by whoever completes each stage (see `RecordEventDTO.assignNextTo`).
   * `undefined` means unclaimed (legacy data, or an admin chose not to assign)
   * — falls back to "anyone with the right role" for that case.
   */
  assignedToActorId?: string;
  /**
   * Head of this batch's hash chain as recorded by the database — advanced
   * only by the ledger insert trigger (migration 007), never by the app.
   * Lets a verifier detect a truncated chain, not just an edited one.
   */
  headHash: string;
  eventCount: number;
  /** Timestamp of the most recent event, derived on read — undefined while no event exists yet. */
  lastEventAt?: Date;
  /** How much of `quantity` (same unit) later merges/splits/transforms have taken. */
  consumedQuantity: number;
  /** How much left without going into another lot: transit shortfall, disposal (same unit). */
  lostQuantity: number;
  /** The plot (field) a harvest lot was picked from — the root of EUDR geolocation. */
  plotId?: string;
  /** Catalog product type; undefined only for lots created before the catalog and not yet mapped. */
  productTypeId?: string;
  /** kg, or "cái" for counted goods. */
  baseUnit?: 'kg' | 'cái';
  /** Base units per `unit`, captured at creation so catalog edits never re-weigh history. */
  unitFactor?: number;
  /** quantity × unitFactor. */
  quantityBase?: number;
  /** The workflow template version this lot follows. */
  workflowId: string;
}

/** What is still physically in a lot, in its own unit. */
export function remainingOf(batch: Pick<Batch, 'quantity' | 'consumedQuantity' | 'lostQuantity'>): number {
  return batch.quantity - batch.consumedQuantity - batch.lostQuantity;
}

/**
 * Event kinds. OBSERVE records a workflow stage; the lineage kinds are the
 * first event of a lot made from other lots (docs/SPEC_PHASE1.md §3); the
 * custody/status kinds record a hand-over or a status change (migration 018),
 * so those are hash-chained and anchored like any stage record.
 */
export type TransformationKind = 'MERGE' | 'SPLIT' | 'TRANSFORM' | 'REWORK' | 'DOWNGRADE';
export type CustodyEventKind =
  | 'TRANSFER_OUT'
  | 'TRANSFER_ACCEPT'
  | 'TRANSFER_REJECT'
  | 'TRANSFER_CANCEL'
  | 'HOLD'
  | 'RELEASE'
  | 'RECALL'
  | 'DISPOSE';
export type EventKind = 'OBSERVE' | TransformationKind | CustodyEventKind;

export const LINEAGE_KINDS: TransformationKind[] = ['MERGE', 'SPLIT', 'TRANSFORM', 'REWORK', 'DOWNGRADE'];

/** Whether an event records a workflow stage (as opposed to a custody/status change). */
export function isStageEvent(kind: EventKind | undefined): boolean {
  return kind === undefined || kind === 'OBSERVE' || (LINEAGE_KINDS as string[]).includes(kind);
}

/** An upstream lot consumed by the first event of a lot created by merge/split/transform. Part of the v3 hash. */
export interface EventLink {
  lotId: string;
  quantity: number;
  unit: string;
  /** Head of the input lot's chain at the moment it was consumed. */
  headHash: string;
  eventCount: number;
}

export interface TraceEvent {
  id: string;
  batchId: string;
  stage: SupplyChainStage;
  actorId: string;
  /** When it was recorded (server clock). */
  timestamp: Date;
  /**
   * When it happened, as declared by the recorder — part of the v4 hash. For
   * v1–v3 events it equals `timestamp`. Never later than `timestamp` (+5 min
   * clock skew) and never earlier than the lot's previous event.
   */
  occurredAt: Date;
  location: string;
  notes?: string;
  data: Record<string, unknown>;
  tenantId: string;
  hash: string;
  prevHash: string;
  sequenceNumber: number;
  /**
   * 1 = legacy HMAC (server-verifiable only), 2 = public salted SHA-256 over
   * the whole event, 3 = per-field commitments (selective disclosure) — see
   * ledger/hashChain.ts and docs/SPEC_PHASE1.md §1.
   */
  hashVersion: 1 | 2 | 3 | 4;
  /** Per-event random salt, part of the v2 hash preimage. Absent on v1/v3/v4 events. */
  salt?: string;
  kind: EventKind;
  /** Consumed input lots — non-empty only on the first event of a merged/split/transformed lot. */
  links: EventLink[];
  /** v3/v4: one 256-bit salt per committed field (claim name → hex). */
  claimSalts?: Record<string, string>;
  /** The field schema `data` was validated against (migration 017); absent for older events and custody events. */
  fieldSchemaId?: number;
}

export type AnomalySeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type AnomalyType =
  | 'STAGE_SKIPPED'
  | 'DUPLICATE_STAGE'
  | 'OUT_OF_ORDER'
  | 'CHAIN_TAMPERED'
  | 'MASS_BALANCE_VIOLATION'
  | 'QUANTITY_DISCREPANCY'
  | 'LATE_ENTRY'
  | 'RECALL_INVESTIGATION'
  | 'QC_CONDITION'
  | 'CONFLICT_OF_INTEREST';

export interface Anomaly {
  id: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  message: string;
  batchId: string;
  tenantId: string;
  eventId?: string;
  detectedAt: Date;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: Date;
}

export interface TraceResult {
  batch: Batch;
  events: TraceEvent[];
  anomalies: Anomaly[];
  isValid: boolean;
}

/** One step of the consumer-facing journey: who (organization, never a person), where, when, and the publishable facts. */
export interface PublicJourneyStep {
  stage: SupplyChainStage;
  kind: EventKind;
  /** When it was recorded. */
  timestamp: Date;
  /** When it happened (declared). */
  occurredAt: Date;
  location: string;
  organization: string;
  /** Only the fields the event's schema marks public. */
  details: Record<string, string | number | boolean>;
  fieldSchemaId?: number;
}

export interface PublicTrace {
  batch: Pick<
    Batch,
    'id' | 'productName' | 'productType' | 'productTypeId' | 'origin' | 'currentStage' | 'status' | 'isRecalled' | 'recallReason' | 'workflowId'
  >;
  stageCount: number;
  isValid: boolean;
  hasAnomalies: boolean;
  journey: PublicJourneyStep[];
  /** Set when the lot was assembled from other lots: how many harvests feed it, from where, by whom. */
  origins?: PublicOrigins;
  /** Lots this one was made from that have since been recalled — the consumer must know. */
  recalledInputs: Array<{ productName: string; reason?: string }>;
}

export interface PublicOrigins {
  harvestLotCount: number;
  /** Distinct places the harvests came from (lot origins), most frequent first. */
  regions: string[];
  /** Organizations that grew them. */
  producers: string[];
  plotCount: number;
  /** The merges/splits/transforms along the way, oldest first. */
  steps: Array<{ kind: TransformationKind; at: Date; inputCount: number }>;
}

/** A batch counts as stalled when nothing has happened to it for this long. */
export const STALLED_AFTER_DAYS = 3;

/** A hand-over that has waited this long for the receiver is flagged. */
export const TRANSFER_OVERDUE_DAYS = 2;

export interface AttentionSummary {
  /** Oldest-first: the batches that have waited longest come first. */
  stalledBatches: Batch[];
  stalledCount: number;
  openAnomalyCount: number;
  /** Hand-overs the receiver hasn't answered for TRANSFER_OVERDUE_DAYS. */
  overdueTransferCount: number;
  onHoldCount: number;
  rejectedCount: number;
}

export interface Invitation {
  id: string;
  tenantId: string;
  role: ActorRole;
  email?: string;
  note?: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt?: Date;
  usedBy?: string;
  revokedAt?: Date;
}

/** What a registrant may learn about an invitation from its code alone. */
export interface InvitationPreview {
  invitationId: string;
  tenantId: string;
  tenantName: string;
  role: ActorRole;
  email?: string;
  expiresAt: Date;
}

export interface LoginDTO {
  email: string;
  password: string;
}

interface RegisterBase {
  name: string;
  email: string;
  password: string;
  organization: string;
}

/** Founds a brand-new workspace; the registrant becomes its first ADMIN. */
export interface RegisterWorkspaceDTO extends RegisterBase {
  tenantSlug: string;
  tenantName: string;
}

/** Joins an existing workspace; the role comes from the invitation, not the registrant. */
export interface RegisterWithInviteDTO extends RegisterBase {
  inviteCode: string;
}

export interface CreateInvitationDTO {
  role: ActorRole;
  email?: string;
  note?: string;
  expiresInDays: number;
}

export interface CreateBatchDTO {
  productName: string;
  /** Catalog product type — by id, or by name/code/alias (resolved against the tenant's catalog). */
  productTypeId?: string;
  productType?: string;
  origin: string;
  quantity: number;
  /** A unit code valid for the product type (kg, tấn, or one of its packaging units). */
  unit: string;
  metadata?: Record<string, unknown>;
  /** The plot (field) this harvest comes from. */
  plotId?: string;
  /** Workflow template code; defaults to the product type's default workflow. */
  workflowCode?: string;
}

/** Merge / split / transform lots — docs/SPEC_PHASE1.md §3. */
export interface CreateTransformationDTO {
  kind: TransformationKind;
  /** The stage this happens at — must be one the actor's role may record. */
  stage: SupplyChainStage;
  location: string;
  notes?: string;
  data?: Record<string, string | number | boolean>;
  inputs: Array<{ lotId: string; quantity: number }>;
  outputs: Array<{ productName: string; productTypeId?: string; productType?: string; quantity: number; unit: string }>;
  /** Who takes the output lots next — someone working this stage or the next; omitted = the actor keeps them. */
  assignNextTo?: string;
  /** When it happened; defaults to now. */
  occurredAt?: Date;
  /** Required when `occurredAt` is further back than the product allows. */
  lateReason?: string;
}

export interface TransformationResult {
  transformationId: string;
  outputs: Batch[];
  anomalies: Anomaly[];
}

export interface LineageGraph {
  lotId: string;
  /** Every lot that appears in the graph (including `lotId`), keyed by id. */
  lots: Record<
    string,
    Pick<
      Batch,
      'id' | 'productName' | 'productType' | 'origin' | 'quantity' | 'unit' | 'currentStage' | 'status' | 'isRecalled' | 'plotId' | 'consumedQuantity' | 'lostQuantity'
    >
  >;
  upstream: Array<{ transformationId: string; kind: TransformationKind; fromLotId: string; toLotId: string; quantity: number; unit: string; createdAt: Date }>;
  downstream: Array<{ transformationId: string; kind: TransformationKind; fromLotId: string; toLotId: string; quantity: number; unit: string; createdAt: Date }>;
  /** Upstream lots not produced by any transformation — where the goods entered the system (harvests). */
  rootLotIds: string[];
}

export interface RecordEventDTO {
  batchId: string;
  stage: SupplyChainStage;
  location: string;
  notes?: string;
  data?: Record<string, unknown>;
  /**
   * Who takes custody next (required for non-ADMIN actors unless this is the
   * last step, or the next steps belong to an external party) — must be an
   * active actor whose role may record a following step. Someone other than
   * the recorder gets a transfer to accept; custody moves on acceptance.
   */
  assignNextTo?: string;
  /** When it happened; defaults to now. */
  occurredAt?: Date;
  /** Required when `occurredAt` is further back than the product allows (max_backdate_days). */
  lateReason?: string;
}

export type TransferStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';

export interface Transfer {
  id: string;
  tenantId: string;
  batchId: string;
  fromActorId: string;
  toActorId: string;
  status: TransferStatus;
  previousStatus: 'ACTIVE' | 'REJECTED';
  quantity: number;
  unit: string;
  packageCount?: number;
  vehicle?: string;
  documentNo?: string;
  receivedQuantity?: number;
  responseReason?: string;
  createdAt: Date;
  respondedAt?: Date;
  outEventId: string;
  responseEventId?: string;
}

export interface CreateTransferDTO {
  toActorId: string;
  packageCount?: number;
  vehicle?: string;
  documentNo?: string;
  location?: string;
  notes?: string;
  /** When the goods left; defaults to now. */
  occurredAt?: Date;
  lateReason?: string;
}

export interface RespondTransferDTO {
  accept: boolean;
  /** Weighed on arrival, in the lot's unit — required to accept. */
  receivedQuantity?: number;
  /** Required to reject. */
  reason?: string;
  location?: string;
  /** When the goods arrived; defaults to now. */
  occurredAt?: Date;
  lateReason?: string;
}

export interface BatchHold {
  id: string;
  tenantId: string;
  batchId: string;
  reason: string;
  sourceBatchId?: string;
  previousStatus: 'ACTIVE' | 'IN_TRANSIT' | 'REJECTED';
  heldBy: string;
  heldAt: Date;
  holdEventId: string;
  releasedAt?: Date;
  releasedBy?: string;
  releaseReason?: string;
  releaseEventId?: string;
}

export interface RecallDTO {
  reason: string;
  /** true: recall every lot made from this one; false (default): put them on hold for investigation. */
  cascade?: boolean;
}

export interface RecallResult {
  batch: Batch;
  /** Lots made from this one that were recalled (cascade) or put on hold. */
  recalledLotIds: string[];
  heldLotIds: string[];
  /** Upstream and sibling lots flagged for investigation. */
  flaggedLotIds: string[];
}

export interface DisposeDTO {
  /** Số biên bản huỷ. */
  recordNo: string;
  method: string;
  /** Người chứng kiến. */
  witness: string;
  reason?: string;
  occurredAt?: Date;
}

export interface StatsOverview {
  totalBatches: number;
  activeBatches: number;
  recalledBatches: number;
  totalEvents: number;
  anomalyCount: number;
  openAnomalyCount: number;
}

export interface StatsByStage {
  stage: SupplyChainStage;
  count: number;
}

export interface StatsByDay {
  date: string; // YYYY-MM-DD
  count: number;
}

export interface StatsByOrigin {
  origin: string;
  batchCount: number;
  anomalyCount: number;
}

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  tenantId: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BatchListQuery {
  page: number;
  pageSize: number;
  search?: string;
  /** A stage, or 'NONE' for batches with no event yet. */
  stage?: SupplyChainStage | 'NONE';
  status?: LotStatus;
}

export interface RefreshTokenRecord {
  /** SHA-256 of the raw token — the raw value is never stored. */
  token: string;
  actorId: string;
  tenantId: string;
  expiresAt: Date;
  revoked: boolean;
  createdAt: Date;
}

export interface AnomalyListQuery {
  page: number;
  pageSize: number;
  resolved?: boolean;
  severity?: AnomalySeverity;
}

export interface UpdateProfileDTO {
  name?: string;
  organization?: string;
}

export interface ChangePasswordDTO {
  currentPassword: string;
  newPassword: string;
}

/** A partner (organization) participating in the supply chain, derived from its actors. */
export interface PartnerSummary {
  organization: string;
  actorCount: number;
  roles: ActorRole[];
}

/** A single item in the combined realtime-alert history (anomaly detected or batch recalled). */
export interface NotificationItem {
  id: string;
  kind: 'ANOMALY' | 'RECALL' | 'TRANSFER';
  message: string;
  severity?: AnomalySeverity;
  batchId: string;
  createdAt: Date;
}
