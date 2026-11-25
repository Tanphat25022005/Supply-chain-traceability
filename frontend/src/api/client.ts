import axios from 'axios'
import { io, Socket } from 'socket.io-client'
import type { VerificationPayload } from '../lib/verify/verifyBatch'
import {
  CircleDot,
  Cog,
  Container,
  Factory,
  Flame,
  Microscope,
  Package,
  PackageCheck,
  Ship,
  ShoppingBasket,
  Snowflake,
  Sprout,
  Store,
  Sun,
  Truck,
  Warehouse,
  type LucideIcon,
} from 'lucide-react'

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api'

// The refresh token now lives only in an httpOnly cookie set by the backend
// (never readable by JS, so an XSS bug can't exfiltrate it). The access token
// is kept in memory only — never persisted — so it doesn't survive a reload
// either; AuthContext re-derives it on mount by calling authApi.refresh(),
// which succeeds automatically as long as the httpOnly cookie is still valid.
let accessToken: string | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

const client = axios.create({ baseURL: BASE_URL, withCredentials: true })

client.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`
  return config
})

// ── Silent-refresh on access-token expiry ────────────────────────────────────
// Concurrent 401s while a refresh is already in flight all wait on the same
// promise instead of each firing their own /auth/refresh call — this also
// covers AuthContext's mount-time session restore racing a 401-triggered
// retry, so a rotated refresh token is never raced against by two callers.
//
// Deliberately uses raw `axios`, NOT the intercepted `client` instance: this
// call itself 401s on every anonymous page load (no session yet), and if that
// went through `client`, the response interceptor below would treat it as a
// failed refresh and hard-redirect to /login — which remounts AuthContext,
// which calls this again, which 401s again... an infinite reload loop on
// every single visit, logged in or not.
let refreshPromise: Promise<{ token: string; actor: Actor }> | null = null

async function performRefresh(): Promise<{ token: string; actor: Actor }> {
  const { data } = await axios.post<{ token: string; actor: Actor }>(
    `${BASE_URL}/auth/refresh`,
    {},
    { withCredentials: true },
  )
  setAccessToken(data.token)
  localStorage.setItem('actor', JSON.stringify(data.actor))
  return data
}

function silentRefresh(): Promise<{ token: string; actor: Actor }> {
  refreshPromise ??= performRefresh().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

function logoutAndRedirect() {
  setAccessToken(null)
  localStorage.removeItem('actor')
  window.location.href = '/login'
}

client.interceptors.response.use(
  (res) => res,
  async (err: {
    config?: { url?: string; headers?: Record<string, string>; _retry?: boolean }
    response?: { status?: number }
  }) => {
    const config = err.config
    const url = config?.url ?? ''
    // A 401 from the login call itself means "wrong credentials", not "session
    // expired" — that should surface as an inline form error, not a redirect.
    const isLoginRequest = url.includes('/auth/login')
    const isRefreshRequest = url.includes('/auth/refresh')

    if (err.response?.status !== 401 || isLoginRequest) {
      return Promise.reject(err)
    }

    if (isRefreshRequest || !config || config._retry) {
      logoutAndRedirect()
      return Promise.reject(err)
    }

    try {
      config._retry = true
      const { token: newToken } = await silentRefresh()
      config.headers = { ...config.headers, Authorization: `Bearer ${newToken}` }
      return client(config)
    } catch {
      logoutAndRedirect()
      return Promise.reject(err)
    }
  },
)

export default client

let socket: Socket | null = null

/**
 * Opens (or reuses) the shared realtime connection for anomaly/recall alerts,
 * authenticated with the current access token — the backend rejects the
 * Socket.IO handshake without one, so anonymous clients can no longer receive
 * the anomaly/recall firehose. Connects to the current page's own origin and
 * lets the dev-server proxy (vite.config.ts) or the production reverse proxy
 * (nginx.conf) forward `/socket.io` to the backend, same as `/api`.
 */
export function connectSocket(token: string): Socket {
  if (socket) {
    if ((socket.auth as { token?: string })?.token === token && socket.connected) return socket
    socket.disconnect()
  }
  socket = io({ path: '/socket.io', transports: ['websocket', 'polling'], auth: { token } })
  return socket
}

export function disconnectSocket(): void {
  socket?.disconnect()
  socket = null
}

// ── Domain types (mirror backend) ────────────────────────────────────────────

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
  | 'ADMIN'

/** Roles an invitation (or an admin's role change) can grant — IMPORTER only comes from a receipt link. */
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
]

/**
 * A stage code of the platform catalog. Which stages a lot goes through, in
 * which order and by whom, comes from the workflow template it pins — see
 * domain/catalog.ts and the CatalogContext. Labels and icons below are
 * platform constants (migration 016), kept here so even the public pages can
 * render them without a round-trip.
 */
export type SupplyChainStage = string

export const STAGE_LABELS: Record<string, string> = {
  HARVEST: 'Thu hoạch',
  COLLECTION: 'Thu gom',
  DRYING: 'Phơi / sấy',
  PROCESSING: 'Chế biến',
  MILLING: 'Xay xát',
  ROASTING: 'Rang',
  WAREHOUSING: 'Nhập kho',
  QUALITY_CHECK: 'Kiểm định chất lượng',
  PACKAGING: 'Đóng gói',
  CONTAINER_STUFFING: 'Đóng container',
  EXPORT: 'Xuất khẩu',
  COLD_CHAIN: 'Vận chuyển lạnh',
  DISTRIBUTION: 'Phân phối',
  RETAIL: 'Bán lẻ',
  IMPORT_RECEIPT: 'Nhận hàng nhập khẩu',
}

export function stageLabel(code: string | null | undefined): string {
  if (!code) return 'Chưa bắt đầu'
  return STAGE_LABELS[code] ?? code
}

export const STAGE_ICONS: Record<string, LucideIcon> = {
  HARVEST: Sprout,
  COLLECTION: ShoppingBasket,
  DRYING: Sun,
  PROCESSING: Factory,
  MILLING: Cog,
  ROASTING: Flame,
  WAREHOUSING: Warehouse,
  QUALITY_CHECK: Microscope,
  PACKAGING: Package,
  CONTAINER_STUFFING: Container,
  EXPORT: Ship,
  COLD_CHAIN: Snowflake,
  DISTRIBUTION: Truck,
  RETAIL: Store,
  IMPORT_RECEIPT: PackageCheck,
}

export function stageIcon(code: string | null | undefined): LucideIcon {
  return (code && STAGE_ICONS[code]) || CircleDot
}

/**
 * The coffee export chain — the demo's deep case, shown on the public pages
 * (Landing, Login, How it works). Mirrors workflow COFFEE_EXPORT v1.
 */
export const SHOWCASE_STAGES: Array<{ stage: SupplyChainStage; roles: ActorRole[]; required: boolean }> = [
  { stage: 'HARVEST', roles: ['FARMER'], required: true },
  { stage: 'COLLECTION', roles: ['COLLECTOR'], required: false },
  { stage: 'PROCESSING', roles: ['PROCESSOR'], required: true },
  { stage: 'WAREHOUSING', roles: ['WAREHOUSE', 'PROCESSOR', 'EXPORTER'], required: false },
  { stage: 'QUALITY_CHECK', roles: ['INSPECTOR'], required: true },
  { stage: 'CONTAINER_STUFFING', roles: ['EXPORTER', 'WAREHOUSE'], required: true },
  { stage: 'EXPORT', roles: ['EXPORTER'], required: true },
  { stage: 'IMPORT_RECEIPT', roles: ['IMPORTER'], required: false },
]

export const ROLE_LABELS: Record<ActorRole, string> = {
  FARMER: 'Nông dân',
  COLLECTOR: 'Thương lái / đại lý',
  PROCESSOR: 'Nhà chế biến',
  WAREHOUSE: 'Kho',
  INSPECTOR: 'Kiểm định viên',
  EXPORTER: 'Doanh nghiệp xuất khẩu',
  DISTRIBUTOR: 'Nhà phân phối',
  RETAILER: 'Nhà bán lẻ',
  IMPORTER: 'Bên nhập khẩu',
  ADMIN: 'Quản trị viên',
}

export interface Actor {
  id: string
  name: string
  role: ActorRole
  // Omitted by the backend for non-ADMIN viewers looking at someone else's
  // profile (see AdminService.redact) — always present for your own /auth/me.
  email?: string
  organization: string
  createdAt: string
  isActive: boolean
}

/** Lot lifecycle (backend migration 018). */
export type LotStatus = 'ACTIVE' | 'IN_TRANSIT' | 'ON_HOLD' | 'REJECTED' | 'RECALLED' | 'DESTROYED' | 'CONSUMED'

export const STATUS_LABELS: Record<LotStatus, string> = {
  ACTIVE: 'Đang lưu thông',
  IN_TRANSIT: 'Đang bàn giao',
  ON_HOLD: 'Tạm giữ',
  REJECTED: 'Không đạt kiểm định',
  RECALLED: 'Đã thu hồi',
  DESTROYED: 'Đã huỷ',
  CONSUMED: 'Đã dùng hết',
}

export interface Batch {
  id: string
  productName: string
  productType: string
  origin: string
  quantity: number
  unit: string
  createdAt: string
  createdBy: string
  currentStage: SupplyChainStage | null
  status: LotStatus
  isRecalled: boolean
  recallReason?: string
  metadata: Record<string, unknown>
  /** Who's currently authorized to record the batch's next event — undefined means unclaimed. */
  assignedToActorId?: string
  /** Head of the batch's hash chain as recorded by the database (last event hash / event count). */
  headHash: string
  eventCount: number
  /** Timestamp of the most recent event — absent while nothing has been recorded. */
  lastEventAt?: string
  /** How much of `quantity` merges/splits/transformations have already taken. */
  consumedQuantity: number
  /** Transit shortfall and disposals. */
  lostQuantity: number
  /** The plot a harvest lot was picked from. */
  plotId?: string
  productTypeId?: string
  baseUnit?: 'kg' | 'cái'
  unitFactor?: number
  quantityBase?: number
  workflowId: string
}

export function remainingOf(b: Pick<Batch, 'quantity' | 'consumedQuantity' | 'lostQuantity'>): number {
  return b.quantity - b.consumedQuantity - (b.lostQuantity ?? 0)
}

export type TransformationKind = 'MERGE' | 'SPLIT' | 'TRANSFORM' | 'REWORK' | 'DOWNGRADE'
export type CustodyEventKind =
  | 'TRANSFER_OUT'
  | 'TRANSFER_ACCEPT'
  | 'TRANSFER_REJECT'
  | 'TRANSFER_CANCEL'
  | 'HOLD'
  | 'RELEASE'
  | 'RECALL'
  | 'DISPOSE'
export type EventKind = 'OBSERVE' | TransformationKind | CustodyEventKind

export const TRANSFORMATION_LABELS: Record<TransformationKind, string> = {
  MERGE: 'Gộp lô',
  SPLIT: 'Tách lô',
  TRANSFORM: 'Chế biến (đổi loại hàng)',
  REWORK: 'Chế biến lại',
  DOWNGRADE: 'Hạ loại',
}

export const CUSTODY_EVENT_LABELS: Record<CustodyEventKind, string> = {
  TRANSFER_OUT: 'Bàn giao',
  TRANSFER_ACCEPT: 'Xác nhận nhận hàng',
  TRANSFER_REJECT: 'Từ chối nhận hàng',
  TRANSFER_CANCEL: 'Huỷ bàn giao',
  HOLD: 'Tạm giữ',
  RELEASE: 'Giải toả',
  RECALL: 'Thu hồi',
  DISPOSE: 'Huỷ lô',
}

export function isStageEvent(kind: EventKind | undefined): boolean {
  return !kind || kind === 'OBSERVE' || kind in TRANSFORMATION_LABELS
}

export interface EventLink {
  lotId: string
  quantity: number
  unit: string
  headHash: string
  eventCount: number
}

type LineageLot = Pick<
  Batch,
  'id' | 'productName' | 'productType' | 'origin' | 'quantity' | 'unit' | 'currentStage' | 'status' | 'isRecalled' | 'plotId' | 'consumedQuantity' | 'lostQuantity'
>

export interface LineageEdge {
  transformationId: string
  kind: TransformationKind
  fromLotId: string
  toLotId: string
  quantity: number
  unit: string
  createdAt: string
}

export interface LineageGraph {
  lotId: string
  lots: Record<string, LineageLot>
  upstream: LineageEdge[]
  downstream: LineageEdge[]
  rootLotIds: string[]
}

export interface Plot {
  id: string
  code: string
  name: string
  ownerActorId: string
  shape: 'polygon' | 'point'
  areaHa: number
  geometry: { type: 'Point' | 'Polygon' | 'MultiPolygon'; coordinates: unknown }
  createdAt: string
}

export interface CreateTransformationBody {
  kind: TransformationKind
  stage: SupplyChainStage
  location: string
  notes?: string
  data?: Record<string, string | number | boolean>
  inputs: Array<{ lotId: string; quantity: number }>
  outputs: Array<{ productName: string; productTypeId?: string; productType?: string; quantity: number; unit: string }>
  assignNextTo?: string
  /** ISO instant; defaults to now on the server. */
  occurredAt?: string
  lateReason?: string
}

export interface TraceEvent {
  id: string
  batchId: string
  stage: SupplyChainStage
  actorId: string
  /** When it was recorded. */
  timestamp: string
  /** When it happened (declared) — equals `timestamp` before hash v4. */
  occurredAt: string
  location: string
  notes?: string
  data: Record<string, unknown>
  hash: string
  prevHash: string
  sequenceNumber: number
  /** 1 = legacy HMAC, 2 = salted SHA-256 over the whole event, 3 = per-field commitments, 4 = 3 + occurredAt. */
  hashVersion: 1 | 2 | 3 | 4
  /** v2 only. */
  salt?: string
  kind: EventKind
  /** Input lots — only on the first event of a merged/split/transformed lot. */
  links: EventLink[]
  fieldSchemaId?: number
}

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
  | 'CONFLICT_OF_INTEREST'

export type AnomalySeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export const ANOMALY_TYPE_LABELS: Record<AnomalyType, string> = {
  STAGE_SKIPPED: 'Bỏ qua khâu',
  DUPLICATE_STAGE: 'Ghi trùng khâu',
  OUT_OF_ORDER: 'Sai thứ tự',
  CHAIN_TAMPERED: 'Dữ liệu bị can thiệp',
  MASS_BALANCE_VIOLATION: 'Sai lệch khối lượng',
  QUANTITY_DISCREPANCY: 'Bàn giao thiếu hàng',
  LATE_ENTRY: 'Ghi muộn',
  RECALL_INVESTIGATION: 'Liên quan lô bị thu hồi',
  QC_CONDITION: 'Đạt có điều kiện',
  CONFLICT_OF_INTEREST: 'Xung đột lợi ích',
}

export const SEVERITY_LABELS: Record<AnomalySeverity, string> = {
  CRITICAL: 'Nghiêm trọng',
  HIGH: 'Cao',
  MEDIUM: 'Trung bình',
  LOW: 'Thấp',
}

export interface Anomaly {
  id: string
  type: AnomalyType
  severity: AnomalySeverity
  message: string
  batchId: string
  eventId?: string
  detectedAt: string
  resolved: boolean
  resolvedBy?: string
  resolvedAt?: string
}

export interface TraceResult {
  batch: Batch
  events: TraceEvent[]
  anomalies: Anomaly[]
  isValid: boolean
}

export interface PublicJourneyStep {
  stage: SupplyChainStage
  kind: EventKind
  /** When it was recorded. */
  timestamp: string
  /** When it happened. */
  occurredAt: string
  location: string
  /** The organization that recorded the step — never a person's name. */
  organization: string
  /** Only the fields the event's schema marks public. */
  details: Record<string, string | number | boolean>
  fieldSchemaId?: number
}

export interface PublicTrace {
  batch: Pick<
    Batch,
    'id' | 'productName' | 'productType' | 'productTypeId' | 'origin' | 'currentStage' | 'status' | 'isRecalled' | 'recallReason' | 'workflowId'
  >
  stageCount: number
  isValid: boolean
  /** Unresolved anomalies only. */
  hasAnomalies: boolean
  journey: PublicJourneyStep[]
  /** Present when the lot was assembled from other lots. */
  origins?: {
    harvestLotCount: number
    regions: string[]
    producers: string[]
    plotCount: number
    steps: Array<{ kind: TransformationKind; at: string; inputCount: number }>
  }
  /** Lots this one was made from that have since been recalled. */
  recalledInputs: Array<{ productName: string; reason?: string }>
}

export interface AttentionSummary {
  stalledBatches: Batch[]
  stalledCount: number
  openAnomalyCount: number
  overdueTransferCount: number
  onHoldCount: number
  rejectedCount: number
}

export type TransferStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED'

export interface Transfer {
  id: string
  batchId: string
  fromActorId: string
  toActorId: string
  status: TransferStatus
  previousStatus: 'ACTIVE' | 'REJECTED'
  quantity: number
  unit: string
  packageCount?: number
  vehicle?: string
  documentNo?: string
  receivedQuantity?: number
  responseReason?: string
  createdAt: string
  respondedAt?: string
}

export interface IncomingTransfer extends Transfer {
  productName: string
  fromName: string
  fromOrganization: string
}

export interface BatchHold {
  id: string
  batchId: string
  reason: string
  sourceBatchId?: string
  previousStatus: 'ACTIVE' | 'IN_TRANSIT' | 'REJECTED'
  heldBy: string
  heldAt: string
  releasedAt?: string
  releasedBy?: string
  releaseReason?: string
}

export interface CustodyView {
  transfers: Transfer[]
  holds: BatchHold[]
}

export interface RecallOutcome extends Batch {
  lineage: { recalledLotIds: string[]; heldLotIds: string[]; flaggedLotIds: string[] }
}

// ── Catalog (backend migrations 015–019) ────────────────────────────────────

export type StageKind = 'RECORD' | 'INSPECTION' | 'EXPORT' | 'RECEIPT'

export interface Stage {
  code: string
  label: string
  kind: StageKind
  sortOrder: number
}

export interface WorkflowStep {
  position: number
  stage: string
  required: boolean
  roles: ActorRole[]
}

export interface Workflow {
  id: string
  code: string
  version: number
  name: string
  description: string
  categoryCode: string | null
  active: boolean
  steps: WorkflowStep[]
}

export interface ProductCategory {
  code: string
  name: string
  sortOrder: number
}

export interface ProductType {
  id: string
  tenantId: string | null
  categoryCode: string
  code: string
  name: string
  baseUnit: 'kg' | 'cái'
  gtin?: string
  defaultWorkflowCode?: string
  aliases: string[]
  active: boolean
}

export interface Unit {
  id: string
  tenantId: string | null
  productTypeId: string | null
  baseUnit: 'kg' | 'cái'
  code: string
  label: string
  factor: number
}

export interface FieldOption {
  value: string
  label: string
}

export interface FieldDef {
  key: string
  label: string
  type: 'text' | 'number' | 'date' | 'select' | 'boolean'
  required?: boolean
  requiredWhen?: { key: string; in: string[] }
  public?: boolean
  unit?: string
  min?: number
  max?: number
  maxLength?: number
  placeholder?: string
  options?: FieldOption[]
}

export interface FieldSchema {
  id: number
  categoryCode: string | null
  stage: string
  version: number
  fields: FieldDef[]
}

export interface CatalogView {
  stages: Stage[]
  workflows: Workflow[]
  categories: ProductCategory[]
  productTypes: ProductType[]
  units: Unit[]
  fieldSchemas: FieldSchema[]
}

interface Sourced {
  id: string
  /** null = platform value; otherwise this tenant's override. */
  tenantId: string | null
  source: string
  updatedBy?: string
  updatedAt: string
}

export interface ConversionFactor extends Sourced {
  fromTypeId: string
  toTypeId: string
  min: number
  max: number
}

export interface ProcessRatio extends Sourced {
  kind: 'MERGE' | 'SPLIT' | 'REWORK' | 'DOWNGRADE'
  categoryCode: string | null
  min: number
  max: number
}

export interface YieldCap extends Sourced {
  productTypeId: string
  region: string | null
  maxKgPerHa: number
}

export interface ProductSettings extends Sourced {
  productTypeId: string
  transitLossTolerance: number
  maxBackdateDays: number
}

export interface ReferenceData {
  conversionFactors: ConversionFactor[]
  processRatios: ProcessRatio[]
  yieldCaps: YieldCap[]
  productSettings: ProductSettings[]
}

export interface UnmappedGroup {
  productType: string
  unit: string
  batchCount: number
  productTypeId?: string
}

export interface ReceiptInfo {
  batchId: string
  productName: string
  quantity: number
  unit: string
  exporter: string
  importer: string
  exportData: Record<string, unknown>
  alreadyReceived: boolean
  expiresAt?: string
}

export interface Invitation {
  id: string
  role: ActorRole
  email?: string
  note?: string
  createdBy: string
  createdAt: string
  expiresAt: string
  usedAt?: string
  usedBy?: string
  revokedAt?: string
}

export interface InvitationPreview {
  tenantName: string
  role: ActorRole
  email?: string
  expiresAt: string
}

export type RegisterBody =
  | { mode: 'workspace'; name: string; email: string; password: string; organization: string; tenantSlug: string; tenantName: string }
  | { mode: 'invite'; name: string; email: string; password: string; organization: string; inviteCode: string }

export interface StatsOverview {
  totalBatches: number
  activeBatches: number
  recalledBatches: number
  totalEvents: number
  anomalyCount: number
  openAnomalyCount: number
}

export interface StatsByStage {
  stage: SupplyChainStage
  count: number
}

export interface StatsByDay {
  date: string
  count: number
}

export interface StatsByOrigin {
  origin: string
  batchCount: number
  anomalyCount: number
}

export interface PartnerSummary {
  organization: string
  actorCount: number
  roles: ActorRole[]
}

export interface ActorDetail {
  actor: Actor
  batches: Batch[]
}

export interface SessionInfo {
  token: string
  expiresAt: string
  createdAt: string
}

export interface NotificationItem {
  id: string
  kind: 'ANOMALY' | 'RECALL' | 'TRANSFER'
  message: string
  severity?: AnomalySeverity
  batchId: string
  createdAt: string
}

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface AuditLogEntry {
  id: string
  actorId: string | null
  action: string
  entityType: string
  entityId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

// ── API calls ─────────────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string) =>
    client.post<{ token: string; actor: Actor }>('/auth/login', { email, password }).then((r) => r.data),

  register: (body: RegisterBody) => client.post<Actor>('/auth/register', body).then((r) => r.data),

  previewInvitation: (code: string) =>
    client.get<InvitationPreview>(`/auth/invitations/${encodeURIComponent(code.trim())}`).then((r) => r.data),

  // Relies on the httpOnly refreshToken cookie the backend set at login —
  // used both for the on-401 silent refresh and for restoring a session on
  // app load (see AuthContext). Shares silentRefresh's in-flight dedup so a
  // mount-time restore racing a 401 retry can't rotate the same token twice.
  refresh: silentRefresh,

  logout: () => client.post('/auth/logout').then(() => undefined),

  me: () => client.get<Actor>('/auth/me').then((r) => r.data),

  updateProfile: (body: { name?: string; organization?: string }) =>
    client.patch<Actor>('/auth/me', body).then((r) => r.data),

  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    client.patch('/auth/me/password', body).then(() => undefined),

  sessions: () => client.get<SessionInfo[]>('/auth/sessions').then((r) => r.data),

  revokeSession: (tokenPrefix: string) => client.delete(`/auth/sessions/${tokenPrefix}`).then(() => undefined),
}

export interface CreateBatchBody {
  productName: string
  productTypeId: string
  origin: string
  quantity: number
  unit: string
  metadata?: Record<string, unknown>
  plotId?: string
  workflowCode?: string
}

export interface TransferBody {
  toActorId: string
  packageCount?: number
  vehicle?: string
  documentNo?: string
  location?: string
  notes?: string
  occurredAt?: string
  lateReason?: string
}

export const batchApi = {
  list: (params?: { page?: number; pageSize?: number; search?: string; stage?: SupplyChainStage | 'NONE'; status?: LotStatus }) =>
    client.get<PaginatedResult<Batch>>('/batches', { params }).then((r) => r.data),
  get: (id: string) => client.get<Batch>(`/batches/${id}`).then((r) => r.data),
  create: (body: CreateBatchBody) => client.post<Batch>('/batches', body).then((r) => r.data),
  /** Hand-over the receiver confirms (two-way custody). */
  transfer: (id: string, body: TransferBody) => client.post<Transfer>(`/batches/${id}/transfers`, body).then((r) => r.data),
  /** Transfers and holds of one lot. */
  custodyOf: (id: string) => client.get<CustodyView>(`/batches/${id}/custody`).then((r) => r.data),
  recall: (id: string, reason: string, cascade = false) =>
    client.post<RecallOutcome>(`/batches/${id}/recall`, { reason, cascade }).then((r) => r.data),
  hold: (id: string, reason: string) => client.post<Batch>(`/batches/${id}/hold`, { reason }).then((r) => r.data),
  release: (id: string, reason: string) => client.post<Batch>(`/batches/${id}/release`, { reason }).then((r) => r.data),
  dispose: (id: string, body: { recordNo: string; method: string; witness: string; reason?: string; occurredAt?: string }) =>
    client.post<Batch>(`/batches/${id}/dispose`, body).then((r) => r.data),
  qrSvg: (id: string) =>
    client.get<string>(`/batches/${id}/qr`, { responseType: 'text' as const }).then((r) => r.data),
  pending: () => client.get<Batch[]>('/batches/pending').then((r) => r.data),
  /** Open lots I hold — candidates for merge / split / transform / rework. */
  custody: () => client.get<Batch[]>('/batches/custody').then((r) => r.data),
  /** Batches for a report; `from`/`to` are ISO instants (the caller decides what "a day" means). */
  exportJson: (params: { from?: string; to?: string; origin?: string }) =>
    client.get<Batch[]>('/batches/export', { params: { ...params, format: 'json' } }).then((r) => r.data),
}

export const transferApi = {
  incoming: () => client.get<IncomingTransfer[]>('/transfers/incoming').then((r) => r.data),
  outgoing: () => client.get<Transfer[]>('/transfers/outgoing').then((r) => r.data),
  respond: (
    id: string,
    body: { accept: boolean; receivedQuantity?: number; reason?: string; location?: string; occurredAt?: string; lateReason?: string },
  ) => client.post<{ transfer: Transfer; batch: Batch }>(`/transfers/${id}/respond`, body).then((r) => r.data),
  cancel: (id: string) => client.post<{ transfer: Transfer; batch: Batch }>(`/transfers/${id}/cancel`).then((r) => r.data),
}

export const eventApi = {
  record: (body: {
    batchId: string
    stage: SupplyChainStage
    location: string
    notes?: string
    data?: Record<string, unknown>
    /** Who takes custody next — they confirm receipt before it is theirs. */
    assignNextTo?: string
    /** ISO instant; defaults to now. */
    occurredAt?: string
    lateReason?: string
  }) => client.post<TraceEvent>('/events', body).then((r) => r.data),
}

export const traceApi = {
  get: (batchId: string) =>
    client.get<TraceResult>(`/trace/${batchId}`).then((r) => r.data),
  public: (batchId: string) =>
    client.get<PublicTrace>(`/trace/public/${batchId}`).then((r) => r.data),
  /** Material for the in-browser verifier; `token` (a verification link) opens every field. */
  verifyFull: (batchId: string, token?: string) =>
    client
      .get<VerificationPayload>(`/trace/public/${batchId}/full`, { params: token ? { token } : undefined })
      .then((r) => r.data),
  createVerificationLink: (batchId: string, days: number) =>
    client.post<{ token: string; expiresAt: string }>(`/trace/${batchId}/verification-links`, { days }).then((r) => r.data),
}

/** The foreign buyer confirms what arrived — by a link the exporter sends; no account needed. */
export const receiptApi = {
  createLink: (batchId: string, importerName: string, days: number) =>
    client
      .post<{ token: string; expiresAt: string; importerActorId: string }>(`/trace/${batchId}/receipt-links`, { importerName, days })
      .then((r) => r.data),
  info: (batchId: string, token: string) =>
    client.get<ReceiptInfo>(`/trace/public/${batchId}/receipt`, { params: { token } }).then((r) => r.data),
  confirm: (batchId: string, body: { token: string; receivedQuantity: number; condition: 'GOOD' | 'DAMAGED' | 'REJECTED'; location: string; notes?: string }) =>
    client.post<TraceEvent>(`/trace/public/${batchId}/receipt`, body).then((r) => r.data),
}

export const catalogApi = {
  /** Platform catalog — public. */
  public: () => client.get<CatalogView>('/catalog').then((r) => r.data),
  /** With the tenant's own product types and units. */
  tenant: () => client.get<CatalogView>('/catalog/tenant').then((r) => r.data),
  reference: () => client.get<ReferenceData>('/catalog/reference').then((r) => r.data),
  unmapped: () => client.get<UnmappedGroup[]>('/catalog/unmapped').then((r) => r.data),
  map: (body: { productType: string; unit: string; productTypeId: string; unitFactor?: number }) =>
    client.post<{ mapped: number }>('/catalog/unmapped/map', body).then((r) => r.data),
  createProductType: (body: {
    categoryCode: string
    code: string
    name: string
    baseUnit: 'kg' | 'cái'
    gtin?: string
    defaultWorkflowCode?: string
    aliases?: string[]
  }) => client.post<ProductType>('/catalog/product-types', body).then((r) => r.data),
  updateProductType: (id: string, body: { name: string; gtin?: string | null; defaultWorkflowCode?: string | null; aliases?: string[]; active: boolean }) =>
    client.patch<ProductType>(`/catalog/product-types/${id}`, body).then((r) => r.data),
  createUnit: (body: { productTypeId: string; code: string; label: string; factor: number }) =>
    client.post<Unit>('/catalog/units', body).then((r) => r.data),
  setConversionFactor: (body: { fromTypeId: string; toTypeId: string; min: number; max: number; source: string }) =>
    client.put<ReferenceData>('/catalog/reference/conversion-factors', body).then((r) => r.data),
  setProcessRatio: (body: { kind: ProcessRatio['kind']; categoryCode: string | null; min: number; max: number; source: string }) =>
    client.put<ReferenceData>('/catalog/reference/process-ratios', body).then((r) => r.data),
  setYieldCap: (body: { productTypeId: string; region: string | null; maxKgPerHa: number; source: string }) =>
    client.put<ReferenceData>('/catalog/reference/yield-caps', body).then((r) => r.data),
  setProductSettings: (body: { productTypeId: string; transitLossTolerance: number; maxBackdateDays: number; source: string }) =>
    client.put<ReferenceData>('/catalog/reference/product-settings', body).then((r) => r.data),
  deleteOverride: (table: 'conversion-factors' | 'process-ratios' | 'yield-caps' | 'product-settings', id: string) =>
    client.delete<ReferenceData>(`/catalog/reference/${table}/${id}`).then((r) => r.data),
}

export const statsApi = {
  overview: () => client.get<StatsOverview>('/stats/overview').then((r) => r.data),
  byStage: () => client.get<StatsByStage[]>('/stats/by-stage').then((r) => r.data),
  byDay: () => client.get<StatsByDay[]>('/stats/by-day').then((r) => r.data),
  byOrigin: () => client.get<StatsByOrigin[]>('/stats/by-origin').then((r) => r.data),
  attention: () => client.get<AttentionSummary>('/stats/attention').then((r) => r.data),
  /** Reports dashboard — one filtered window; `from`/`to` are ISO instants. */
  report: (params: { from?: string; to?: string; productType?: string; origin?: string; workflowCode?: string }) =>
    client.get<ReportData>('/stats/report', { params }).then((r) => r.data),
}

export interface KpiValue {
  value: number
  /** Same measure over the equally long window just before — null when not computable. */
  previous: number | null
  /** 12 equal buckets across the window, oldest first. */
  trend: number[]
}

export interface ProcessLoss {
  kind: TransformationKind
  fromTypeId: string
  toTypeId: string
  fromType: string
  toType: string
  count: number
  inKg: number
  outKg: number
  avgRatio: number
  min: number | null
  max: number | null
  source: string | null
  outOfRange: number
}

export interface ReportData {
  window: { from: string; to: string; previousFrom: string }
  kpis: {
    batches: KpiValue
    volumeKg: KpiValue
    events: KpiValue
    completionRate: KpiValue
    recallRate: KpiValue
    openAnomalies: KpiValue
    avgLeadTimeDays: KpiValue
    anchoredRate: KpiValue
  }
  monthly: Array<{ month: string; batches: number; events: number; volumeKg: number; recalls: number; anomalies: number }>
  funnel: Array<{ stage: SupplyChainStage; batches: number }>
  stageDurations: Array<{ from: SupplyChainStage; to: SupplyChainStage; avgHours: number; samples: number }>
  byProductType: Array<{ productType: string; batches: number; volumeKg: number }>
  byOrigin: Array<{ origin: string; batches: number; anomalies: number; recalls: number }>
  anomaliesByType: Array<{ type: AnomalyType; open: number; resolved: number }>
  organizations: Array<{ organization: string; events: number; batches: number; anomalies: number; avgWaitHours: number | null }>
  statusBreakdown: Array<{ status: LotStatus; batches: number }>
  losses: {
    processes: ProcessLoss[]
    transit: { accepted: number; rejected: number; pending: number; sentKg: number; shortfallKg: number; discrepancies: number }
    disposedKg: number
  }
  options: { productTypes: string[]; origins: string[]; workflows: Array<{ code: string; name: string }> }
}

export const adminApi = {
  auditLogs: (page = 1, pageSize = 20) =>
    client.get<PaginatedResult<AuditLogEntry>>('/admin/audit-logs', { params: { page, pageSize } }).then((r) => r.data),
  anomalies: (params: { page?: number; pageSize?: number; resolved?: boolean; severity?: AnomalySeverity }) =>
    client.get<PaginatedResult<Anomaly>>('/admin/anomalies', { params }).then((r) => r.data),
  resolveAnomaly: (id: string) =>
    client.patch<Anomaly>(`/admin/anomalies/${id}/resolve`).then((r) => r.data),
  invitations: () => client.get<Invitation[]>('/admin/invitations').then((r) => r.data),
  createInvitation: (body: { role: ActorRole; email?: string; note?: string; expiresInDays?: number }) =>
    client.post<{ invitation: Invitation; code: string }>('/admin/invitations', body).then((r) => r.data),
  revokeInvitation: (id: string) => client.delete<Invitation>(`/admin/invitations/${id}`).then((r) => r.data),
}

export const actorsApi = {
  list: () => client.get<Actor[]>('/actors').then((r) => r.data),
  partners: () => client.get<PartnerSummary[]>('/actors/partners').then((r) => r.data),
  detail: (id: string) => client.get<ActorDetail>(`/actors/${id}`).then((r) => r.data),
  setStatus: (id: string, isActive: boolean) =>
    client.patch<Actor>(`/actors/${id}/status`, { isActive }).then((r) => r.data),
  setRole: (id: string, role: ActorRole) =>
    client.patch<Actor>(`/actors/${id}/role`, { role }).then((r) => r.data),
}

export const notificationsApi = {
  list: (limit = 20) => client.get<NotificationItem[]>('/notifications', { params: { limit } }).then((r) => r.data),
}

export const lineageApi = {
  transform: (body: CreateTransformationBody) =>
    client.post<{ transformationId: string; outputs: Batch[]; anomalies: Anomaly[] }>('/transformations', body).then((r) => r.data),
  graph: (lotId: string) => client.get<LineageGraph>(`/transformations/lineage/${lotId}`).then((r) => r.data),
  /** GeoJSON FeatureCollection of every plot behind a lot (EUDR geolocation). */
  plotsGeoJson: (lotId: string) =>
    client.get<string>(`/transformations/lineage/${lotId}/plots.geojson`, { responseType: 'text' as const }).then((r) => r.data),
}

export const plotsApi = {
  list: () => client.get<Plot[]>('/plots').then((r) => r.data),
  create: (body: { code: string; name: string; geometry: Plot['geometry']; declaredAreaHa?: number; ownerActorId?: string }) =>
    client.post<Plot>('/plots', body).then((r) => r.data),
  import: (featureCollection: unknown) =>
    client
      .post<{ results: Array<{ index: number; plot?: Plot; error?: string }> }>('/plots/import', featureCollection, {
        // Partial success comes back as 422 — still a result list, not an exception.
        validateStatus: (s) => s === 201 || s === 422,
      })
      .then((r) => r.data),
}
