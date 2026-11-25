import {
  Actor,
  Batch,
  CUSTODY_EVENT_LABELS,
  CustodyEventKind,
  isStageEvent,
  ROLE_LABELS,
  SEVERITY_LABELS,
  stageLabel,
  STATUS_LABELS,
  SupplyChainStage,
  TraceResult,
  TRANSFORMATION_LABELS,
} from '../../api/client'
import { Catalog, describeEventData } from '../../domain/catalog'

/**
 * One source of truth for every downloadable report (PDF, Word, Excel), so the
 * three formats can never disagree on content — only on layout.
 */

const pad = (n: number) => String(n).padStart(2, '0')

/** dd/mm/yyyy — fixed, not toLocaleString(), whose output differs between browsers. */
export function formatDate(d: Date): string {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

/** dd/mm/yyyy HH:mm (24h, local time). */
export function formatDateTime(d: Date): string {
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** ISO 8601 with the local UTC offset, e.g. 2026-10-04T21:20:00+07:00 — unambiguous for machines and auditors. */
export function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

export function formatQuantity(n: number): string {
  return n.toLocaleString('vi-VN', { maximumFractionDigits: 3 })
}

/** File-name-safe slug: no diacritics, spaces or reserved characters (Windows/macOS/Linux, email attachments). */
export function fileSlug(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D'))
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 50) || 'lo-hang'
  )
}

export interface ReportStep {
  index: number
  stage: SupplyChainStage
  stageLabel: string
  /** When it happened (occurredAt) — what a reader means by "time". */
  time: Date
  /** When it was written to the ledger; differs from `time` for late entries. */
  recordedAt: Date
  organization: string
  person: string
  role: string
  location: string
  facts: Array<{ label: string; value: string }>
  notes: string
  hash: string
}

export interface BatchReport {
  title: string
  generatedAt: Date
  batch: Batch
  publicUrl: string
  isValid: boolean
  integrityText: string
  statusText: string
  steps: ReportStep[]
  anomalies: Array<{ severity: string; message: string; detectedAt: Date; resolved: boolean }>
  /** Base for download names: hanh-trinh-<product>-<id8>. */
  fileBase: string
}

export function batchStatusText(batch: Pick<Batch, 'isRecalled' | 'recallReason' | 'currentStage'> & Partial<Pick<Batch, 'status'>>): string {
  if (batch.isRecalled || batch.status === 'RECALLED') return `Đã thu hồi — ${batch.recallReason ?? ''}`.replace(/ — $/, '')
  if (batch.status && batch.status !== 'ACTIVE') return STATUS_LABELS[batch.status]
  if (!batch.currentStage) return 'Chưa bắt đầu'
  if (batch.currentStage === 'RETAIL') return 'Hoàn tất (đã đến điểm bán lẻ)'
  if (batch.currentStage === 'IMPORT_RECEIPT') return 'Hoàn tất (bên nhập khẩu đã nhận hàng)'
  return `Đang lưu thông — khâu gần nhất: ${stageLabel(batch.currentStage)}`
}

/** "Chế biến", "Chế biến (gộp)", or a custody step such as "Tạm giữ (tại khâu Nhập kho)". */
function stepLabel(kind: string, stage: string, catalog?: Catalog): string {
  const label = catalog?.stageLabel(stage) ?? stageLabel(stage)
  if (!isStageEvent(kind as never)) return `${CUSTODY_EVENT_LABELS[kind as CustodyEventKind] ?? kind} (tại khâu ${label})`
  const transform = (TRANSFORMATION_LABELS as Record<string, string>)[kind]
  return kind === 'OBSERVE' || !transform ? label : `${label} (${transform.toLowerCase()})`
}

/** "Ghi nhận muộn lúc …" when the step was entered more than 10 minutes after it happened. */
export function lateNote(step: Pick<ReportStep, 'time' | 'recordedAt'>): string {
  return step.recordedAt.getTime() - step.time.getTime() > 10 * 60 * 1000 ? `Ghi nhận muộn lúc ${formatDateTime(step.recordedAt)}` : ''
}

export function buildBatchReport(result: TraceResult, actorsById: Map<string, Actor>, publicUrl: string, catalog?: Catalog): BatchReport {
  const category = catalog?.categoryOf(result.batch)
  const { batch, events, anomalies, isValid } = result
  return {
    title: 'Báo cáo hành trình lô hàng',
    generatedAt: new Date(),
    batch,
    publicUrl,
    isValid,
    integrityText: isValid
      ? 'Chuỗi băm khớp — dữ liệu chưa bị sửa hoặc xoá kể từ khi được ghi.'
      : 'Chuỗi băm KHÔNG khớp — phát hiện dữ liệu bị sửa hoặc xoá sau khi ghi.',
    statusText: batchStatusText(batch),
    steps: [...events]
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
      .map((e, i) => {
        const actor = actorsById.get(e.actorId)
        return {
          index: i + 1,
          stage: e.stage,
          stageLabel: stepLabel(e.kind, e.stage, catalog),
          time: new Date(e.occurredAt ?? e.timestamp),
          recordedAt: new Date(e.timestamp),
          organization: actor?.organization ?? 'Không rõ',
          person: actor?.name ?? '',
          role: actor ? ROLE_LABELS[actor.role] : '',
          location: e.location,
          facts: describeEventData(catalog?.fieldsForEvent(e, category) ?? [], e.data ?? {}).map(({ label, value }) => ({ label, value })),
          notes: e.notes ?? '',
          hash: e.hash,
        }
      }),
    anomalies: anomalies.map((a) => ({
      severity: SEVERITY_LABELS[a.severity],
      message: a.message,
      detectedAt: new Date(a.detectedAt),
      resolved: a.resolved,
    })),
    fileBase: `hanh-trinh-${fileSlug(batch.productName)}-${batch.id.slice(0, 8)}`,
  }
}
