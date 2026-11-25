import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Actor, ActorRole, ROLE_LABELS } from '../api/client'
import { inputClass, labelClass } from './ui/field'

/**
 * "Who takes the lot next" — only active accounts whose role can do what may
 * come next (per the lot's workflow) are offered; a single candidate is
 * pre-selected so the common case is zero clicks. The receiver confirms
 * receipt before the lot is theirs.
 */
export default function HandoffSelect({
  roles,
  label,
  actors,
  value,
  onChange,
  isAdmin,
  required = !isAdmin,
  excludeId,
}: {
  /** Roles that can take it; empty = any partner (e.g. a rejected lot going back for rework). */
  roles: ActorRole[]
  label: string
  actors: Actor[]
  value: string
  onChange: (id: string) => void
  isAdmin: boolean
  required?: boolean
  /** Usually the current holder — handing to yourself is not a hand-over. */
  excludeId?: string
}) {
  const candidates = useMemo(
    () =>
      actors.filter(
        (a) => a.isActive && a.id !== excludeId && a.role !== 'IMPORTER' && (roles.length === 0 || roles.includes(a.role) || a.role === 'ADMIN'),
      ),
    [actors, roles, excludeId],
  )

  useEffect(() => {
    const realCandidates = candidates.filter((a) => a.role !== 'ADMIN')
    if (!value && required && realCandidates.length === 1) onChange(realCandidates[0].id)
  }, [value, candidates, onChange, required])

  return (
    <div>
      <label htmlFor="handoff" className={labelClass}>
        {label} {required && <span className="text-rose-500">*</span>}
      </label>
      <select id="handoff" value={value} onChange={(e) => onChange(e.target.value)} required={required} className={inputClass}>
        <option value="">{required ? '— Chọn người tiếp nhận —' : '— Tôi giữ lại / để trống —'}</option>
        {candidates.map((a) => (
          <option key={a.id} value={a.id}>
            {a.organization} · {a.name} ({ROLE_LABELS[a.role]})
          </option>
        ))}
      </select>
      {candidates.length === 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5">
          Chưa có {roles.map((r) => ROLE_LABELS[r].toLowerCase()).join(' hoặc ') || 'đối tác'} nào trong không gian làm việc.{' '}
          {isAdmin ? (
            <Link to="/actors" className="underline font-medium">
              Mời thành viên
            </Link>
          ) : (
            'Nhờ quản trị viên gửi lời mời cho đối tác.'
          )}
        </p>
      )}
    </div>
  )
}
