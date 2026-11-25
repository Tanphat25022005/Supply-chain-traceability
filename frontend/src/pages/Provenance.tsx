import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import BackButton from '../components/BackButton'
import { Building2, CircleX, MapPin, PauseCircle, ShieldAlert, ShieldCheck, Siren, Sprout, TriangleAlert } from 'lucide-react'
import { CUSTODY_EVENT_LABELS, CustodyEventKind, isStageEvent, PublicTrace, stageIcon, stageLabel, traceApi } from '../api/client'
import { useCatalog } from '../context/CatalogContext'
import { describeEventData } from '../domain/catalog'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/** Where the product is now, in words a shopper uses — not "4/6 khâu". */
function statusLine(data: PublicTrace): { text: string; tone: 'danger' | 'success' | 'info' | 'warning' } {
  switch (data.batch.status) {
    case 'RECALLED':
      return { text: 'Đã thu hồi', tone: 'danger' }
    case 'DESTROYED':
      return { text: 'Đã huỷ', tone: 'danger' }
    case 'REJECTED':
      return { text: 'Không đạt kiểm định', tone: 'danger' }
    case 'ON_HOLD':
      return { text: 'Đang tạm giữ để kiểm tra', tone: 'warning' }
  }
  switch (data.batch.currentStage) {
    case 'RETAIL':
      return { text: 'Đã đến cửa hàng', tone: 'success' }
    case 'IMPORT_RECEIPT':
      return { text: 'Đã đến nước nhập khẩu', tone: 'success' }
    case 'EXPORT':
      return { text: 'Đã xuất khẩu', tone: 'info' }
    case 'DISTRIBUTION':
    case 'COLD_CHAIN':
      return { text: 'Đang vận chuyển', tone: 'info' }
    case null:
      return { text: 'Mới ghi nhận', tone: 'info' }
    default:
      return { text: `Đang ở khâu ${stageLabel(data.batch.currentStage).toLowerCase()}`, tone: 'info' }
  }
}

const toneClass = {
  danger: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  info: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  warning: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
}

/** Custody events worth telling a shopper about; plain hand-over paperwork is not. */
const PUBLIC_CUSTODY: CustodyEventKind[] = ['TRANSFER_ACCEPT', 'HOLD', 'RELEASE', 'RECALL', 'DISPOSE']

/**
 * The page a shopper lands on after scanning the QR code. It tells the
 * product's story — which organization did what, where and when, with the
 * facts worth knowing (variety, grade, expiry) — and states plainly what the
 * integrity check does and doesn't prove.
 */
export default function Provenance() {
  const { batchId } = useParams<{ batchId: string }>()
  const { catalog } = useCatalog()
  const [data, setData] = useState<PublicTrace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!batchId) return
    traceApi
      .public(batchId)
      .then(setData)
      .catch(() => setError('Không tìm thấy sản phẩm với mã này'))
      .finally(() => setLoading(false))
  }, [batchId])

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-emerald-50 to-white dark:from-slate-950 dark:to-slate-900 flex items-center justify-center">
        <div className="flex items-center gap-2 text-slate-400 dark:text-slate-500 text-sm">
          <span className="w-4 h-4 rounded-full border-2 border-slate-200 dark:border-slate-700 border-t-brand-500 animate-spin" />
          Đang tra cứu nguồn gốc...
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="relative min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
        <BackButton fallback="/" className="absolute top-4 left-4" />
        <div className="text-center max-w-xs">
          <CircleX className="w-12 h-12 mx-auto mb-3 text-rose-500 dark:text-rose-400" />
          <p className="text-slate-900 dark:text-slate-100 font-medium">{error || 'Không tìm thấy sản phẩm'}</p>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-2">
            Mã QR có thể bị hỏng hoặc không phải của hệ thống TraceChain. Nếu nghi ngờ hàng giả, hãy báo cho cửa hàng nơi bạn mua.
          </p>
        </div>
      </div>
    )
  }

  const status = statusLine(data)
  const { batch, journey } = data

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50 via-white to-white dark:from-slate-950 dark:via-slate-950 dark:to-slate-900">
      <div className="max-w-md mx-auto px-4 pt-4 pb-12">
        <BackButton fallback="/" className="-ml-3 mb-2" />
        {/* Product */}
        <header className="text-center mb-6 animate-slide-up">
          <span className={`inline-block text-xs font-semibold px-3 py-1 rounded-full ${toneClass[status.tone]}`}>{status.text}</span>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50 tracking-tight mt-3">{batch.productName}</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1 flex items-center justify-center gap-1">
            <MapPin className="w-3.5 h-3.5" /> {batch.origin}
          </p>
        </header>

        {data.recalledInputs.length > 0 && !batch.isRecalled && (
          <div role="alert" className="bg-rose-50 border-2 border-rose-300 dark:bg-rose-500/10 dark:border-rose-500/30 rounded-2xl p-4 mb-5">
            <p className="font-bold text-rose-700 dark:text-rose-400 flex items-center gap-2">
              <Siren className="w-5 h-5" /> Lô nguyên liệu của sản phẩm này đã bị thu hồi
            </p>
            <ul className="text-rose-700 dark:text-rose-300 text-sm mt-1.5 space-y-0.5">
              {data.recalledInputs.map((r, i) => (
                <li key={i}>
                  {r.productName}
                  {r.reason && ` — ${r.reason}`}
                </li>
              ))}
            </ul>
            <p className="text-rose-600 dark:text-rose-400/90 text-sm mt-2">Tạm ngừng sử dụng và liên hệ nơi bán trong khi chờ kết luận.</p>
          </div>
        )}

        {batch.status === 'ON_HOLD' && (
          <div role="status" className="bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30 rounded-2xl p-4 mb-5 text-sm text-amber-800 dark:text-amber-300 flex gap-2">
            <PauseCircle className="w-5 h-5 flex-shrink-0" />
            <p>Lô hàng đang được tạm giữ để kiểm tra. Thông tin sẽ được cập nhật khi có kết luận.</p>
          </div>
        )}

        {batch.isRecalled && (
          <div role="alert" className="bg-rose-50 border-2 border-rose-300 dark:bg-rose-500/10 dark:border-rose-500/30 rounded-2xl p-4 mb-5">
            <p className="font-bold text-rose-700 dark:text-rose-400 flex items-center gap-2">
              <Siren className="w-5 h-5" /> Sản phẩm này đã bị thu hồi
            </p>
            {batch.recallReason && <p className="text-rose-700 dark:text-rose-300 text-sm mt-1.5">Lý do: {batch.recallReason}</p>}
            <p className="text-rose-600 dark:text-rose-400/90 text-sm mt-2">Không sử dụng sản phẩm. Mang trả lại nơi đã mua để được hỗ trợ.</p>
          </div>
        )}

        {/* Where it came from — only when assembled from several harvests */}
        {data.origins && (
          <section className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-card dark:shadow-none p-5 mb-4">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2 flex items-center gap-1.5">
              <Sprout className="w-4 h-4 text-emerald-500" /> Nguồn gốc
            </h2>
            <p className="text-sm text-slate-700 dark:text-slate-200">
              Sản phẩm được tập hợp từ <strong>{data.origins.harvestLotCount}</strong> lô thu hoạch
              {data.origins.plotCount > 0 && <> trên <strong>{data.origins.plotCount}</strong> lô đất có toạ độ</>}
              {data.origins.producers.length > 0 && <> của {data.origins.producers.length} đơn vị sản xuất</>}.
            </p>
            {data.origins.regions.length > 0 && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 flex items-start gap-1">
                <MapPin className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {data.origins.regions.slice(0, 5).join(' · ')}
                {data.origins.regions.length > 5 && ` và ${data.origins.regions.length - 5} vùng khác`}
              </p>
            )}
            {data.origins.producers.length > 0 && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-start gap-1">
                <Building2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {data.origins.producers.slice(0, 5).join(' · ')}
              </p>
            )}
          </section>
        )}

        {/* Journey */}
        <section className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-card dark:shadow-none p-5 mb-4">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">Hành trình sản phẩm</h2>
          {journey.length === 0 ? (
            <p className="text-sm text-slate-400">Chưa có bước nào được ghi nhận.</p>
          ) : (
            <ol className="relative space-y-5">
              <span aria-hidden="true" className="absolute left-[17px] top-3 bottom-3 w-px bg-emerald-200 dark:bg-emerald-500/30" />
              {journey
                .filter((step) => isStageEvent(step.kind) || PUBLIC_CUSTODY.includes(step.kind as CustodyEventKind))
                .map((step, i) => {
                if (!isStageEvent(step.kind)) {
                  const danger = step.kind === 'RECALL' || step.kind === 'DISPOSE'
                  return (
                    <li key={i} className="relative pl-12 text-sm">
                      <span
                        className={`absolute left-2.5 top-0.5 w-4 h-4 rounded-full border-2 ${danger ? 'bg-rose-500 border-rose-500' : 'bg-white border-emerald-400 dark:bg-slate-900'}`}
                      />
                      <p className={danger ? 'text-rose-700 dark:text-rose-400 font-medium' : 'text-slate-600 dark:text-slate-300'}>
                        {step.kind === 'TRANSFER_ACCEPT' ? 'Tiếp nhận hàng' : CUSTODY_EVENT_LABELS[step.kind as CustodyEventKind]}
                        {step.organization && <span className="font-normal text-slate-500 dark:text-slate-400"> · {step.organization}</span>}
                        <span className="text-xs text-slate-400 dark:text-slate-500"> · {formatDate(step.occurredAt ?? step.timestamp)}</span>
                      </p>
                      {typeof step.details.reason === 'string' && <p className="text-xs text-slate-500 dark:text-slate-400">{step.details.reason}</p>}
                    </li>
                  )
                }
                const Icon = stageIcon(step.stage)
                const fields = catalog?.fieldsForEvent(step, catalog.productType(batch.productTypeId)?.categoryCode) ?? []
                const facts = describeEventData(fields, step.details, { publicOnly: fields.length > 0 })
                return (
                  <li key={i} className="relative pl-12">
                    <span className="absolute left-0 top-0 w-9 h-9 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-sm">
                      <Icon className="w-4 h-4" />
                    </span>
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="font-semibold text-slate-900 dark:text-slate-50">{catalog?.stageLabel(step.stage) ?? stageLabel(step.stage)}</p>
                      <time dateTime={step.occurredAt} className="text-xs text-slate-400 dark:text-slate-500 flex-shrink-0">
                        {formatDate(step.occurredAt ?? step.timestamp)}
                      </time>
                    </div>
                    {step.organization && (
                      <p className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-1.5 mt-0.5">
                        <Building2 className="w-3.5 h-3.5 text-slate-400" /> {step.organization}
                      </p>
                    )}
                    <p className="text-sm text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-slate-400" /> {step.location}
                    </p>
                    {facts.length > 0 && (
                      <dl className="mt-2 flex flex-wrap gap-1.5">
                        {facts.map((f) => (
                          <div key={f.key} className="text-xs bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-lg px-2 py-1">
                            <dt className="inline text-slate-400 dark:text-slate-500">{f.label}: </dt>
                            <dd className="inline font-medium text-slate-700 dark:text-slate-200">{f.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </section>

        {/* Integrity — stated within what the hash chain actually proves */}
        <section
          className={`rounded-2xl p-4 mb-6 border ${
            data.isValid
              ? 'bg-slate-50 border-slate-200 dark:bg-slate-900 dark:border-slate-800'
              : 'bg-rose-50 border-rose-200 dark:bg-rose-500/10 dark:border-rose-500/20'
          }`}
        >
          {data.isValid ? (
            <>
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> Hồ sơ nguyên vẹn
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                Mỗi bước được ghi nối tiếp nhau bằng mã băm. Không bước nào bị sửa hoặc xoá kể từ khi được ghi. Hồ sơ này cho biết ai đã
                khai báo điều gì, nhưng không thay thế cho kiểm định độc lập.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-rose-700 dark:text-rose-400 flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4" /> Hồ sơ đã bị sửa đổi
              </p>
              <p className="text-xs text-rose-600 dark:text-rose-400/90 mt-1">
                Có dữ liệu bị thay đổi hoặc xoá sau khi ghi. Đừng dựa vào thông tin trên trang này.
              </p>
            </>
          )}
          {data.isValid && data.hasAnomalies && (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-2 flex items-center gap-1.5">
              <TriangleAlert className="w-3.5 h-3.5" /> Có bước ghi nhận sai quy trình đang được xem xét.
            </p>
          )}
          <Link to={`/verify?batch=${batch.id}`} className="text-xs text-brand-600 dark:text-brand-400 hover:underline mt-2 inline-block">
            Tự kiểm chứng kỹ thuật →
          </Link>
        </section>

        <footer className="text-center">
          <p className="text-[11px] text-slate-300 dark:text-slate-600 font-mono break-all">Mã lô: {batchId}</p>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Truy xuất nguồn gốc bởi TraceChain</p>
        </footer>
      </div>
    </div>
  )
}
