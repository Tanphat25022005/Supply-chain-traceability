import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Ship, TriangleAlert } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useCatalog } from '../context/CatalogContext'
import { actorsApi, Actor, batchApi, Batch, eventApi, ROLE_LABELS, stageIcon, STATUS_LABELS } from '../api/client'
import { canActOn, nextStepLabel, toEventData, toLocalInput } from '../domain/catalog'
import { apiErrorMessage } from '../lib/apiError'
import { rememberLocation, recallLocation } from '../lib/lastLocation'
import StageFieldsInput, { StageValues } from '../components/StageFieldsInput'
import HandoffSelect from '../components/HandoffSelect'
import OccurredAtInput, { isLate, occurredAtToIso } from '../components/OccurredAtInput'
import WorkflowSteps from '../components/WorkflowSteps'
import Button, { buttonClass } from '../components/ui/Button'
import { inputClass, labelClass } from '../components/ui/field'
import { cardClass } from '../components/ui/Card'
import { Skeleton } from '../components/ui/Skeleton'

/**
 * "Xử lý lô hàng": the one screen every partner uses to complete their step.
 * The steps offered are the lot's workflow's next ones that this role records
 * (optional steps may be skipped, required ones never); the form asks for
 * that step's own fields from the product group's schema; when it happened
 * may be set in the past; and the lot is handed to whoever does what comes
 * next — they confirm receipt before it's theirs.
 */
export default function RecordEvent() {
  const { actor } = useAuth()
  const { catalog } = useCatalog()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const batchId = searchParams.get('batchId') ?? ''

  const [batch, setBatch] = useState<Batch | null>(null)
  const [actors, setActors] = useState<Actor[]>([])
  const [loadError, setLoadError] = useState('')
  const [stage, setStage] = useState<string | null>(null)
  const [values, setValues] = useState<StageValues>({})
  const [location, setLocation] = useState('')
  const [notes, setNotes] = useState('')
  const [occurredAt, setOccurredAt] = useState(toLocalInput(new Date()))
  const [lateReason, setLateReason] = useState('')
  const [assignNextTo, setAssignNextTo] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const isAdmin = actor?.role === 'ADMIN'
  const rules = catalog?.rules(batch?.workflowId)

  useEffect(() => {
    if (!batchId) return
    batchApi
      .get(batchId)
      .then(setBatch)
      .catch((err) => setLoadError(apiErrorMessage(err, 'Không tải được lô hàng.')))
    actorsApi.list().then(setActors).catch(() => {})
  }, [batchId])

  // Steps this person may record now. An ADMIN may also back-fill any step of the workflow.
  const options = useMemo(() => {
    if (!batch || !rules || !actor) return []
    const next = rules.recordable(batch, actor.role).map((s) => s.stage)
    if (!isAdmin) return next
    const rest = rules.steps.map((s) => s.stage).filter((s) => !next.includes(s) && rules.kind(s) !== 'RECEIPT')
    return [...next, ...rest]
  }, [batch, rules, actor, isAdmin])

  useEffect(() => {
    if (!stage && options.length > 0) setStage(options[0])
  }, [options, stage])

  // Sensible location default: the farm itself for the first step, otherwise
  // where this person last recorded the same step (a factory rarely moves).
  useEffect(() => {
    if (!batch || !stage || !actor || !rules) return
    setLocation(rules.position(stage) === 1 ? batch.origin : recallLocation(actor.id, stage) ?? '')
    setValues({})
    setAssignNextTo('')
  }, [batch, stage, actor, rules])

  const onHandoffChange = useCallback((id: string) => setAssignNextTo(id), [])

  if (!batchId) {
    // No batch picked: creators start a new one, everyone else goes to their queue.
    return <Navigate to={actor?.role === 'FARMER' || isAdmin ? '/batches/new' : '/tasks'} replace />
  }

  const category = batch ? catalog?.categoryOf(batch) : undefined
  const fields = stage ? catalog?.currentSchema(category, stage)?.fields ?? [] : []
  const settings = catalog?.settingsFor(batch?.productTypeId) ?? { maxBackdateDays: 7 }
  const stagePos = rules && stage ? rules.position(stage) : 0
  const isAdvancing = !!batch && !!rules && stagePos > rules.position(batch.currentStage)
  const failing = !!stage && rules?.kind(stage) === 'INSPECTION' && values.result === 'FAIL'
  const finalStep = !!stage && !!rules?.isFinal(stage)
  const external = !!rules && rules.nextIsExternal(stagePos, batch ?? undefined)
  const nextRoles = rules && batch ? [...rules.rolesForNext(stagePos, batch)] : []
  const canDoNextMyself = !!actor && nextRoles.includes(actor.role)
  const needsHandoff = isAdvancing && !failing && !finalStep && !external
  const handoffRequired = needsHandoff && !isAdmin && !canDoNextMyself
  const nextLabel = rules?.nextCandidates(stagePos, batch ?? undefined).map((s) => catalog!.stageLabel(s.stage).toLowerCase()).join(' hoặc ')
  const skipped = batch && rules && stage ? rules.skippedRequired(batch, stage) : []

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!batch || !stage || !actor) return
    setError('')
    setSubmitting(true)
    try {
      await eventApi.record({
        batchId: batch.id,
        stage,
        location: location.trim(),
        notes: notes.trim() || undefined,
        data: toEventData(fields, values),
        occurredAt: occurredAtToIso(occurredAt),
        lateReason: isLate(occurredAt, settings.maxBackdateDays) ? lateReason.trim() : undefined,
        assignNextTo: (needsHandoff || failing) && assignNextTo ? assignNextTo : undefined,
      })
      rememberLocation(actor.id, stage, location.trim())
      const label = catalog?.stageLabel(stage).toLowerCase() ?? stage
      navigate(`/batch/${batch.id}`, {
        state: {
          flash: failing
            ? `Đã ghi kiểm định KHÔNG ĐẠT — lô bị loại: chế biến lại, hạ loại hoặc huỷ.`
            : assignNextTo
              ? `Đã ghi nhận khâu ${label}. Lô đang chờ người nhận xác nhận.`
              : `Đã ghi nhận khâu ${label}.`,
        },
      })
    } catch (err) {
      setError(apiErrorMessage(err, 'Ghi sự kiện thất bại. Thử lại sau.'))
    } finally {
      setSubmitting(false)
    }
  }

  const header = (
    <header className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
      <button
        type="button"
        onClick={() => navigate(-1)}
        aria-label="Quay lại"
        className="text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <ArrowLeft className="w-4 h-4" />
      </button>
      <h1 className="font-semibold text-slate-900 dark:text-slate-50">Xử lý lô hàng</h1>
    </header>
  )

  if (loadError) {
    return (
      <div className="page-shell">
        {header}
        <main className="page-container">
          <div className={cardClass({ className: 'text-center' })}>
            <p className="text-sm text-rose-600 dark:text-rose-400">{loadError}</p>
            <Link to="/tasks" className={buttonClass('secondary', 'sm', 'mt-4')}>
              Về việc cần làm
            </Link>
          </div>
        </main>
      </div>
    )
  }

  if (!batch || !actor || !catalog || !rules) {
    return (
      <div className="page-shell">
        {header}
        <main className="page-container space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-72 w-full" />
        </main>
      </div>
    )
  }

  const next = nextStepLabel(batch, catalog)
  const blocked = !canActOn(actor, batch, catalog)
  const StageIcon = stage ? stageIcon(stage) : null
  const nextStepRoles = [...rules.rolesForNext(rules.position(batch.currentStage), batch)]

  return (
    <div className="page-shell">
      {header}
      <main className="page-container grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        {/* What am I working on */}
        <Link to={`/batch/${batch.id}`} className={cardClass({ hover: true, padding: 'md', className: 'lg:sticky lg:top-20 space-y-3' })}>
          <div>
            <p className="font-semibold text-slate-900 dark:text-slate-50">{batch.productName}</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              {batch.productType} · {batch.origin} · {batch.quantity.toLocaleString('vi-VN')} {batch.unit}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="px-2 py-1 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {catalog.stageLabel(batch.currentStage)}
            </span>
            <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
            <span className="px-2 py-1 rounded-full bg-brand-50 text-brand-700 font-medium dark:bg-brand-500/10 dark:text-brand-400">
              {next ?? 'Đã hoàn tất'}
            </span>
          </div>
          {rules && <WorkflowSteps workflow={rules.workflow} currentStage={batch.currentStage} />}
        </Link>

        {blocked ? (
          <div className={cardClass({ className: 'flex gap-3 lg:col-span-2' })}>
            <TriangleAlert className="w-5 h-5 text-amber-500 flex-shrink-0" />
            <div className="text-sm text-slate-600 dark:text-slate-300">
              {batch.status !== 'ACTIVE' ? (
                <p>
                  Lô đang ở trạng thái <strong>{STATUS_LABELS[batch.status].toLowerCase()}</strong> — không ghi thêm khâu được.
                  {batch.status === 'IN_TRANSIT' && ' Người nhận cần xác nhận nhận hàng trước.'}
                  {batch.status === 'REJECTED' && ' Hãy chế biến lại, hạ loại hoặc huỷ lô (ở trang chi tiết lô).'}
                </p>
              ) : !next ? (
                <p>Lô hàng đã đi hết quy trình.</p>
              ) : (
                <p>
                  Lô này đang chờ <strong>{next.toLowerCase()}</strong>
                  {batch.assignedToActorId && batch.assignedToActorId !== actor.id
                    ? ' và đang do người khác giữ.'
                    : ` — việc của ${nextStepRoles.map((r) => ROLE_LABELS[r].toLowerCase()).join(' hoặc ')}.`}
                </p>
              )}
              <Link to="/tasks" className="text-brand-600 dark:text-brand-400 font-medium hover:underline mt-2 inline-block">
                Xem việc của bạn →
              </Link>
            </div>
          </div>
        ) : (
          stage && (
            <form onSubmit={handleSubmit} className={cardClass({ padding: 'lg', className: 'space-y-5 lg:col-span-2' })}>
              <div className="flex items-center gap-3">
                {StageIcon && (
                  <span className="w-10 h-10 rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400 flex items-center justify-center">
                    <StageIcon className="w-5 h-5" />
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-slate-500 dark:text-slate-400">Ghi nhận khâu</p>
                  {options.length > 1 ? (
                    <select
                      aria-label="Khâu ghi nhận"
                      value={stage}
                      onChange={(e) => setStage(e.target.value)}
                      className="font-semibold text-slate-900 dark:text-slate-50 bg-transparent -ml-1 pr-6 rounded focus:outline-none focus:ring-2 focus:ring-brand-400"
                    >
                      {options.map((s) => {
                        const step = rules.steps.find((x) => x.stage === s)
                        return (
                          <option key={s} value={s}>
                            {catalog.stageLabel(s)}
                            {step && !step.required ? ' (không bắt buộc)' : ''}
                          </option>
                        )
                      })}
                    </select>
                  ) : (
                    <p className="font-semibold text-slate-900 dark:text-slate-50">{catalog.stageLabel(stage)}</p>
                  )}
                </div>
              </div>
              {skipped.length > 0 && (
                <p className="text-xs text-rose-600 dark:text-rose-400 -mt-2">
                  Không thể ghi: phải ghi khâu bắt buộc {skipped.map((s) => catalog.stageLabel(s.stage)).join(', ')} trước.
                </p>
              )}
              {isAdmin && skipped.length === 0 && !isAdvancing && (
                <p className="text-xs text-amber-600 dark:text-amber-400 -mt-2">
                  Ghi lại khâu đã qua sẽ tạo cảnh báo bất thường — chỉ dùng để bổ sung dữ liệu.
                </p>
              )}

              <StageFieldsInput fields={fields} values={values} onChange={setValues} />

              {failing && (
                <div className="bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 rounded-xl p-3 text-sm text-rose-700 dark:text-rose-300">
                  Lô không đạt sẽ bị <strong>loại</strong>: không đi tiếp được, chỉ còn chế biến lại, hạ loại hoặc huỷ. Bạn có thể chuyển
                  ngay lô cho đơn vị sẽ xử lý (họ xác nhận nhận hàng).
                </div>
              )}

              <OccurredAtInput
                value={occurredAt}
                onChange={setOccurredAt}
                lateReason={lateReason}
                onLateReasonChange={setLateReason}
                maxBackdateDays={settings.maxBackdateDays}
              />

              <div>
                <label htmlFor="location" className={labelClass}>
                  Địa điểm thực hiện <span className="text-rose-500">*</span>
                </label>
                <input
                  id="location"
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  required
                  maxLength={200}
                  placeholder="VD: Xưởng chế biến An Giang"
                  className={inputClass}
                />
              </div>

              <div>
                <label htmlFor="notes" className={labelClass}>
                  Ghi chú
                </label>
                <textarea
                  id="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  placeholder="Chỉ nội bộ — không hiển thị cho người tiêu dùng"
                  className={`${inputClass} resize-none`}
                />
              </div>

              {(needsHandoff || failing) && (
                <HandoffSelect
                  roles={failing ? [] : nextRoles}
                  label={failing ? 'Chuyển lô cho (để xử lý)' : `Bàn giao cho (${nextLabel})`}
                  actors={actors}
                  value={assignNextTo}
                  onChange={onHandoffChange}
                  isAdmin={isAdmin}
                  required={handoffRequired}
                  excludeId={batch.assignedToActorId ?? actor.id}
                />
              )}
              {isAdvancing && external && (
                <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                  <Ship className="w-3.5 h-3.5" /> Sau khâu này, bên nhập khẩu xác nhận nhận hàng qua link bạn gửi (tạo ở trang chi tiết lô).
                </p>
              )}

              {error && (
                <div role="alert" className="bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 text-rose-700 dark:text-rose-400 text-sm rounded-xl px-3.5 py-2.5">
                  {error}
                </div>
              )}

              <Button type="submit" disabled={submitting || skipped.length > 0} className="w-full">
                {submitting
                  ? 'Đang ghi...'
                  : assignNextTo
                    ? `Hoàn tất ${catalog.stageLabel(stage).toLowerCase()} & bàn giao`
                    : `Hoàn tất ${catalog.stageLabel(stage).toLowerCase()}`}
              </Button>
            </form>
          )
        )}
      </main>
    </div>
  )
}
