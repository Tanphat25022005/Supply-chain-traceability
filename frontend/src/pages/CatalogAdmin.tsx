import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { BookMarked, Boxes, Link2, Scale, Trash2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useCatalog } from '../context/CatalogContext'
import { catalogApi, ProcessRatio, ProductType, TRANSFORMATION_LABELS, UnmappedGroup } from '../api/client'
import { Catalog } from '../domain/catalog'
import { apiErrorMessage } from '../lib/apiError'
import PageHeader from '../components/ui/PageHeader'
import Badge from '../components/ui/Badge'
import Button from '../components/ui/Button'
import { cardClass } from '../components/ui/Card'
import { inputClass } from '../components/ui/field'
import { SkeletonCardList } from '../components/ui/Skeleton'

type RefTable = 'conversion-factors' | 'process-ratios' | 'yield-caps' | 'product-settings'

function Section({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className={cardClass({ className: 'space-y-3' })}>
      <div>
        <h2 className="font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
          {icon} {title}
        </h2>
        {hint && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Origin({ tenantId }: { tenantId: string | null }) {
  return tenantId ? <Badge tone="brand">Riêng của bạn</Badge> : <Badge tone="neutral">Nền tảng</Badge>
}

const th = 'text-left text-xs font-medium text-slate-500 dark:text-slate-400 px-2 py-1.5'
const td = 'px-2 py-1.5 align-top'

/** Product types by group, with their units; a form to add the tenant's own. */
function ProductTypes({ catalog, onChanged }: { catalog: Catalog; onChanged: () => void }) {
  const { view } = catalog
  const [form, setForm] = useState({ categoryCode: 'OTHER', code: '', name: '', baseUnit: 'kg' as 'kg' | 'cái', defaultWorkflowCode: '', aliases: '' })
  const [unitFor, setUnitFor] = useState('')
  const [unit, setUnit] = useState({ code: '', label: '', factor: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const workflowCodes = [...new Set(view.workflows.map((w) => w.code))]

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onChanged()
      return true
    } catch (err) {
      setError(apiErrorMessage(err, 'Không lưu được.'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const addType = async (e: FormEvent) => {
    e.preventDefault()
    const ok = await run(() =>
      catalogApi.createProductType({
        categoryCode: form.categoryCode,
        code: form.code.trim(),
        name: form.name.trim(),
        baseUnit: form.baseUnit,
        defaultWorkflowCode: form.defaultWorkflowCode || undefined,
        aliases: form.aliases.split(',').map((a) => a.trim()).filter(Boolean),
      }),
    )
    if (ok) setForm({ ...form, code: '', name: '', aliases: '' })
  }

  const addUnit = async (e: FormEvent) => {
    e.preventDefault()
    const ok = await run(() => catalogApi.createUnit({ productTypeId: unitFor, code: unit.code.trim(), label: unit.label.trim(), factor: Number(unit.factor) }))
    if (ok) setUnit({ code: '', label: '', factor: '' })
  }

  const toggle = (pt: ProductType) =>
    run(() => catalogApi.updateProductType(pt.id, { name: pt.name, gtin: pt.gtin ?? null, defaultWorkflowCode: pt.defaultWorkflowCode ?? null, aliases: pt.aliases, active: !pt.active }))

  return (
    <Section
      icon={<Boxes className="w-5 h-5 text-brand-500" />}
      title="Loại sản phẩm & đơn vị"
      hint="Loại của nền tảng dùng chung cho mọi doanh nghiệp. Bạn có thể thêm loại riêng và quy cách đóng gói riêng (bao, thùng…) quy đổi về kg hoặc cái."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={th}>Nhóm</th>
              <th className={th}>Loại sản phẩm</th>
              <th className={th}>Quy trình mặc định</th>
              <th className={th}>Đơn vị</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {[...view.productTypes]
              .sort((a, b) => a.categoryCode.localeCompare(b.categoryCode) || a.name.localeCompare(b.name, 'vi'))
              .map((pt) => (
                <tr key={pt.id} className={pt.active ? '' : 'opacity-50'}>
                  <td className={td}>{view.categories.find((c) => c.code === pt.categoryCode)?.name ?? pt.categoryCode}</td>
                  <td className={td}>
                    <p className="font-medium text-slate-800 dark:text-slate-100">{pt.name}</p>
                    <p className="text-xs text-slate-400">
                      {pt.code}
                      {pt.aliases.length > 0 && ` · còn gọi: ${pt.aliases.join(', ')}`}
                    </p>
                  </td>
                  <td className={td}>{view.workflows.find((w) => w.code === pt.defaultWorkflowCode)?.name ?? '—'}</td>
                  <td className={td}>
                    {catalog
                      .unitsFor(pt.id)
                      .map((u) => (u.factor === 1 ? u.label : `${u.label} (${u.factor.toLocaleString('vi-VN')} ${pt.baseUnit})`))
                      .join(', ')}
                  </td>
                  <td className={`${td} whitespace-nowrap space-x-2`}>
                    <Origin tenantId={pt.tenantId} />
                    {pt.tenantId && (
                      <button type="button" className="text-xs text-brand-600 dark:text-brand-400 hover:underline" disabled={busy} onClick={() => toggle(pt)}>
                        {pt.active ? 'Ngừng dùng' : 'Dùng lại'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
        <form onSubmit={addType} className="space-y-2">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Thêm loại sản phẩm riêng</p>
          <div className="grid grid-cols-2 gap-2">
            <select aria-label="Nhóm" value={form.categoryCode} onChange={(e) => setForm({ ...form, categoryCode: e.target.value })} className={inputClass}>
              {view.categories.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
            <select aria-label="Đơn vị gốc" value={form.baseUnit} onChange={(e) => setForm({ ...form, baseUnit: e.target.value as 'kg' | 'cái' })} className={inputClass}>
              <option value="kg">Tính theo kg</option>
              <option value="cái">Tính theo cái</option>
            </select>
            <input aria-label="Mã" placeholder="Mã (vd. CASHEW_RAW)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputClass} />
            <input aria-label="Tên" placeholder="Tên hiển thị" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} />
            <select aria-label="Quy trình mặc định" value={form.defaultWorkflowCode} onChange={(e) => setForm({ ...form, defaultWorkflowCode: e.target.value })} className={inputClass}>
              <option value="">Quy trình mặc định: chung</option>
              {workflowCodes.map((c) => (
                <option key={c} value={c}>
                  {view.workflows.find((w) => w.code === c)?.name}
                </option>
              ))}
            </select>
            <input aria-label="Tên gọi khác" placeholder="Tên gọi khác, cách nhau dấu phẩy" value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} className={inputClass} />
          </div>
          <Button type="submit" size="sm" disabled={busy || !form.code.trim() || !form.name.trim()}>
            Thêm loại
          </Button>
        </form>

        <form onSubmit={addUnit} className="space-y-2">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Thêm quy cách đóng gói</p>
          <select aria-label="Cho loại sản phẩm" value={unitFor} onChange={(e) => setUnitFor(e.target.value)} className={inputClass}>
            <option value="">Chọn loại sản phẩm…</option>
            {view.productTypes
              .filter((p) => p.active)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <div className="grid grid-cols-3 gap-2">
            <input aria-label="Mã đơn vị" placeholder="Mã (bao70)" value={unit.code} onChange={(e) => setUnit({ ...unit, code: e.target.value })} className={inputClass} />
            <input aria-label="Tên đơn vị" placeholder="Bao 70 kg" value={unit.label} onChange={(e) => setUnit({ ...unit, label: e.target.value })} className={inputClass} />
            <input
              aria-label="Hệ số quy đổi"
              type="number"
              min={0}
              step="any"
              placeholder={`= ? ${view.productTypes.find((p) => p.id === unitFor)?.baseUnit ?? 'kg'}`}
              value={unit.factor}
              onChange={(e) => setUnit({ ...unit, factor: e.target.value })}
              className={inputClass}
            />
          </div>
          <Button type="submit" size="sm" disabled={busy || !unitFor || !unit.code.trim() || !unit.label.trim() || !(Number(unit.factor) > 0)}>
            Thêm đơn vị
          </Button>
        </form>
      </div>
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
    </Section>
  )
}

/** Lots created before the catalog whose free-text product didn't match any type: map them by hand. */
function UnmappedQueue({ catalog, onChanged }: { catalog: Catalog; onChanged: () => void }) {
  const [groups, setGroups] = useState<UnmappedGroup[] | null>(null)
  const [choice, setChoice] = useState<Record<string, { productTypeId: string; factor: string }>>({})
  const [error, setError] = useState('')

  const load = () => catalogApi.unmapped().then(setGroups).catch(() => setGroups([]))
  useEffect(() => {
    load()
  }, [])

  if (!groups || groups.length === 0) return null
  const keyOf = (g: UnmappedGroup) => `${g.productType}|${g.unit}`

  const map = async (g: UnmappedGroup) => {
    const c = choice[keyOf(g)]
    if (!c?.productTypeId) return
    setError('')
    try {
      await catalogApi.map({ productType: g.productType, unit: g.unit, productTypeId: c.productTypeId, unitFactor: c.factor ? Number(c.factor) : undefined })
      await load()
      onChanged()
    } catch (err) {
      setError(apiErrorMessage(err, 'Không gán được.'))
    }
  }

  return (
    <Section
      icon={<Link2 className="w-5 h-5 text-amber-500" />}
      title={`Lô cũ chưa gắn loại sản phẩm (${groups.reduce((n, g) => n + g.batchCount, 0)})`}
      hint="Các lô tạo trước khi có danh mục, với tên sản phẩm gõ tự do không khớp loại nào. Gán một lần cho cả nhóm; hệ thống không tự đoán."
    >
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {groups.map((g) => {
          const c = choice[keyOf(g)] ?? { productTypeId: '', factor: '' }
          const target = catalog.productType(c.productTypeId)
          const needsFactor = !!target && g.unit !== target.baseUnit && !catalog.unitsFor(target.id).some((u) => u.code === g.unit || u.label === g.unit)
          return (
            <li key={keyOf(g)} className="py-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="flex-1 min-w-[12rem]">
                “{g.productType}” · {g.unit} <span className="text-slate-400">({g.batchCount} lô)</span>
              </span>
              <select
                aria-label={`Loại cho ${g.productType}`}
                value={c.productTypeId}
                onChange={(e) => setChoice({ ...choice, [keyOf(g)]: { ...c, productTypeId: e.target.value } })}
                className={`${inputClass} w-56`}
              >
                <option value="">Chọn loại…</option>
                {catalog.view.productTypes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {needsFactor && (
                <input
                  aria-label="1 đơn vị cũ bằng bao nhiêu đơn vị gốc"
                  type="number"
                  min={0}
                  step="any"
                  placeholder={`1 ${g.unit} = ? ${target!.baseUnit}`}
                  value={c.factor}
                  onChange={(e) => setChoice({ ...choice, [keyOf(g)]: { ...c, factor: e.target.value } })}
                  className={`${inputClass} w-36`}
                />
              )}
              <Button size="sm" variant="secondary" disabled={!c.productTypeId || (needsFactor && !(Number(c.factor) > 0))} onClick={() => map(g)}>
                Gán
              </Button>
            </li>
          )
        })}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
    </Section>
  )
}

/** One row of reference data: the value, where it comes from, and an inline override. */
function RefRow({
  label,
  value,
  source,
  tenantId,
  fields,
  onSave,
  onDelete,
}: {
  label: ReactNode
  value: string
  source: string
  tenantId: string | null
  fields: Array<{ key: string; label: string; initial: number; step?: string }>
  onSave: (values: Record<string, number>, source: string) => Promise<void>
  onDelete?: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')

  const start = () => {
    setValues(Object.fromEntries(fields.map((f) => [f.key, String(f.initial)])))
    setSrc(tenantId ? source : '')
    setError('')
    setEditing(true)
  }

  const save = async () => {
    setError('')
    try {
      await onSave(Object.fromEntries(fields.map((f) => [f.key, Number(values[f.key])])), src.trim())
      setEditing(false)
    } catch (err) {
      setError(apiErrorMessage(err, 'Không lưu được.'))
    }
  }

  return (
    <tr>
      <td className={td}>{label}</td>
      <td className={`${td} whitespace-nowrap font-medium`}>{value}</td>
      <td className={`${td} text-xs text-slate-500 dark:text-slate-400`}>
        <Origin tenantId={tenantId} /> {source}
        {editing && (
          <div className="mt-2 space-y-1.5">
            <div className="flex flex-wrap gap-1.5">
              {fields.map((f) => (
                <label key={f.key} className="text-xs">
                  {f.label}
                  <input
                    type="number"
                    step={f.step ?? 'any'}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    className={`${inputClass} w-24`}
                  />
                </label>
              ))}
            </div>
            <input placeholder="Nguồn số liệu (bắt buộc), vd. biên bản cân thực tế 2026" value={src} onChange={(e) => setSrc(e.target.value)} className={inputClass} />
            {error && <p className="text-rose-600 dark:text-rose-400">{error}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={src.trim().length < 3}>
                Lưu giá trị riêng
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Huỷ
              </Button>
            </div>
          </div>
        )}
      </td>
      <td className={`${td} whitespace-nowrap`}>
        {!editing && (
          <button type="button" onClick={start} className="text-xs text-brand-600 dark:text-brand-400 hover:underline">
            {tenantId ? 'Sửa' : 'Đặt giá trị riêng'}
          </button>
        )}
        {tenantId && onDelete && (
          <button type="button" aria-label="Bỏ giá trị riêng" title="Bỏ giá trị riêng, dùng lại giá trị nền tảng" onClick={onDelete} className="ml-2 text-slate-400 hover:text-rose-500">
            <Trash2 className="w-3.5 h-3.5 inline" />
          </button>
        )}
      </td>
    </tr>
  )
}

const pct = (n: number) => `${(n * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`

/** Reference values the anomaly checks use — each with its source; a tenant may override with its own measured value. */
function ReferenceTables({ catalog, onChanged }: { catalog: Catalog; onChanged: () => void }) {
  const ref = catalog.reference
  const name = (id: string) => catalog.productType(id)?.name ?? id
  const save = async (fn: () => Promise<unknown>) => {
    await fn()
    onChanged()
  }
  const del = (table: RefTable, id: string) => save(() => catalogApi.deleteOverride(table, id))

  /** Platform row hidden when this tenant has overridden it — show what's actually in force. */
  const inForce = <T extends { tenantId: string | null }>(rows: T[], keyOf: (r: T) => string) => {
    const own = new Set(rows.filter((r) => r.tenantId).map(keyOf))
    return rows.filter((r) => r.tenantId || !own.has(keyOf(r)))
  }

  const tables = useMemo(() => {
    if (!ref) return null
    return {
      conversion: inForce(ref.conversionFactors, (r) => `${r.fromTypeId}>${r.toTypeId}`),
      ratios: inForce(ref.processRatios, (r) => `${r.kind}|${r.categoryCode}`),
      yields: inForce(ref.yieldCaps, (r) => `${r.productTypeId}|${r.region}`),
      settings: inForce(ref.productSettings, (r) => r.productTypeId),
    }
  }, [ref])

  if (!tables) return <p className="text-sm text-slate-500">Không tải được dữ liệu tham chiếu.</p>
  const head = (
    <thead>
      <tr>
        <th className={th}>Áp dụng cho</th>
        <th className={th}>Giá trị</th>
        <th className={th}>Nguồn</th>
        <th className={th}></th>
      </tr>
    </thead>
  )

  return (
    <Section
      icon={<Scale className="w-5 h-5 text-brand-500" />}
      title="Dữ liệu tham chiếu cho cảnh báo"
      hint="Các ngưỡng hệ thống dùng để phát hiện bất thường (hao hụt, năng suất, ghi lùi ngày…). Mỗi giá trị ghi rõ nguồn. Nếu số liệu thực tế của bạn khác, đặt giá trị riêng kèm nguồn — giá trị nền tảng vẫn được giữ."
    >
      <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300">Tỉ lệ quy đổi khi chế biến (đầu ra / đầu vào)</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {head}
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {tables.conversion.map((r) => (
              <RefRow
                key={r.id}
                label={`${name(r.fromTypeId)} → ${name(r.toTypeId)}`}
                value={`${pct(r.min)} – ${pct(r.max)}`}
                source={r.source}
                tenantId={r.tenantId}
                fields={[
                  { key: 'min', label: 'Thấp nhất', initial: r.min },
                  { key: 'max', label: 'Cao nhất', initial: r.max },
                ]}
                onSave={(v, source) => save(() => catalogApi.setConversionFactor({ fromTypeId: r.fromTypeId, toTypeId: r.toTypeId, min: v.min, max: v.max, source }))}
                onDelete={() => del('conversion-factors', r.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300">Hao hụt cho phép khi gộp / tách / tái chế / hạ loại</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {head}
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {tables.ratios.map((r) => (
              <RefRow
                key={r.id}
                label={`${TRANSFORMATION_LABELS[r.kind as ProcessRatio['kind']]}${r.categoryCode ? ` · ${catalog.view.categories.find((c) => c.code === r.categoryCode)?.name ?? r.categoryCode}` : ' · mọi nhóm'}`}
                value={`${pct(r.min)} – ${pct(r.max)}`}
                source={r.source}
                tenantId={r.tenantId}
                fields={[
                  { key: 'min', label: 'Thấp nhất', initial: r.min },
                  { key: 'max', label: 'Cao nhất', initial: r.max },
                ]}
                onSave={(v, source) => save(() => catalogApi.setProcessRatio({ kind: r.kind, categoryCode: r.categoryCode, min: v.min, max: v.max, source }))}
                onDelete={() => del('process-ratios', r.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300">Năng suất tối đa hợp lý</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {head}
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {tables.yields.map((r) => (
              <RefRow
                key={r.id}
                label={`${name(r.productTypeId)}${r.region ? ` · ${r.region}` : ''}`}
                value={`${r.maxKgPerHa.toLocaleString('vi-VN')} kg/ha`}
                source={r.source}
                tenantId={r.tenantId}
                fields={[{ key: 'maxKgPerHa', label: 'kg/ha', initial: r.maxKgPerHa }]}
                onSave={(v, source) => save(() => catalogApi.setYieldCap({ productTypeId: r.productTypeId, region: r.region, maxKgPerHa: v.maxKgPerHa, source }))}
                onDelete={() => del('yield-caps', r.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300">Hao hụt vận chuyển cho phép & số ngày được ghi lùi</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {head}
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {tables.settings.map((r) => (
              <RefRow
                key={r.id}
                label={name(r.productTypeId)}
                value={`${pct(r.transitLossTolerance)} · ${r.maxBackdateDays} ngày`}
                source={r.source}
                tenantId={r.tenantId}
                fields={[
                  { key: 'transitLossTolerance', label: 'Hao hụt (0–0,5)', initial: r.transitLossTolerance },
                  { key: 'maxBackdateDays', label: 'Ngày ghi lùi', initial: r.maxBackdateDays, step: '1' },
                ]}
                onSave={(v, source) =>
                  save(() =>
                    catalogApi.setProductSettings({ productTypeId: r.productTypeId, transitLossTolerance: v.transitLossTolerance, maxBackdateDays: v.maxBackdateDays, source }),
                  )
                }
                onDelete={() => del('product-settings', r.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

/** ADMIN: the tenant's view of the product catalog, the legacy-data mapping queue and the sourced reference data. */
export default function CatalogAdmin() {
  const { actor } = useAuth()
  const { catalog, error, reload } = useCatalog()
  if (actor && actor.role !== 'ADMIN') return <Navigate to="/" replace />

  return (
    <div className="page-shell">
      <main className="page-container space-y-5">
        <PageHeader title="Danh mục sản phẩm" subtitle="Loại sản phẩm, đơn vị, quy trình và các ngưỡng tham chiếu dùng để kiểm tra dữ liệu." />
        {error && <p className="text-sm text-rose-600 dark:text-rose-400">Không tải được danh mục.</p>}
        {!catalog && !error && <SkeletonCardList rows={3} />}
        {catalog && (
          <>
            <UnmappedQueue catalog={catalog} onChanged={reload} />
            <ProductTypes catalog={catalog} onChanged={reload} />
            <ReferenceTables catalog={catalog} onChanged={reload} />
            <Section
              icon={<BookMarked className="w-5 h-5 text-brand-500" />}
              title="Quy trình mẫu"
              hint="Mỗi lô gắn với một phiên bản quy trình lúc tạo; sửa quy trình về sau không ảnh hưởng lô cũ."
            >
              <ul className="space-y-2 text-sm">
                {catalog.view.workflows.map((w) => (
                  <li key={w.id}>
                    <p className="font-medium text-slate-800 dark:text-slate-100">
                      {w.name} <span className="text-xs text-slate-400">v{w.version}</span>
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {w.steps.map((s) => `${catalog.stageLabel(s.stage)}${s.required ? '' : ' (tuỳ chọn)'}`).join(' → ')}
                    </p>
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )}
      </main>
    </div>
  )
}
