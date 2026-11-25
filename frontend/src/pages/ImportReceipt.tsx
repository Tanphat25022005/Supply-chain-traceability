import { FormEvent, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CircleCheck, PackageCheck, TriangleAlert } from 'lucide-react'
import { receiptApi, ReceiptInfo } from '../api/client'
import { formatDateTime } from '../domain/catalog'
import { apiErrorMessage } from '../lib/apiError'
import Button from '../components/ui/Button'
import { cardClass } from '../components/ui/Card'
import { inputClass, labelClass } from '../components/ui/field'
import { SkeletonCardList } from '../components/ui/Skeleton'

type Condition = 'GOOD' | 'DAMAGED' | 'REJECTED'

/** The buyer abroad is rarely a Vietnamese reader: every label carries English first. */
const CONDITIONS: Array<{ value: Condition; label: string }> = [
  { value: 'GOOD', label: 'Good condition / Hàng tốt' },
  { value: 'DAMAGED', label: 'Partly damaged / Hư hỏng một phần' },
  { value: 'REJECTED', label: 'Rejected / Từ chối nhận' },
]

/**
 * Public page behind the receipt link the exporter sent: no account, the
 * signed token in the URL is the authorisation. The importer weighs what
 * arrived and confirms — the final step of the lot's chain, recorded on the
 * ledger under their name.
 */
export default function ImportReceipt() {
  const [params] = useSearchParams()
  const batchId = params.get('batch') ?? ''
  const token = params.get('token') ?? ''
  const [info, setInfo] = useState<ReceiptInfo | null>(null)
  const [loadError, setLoadError] = useState('')
  const [quantity, setQuantity] = useState('')
  const [condition, setCondition] = useState<Condition>('GOOD')
  const [location, setLocation] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!batchId || !token) {
      setLoadError('Link không hợp lệ / This link is incomplete.')
      return
    }
    receiptApi
      .info(batchId, token)
      .then((r) => {
        setInfo(r)
        setQuantity(String(r.quantity))
      })
      .catch((err) => setLoadError(apiErrorMessage(err, 'Link không hợp lệ hoặc đã hết hạn / The link is invalid or has expired.')))
  }, [batchId, token])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const received = Number(quantity)
    if (!Number.isFinite(received) || received < 0) {
      setError('Nhập khối lượng nhận được / Enter the received quantity.')
      return
    }
    if (condition !== 'GOOD' && !notes.trim()) {
      setError('Mô tả tình trạng hàng / Please describe the problem.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await receiptApi.confirm(batchId, { token, receivedQuantity: received, condition, location: location.trim(), notes: notes.trim() || undefined })
      setDone(true)
    } catch (err) {
      setError(apiErrorMessage(err, 'Không ghi nhận được / Could not record the receipt.'))
    } finally {
      setBusy(false)
    }
  }

  const shortfall = info && quantity !== '' ? info.quantity - Number(quantity) : 0

  return (
    <div className="page-shell p-4">
      <main className="max-w-xl mx-auto py-8 space-y-5">
        <div className="text-center">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-brand-500 to-emerald-500 flex items-center justify-center text-white mb-3 shadow-glow">
            <PackageCheck className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50 tracking-tight">Import receipt</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Xác nhận nhận hàng nhập khẩu</p>
        </div>

        {loadError && (
          <div role="alert" className={cardClass({ className: 'flex gap-2 text-rose-700 dark:text-rose-400' })}>
            <TriangleAlert className="w-5 h-5 flex-shrink-0" />
            <p className="text-sm">{loadError}</p>
          </div>
        )}
        {!info && !loadError && <SkeletonCardList rows={2} />}

        {info && (
          <section className={cardClass({ className: 'space-y-1.5 text-sm' })}>
            <p className="text-lg font-semibold text-slate-900 dark:text-slate-50">{info.productName}</p>
            <p className="text-slate-600 dark:text-slate-300">
              Shipped / Đã xuất: <strong>{info.quantity.toLocaleString('vi-VN')} {info.unit}</strong>
            </p>
            <p className="text-slate-600 dark:text-slate-300">Exporter / Bên xuất khẩu: {info.exporter}</p>
            <p className="text-slate-600 dark:text-slate-300">Importer / Bên nhập khẩu: {info.importer}</p>
            {Object.entries(info.exportData)
              .filter(([, v]) => v !== '' && v !== null && v !== undefined)
              .map(([k, v]) => (
                <p key={k} className="text-xs text-slate-500 dark:text-slate-400">
                  {k}: {String(v)}
                </p>
              ))}
            {info.expiresAt && <p className="text-xs text-slate-400">Link valid until / Hiệu lực đến {formatDateTime(info.expiresAt)}</p>}
          </section>
        )}

        {info && (info.alreadyReceived || done) && (
          <div role="status" className={cardClass({ className: 'flex gap-2 text-emerald-700 dark:text-emerald-400' })}>
            <CircleCheck className="w-5 h-5 flex-shrink-0" />
            <div className="text-sm">
              <p className="font-semibold">Receipt recorded / Đã ghi nhận nhận hàng.</p>
              <p className="text-slate-600 dark:text-slate-300">
                The full journey is public:{' '}
                <Link to={`/provenance/${batchId}`} className="text-brand-600 dark:text-brand-400 font-medium hover:underline">
                  view provenance / xem nguồn gốc
                </Link>
              </p>
            </div>
          </div>
        )}

        {info && !info.alreadyReceived && !done && (
          <form onSubmit={submit} className={cardClass({ className: 'space-y-3' })} noValidate>
            <div>
              <label htmlFor="rq" className={labelClass}>
                Quantity received ({info.unit}) / Khối lượng nhận được <span className="text-rose-500">*</span>
              </label>
              <input id="rq" type="number" min={0} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={inputClass} required />
              {shortfall > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                  {shortfall.toLocaleString('vi-VN')} {info.unit} short of what was shipped — the difference is recorded as transit loss.
                </p>
              )}
            </div>
            <div>
              <label htmlFor="cond" className={labelClass}>
                Condition / Tình trạng <span className="text-rose-500">*</span>
              </label>
              <select id="cond" value={condition} onChange={(e) => setCondition(e.target.value as Condition)} className={inputClass}>
                {CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="loc" className={labelClass}>
                Place of receipt / Nơi nhận <span className="text-rose-500">*</span>
              </label>
              <input id="loc" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} placeholder="Port of Hamburg, DE" className={inputClass} required />
            </div>
            <div>
              <label htmlFor="notes" className={labelClass}>
                Notes / Ghi chú {condition !== 'GOOD' && <span className="text-rose-500">*</span>}
              </label>
              <textarea id="notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} className={inputClass} />
            </div>
            {error && (
              <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy || !location.trim()} className="w-full">
              {busy ? 'Sending… / Đang gửi…' : 'Confirm receipt / Xác nhận đã nhận'}
            </Button>
          </form>
        )}
      </main>
    </div>
  )
}
