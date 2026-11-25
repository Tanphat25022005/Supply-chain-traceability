import { useState } from 'react'
import { ArrowRightLeft, Clock, Undo2 } from 'lucide-react'
import { Actor, Batch, batchApi, CustodyView, remainingOf, transferApi } from '../api/client'
import { useCatalog } from '../context/CatalogContext'
import { formatDateTime } from '../domain/catalog'
import { apiErrorMessage } from '../lib/apiError'
import HandoffSelect from './HandoffSelect'
import Button from './ui/Button'
import { cardClass } from './ui/Card'
import { inputClass, labelClass } from './ui/field'

/**
 * Hand a lot over without recording a stage — e.g. the mill kept the green
 * beans after transforming them and now sends them to QC, or a lot that failed
 * inspection goes back to the mill. The receiver must accept (weighing what
 * arrived) or reject; until then the lot is "in transit". While a hand-over is
 * pending, the sender sees it here and may withdraw it.
 */
export default function HandOffPanel({
  batch,
  actors,
  custody,
  me,
  onDone,
}: {
  batch: Batch
  actors: Actor[]
  custody?: CustodyView
  me: Actor
  onDone: () => void
}) {
  const { catalog } = useCatalog()
  const [to, setTo] = useState('')
  const [vehicle, setVehicle] = useState('')
  const [packageCount, setPackageCount] = useState('')
  const [documentNo, setDocumentNo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const pending = custody?.transfers.find((t) => t.status === 'PENDING')
  const rules = catalog?.rules(batch.workflowId)
  const nameOf = (id: string) => {
    const a = actors.find((x) => x.id === id)
    return a ? `${a.organization} · ${a.name}` : 'người nhận'
  }

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onDone()
    } catch (err) {
      setError(apiErrorMessage(err, 'Không bàn giao được.'))
    } finally {
      setBusy(false)
    }
  }

  if (pending) {
    const mine = pending.fromActorId === me.id || me.role === 'ADMIN'
    return (
      <section className={cardClass({ className: 'space-y-2 border-sky-200/80 dark:border-sky-500/20' })}>
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
          <Clock className="w-4 h-4 text-sky-500" /> Đang chờ xác nhận nhận hàng
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Đã bàn giao {pending.quantity.toLocaleString('vi-VN')} {pending.unit} cho <strong>{nameOf(pending.toActorId)}</strong> lúc{' '}
          {formatDateTime(pending.createdAt)}
          {pending.vehicle && ` · xe ${pending.vehicle}`}
          {pending.packageCount && ` · ${pending.packageCount} kiện`}.
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">Lô chỉ thuộc về người nhận khi họ cân và xác nhận.</p>
        {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
        {mine && (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => run(() => transferApi.cancel(pending.id))}>
            <Undo2 className="w-3.5 h-3.5" /> Huỷ bàn giao
          </Button>
        )}
      </section>
    )
  }

  const holder = batch.assignedToActorId ?? me.id
  const rejected = batch.status === 'REJECTED'
  if (!rules || (batch.status !== 'ACTIVE' && !rejected)) return null
  if (holder !== me.id && me.role !== 'ADMIN') return null
  if (!rejected && rules.isFinal(batch.currentStage)) return null
  const position = rules.position(batch.currentStage)
  const nextSteps = rules.nextCandidates(position, batch)
  // Someone working the next steps, or (as with merges) the current one.
  const current = rules.steps.find((s) => s.position === position)
  const roles = rejected ? [] : [...new Set([...nextSteps, ...(current ? [current] : [])].flatMap((s) => s.roles))]
  const nextLabel = nextSteps.map((s) => catalog!.stageLabel(s.stage).toLowerCase()).join(' hoặc ')

  return (
    <section className={cardClass({ className: 'space-y-3 border-amber-200/80 dark:border-amber-500/20' })}>
      <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
        <ArrowRightLeft className="w-4 h-4 text-amber-500" /> Bàn giao lô
      </h2>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {rejected
          ? 'Lô không đạt kiểm định — chuyển cho đơn vị sẽ chế biến lại, hạ loại hoặc huỷ.'
          : `Bàn giao ${remainingOf(batch).toLocaleString('vi-VN')} ${batch.unit} cho đơn vị làm khâu tiếp theo (${nextLabel}). Người nhận cân và xác nhận.`}
      </p>
      <HandoffSelect roles={roles} label="Người nhận" actors={actors} value={to} onChange={setTo} isAdmin={false} excludeId={holder} />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <label htmlFor="ho-vehicle" className={labelClass}>Xe / biển số</label>
          <input id="ho-vehicle" value={vehicle} onChange={(e) => setVehicle(e.target.value)} maxLength={40} className={inputClass} />
        </div>
        <div>
          <label htmlFor="ho-packages" className={labelClass}>Số kiện</label>
          <input id="ho-packages" type="number" min={1} value={packageCount} onChange={(e) => setPackageCount(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label htmlFor="ho-doc" className={labelClass}>Số chứng từ</label>
          <input id="ho-doc" value={documentNo} onChange={(e) => setDocumentNo(e.target.value)} maxLength={60} className={inputClass} />
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
      <Button
        type="button"
        size="sm"
        disabled={busy || !to}
        onClick={() =>
          run(() =>
            batchApi.transfer(batch.id, {
              toActorId: to,
              vehicle: vehicle.trim() || undefined,
              packageCount: packageCount ? Number(packageCount) : undefined,
              documentNo: documentNo.trim() || undefined,
            }),
          )
        }
      >
        {busy ? 'Đang bàn giao...' : 'Bàn giao'}
      </Button>
    </section>
  )
}
