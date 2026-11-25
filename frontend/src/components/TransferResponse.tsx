import { useState } from 'react'
import { Ban, PackageCheck, Scale } from 'lucide-react'
import { IncomingTransfer, Transfer, transferApi } from '../api/client'
import { formatDateTime } from '../domain/catalog'
import { apiErrorMessage } from '../lib/apiError'
import Button from './ui/Button'
import { inputClass, labelClass } from './ui/field'

/**
 * The receiver's side of a hand-over: weigh what arrived and accept it — a
 * shortfall is recorded as loss, and beyond the product's tolerance it raises
 * an alert — or refuse it with a reason, which returns it to the sender.
 */
export default function TransferResponse({
  transfer,
  tolerance,
  onDone,
  compact = false,
}: {
  transfer: Transfer | IncomingTransfer
  /** The product's transit tolerance (0.005 = 0.5%), to warn before submitting. */
  tolerance?: number
  onDone: () => void
  compact?: boolean
}) {
  const [received, setReceived] = useState(String(transfer.quantity))
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const receivedNum = Number(received)
  const shortfall = transfer.quantity - receivedNum
  const overTolerance = tolerance !== undefined && shortfall > transfer.quantity * tolerance + 1e-9

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onDone()
    } catch (err) {
      setError(apiErrorMessage(err, 'Không gửi được xác nhận.'))
    } finally {
      setBusy(false)
    }
  }

  const from = 'fromOrganization' in transfer ? `${transfer.fromOrganization} · ${transfer.fromName}` : undefined

  return (
    <div className="space-y-2">
      {!compact && (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {from ? <strong>{from}</strong> : 'Một đơn vị'} bàn giao {transfer.quantity.toLocaleString('vi-VN')} {transfer.unit} lúc{' '}
          {formatDateTime(transfer.createdAt)}
          {transfer.vehicle && ` · xe ${transfer.vehicle}`}
          {transfer.packageCount && ` · ${transfer.packageCount} kiện`}
          {transfer.documentNo && ` · chứng từ ${transfer.documentNo}`}.
        </p>
      )}
      {!rejecting ? (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={`recv-${transfer.id}`} className={`${labelClass} flex items-center gap-1`}>
              <Scale className="w-3.5 h-3.5 text-slate-400" /> Khối lượng cân được ({transfer.unit})
            </label>
            <input
              id={`recv-${transfer.id}`}
              type="number"
              min={0}
              max={transfer.quantity}
              step="any"
              value={received}
              onChange={(e) => setReceived(e.target.value)}
              className={`${inputClass} w-40`}
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="success"
            disabled={busy || !(receivedNum >= 0) || receivedNum > transfer.quantity}
            onClick={() => run(() => transferApi.respond(transfer.id, { accept: true, receivedQuantity: receivedNum }))}
          >
            <PackageCheck className="w-3.5 h-3.5" /> Xác nhận đã nhận
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(true)}>
            <Ban className="w-3.5 h-3.5" /> Từ chối
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-48">
            <label htmlFor={`reject-${transfer.id}`} className={labelClass}>
              Lý do từ chối <span className="text-rose-500">*</span>
            </label>
            <input
              id={`reject-${transfer.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              placeholder="VD: Quả xanh quá 10%, bao rách"
              className={inputClass}
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={busy || !reason.trim()}
            onClick={() => run(() => transferApi.respond(transfer.id, { accept: false, reason: reason.trim() }))}
          >
            Gửi từ chối
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>
            Quay lại
          </Button>
        </div>
      )}
      {!rejecting && shortfall > 0 && (
        <p className={`text-xs ${overTolerance ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500'}`}>
          Thiếu {shortfall.toLocaleString('vi-VN')} {transfer.unit} ({((shortfall / transfer.quantity) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%)
          {overTolerance ? ' — vượt mức hao hụt cho phép, hệ thống sẽ tạo cảnh báo.' : ' — trong mức hao hụt cho phép.'}
        </p>
      )}
      {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
    </div>
  )
}
