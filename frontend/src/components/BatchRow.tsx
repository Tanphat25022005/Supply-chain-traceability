import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { Batch, STATUS_LABELS } from '../api/client'
import { useCatalog } from '../context/CatalogContext'
import { daysSince, nextStepLabel, relativeDays } from '../domain/catalog'
import Badge, { BadgeTone } from './ui/Badge'
import { cardClass } from './ui/Card'

const STATUS_TONES: Record<Batch['status'], BadgeTone> = {
  ACTIVE: 'brand',
  IN_TRANSIT: 'info',
  ON_HOLD: 'warning',
  REJECTED: 'danger',
  RECALLED: 'danger',
  DESTROYED: 'danger',
  CONSUMED: 'neutral',
}

/** The lot's state in one phrase: what it's waiting for, or why it can't move. */
export function BatchStatusBadge({ batch }: { batch: Batch }) {
  const { catalog } = useCatalog()
  if (batch.status !== 'ACTIVE') return <Badge tone={STATUS_TONES[batch.status]}>{STATUS_LABELS[batch.status]}</Badge>
  const next = nextStepLabel(batch, catalog)
  if (!next) return <Badge tone="success">Hoàn tất</Badge>
  const waited = daysSince(batch.lastEventAt ?? batch.createdAt) ?? 0
  return <Badge tone={waited >= 3 ? 'warning' : 'brand'}>Chờ {next.toLowerCase()}</Badge>
}

export default function BatchRow({ batch, to, action }: { batch: Batch; to?: string; action?: string }) {
  const lastActivity = batch.lastEventAt ?? batch.createdAt
  return (
    <Link
      to={to ?? `/batch/${batch.id}`}
      className={cardClass({ hover: true, padding: 'md', className: 'flex items-center justify-between gap-3' })}
    >
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-slate-900 dark:text-slate-50 truncate">{batch.productName}</p>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 truncate">
          {batch.origin} · {batch.quantity.toLocaleString('vi-VN')} {batch.unit}
          {batch.unit !== batch.baseUnit && batch.quantityBase !== undefined && (
            <span className="text-slate-400"> ({batch.quantityBase.toLocaleString('vi-VN')} {batch.baseUnit})</span>
          )}
        </p>
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">Cập nhật {relativeDays(lastActivity)}</p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <BatchStatusBadge batch={batch} />
        {action ? (
          <span className="text-sm font-medium text-brand-600 dark:text-brand-400 hidden sm:inline">{action} →</span>
        ) : (
          <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600" />
        )}
      </div>
    </Link>
  )
}
