import { FormEvent, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Batch, batchApi, remainingOf } from '../api/client'
import { toLocalInput } from '../domain/catalog'
import { apiErrorMessage } from '../lib/apiError'
import { occurredAtToIso } from './OccurredAtInput'
import Modal from './ui/Modal'
import Button from './ui/Button'
import { inputClass, labelClass } from './ui/field'

/** A reason, then an action — for putting a lot on hold and releasing it. */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  danger,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  danger?: boolean
  onClose: () => void
  onConfirm: (reason: string) => Promise<unknown>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onConfirm(reason.trim())
      setReason('')
    } catch (err) {
      setError(apiErrorMessage(err, 'Không thực hiện được. Thử lại sau.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} title={title} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">{description}</p>
        <div>
          <label htmlFor="reason-dialog" className={labelClass}>
            Lý do <span className="text-rose-500">*</span>
          </label>
          <textarea id="reason-dialog" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} required className={`${inputClass} resize-none`} />
        </div>
        {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Huỷ
          </Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={busy || !reason.trim()}>
            {busy ? 'Đang xử lý...' : confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Destroying what remains of a lot, with the record a real disposal has:
 * record number, method, witness. Final — the lot can take nothing more.
 */
export function DisposeDialog({ batch, open, onClose, onDone }: { batch: Batch; open: boolean; onClose: () => void; onDone: () => void }) {
  const [recordNo, setRecordNo] = useState('')
  const [method, setMethod] = useState('')
  const [witness, setWitness] = useState('')
  const [reason, setReason] = useState('')
  const [occurredAt, setOccurredAt] = useState(toLocalInput(new Date()))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await batchApi.dispose(batch.id, {
        recordNo: recordNo.trim(),
        method: method.trim(),
        witness: witness.trim(),
        reason: reason.trim() || undefined,
        occurredAt: occurredAtToIso(occurredAt),
      })
      onDone()
    } catch (err) {
      setError(apiErrorMessage(err, 'Không huỷ được lô. Thử lại sau.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} title="Huỷ lô hàng" onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        <div className="bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 rounded-xl p-3 text-sm text-rose-800 dark:text-rose-300 flex gap-2">
          <Trash2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <p>
            Huỷ {remainingOf(batch).toLocaleString('vi-VN')} {batch.unit} còn lại của <strong>{batch.productName}</strong>. Khối lượng này được tính là hao
            hụt, lô không thể đi tiếp. Không hoàn tác được.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="d-record" className={labelClass}>
              Số biên bản <span className="text-rose-500">*</span>
            </label>
            <input id="d-record" value={recordNo} onChange={(e) => setRecordNo(e.target.value)} required maxLength={60} placeholder="VD: BB-HUY-2026-031" className={inputClass} />
          </div>
          <div>
            <label htmlFor="d-at" className={labelClass}>
              Thời điểm huỷ
            </label>
            <input id="d-at" type="datetime-local" value={occurredAt} max={toLocalInput(new Date())} onChange={(e) => setOccurredAt(e.target.value)} className={inputClass} />
          </div>
        </div>
        <div>
          <label htmlFor="d-method" className={labelClass}>
            Phương thức huỷ <span className="text-rose-500">*</span>
          </label>
          <input id="d-method" value={method} onChange={(e) => setMethod(e.target.value)} required maxLength={200} placeholder="VD: Tiêu huỷ tại lò đốt chất thải nông nghiệp" className={inputClass} />
        </div>
        <div>
          <label htmlFor="d-witness" className={labelClass}>
            Người / cơ quan chứng kiến <span className="text-rose-500">*</span>
          </label>
          <input id="d-witness" value={witness} onChange={(e) => setWitness(e.target.value)} required maxLength={200} placeholder="VD: Đại diện Chi cục QLCL Nông Lâm Thủy sản" className={inputClass} />
        </div>
        <div>
          <label htmlFor="d-reason" className={labelClass}>
            Lý do
          </label>
          <input id="d-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} className={inputClass} />
        </div>
        {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Huỷ bỏ
          </Button>
          <Button type="submit" variant="danger" disabled={busy || !recordNo.trim() || !method.trim() || !witness.trim()}>
            {busy ? 'Đang huỷ...' : 'Xác nhận huỷ lô'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
