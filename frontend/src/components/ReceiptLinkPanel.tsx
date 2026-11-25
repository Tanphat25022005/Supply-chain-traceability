import { useState } from 'react'
import { Ship } from 'lucide-react'
import { receiptApi } from '../api/client'
import { formatDateTime } from '../domain/catalog'
import { apiErrorMessage } from '../lib/apiError'
import Button from './ui/Button'
import { cardClass } from './ui/Card'
import { inputClass, labelClass } from './ui/field'

/**
 * After export: a time-limited link for the foreign buyer. They open it (no
 * account), weigh what arrived and confirm — the last step of the chain,
 * attributed to them on the ledger.
 */
export default function ReceiptLinkPanel({ batchId, importerName }: { batchId: string; importerName?: string }) {
  const [name, setName] = useState(importerName ?? '')
  const [days, setDays] = useState(60)
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await receiptApi.createLink(batchId, name.trim(), days)
      const url = `${window.location.origin}/receipt?batch=${batchId}&token=${encodeURIComponent(r.token)}`
      setLink({ url, expiresAt: r.expiresAt })
    } catch (err) {
      setError(apiErrorMessage(err, 'Không tạo được link.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={cardClass({ className: 'space-y-3' })}>
      <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
        <Ship className="w-4 h-4 text-brand-500" /> Bên nhập khẩu xác nhận nhận hàng
      </h2>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Gửi link này cho người nhập khẩu. Họ không cần tài khoản: mở link, nhập khối lượng nhận được và tình trạng hàng — đó là khâu cuối của chuỗi.
      </p>
      {!link ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="sm:col-span-2">
              <label htmlFor="importer" className={labelClass}>
                Tên người nhập khẩu <span className="text-rose-500">*</span>
              </label>
              <input id="importer" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className={inputClass} />
            </div>
            <div>
              <label htmlFor="link-days" className={labelClass}>
                Hiệu lực (ngày)
              </label>
              <input id="link-days" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputClass} />
            </div>
          </div>
          {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
          <Button type="button" size="sm" disabled={busy || !name.trim()} onClick={create}>
            {busy ? 'Đang tạo...' : 'Tạo link xác nhận'}
          </Button>
        </>
      ) : (
        <div className="space-y-2">
          <input readOnly value={link.url} aria-label="Link xác nhận nhận hàng" className={`${inputClass} font-mono text-xs`} onFocus={(e) => e.target.select()} />
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() =>
                navigator.clipboard.writeText(link.url).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                })
              }
            >
              {copied ? 'Đã sao chép' : 'Sao chép link'}
            </Button>
            <span className="text-xs text-slate-500">Hết hạn {formatDateTime(link.expiresAt)}</span>
          </div>
        </div>
      )}
    </section>
  )
}
