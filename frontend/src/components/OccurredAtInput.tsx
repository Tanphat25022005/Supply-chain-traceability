import { CalendarClock } from 'lucide-react'
import { toLocalInput } from '../domain/catalog'
import { inputClass, labelClass } from './ui/field'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * "When did it happen?" — defaults to now; may be set in the past (recorded
 * later than it happened). Beyond the product's limit a reason is required,
 * and the entry is flagged as late (the server enforces the same rule).
 */
export default function OccurredAtInput({
  value,
  onChange,
  lateReason,
  onLateReasonChange,
  maxBackdateDays,
  label = 'Thời điểm thực hiện',
}: {
  /** datetime-local string */
  value: string
  onChange: (v: string) => void
  lateReason: string
  onLateReasonChange: (v: string) => void
  maxBackdateDays: number
  label?: string
}) {
  const at = value ? new Date(value) : new Date()
  const ageMs = Date.now() - at.getTime()
  const late = ageMs > maxBackdateDays * DAY_MS
  const future = ageMs < -5 * 60 * 1000
  return (
    <div className="space-y-2">
      <div>
        <label htmlFor="occurred-at" className={`${labelClass} flex items-center gap-1.5`}>
          <CalendarClock className="w-3.5 h-3.5 text-slate-400" /> {label}
        </label>
        <input
          id="occurred-at"
          type="datetime-local"
          value={value}
          max={toLocalInput(new Date())}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
          Khi việc diễn ra — có thể ghi bù cho việc đã làm trước. Thời điểm hệ thống ghi nhận được lưu riêng.
        </p>
        {future && <p className="text-xs text-rose-600 mt-1">Không chọn thời điểm trong tương lai.</p>}
      </div>
      {late && (
        <div>
          <label htmlFor="late-reason" className={labelClass}>
            Lý do ghi muộn <span className="text-rose-500">*</span>
          </label>
          <input
            id="late-reason"
            value={lateReason}
            onChange={(e) => onLateReasonChange(e.target.value)}
            required
            maxLength={500}
            placeholder="VD: Mất sóng điện thoại trên rẫy, ghi bù khi về xưởng"
            className={inputClass}
          />
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
            Quá {maxBackdateDays} ngày sau khi xảy ra — hệ thống sẽ gắn cảnh báo "Ghi muộn" kèm lý do này.
          </p>
        </div>
      )}
    </div>
  )
}

/** The ISO instant to send, or undefined for "now" (within a minute of it). */
export function occurredAtToIso(value: string): string | undefined {
  if (!value) return undefined
  const at = new Date(value)
  return Math.abs(Date.now() - at.getTime()) < 60 * 1000 ? undefined : at.toISOString()
}

export function isLate(value: string, maxBackdateDays: number): boolean {
  return !!value && Date.now() - new Date(value).getTime() > maxBackdateDays * DAY_MS
}
