import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Download,
  ExternalLink,
  Inbox,
  PauseCircle,
  PlayCircle,
  Recycle,
  Siren,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useCatalog } from '../context/CatalogContext'
import { Actor, actorsApi, batchApi, CustodyView, remainingOf, ROLE_LABELS, stageIcon, traceApi, TraceResult, Workflow } from '../api/client'
import { canActOn, Catalog, formatDateTime, nextStepLabel, relativeDays } from '../domain/catalog'
import { apiErrorMessage } from '../lib/apiError'
import { buildBatchReport } from '../lib/reports/model'
import { downloadBlob, MIME } from '../lib/reports/download'
import Timeline from '../components/Timeline'
import VerifyBadge from '../components/VerifyBadge'
import RecallDialog from '../components/RecallDialog'
import VerifyPanel from '../components/VerifyPanel'
import LineagePanel from '../components/LineagePanel'
import HandOffPanel from '../components/HandOffPanel'
import TransferResponse from '../components/TransferResponse'
import ReceiptLinkPanel from '../components/ReceiptLinkPanel'
import { DisposeDialog, ReasonDialog } from '../components/LotActionDialogs'
import { BatchStatusBadge } from '../components/BatchRow'
import { buttonClass } from '../components/ui/Button'
import { cardClass } from '../components/ui/Card'
import { Skeleton, SkeletonCardList } from '../components/ui/Skeleton'

/** The lot's own workflow as a progress line: done / current / upcoming; optional steps dashed. */
function StageProgress({ workflow, catalog, current, stopped }: { workflow: Workflow; catalog: Catalog; current: string | null; stopped: boolean }) {
  const rules = catalog.rules(workflow.id)!
  const at = rules.position(current)
  return (
    <ol className="flex items-start overflow-x-auto pb-1" aria-label="Tiến độ theo quy trình">
      {workflow.steps.map((step, i) => {
        const Icon = stageIcon(step.stage)
        const done = step.position <= at
        const isNext = step.position === at + 1 && !stopped
        return (
          <li key={step.stage} className="flex-1 flex flex-col items-center text-center min-w-[4.5rem] relative">
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`absolute top-4 right-1/2 w-full h-0.5 -z-0 ${done ? 'bg-emerald-400 dark:bg-emerald-500/60' : 'bg-slate-200 dark:bg-slate-700'}`}
              />
            )}
            <span
              className={`relative z-10 w-8 h-8 rounded-full flex items-center justify-center border-2 ${step.required ? '' : 'border-dashed'} ${
                done
                  ? 'bg-emerald-500 border-emerald-500 text-white'
                  : isNext
                    ? 'bg-white dark:bg-slate-900 border-brand-500 text-brand-600 dark:text-brand-400 ring-4 ring-brand-100 dark:ring-brand-500/20'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-300 dark:text-slate-600'
              }`}
              title={step.required ? 'Bắt buộc' : 'Có thể bỏ qua'}
            >
              {done ? <CheckCircle2 className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
            </span>
            <span
              className={`mt-1.5 text-[11px] leading-tight px-0.5 ${
                done ? 'text-slate-700 dark:text-slate-200' : isNext ? 'text-brand-700 dark:text-brand-400 font-semibold' : 'text-slate-400 dark:text-slate-500'
              }`}
            >
              {catalog.stageLabel(step.stage)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

type ExportFormat = 'docx' | 'xlsx'

const EXPORT_OPTIONS: Array<{ format: ExportFormat; label: string; hint: string }> = [
  { format: 'docx', label: 'Word (.docx)', hint: 'In ấn, chỉnh sửa, đính kèm hồ sơ' },
  { format: 'xlsx', label: 'Excel (.xlsx)', hint: 'Lọc, tính toán số liệu' },
]

const FORMAT_NAMES: Record<ExportFormat, string> = { docx: 'Word', xlsx: 'Excel' }

/**
 * Every format is generated in the browser from the same report model
 * (lib/reports/model.ts) and only its library is downloaded on first use.
 */
function ExportMenu({ result, actorsById, publicUrl, catalog }: { result: TraceResult; actorsById: Map<string, Actor>; publicUrl: string; catalog: Catalog }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  const run = async (format: ExportFormat) => {
    setOpen(false)
    setBusy(format)
    setError('')
    try {
      const report = buildBatchReport(result, actorsById, publicUrl, catalog)
      let blob: Blob
      if (format === 'docx') blob = await (await import('../lib/reports/docx')).buildBatchDocx(report)
      else blob = await (await import('../lib/reports/xlsx')).buildBatchXlsx(report)
      downloadBlob(`${report.fileBase}.${format}`, blob, MIME[format])
    } catch (err) {
      console.error(err)
      setError(`Không xuất được file ${FORMAT_NAMES[format]}. Thử lại sau.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy !== null}
        aria-expanded={open}
        aria-haspopup="menu"
        className={buttonClass('secondary', 'md')}
      >
        <Download className="w-4 h-4" /> {busy ? `Đang tạo ${FORMAT_NAMES[busy]}...` : 'Xuất báo cáo'} <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 mt-1 w-64 z-20 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-card-hover p-1">
          {EXPORT_OPTIONS.map((o) => (
            <button
              key={o.format}
              role="menuitem"
              type="button"
              onClick={() => run(o.format)}
              className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <span className="block text-sm text-slate-800 dark:text-slate-100">{o.label}</span>
              <span className="block text-xs text-slate-400 dark:text-slate-500">{o.hint}</span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="absolute left-0 mt-1 text-xs text-rose-600 dark:text-rose-400 whitespace-nowrap">
          {error}
        </p>
      )}
    </div>
  )
}

function QrPanel({ batchId, publicUrl }: { batchId: string; publicUrl: string }) {
  const [svg, setSvg] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    batchApi.qrSvg(batchId).then(setSvg).catch(() => {})
  }, [batchId])

  return (
    <div className={cardClass({ className: 'flex flex-col sm:flex-row gap-4 items-center' })}>
      {svg && (
        // Rendered as an <img> (not dangerouslySetInnerHTML) so the SVG markup is
        // never parsed into the live DOM — an <img>-loaded SVG can't run scripts.
        <img
          src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
          alt="Mã QR tra cứu nguồn gốc"
          className="w-32 h-32 rounded-xl ring-1 ring-slate-100 dark:ring-slate-700 bg-white flex-shrink-0"
        />
      )}
      <div className="min-w-0 flex-1 w-full">
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">Tem truy xuất cho người tiêu dùng</p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">In mã QR lên bao bì. Người mua quét sẽ thấy hành trình công khai của lô.</p>
        <div className="flex flex-wrap gap-2 mt-3">
          {svg && (
            <button type="button" onClick={() => downloadBlob(`qr-${batchId.slice(0, 8)}.svg`, svg, MIME.svg)} className={buttonClass('secondary', 'sm')}>
              Tải mã QR
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(publicUrl).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              })
            }}
            className={buttonClass('secondary', 'sm')}
          >
            {copied ? 'Đã sao chép' : 'Sao chép link'}
          </button>
          <a href={publicUrl} target="_blank" rel="noreferrer" className={buttonClass('ghost', 'sm')}>
            Xem trang công khai <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    </div>
  )
}

export default function BatchDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { actor } = useAuth()
  const { catalog } = useCatalog()
  const [result, setResult] = useState<TraceResult | null>(null)
  const [custody, setCustody] = useState<CustodyView>()
  const [actors, setActors] = useState<Actor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<'recall' | 'hold' | 'release' | 'dispose' | null>(null)
  const [flash, setFlash] = useState<string>((location.state as { flash?: string } | null)?.flash ?? '')

  const load = useCallback(() => {
    if (!id) return
    setLoading(true)
    setError('')
    Promise.all([traceApi.get(id), batchApi.custodyOf(id).catch(() => undefined)])
      .then(([r, c]) => {
        setResult(r)
        setCustody(c)
      })
      .catch((err) => setError(apiErrorMessage(err, 'Không thể tải thông tin lô hàng.')))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    load()
    actorsApi.list().then(setActors).catch(() => {})
  }, [load])

  const actorsById = useMemo(() => new Map(actors.map((a) => [a.id, a])), [actors])
  const oversight = actor?.role === 'ADMIN' || actor?.role === 'INSPECTOR'

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(''), 5000)
    return () => clearTimeout(t)
  }, [flash])

  const done = (message: string) => {
    setDialog(null)
    setFlash(message)
    load()
  }

  const header = (title: string, right?: ReactNode) => (
    <header className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
      <button
        type="button"
        onClick={() => navigate(-1)}
        aria-label="Quay lại"
        className="text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <ArrowLeft className="w-4 h-4" />
      </button>
      <h1 className="font-semibold text-slate-900 dark:text-slate-50 flex-1 truncate">{title}</h1>
      {right}
    </header>
  )

  if ((loading && !result) || !catalog) {
    return (
      <div className="page-shell">
        <main className="page-container space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-32 w-full" />
          <SkeletonCardList rows={4} />
        </main>
      </div>
    )
  }

  if (error || !result) {
    return (
      <div className="page-shell">
        {header('Lô hàng')}
        <main className="page-container">
          <div className={cardClass({ className: 'text-center py-10' })}>
            <p className="text-rose-500 dark:text-rose-400 text-sm mb-4">{error || 'Không tìm thấy lô hàng.'}</p>
            <Link to="/dashboard" className={buttonClass('secondary', 'sm')}>
              Về tổng quan
            </Link>
          </div>
        </main>
      </div>
    )
  }

  const { batch, events, anomalies, isValid } = result
  const publicUrl = `${window.location.origin}/provenance/${batch.id}`
  const rules = catalog.rules(batch.workflowId)
  const category = catalog.categoryOf(batch)
  const next = nextStepLabel(batch, catalog)
  const custodian = batch.assignedToActorId ? actorsById.get(batch.assignedToActorId) : undefined
  const mine = actor ? canActOn(actor, batch, catalog) : false
  const openAnomalies = anomalies.filter((a) => !a.resolved)
  const waitingSince = batch.lastEventAt ?? batch.createdAt
  const pending = custody?.transfers.find((t) => t.status === 'PENDING')
  const forMe = pending && actor && (pending.toActorId === actor.id || actor.role === 'ADMIN') ? pending : undefined
  const openHold = custody?.holds.find((h) => !h.releasedAt)
  const remaining = remainingOf(batch)
  const holder = batch.assignedToActorId ?? actor?.id
  const canHandleRejected = !!actor && batch.status === 'REJECTED' && (actor.role === 'ADMIN' || holder === actor.id)
  const atExport = !!batch.currentStage && rules?.kind(batch.currentStage) === 'EXPORT' && batch.status === 'ACTIVE'
  const exportData = atExport ? [...events].reverse().find((e) => e.kind === 'OBSERVE' && e.stage === batch.currentStage)?.data : undefined
  const stopped = ['RECALLED', 'DESTROYED', 'REJECTED', 'ON_HOLD', 'CONSUMED'].includes(batch.status)

  return (
    <div className="page-shell">
      {header(batch.productName, <VerifyBadge isValid={isValid} hasAnomalies={openAnomalies.length > 0} />)}

      <main className="page-container space-y-4">
        {flash && (
          <div role="status" className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-emerald-800 dark:text-emerald-300 text-sm rounded-xl px-3.5 py-2.5 flex items-center gap-2 animate-scale-in">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> {flash}
          </div>
        )}

        {batch.status === 'RECALLED' && (
          <div className="bg-rose-50 dark:bg-rose-500/10 border-2 border-rose-200 dark:border-rose-500/30 rounded-2xl p-4 text-rose-800 dark:text-rose-300 flex gap-3">
            <Siren className="w-5 h-5 flex-shrink-0" />
            <div className="text-sm">
              <p className="font-semibold">Lô hàng đã bị thu hồi</p>
              <p className="mt-0.5">{batch.recallReason}</p>
            </div>
          </div>
        )}
        {batch.status === 'DESTROYED' && (
          <div className="bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-4 text-slate-700 dark:text-slate-300 flex gap-3 text-sm">
            <Trash2 className="w-5 h-5 flex-shrink-0" /> Lô đã được huỷ có biên bản — xem chi tiết ở cuối hành trình.
          </div>
        )}
        {batch.status === 'ON_HOLD' && (
          <div className="bg-amber-50 dark:bg-amber-500/10 border-2 border-amber-200 dark:border-amber-500/30 rounded-2xl p-4 text-amber-800 dark:text-amber-300 flex gap-3">
            <PauseCircle className="w-5 h-5 flex-shrink-0" />
            <div className="text-sm flex-1">
              <p className="font-semibold">Lô đang bị tạm giữ chờ điều tra</p>
              {openHold && (
                <p className="mt-0.5">
                  {openHold.reason} · từ {formatDateTime(openHold.heldAt)}
                </p>
              )}
              <p className="mt-1 text-xs">Không ai ghi khâu, bàn giao hay dùng lô này cho tới khi kiểm định viên / quản trị viên giải toả.</p>
            </div>
            {oversight && (
              <button type="button" onClick={() => setDialog('release')} className={buttonClass('secondary', 'sm', 'self-start')}>
                <PlayCircle className="w-3.5 h-3.5" /> Giải toả…
              </button>
            )}
          </div>
        )}
        {batch.status === 'REJECTED' && (
          <div className="bg-rose-50 dark:bg-rose-500/10 border-2 border-rose-200 dark:border-rose-500/30 rounded-2xl p-4 text-rose-800 dark:text-rose-300 space-y-3">
            <div className="flex gap-3">
              <TriangleAlert className="w-5 h-5 flex-shrink-0" />
              <div className="text-sm">
                <p className="font-semibold">Lô không đạt kiểm định</p>
                <p className="mt-0.5">Không đi tiếp được. Ba cách xử lý: chế biến lại (rồi kiểm định lại), hạ loại, hoặc huỷ có biên bản.</p>
              </div>
            </div>
            {canHandleRejected && (
              <div className="flex flex-wrap gap-2">
                <Link to={`/lots/transform?kind=REWORK&lotId=${batch.id}`} className={buttonClass('secondary', 'sm')}>
                  <Recycle className="w-3.5 h-3.5" /> Chế biến lại
                </Link>
                <Link to={`/lots/transform?kind=DOWNGRADE&lotId=${batch.id}`} className={buttonClass('secondary', 'sm')}>
                  Hạ loại
                </Link>
                <button type="button" onClick={() => setDialog('dispose')} className={buttonClass('danger', 'sm')}>
                  <Trash2 className="w-3.5 h-3.5" /> Huỷ lô…
                </button>
              </div>
            )}
          </div>
        )}

        {forMe && (
          <section className={cardClass({ className: 'space-y-2 border-sky-300 dark:border-sky-500/40 ring-2 ring-sky-100 dark:ring-sky-500/10' })}>
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
              <Inbox className="w-4 h-4 text-sky-500" /> Lô này đang được bàn giao cho bạn
            </h2>
            <TransferResponse
              transfer={forMe}
              tolerance={catalog.settingsFor(batch.productTypeId).transitLossTolerance}
              onDone={() => done('Đã gửi xác nhận bàn giao.')}
            />
          </section>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
          <div className="xl:col-span-2 space-y-4 min-w-0">
            {/* Status: what is it, where is it, who has it, what's next */}
            <section className={cardClass({ className: 'space-y-4' })}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {batch.productType} · {batch.origin}
                    {rules && <span> · quy trình {rules.workflow.name}</span>}
                  </p>
                  <p className="text-lg font-semibold text-slate-900 dark:text-slate-50">
                    {batch.quantity.toLocaleString('vi-VN')} {batch.unit}
                    {batch.unit !== batch.baseUnit && batch.quantityBase !== undefined && (
                      <span className="text-sm font-normal text-slate-500">
                        {' '}
                        = {batch.quantityBase.toLocaleString('vi-VN')} {batch.baseUnit}
                      </span>
                    )}
                  </p>
                  {(batch.consumedQuantity > 0 || batch.lostQuantity > 0) && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Còn {remaining.toLocaleString('vi-VN')} {batch.unit}
                      {batch.consumedQuantity > 0 && ` · đã dùng ${batch.consumedQuantity.toLocaleString('vi-VN')}`}
                      {batch.lostQuantity > 0 && ` · hao hụt ${batch.lostQuantity.toLocaleString('vi-VN')}`}
                    </p>
                  )}
                </div>
                <BatchStatusBadge batch={batch} />
              </div>

              {rules && <StageProgress workflow={rules.workflow} catalog={catalog} current={batch.currentStage} stopped={stopped} />}

              {batch.status === 'ACTIVE' && next && (
                <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
                  <p className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-1.5 min-w-0">
                    <Clock3 className="w-4 h-4 text-slate-400 flex-shrink-0" />
                    <span>
                      {mine ? (
                        <strong className="text-brand-700 dark:text-brand-400">Đang chờ bạn</strong>
                      ) : custodian ? (
                        <>
                          Đang do <strong>{custodian.organization}</strong> ({ROLE_LABELS[custodian.role].toLowerCase()}) giữ
                        </>
                      ) : (
                        'Chưa giao cho ai'
                      )}{' '}
                      · từ {relativeDays(waitingSince)}
                    </span>
                  </p>
                  {mine && (
                    <Link to={`/record?batchId=${batch.id}`} className={buttonClass('primary', 'md')}>
                      Xử lý: {next}
                    </Link>
                  )}
                </div>
              )}
            </section>

            {openAnomalies.length > 0 && (
              <section className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-2xl p-4">
                <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-400 mb-2">Cảnh báo chưa xử lý ({openAnomalies.length})</h2>
                <ul className="space-y-1">
                  {openAnomalies.map((a) => (
                    <li key={a.id} className="text-sm text-amber-700 dark:text-amber-400/90 flex gap-2">
                      <TriangleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      <span>{a.message}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <Timeline events={events} actorsById={actorsById} catalog={catalog} categoryCode={category} />
          </div>

          {/* Side column: what you can do with this lot. */}
          <aside className="space-y-4 min-w-0">
            <div className="flex gap-2 flex-wrap items-center">
              <ExportMenu result={result} actorsById={actorsById} publicUrl={publicUrl} catalog={catalog} />
            </div>

            {actor && !forMe && (batch.status === 'ACTIVE' || batch.status === 'REJECTED' || batch.status === 'IN_TRANSIT') && !mine && (
              <HandOffPanel batch={batch} actors={actors} custody={custody} me={actor} onDone={() => done('Đã cập nhật bàn giao.')} />
            )}

            {atExport && (actor?.role === 'EXPORTER' || actor?.role === 'ADMIN') && (
              <ReceiptLinkPanel batchId={batch.id} importerName={typeof exportData?.importerName === 'string' ? exportData.importerName : undefined} />
            )}

            <LineagePanel batch={batch} />

            <QrPanel batchId={batch.id} publicUrl={publicUrl} />

            <VerifyPanel batchId={batch.id} />

            {oversight && !['RECALLED', 'DESTROYED'].includes(batch.status) && (
              <section className={cardClass({ className: 'border-rose-200/80 dark:border-rose-500/20 space-y-3' })}>
                <div>
                  <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Kiểm soát lô hàng</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Tạm giữ để điều tra (giải toả được), hoặc thu hồi — lan theo phả hệ, báo cho đối tác và hiện trên trang công khai.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {['ACTIVE', 'IN_TRANSIT', 'REJECTED'].includes(batch.status) && (
                    <button type="button" onClick={() => setDialog('hold')} className={buttonClass('secondary', 'sm')}>
                      <PauseCircle className="w-3.5 h-3.5" /> Tạm giữ…
                    </button>
                  )}
                  <button type="button" onClick={() => setDialog('recall')} className={buttonClass('danger', 'sm')}>
                    Thu hồi lô hàng…
                  </button>
                  {['ACTIVE', 'ON_HOLD', 'REJECTED'].includes(batch.status) && !canHandleRejected && (
                    <button type="button" onClick={() => setDialog('dispose')} className={buttonClass('ghost', 'sm')}>
                      <Trash2 className="w-3.5 h-3.5" /> Huỷ lô…
                    </button>
                  )}
                </div>
              </section>
            )}
            {batch.status === 'RECALLED' && oversight && (
              <button type="button" onClick={() => setDialog('dispose')} className={buttonClass('ghost', 'sm')}>
                <Trash2 className="w-3.5 h-3.5" /> Ghi nhận huỷ lô đã thu hồi…
              </button>
            )}

            <p className="text-[11px] text-slate-300 dark:text-slate-600 font-mono break-all">Mã lô: {batch.id}</p>
          </aside>
        </div>
      </main>

      <RecallDialog
        batch={batch}
        open={dialog === 'recall'}
        onClose={() => setDialog(null)}
        onRecalled={(outcome) => {
          const parts = ['Đã thu hồi lô hàng và thông báo cho các đối tác']
          if (outcome.lineage.recalledLotIds.length) parts.push(`${outcome.lineage.recalledLotIds.length} lô làm ra từ lô này cũng bị thu hồi`)
          if (outcome.lineage.heldLotIds.length) parts.push(`${outcome.lineage.heldLotIds.length} lô làm ra từ lô này bị tạm giữ`)
          if (outcome.lineage.flaggedLotIds.length) parts.push(`${outcome.lineage.flaggedLotIds.length} lô liên quan được gắn cờ điều tra`)
          done(parts.join('; ') + '.')
        }}
      />
      <ReasonDialog
        open={dialog === 'hold'}
        title="Tạm giữ lô hàng"
        description="Lô sẽ bị đóng băng — không ghi khâu, không bàn giao, không dùng làm nguyên liệu — cho tới khi được giải toả. Việc tạm giữ được ghi vào chuỗi."
        confirmLabel="Tạm giữ"
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          await batchApi.hold(batch.id, reason)
          done('Đã tạm giữ lô hàng.')
        }}
      />
      <ReasonDialog
        open={dialog === 'release'}
        title="Giải toả lô hàng"
        description="Lô trở lại trạng thái trước khi bị tạm giữ. Ghi rõ kết quả điều tra — lý do được ghi vào chuỗi."
        confirmLabel="Giải toả"
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          await batchApi.release(batch.id, reason)
          done('Đã giải toả lô hàng.')
        }}
      />
      <DisposeDialog batch={batch} open={dialog === 'dispose'} onClose={() => setDialog(null)} onDone={() => done('Đã huỷ lô hàng có biên bản.')} />
    </div>
  )
}
