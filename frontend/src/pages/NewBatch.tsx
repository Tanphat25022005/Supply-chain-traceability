import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { ArrowLeft, Search, Sprout } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useCatalog } from '../context/CatalogContext'
import { actorsApi, Actor, batchApi, Batch, eventApi, Plot, plotsApi } from '../api/client'
import { toEventData, toLocalInput } from '../domain/catalog'
import { apiErrorMessage } from '../lib/apiError'
import StageFieldsInput, { StageValues } from '../components/StageFieldsInput'
import HandoffSelect from '../components/HandoffSelect'
import OccurredAtInput, { isLate, occurredAtToIso } from '../components/OccurredAtInput'
import WorkflowSteps from '../components/WorkflowSteps'
import Button from '../components/ui/Button'
import { inputClass, labelClass } from '../components/ui/field'
import { cardClass } from '../components/ui/Card'

/**
 * Creating a lot IS its first step (the harvest): product type, unit and
 * workflow come from the catalog — so reports group cleanly, every unit
 * converts to kg, and the lot knows which steps it must go through — then
 * it is handed to whoever does the next step, who confirms receipt.
 */
export default function NewBatch() {
  const { actor } = useAuth()
  const { catalog } = useCatalog()
  const navigate = useNavigate()
  const [actors, setActors] = useState<Actor[]>([])

  const [productName, setProductName] = useState('')
  const [typeSearch, setTypeSearch] = useState('')
  const [productTypeId, setProductTypeId] = useState('')
  const [workflowCode, setWorkflowCode] = useState('')
  const [origin, setOrigin] = useState('')
  const [plots, setPlots] = useState<Plot[]>([])
  const [plotId, setPlotId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState('kg')
  const [harvest, setHarvest] = useState<StageValues>({})
  const [occurredAt, setOccurredAt] = useState(toLocalInput(new Date()))
  const [lateReason, setLateReason] = useState('')
  const [notes, setNotes] = useState('')
  const [assignNextTo, setAssignNextTo] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // Set once the batch exists, so a retry after a failed harvest record doesn't create a second batch.
  const [created, setCreated] = useState<Batch | null>(null)

  const isAdmin = actor?.role === 'ADMIN'
  const onHandoffChange = useCallback((id: string) => setAssignNextTo(id), [])

  useEffect(() => {
    actorsApi.list().then(setActors).catch(() => {})
    plotsApi.list().then(setPlots).catch(() => {})
  }, [])

  const productType = catalog?.productType(productTypeId)
  const units = catalog?.unitsFor(productTypeId) ?? []
  const workflows = catalog?.workflowsFor(productType?.categoryCode) ?? []
  const workflow = workflows.find((w) => w.code === workflowCode) ?? workflows.find((w) => w.code === productType?.defaultWorkflowCode) ?? workflows[0]
  const rules = catalog?.rules(workflow?.id)
  const firstStage = rules?.steps[0]?.stage ?? 'HARVEST'
  const fields = catalog?.currentSchema(productType?.categoryCode, firstStage)?.fields ?? []
  const settings = catalog?.settingsFor(productTypeId) ?? { maxBackdateDays: 7 }
  const nextRoles = rules ? [...rules.rolesForNext(1)] : []
  const nextLabel = rules?.nextCandidates(1).map((s) => catalog!.stageLabel(s.stage).toLowerCase()).join(' hoặc ')
  const selectedUnit = units.find((u) => u.code === unit)

  const groups = useMemo(() => {
    const q = typeSearch.trim().toLowerCase()
    return (catalog?.productTypesByCategory() ?? [])
      .map((g) => ({ ...g, types: g.types.filter((t) => !q || t.name.toLowerCase().includes(q) || t.aliases.some((a) => a.toLowerCase().includes(q))) }))
      .filter((g) => g.types.length > 0)
  }, [catalog, typeSearch])

  if (actor && actor.role !== 'FARMER' && !isAdmin) return <Navigate to="/tasks" replace />

  const chooseType = (id: string) => {
    setProductTypeId(id)
    setWorkflowCode('')
    setHarvest({})
    const firstUnit = catalog?.unitsFor(id)[0]
    setUnit(firstUnit?.code ?? 'kg')
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!productType || !workflow) return
    setError('')
    setSubmitting(true)
    try {
      const batch =
        created ??
        (await batchApi.create({
          productName: productName.trim(),
          productTypeId: productType.id,
          workflowCode: workflow.code,
          origin: origin.trim(),
          plotId: plotId || undefined,
          quantity: Number(quantity),
          unit,
        }))
      setCreated(batch)
      await eventApi.record({
        batchId: batch.id,
        stage: firstStage,
        location: batch.origin,
        notes: notes.trim() || undefined,
        data: toEventData(fields, harvest),
        occurredAt: occurredAtToIso(occurredAt),
        lateReason: isLate(occurredAt, settings.maxBackdateDays) ? lateReason.trim() : undefined,
        assignNextTo: assignNextTo || undefined,
      })
      navigate(`/batch/${batch.id}`, {
        state: { flash: assignNextTo ? 'Đã tạo lô hàng và ghi nhận thu hoạch. Lô đang chờ người nhận xác nhận.' : 'Đã tạo lô hàng và ghi nhận thu hoạch.' },
      })
    } catch (err) {
      setError(
        created
          ? apiErrorMessage(err, 'Lô hàng đã được tạo nhưng chưa ghi được thu hoạch. Bấm lưu lại để thử tiếp.')
          : apiErrorMessage(err, 'Không tạo được lô hàng. Thử lại sau.'),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page-shell">
      <header className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label="Quay lại"
          className="text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="font-semibold text-slate-900 dark:text-slate-50">Lô hàng mới</h1>
      </header>

      <main className="page-container">
        {!catalog ? (
          <p className="text-sm text-slate-500">Đang tải danh mục loại hàng…</p>
        ) : (
          <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <fieldset disabled={!!created} className={cardClass({ padding: 'lg', className: 'space-y-4 disabled:opacity-70' })}>
              <legend className="sr-only">Thông tin sản phẩm</legend>
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Sản phẩm</h2>
              <div>
                <label htmlFor="productName" className={labelClass}>
                  Tên lô <span className="text-rose-500">*</span>
                </label>
                <input
                  id="productName"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  required
                  maxLength={200}
                  placeholder="VD: Cà phê Robusta Cầu Đất đợt 1"
                  className={inputClass}
                />
              </div>

              <div>
                <label htmlFor="productType" className={labelClass}>
                  Loại hàng <span className="text-rose-500">*</span>
                </label>
                <div className="relative mb-2">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    aria-label="Tìm loại hàng"
                    value={typeSearch}
                    onChange={(e) => setTypeSearch(e.target.value)}
                    placeholder="Tìm: cà phê, gạo, sầu riêng…"
                    className={`${inputClass} pl-9`}
                  />
                </div>
                <select id="productType" value={productTypeId} onChange={(e) => chooseType(e.target.value)} required className={inputClass}>
                  <option value="">— Chọn loại hàng trong danh mục —</option>
                  {groups.map((g) => (
                    <optgroup key={g.category.code} label={g.category.name}>
                      {g.types.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.tenantId ? ' (riêng của đơn vị)' : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {isAdmin && (
                  <p className="text-xs text-slate-400 mt-1">
                    Thiếu loại hàng?{' '}
                    <Link to="/admin/catalog" className="text-brand-600 dark:text-brand-400 underline">
                      Thêm vào danh mục
                    </Link>
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="quantity" className={labelClass}>
                  Số lượng <span className="text-rose-500">*</span>
                </label>
                <div className="flex gap-2">
                  <input
                    id="quantity"
                    type="number"
                    min="0.001"
                    step="any"
                    inputMode="decimal"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    required
                    className={`${inputClass} min-w-0`}
                  />
                  <select aria-label="Đơn vị" value={unit} onChange={(e) => setUnit(e.target.value)} className={`${inputClass} w-40`} disabled={!productType}>
                    {units.map((u) => (
                      <option key={u.id} value={u.code}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </div>
                {selectedUnit && selectedUnit.factor !== 1 && Number(quantity) > 0 && (
                  <p className="text-xs text-slate-500 mt-1">
                    = {(Number(quantity) * selectedUnit.factor).toLocaleString('vi-VN')} {selectedUnit.baseUnit} (quy đổi theo danh mục)
                  </p>
                )}
              </div>

              {productType && workflows.length > 0 && (
                <div>
                  <label htmlFor="workflow" className={labelClass}>
                    Quy trình
                  </label>
                  <select id="workflow" value={workflow?.code ?? ''} onChange={(e) => setWorkflowCode(e.target.value)} className={inputClass}>
                    {workflows.map((w) => (
                      <option key={w.id} value={w.code}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                  {workflow && <WorkflowSteps workflow={workflow} className="mt-2" />}
                </div>
              )}

              <div>
                <label htmlFor="plot" className={labelClass}>
                  Lô đất
                </label>
                <select
                  id="plot"
                  value={plotId}
                  onChange={(e) => {
                    setPlotId(e.target.value)
                    const p = plots.find((x) => x.id === e.target.value)
                    if (p && !origin) setOrigin(p.name)
                  }}
                  className={inputClass}
                >
                  <option value="">— Không gắn lô đất —</option>
                  {plots.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code} · {p.name} ({p.areaHa.toLocaleString('vi-VN')} ha)
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                  Gắn lô đất để truy ngược được toạ độ nơi trồng và kiểm sản lượng theo diện tích.{' '}
                  {plots.length === 0 && (
                    <Link to="/plots" className="text-brand-600 dark:text-brand-400 underline">
                      Thêm lô đất
                    </Link>
                  )}
                </p>
              </div>
              <div>
                <label htmlFor="origin" className={labelClass}>
                  Vùng trồng / nông trại <span className="text-rose-500">*</span>
                </label>
                <input
                  id="origin"
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value)}
                  required
                  maxLength={200}
                  placeholder="VD: Cầu Đất, Đà Lạt, Lâm Đồng"
                  className={inputClass}
                />
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Dùng làm xuất xứ của lô và địa điểm thu hoạch.</p>
              </div>
            </fieldset>

            <div className={cardClass({ padding: 'lg', className: 'space-y-4' })}>
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                <Sprout className="w-4 h-4 text-emerald-500" /> {catalog.stageLabel(firstStage)}
              </h2>
              {!productType ? (
                <p className="text-sm text-slate-400">Chọn loại hàng để hiện các trường thông tin.</p>
              ) : (
                <StageFieldsInput fields={fields} values={harvest} onChange={setHarvest} />
              )}
              <OccurredAtInput
                label="Thời điểm thu hoạch"
                value={occurredAt}
                onChange={setOccurredAt}
                lateReason={lateReason}
                onLateReasonChange={setLateReason}
                maxBackdateDays={settings.maxBackdateDays}
              />
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
              {rules && (
                <HandoffSelect
                  roles={nextRoles}
                  label={`Bàn giao cho (${nextLabel})`}
                  actors={actors}
                  value={assignNextTo}
                  onChange={onHandoffChange}
                  isAdmin={isAdmin}
                  excludeId={actor?.id}
                />
              )}
            </div>

            {error && (
              <div role="alert" className="lg:col-span-2 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 text-rose-700 dark:text-rose-400 text-sm rounded-xl px-3.5 py-2.5">
                {error}
              </div>
            )}

            <div className="lg:col-span-2 flex justify-end">
              <Button type="submit" disabled={submitting || !productType} className="w-full lg:w-auto lg:min-w-64">
                {submitting ? 'Đang lưu...' : created ? 'Lưu lại thu hoạch' : 'Tạo lô & bàn giao'}
              </Button>
            </div>
          </form>
        )}
      </main>
    </div>
  )
}
