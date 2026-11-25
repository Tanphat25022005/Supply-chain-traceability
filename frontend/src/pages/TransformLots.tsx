import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowDownCircle, ArrowLeft, Combine, Factory, Plus, Recycle, Split, Trash2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useCatalog } from '../context/CatalogContext'
import { actorsApi, Actor, batchApi, Batch, lineageApi, remainingOf, TRANSFORMATION_LABELS, TransformationKind } from '../api/client'
import { toEventData, toLocalInput } from '../domain/catalog'
import { apiErrorMessage } from '../lib/apiError'
import { recallLocation, rememberLocation } from '../lib/lastLocation'
import StageFieldsInput, { StageValues } from '../components/StageFieldsInput'
import HandoffSelect from '../components/HandoffSelect'
import OccurredAtInput, { isLate, occurredAtToIso } from '../components/OccurredAtInput'
import Button from '../components/ui/Button'
import { cardClass } from '../components/ui/Card'
import { inputClass, labelClass } from '../components/ui/field'
import { SkeletonCardList } from '../components/ui/Skeleton'

/** Mirrors backend LineageService.KIND_ROLES — the server decides. */
const KIND_ROLES: Record<TransformationKind, Actor['role'][]> = {
  MERGE: ['COLLECTOR', 'PROCESSOR', 'WAREHOUSE', 'EXPORTER', 'DISTRIBUTOR', 'ADMIN'],
  SPLIT: ['COLLECTOR', 'PROCESSOR', 'WAREHOUSE', 'EXPORTER', 'DISTRIBUTOR', 'ADMIN'],
  TRANSFORM: ['PROCESSOR', 'ADMIN'],
  REWORK: ['PROCESSOR', 'ADMIN'],
  DOWNGRADE: ['PROCESSOR', 'INSPECTOR', 'ADMIN'],
}

const KIND_INFO: Record<TransformationKind, { icon: typeof Combine; hint: string }> = {
  MERGE: { icon: Combine, hint: 'Nhiều lô cùng loại vào một lô, ví dụ đại lý gom cà phê của nhiều hộ.' },
  SPLIT: { icon: Split, hint: 'Một lô chia thành nhiều lô cùng loại, ví dụ đóng nhiều container.' },
  TRANSFORM: { icon: Factory, hint: 'Đổi loại hàng, ví dụ cà phê quả tươi thành nhân xanh.' },
  REWORK: { icon: Recycle, hint: 'Lô không đạt kiểm định được sấy lại / phân loại lại thành lô mới — phải kiểm định lại.' },
  DOWNGRADE: { icon: ArrowDownCircle, hint: 'Lô không đạt được xếp vào hạng thấp hơn ngay tại khâu kiểm định, rồi đi tiếp.' },
}

interface OutputRow {
  productName: string
  productTypeId: string
  quantity: string
  unit: string
}

const fmtQty = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 3 })
const remedy = (k: TransformationKind) => k === 'REWORK' || k === 'DOWNGRADE'

/**
 * Merge / split / transform lots — and, for a lot that failed inspection,
 * rework or downgrade (docs/SPEC_PHASE1_5.md §0.3). The server is the
 * authority on every rule; this form only guides: lots the user holds, the
 * steps their workflow allows here, the fields of that step, and a live
 * mass-balance estimate against the catalog's reference ranges.
 */
export default function TransformLots() {
  const { actor } = useAuth()
  const { catalog } = useCatalog()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const allowedKinds = (Object.keys(KIND_ROLES) as TransformationKind[]).filter((k) => actor && KIND_ROLES[k].includes(actor.role))
  const initialKind = (params.get('kind') as TransformationKind | null) ?? undefined
  const [kind, setKind] = useState<TransformationKind>(initialKind && allowedKinds.includes(initialKind) ? initialKind : allowedKinds[0] ?? 'MERGE')
  const [lots, setLots] = useState<Batch[] | null>(null)
  const [actors, setActors] = useState<Actor[]>([])
  const [selected, setSelected] = useState<Record<string, string>>({}) // lotId → quantity text
  const [outputs, setOutputs] = useState<OutputRow[]>([])
  const [stage, setStage] = useState('')
  const [values, setValues] = useState<StageValues>({})
  const [location, setLocation] = useState('')
  const [notes, setNotes] = useState('')
  const [occurredAt, setOccurredAt] = useState(toLocalInput(new Date()))
  const [lateReason, setLateReason] = useState('')
  const [assignNextTo, setAssignNextTo] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    batchApi
      .custody()
      .then((l) => {
        setLots(l)
        const pre = params.get('lotId')
        const lot = l.find((x) => x.id === pre)
        if (lot) setSelected({ [lot.id]: String(remainingOf(lot)) })
      })
      .catch(() => setLots([]))
    actorsApi.list().then(setActors).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = useMemo(() => (lots ?? []).filter((l) => l.id in selected), [lots, selected])
  const first = chosen[0]
  const inputType = catalog?.productType(first?.productTypeId)
  const rules = catalog?.rules(first?.workflowId)

  // The steps this can be recorded at, given the inputs' workflow and position.
  const stageOptions = useMemo(() => {
    if (!rules || !actor || chosen.length === 0) return []
    const at = Math.max(...chosen.map((l) => rules.position(l.currentStage)))
    if (kind === 'DOWNGRADE') return first?.currentStage ? [first.currentStage] : []
    const can = (s: string) => actor.role === 'ADMIN' || rules.steps.find((x) => x.stage === s)?.roles.includes(actor.role)
    if (kind === 'REWORK') {
      return rules.steps.filter((s) => s.position < at && rules.kind(s.stage) !== 'INSPECTION' && can(s.stage)).map((s) => s.stage)
    }
    const here = rules.steps.find((s) => s.position === at)
    const candidates = [...(here ? [here] : []), ...rules.nextCandidates(at)]
    return candidates.filter((s) => can(s.stage) && rules.kind(s.stage) !== 'RECEIPT').map((s) => s.stage)
  }, [rules, actor, chosen, kind, first])

  useEffect(() => {
    if (!stageOptions.includes(stage)) setStage(stageOptions[stageOptions.length > 1 && kind === 'REWORK' ? stageOptions.length - 1 : 0] ?? '')
  }, [stageOptions, stage, kind])

  useEffect(() => {
    if (actor && stage) setLocation((loc) => loc || recallLocation(actor.id, `transform-${stage}`) || '')
    setValues(kind === 'DOWNGRADE' ? { result: 'PASS' } : {})
  }, [actor, stage, kind])

  // Keep the output rows consistent with the kind and the chosen inputs.
  useEffect(() => {
    const totalIn = chosen.reduce((s, l) => s + (Number(selected[l.id]) || 0), 0)
    const unit = first?.unit ?? 'kg'
    const typeId = first?.productTypeId ?? ''
    if (kind === 'MERGE') {
      setOutputs([{ productName: first ? `${first.productType} gộp` : '', productTypeId: typeId, quantity: totalIn ? String(totalIn) : '', unit }])
    } else if (kind === 'SPLIT') {
      setOutputs((prev) =>
        prev.length >= 2 && prev.every((o) => o.productTypeId === typeId)
          ? prev
          : [1, 2].map((n) => ({ productName: first ? `${first.productName} — phần ${n}` : '', productTypeId: typeId, quantity: '', unit })),
      )
    } else if (kind === 'REWORK') {
      setOutputs([{ productName: first ? `${first.productName} (chế biến lại)` : '', productTypeId: typeId, quantity: '', unit }])
    } else if (kind === 'DOWNGRADE') {
      setOutputs([{ productName: first ? `${first.productName} (hạ loại)` : '', productTypeId: typeId, quantity: '', unit }])
    } else {
      // TRANSFORM: suggest the first product this one converts into.
      const target = (catalog?.reference?.conversionFactors ?? []).find((c) => c.fromTypeId === typeId)?.toTypeId ?? ''
      setOutputs((prev) =>
        prev.length === 1 && prev[0].productTypeId && prev[0].productTypeId !== typeId
          ? prev
          : [{ productName: catalog?.productType(target)?.name ?? '', productTypeId: target, quantity: '', unit: catalog?.unitsFor(target)[0]?.code ?? 'kg' }],
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, first?.id, chosen.length, selected])

  if (actor && allowedKinds.length === 0) return <Navigate to="/tasks" replace />

  const toggle = (lot: Batch) => {
    setError('')
    setSelected((prev) => {
      if (lot.id in prev) {
        const { [lot.id]: _removed, ...rest } = prev
        return rest
      }
      const qty = String(remainingOf(lot))
      return kind === 'MERGE' ? { ...prev, [lot.id]: qty } : { [lot.id]: qty }
    })
  }

  const usable = (lots ?? []).filter(
    (l) =>
      (remedy(kind) ? l.status === 'REJECTED' : l.status === 'ACTIVE') &&
      (kind !== 'MERGE' || !first || (l.productTypeId === first.productTypeId && l.workflowId === first.workflowId)),
  )

  // ── Mass balance against the catalog ──
  const inKg = chosen.every((l) => l.baseUnit === 'kg' && l.unitFactor)
    ? chosen.reduce((s, l) => s + (Number(selected[l.id]) || 0) * (l.unitFactor ?? 0), 0)
    : null
  const unitFactor = (o: OutputRow) => catalog?.unitsFor(o.productTypeId).find((u) => u.code === o.unit)
  const outKg = outputs.every((o) => unitFactor(o)?.baseUnit === 'kg') ? outputs.reduce((s, o) => s + (Number(o.quantity) || 0) * (unitFactor(o)?.factor ?? 0), 0) : null
  const bounds =
    kind === 'TRANSFORM'
      ? catalog?.conversion(first?.productTypeId, outputs[0]?.productTypeId)
      : catalog?.processRatio(kind as 'MERGE' | 'SPLIT' | 'REWORK' | 'DOWNGRADE', inputType?.categoryCode)
  const outOfRange = inKg !== null && outKg !== null && bounds && (outKg > inKg * bounds.max + 1e-6 || outKg < inKg * bounds.min - 1e-6)

  // ── Fields of the step, for the output product's group ──
  const outType = catalog?.productType(outputs[0]?.productTypeId)
  const fields = stage ? catalog?.currentSchema(outType?.categoryCode ?? inputType?.categoryCode, stage)?.fields ?? [] : []
  const settings = catalog?.settingsFor(first?.productTypeId) ?? { maxBackdateDays: 7 }
  const stagePos = rules && stage ? rules.position(stage) : 0
  const here = rules?.steps.find((s) => s.position === stagePos)
  const handoffRoles = rules ? [...new Set([...(here?.roles ?? []), ...rules.nextCandidates(stagePos, { metadata: { reinspect: kind === 'REWORK' } }).flatMap((s) => s.roles)])] : []

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const result = await lineageApi.transform({
        kind,
        stage,
        location: location.trim(),
        notes: notes.trim() || undefined,
        data: toEventData(fields, values),
        inputs: chosen.map((l) => ({ lotId: l.id, quantity: Number(selected[l.id]) })),
        outputs: outputs.map((o) => ({ productName: o.productName.trim(), productTypeId: o.productTypeId, quantity: Number(o.quantity), unit: o.unit })),
        assignNextTo: assignNextTo || undefined,
        occurredAt: occurredAtToIso(occurredAt),
        lateReason: isLate(occurredAt, settings.maxBackdateDays) ? lateReason.trim() : undefined,
      })
      if (actor) rememberLocation(actor.id, `transform-${stage}`, location.trim())
      const flash =
        result.anomalies.length > 0
          ? `Đã ghi nhận, nhưng có cảnh báo: ${result.anomalies[0].message}`
          : `Đã ${TRANSFORMATION_LABELS[kind].toLowerCase()} — tạo ${result.outputs.length} lô mới.`
      navigate(`/batch/${result.outputs[0].id}`, { state: { flash } })
    } catch (err) {
      setError(apiErrorMessage(err, 'Không ghi nhận được. Kiểm tra lại lô đầu vào và số lượng.'))
    } finally {
      setSubmitting(false)
    }
  }

  const minInputs = kind === 'MERGE' ? 2 : 1
  const canSubmit =
    chosen.length >= minInputs &&
    (kind === 'MERGE' || chosen.length === 1) &&
    !!stage &&
    outputs.length > 0 &&
    outputs.every((o) => o.productName.trim() && o.productTypeId && Number(o.quantity) > 0) &&
    location.trim().length > 0

  const typeGroups = catalog?.productTypesByCategory() ?? []

  return (
    <div className="page-shell">
      <header className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
        <button type="button" onClick={() => navigate(-1)} aria-label="Quay lại" className="text-slate-500 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="font-semibold text-slate-900 dark:text-slate-50">Gộp / tách / chế biến lô</h1>
      </header>

      <main className="page-container">
        <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <div role="radiogroup" aria-label="Loại thao tác" className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-3 xl:grid-cols-5 gap-2">
            {allowedKinds.map((k) => {
              const Icon = KIND_INFO[k].icon
              const active = kind === k
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setKind(k)
                    setSelected({})
                  }}
                  className={cardClass({
                    padding: 'sm',
                    className: `text-left transition-colors ${active ? '!border-brand-500 ring-2 ring-brand-100 dark:ring-brand-500/20' : 'hover:border-brand-200'}`,
                  })}
                >
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-50">
                    <Icon className={`w-4 h-4 ${remedy(k) ? 'text-rose-500' : 'text-brand-600'}`} /> {TRANSFORMATION_LABELS[k]}
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400 mt-1">{KIND_INFO[k].hint}</span>
                </button>
              )
            })}
          </div>

          <section className={cardClass({ className: 'space-y-3' })}>
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
              Lô đầu vào{' '}
              {kind === 'MERGE' ? '(chọn từ 2 lô cùng loại, cùng quy trình)' : remedy(kind) ? '(lô không đạt kiểm định bạn đang giữ)' : '(chọn 1 lô)'}
            </h2>
            {lots === null && <SkeletonCardList rows={3} />}
            {lots !== null && usable.length === 0 && (
              <p className="text-sm text-slate-500">{remedy(kind) ? 'Bạn không giữ lô nào bị loại.' : 'Bạn chưa giữ lô hàng nào có thể dùng.'}</p>
            )}
            <ul className="space-y-2 max-h-[60vh] overflow-y-auto">
              {usable.map((l) => {
                const checked = l.id in selected
                return (
                  <li key={l.id} className={`rounded-xl border p-3 ${checked ? 'border-brand-300 bg-brand-50/50 dark:bg-brand-500/10 dark:border-brand-500/40' : 'border-slate-200 dark:border-slate-700'}`}>
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input type={kind === 'MERGE' ? 'checkbox' : 'radio'} name="input-lot" checked={checked} onChange={() => toggle(l)} className="mt-1" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-slate-900 dark:text-slate-50 truncate">{l.productName}</span>
                        <span className="block text-xs text-slate-500">
                          {l.productType} · {l.origin} · còn {fmtQty(remainingOf(l))}/{fmtQty(l.quantity)} {l.unit}
                          {l.currentStage && ` · ${catalog?.stageLabel(l.currentStage) ?? l.currentStage}`}
                        </span>
                      </span>
                    </label>
                    {checked && (
                      <div className="mt-2 flex items-center gap-2 pl-7">
                        <label htmlFor={`q-${l.id}`} className="text-xs text-slate-500">Lấy</label>
                        <input
                          id={`q-${l.id}`}
                          type="number"
                          min="0.001"
                          step="any"
                          max={remainingOf(l)}
                          value={selected[l.id]}
                          onChange={(e) => setSelected((p) => ({ ...p, [l.id]: e.target.value }))}
                          className={`${inputClass} !w-32 !py-1.5`}
                        />
                        <span className="text-xs text-slate-500">{l.unit}</span>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>

          <div className="space-y-4 min-w-0">
            <section className={cardClass({ className: 'space-y-3' })}>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Lô đầu ra</h2>
                {kind === 'SPLIT' && (
                  <button
                    type="button"
                    onClick={() => setOutputs((o) => [...o, { ...o[0], productName: `${first?.productName ?? 'Lô'} — phần ${o.length + 1}`, quantity: '' }])}
                    className="text-xs text-brand-600 font-medium inline-flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> Thêm phần
                  </button>
                )}
              </div>
              {outputs.map((o, i) => {
                const units = catalog?.unitsFor(o.productTypeId) ?? []
                const typeEditable = kind === 'TRANSFORM' || kind === 'DOWNGRADE'
                return (
                  <div key={i} className="grid grid-cols-12 gap-2 items-end">
                    <div className="col-span-12 sm:col-span-5">
                      <label className={labelClass} htmlFor={`out-name-${i}`}>Tên lô</label>
                      <input id={`out-name-${i}`} value={o.productName} onChange={(e) => setOutputs((p) => p.map((x, j) => (j === i ? { ...x, productName: e.target.value } : x)))} className={inputClass} required />
                    </div>
                    <div className="col-span-6 sm:col-span-3">
                      <label className={labelClass} htmlFor={`out-type-${i}`}>Loại hàng</label>
                      <select
                        id={`out-type-${i}`}
                        value={o.productTypeId}
                        disabled={!typeEditable}
                        onChange={(e) =>
                          setOutputs((p) =>
                            p.map((x, j) => (j === i ? { ...x, productTypeId: e.target.value, unit: catalog?.unitsFor(e.target.value)[0]?.code ?? 'kg' } : x)),
                          )
                        }
                        className={inputClass}
                      >
                        <option value="">—</option>
                        {typeGroups
                          .filter((g) => kind !== 'DOWNGRADE' || g.category.code === inputType?.categoryCode)
                          .map((g) => (
                            <optgroup key={g.category.code} label={g.category.name}>
                              {g.types.map((t) => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                            </optgroup>
                          ))}
                      </select>
                    </div>
                    <div className="col-span-4 sm:col-span-2">
                      <label className={labelClass} htmlFor={`out-q-${i}`}>Số lượng</label>
                      <input id={`out-q-${i}`} type="number" min="0.001" step="any" value={o.quantity} onChange={(e) => setOutputs((p) => p.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} className={inputClass} required />
                    </div>
                    <div className="col-span-2 sm:col-span-2 flex gap-1">
                      <select aria-label="Đơn vị" value={o.unit} onChange={(e) => setOutputs((p) => p.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} className={inputClass}>
                        {units.map((u) => <option key={u.id} value={u.code}>{u.label}</option>)}
                      </select>
                      {kind === 'SPLIT' && outputs.length > 2 && (
                        <button type="button" aria-label="Xoá phần này" onClick={() => setOutputs((p) => p.filter((_, j) => j !== i))} className="text-slate-400 hover:text-rose-600 px-1">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
              {inKg !== null && outKg !== null && chosen.length > 0 && (
                <p className={`text-xs ${outOfRange ? 'text-rose-600 dark:text-rose-400 font-medium' : 'text-slate-500'}`}>
                  Đầu vào {fmtQty(inKg)} kg → đầu ra {fmtQty(outKg)} kg
                  {inKg > 0 && ` (tỉ lệ ${(outKg / inKg).toLocaleString('vi-VN', { maximumFractionDigits: 3 })}`}
                  {bounds && `; chuẩn ${bounds.min}–${bounds.max}`}
                  {inKg > 0 && ')'}
                  {outOfRange && ' — ngoài khoảng tham chiếu, sẽ bị gắn cảnh báo.'}
                </p>
              )}
              {bounds && <p className="text-[11px] text-slate-400">Nguồn số liệu: {bounds.source}</p>}
              {kind === 'TRANSFORM' && inputType && outputs[0]?.productTypeId && !bounds && (
                <p className="text-xs text-slate-500">Chưa có hệ số quy đổi cho {inputType.name} → {outType?.name}: không kiểm cân bằng khối lượng.</p>
              )}
            </section>

            <section className={cardClass({ className: 'space-y-4' })}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={labelClass} htmlFor="stage">Khâu</label>
                  <select id="stage" value={stage} onChange={(e) => setStage(e.target.value)} className={inputClass} disabled={stageOptions.length <= 1}>
                    {stageOptions.length === 0 && <option value="">— Chọn lô đầu vào trước —</option>}
                    {stageOptions.map((s) => (
                      <option key={s} value={s}>{catalog?.stageLabel(s) ?? s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass} htmlFor="location">Địa điểm</label>
                  <input id="location" value={location} onChange={(e) => setLocation(e.target.value)} required maxLength={200} className={inputClass} placeholder="VD: Nhà máy Bảo Lộc" />
                </div>
              </div>
              {stage && <StageFieldsInput fields={fields} values={values} onChange={setValues} />}
              <OccurredAtInput value={occurredAt} onChange={setOccurredAt} lateReason={lateReason} onLateReasonChange={setLateReason} maxBackdateDays={settings.maxBackdateDays} />
              {stage && (
                <HandoffSelect
                  roles={handoffRoles}
                  label="Lô đầu ra giao cho"
                  actors={actors}
                  value={assignNextTo}
                  onChange={setAssignNextTo}
                  isAdmin={actor?.role === 'ADMIN'}
                  required={false}
                  excludeId={actor?.id}
                />
              )}
              <div>
                <label className={labelClass} htmlFor="notes">Ghi chú</label>
                <textarea id="notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} className={`${inputClass} resize-none`} placeholder="Chỉ nội bộ" />
              </div>
            </section>
          </div>

          {error && (
            <div role="alert" className="lg:col-span-2 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 text-rose-700 dark:text-rose-400 text-sm rounded-xl px-3.5 py-2.5">
              {error}
            </div>
          )}
          <div className="lg:col-span-2 flex justify-end">
            <Button type="submit" disabled={submitting || !canSubmit} className="w-full lg:w-auto lg:min-w-64">
              {submitting ? 'Đang ghi nhận...' : `Ghi nhận ${TRANSFORMATION_LABELS[kind].toLowerCase()}`}
            </Button>
          </div>
        </form>
      </main>
    </div>
  )
}
