import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, Clock3, ListChecks, Package, Plus, ShieldAlert, Siren } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { AttentionSummary, batchApi, Batch, LotStatus, statsApi, StatsOverview, STATUS_LABELS, SupplyChainStage } from '../api/client'
import { useCatalog } from '../context/CatalogContext'
import { Catalog, nextStepLabel, relativeDays } from '../domain/catalog'
import PageHeader from '../components/ui/PageHeader'
import StatCard from '../components/ui/StatCard'
import EmptyState from '../components/ui/EmptyState'
import BatchRow from '../components/BatchRow'
import { buttonClass } from '../components/ui/Button'
import { cardClass } from '../components/ui/Card'
import { inputClass } from '../components/ui/field'
import { SkeletonCardList } from '../components/ui/Skeleton'

const PAGE_SIZE = 10
const KANBAN_COLUMN_SIZE = 8

type StageFilter = SupplyChainStage | 'NONE' | ''

/** "Not started", then every stage of the catalog in display order. */
function stageColumns(catalog: Catalog | undefined): Array<{ key: SupplyChainStage | 'NONE'; label: string }> {
  return [
    { key: 'NONE', label: 'Chưa bắt đầu' },
    ...[...(catalog?.view.stages ?? [])].sort((a, b) => a.sortOrder - b.sortOrder).map((s) => ({ key: s.code, label: s.label })),
  ]
}

/** One request per column, each capped — the board never pulls the whole tenant into the browser. Empty stages are hidden. */
function KanbanBoard({ onShowAll }: { onShowAll: (stage: SupplyChainStage | 'NONE') => void }) {
  const { catalog } = useCatalog()
  const columnsDef = stageColumns(catalog)
  const [columns, setColumns] = useState<Record<string, { items: Batch[]; total: number }> | null>(null)

  useEffect(() => {
    if (!catalog) return
    const defs = stageColumns(catalog)
    Promise.all(defs.map((c) => batchApi.list({ page: 1, pageSize: KANBAN_COLUMN_SIZE, stage: c.key })))
      .then((pages) => setColumns(Object.fromEntries(defs.map((c, i) => [c.key, { items: pages[i].items, total: pages[i].total }]))))
      .catch(() => setColumns({}))
  }, [catalog])

  if (!columns) return <SkeletonCardList rows={4} className="mt-2" />

  return (
    <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0">
      {columnsDef.filter((col) => col.key === 'NONE' || (columns[col.key]?.total ?? 0) > 0).map((col) => {
        const data = columns[col.key] ?? { items: [], total: 0 }
        return (
          <section key={col.key} className="bg-slate-100/70 dark:bg-slate-800/70 rounded-2xl p-3 w-60 flex-shrink-0" aria-label={col.label}>
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2 flex items-center justify-between">
              {col.label}
              <span className="bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 rounded-full px-2 py-0.5 shadow-sm">{data.total}</span>
            </h3>
            <div className="space-y-2">
              {data.items.map((b) => (
                <Link
                  key={b.id}
                  to={`/batch/${b.id}`}
                  className="block bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3 hover:border-brand-300 dark:hover:border-brand-500/40 transition-colors"
                >
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-50 truncate">{b.productName}</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500 truncate">{b.origin}</p>
                  <p className={`text-[11px] mt-1 ${b.status !== 'ACTIVE' ? 'text-rose-600 dark:text-rose-400 font-medium' : 'text-slate-400 dark:text-slate-500'}`}>
                    {b.status !== 'ACTIVE' ? STATUS_LABELS[b.status] : `Cập nhật ${relativeDays(b.lastEventAt ?? b.createdAt)}`}
                  </p>
                </Link>
              ))}
              {data.items.length === 0 && <p className="text-xs text-slate-300 dark:text-slate-600 text-center py-3">Trống</p>}
              {data.total > data.items.length && (
                <button type="button" onClick={() => onShowAll(col.key)} className="w-full text-xs text-brand-600 dark:text-brand-400 hover:underline py-1">
                  Xem thêm {data.total - data.items.length} lô →
                </button>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function needsAttention(a: AttentionSummary): boolean {
  return a.stalledCount + a.openAnomalyCount + a.overdueTransferCount + a.onHoldCount + a.rejectedCount > 0
}

/** "What needs a human today": unanswered hand-overs, frozen and rejected lots, stalled lots, open anomalies. */
function AttentionCard({ attention, isAdmin, onStatus }: { attention: AttentionSummary; isAdmin: boolean; onStatus: (s: LotStatus) => void }) {
  const { catalog } = useCatalog()
  if (!needsAttention(attention)) return null
  return (
    <section className={cardClass({ className: 'border-amber-200/80 dark:border-amber-500/20' })}>
      <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-3">
        <ShieldAlert className="w-4 h-4 text-amber-500" /> Cần chú ý
      </h2>
      {attention.openAnomalyCount > 0 && (
        <p className="text-sm text-slate-600 dark:text-slate-300 mb-3">
          {attention.openAnomalyCount} cảnh báo bất thường chưa xử lý.{' '}
          {isAdmin && (
            <Link to="/admin/anomalies" className="text-brand-600 dark:text-brand-400 font-medium hover:underline">
              Xem và xử lý →
            </Link>
          )}
        </p>
      )}
      <ul className="text-sm text-slate-600 dark:text-slate-300 mb-3 space-y-1">
        {attention.overdueTransferCount > 0 && <li>{attention.overdueTransferCount} lần bàn giao chưa được bên nhận xác nhận quá 2 ngày.</li>}
        {attention.onHoldCount > 0 && (
          <li>
            {attention.onHoldCount} lô đang tạm giữ chờ điều tra.{' '}
            <button type="button" onClick={() => onStatus('ON_HOLD')} className="text-brand-600 dark:text-brand-400 font-medium hover:underline">
              Xem →
            </button>
          </li>
        )}
        {attention.rejectedCount > 0 && (
          <li>
            {attention.rejectedCount} lô không đạt kiểm định chờ chế biến lại / hạ loại / huỷ.{' '}
            <button type="button" onClick={() => onStatus('REJECTED')} className="text-brand-600 dark:text-brand-400 font-medium hover:underline">
              Xem →
            </button>
          </li>
        )}
      </ul>
      {attention.stalledCount > 0 && (
        <>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
            {attention.stalledCount} lô không có tiến triển từ 3 ngày trở lên
            {attention.stalledCount > attention.stalledBatches.length ? ` (hiển thị ${attention.stalledBatches.length} lô chờ lâu nhất)` : ''}:
          </p>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {attention.stalledBatches.map((b) => {
              const next = nextStepLabel(b, catalog)
              return (
                <li key={b.id}>
                  <Link to={`/batch/${b.id}`} className="flex items-center justify-between gap-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50 -mx-2 px-2 rounded-lg">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{b.productName}</span>
                      <span className="block text-xs text-slate-400">{next ? `Chờ ${next.toLowerCase()}` : ''}</span>
                    </span>
                    <span className="text-xs text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1 flex-shrink-0">
                      <Clock3 className="w-3 h-3" /> {relativeDays(b.lastEventAt ?? b.createdAt)}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}

export default function Dashboard() {
  const { actor } = useAuth()
  const { catalog } = useCatalog()
  const [view, setView] = useState<'list' | 'kanban'>('list')
  const [batches, setBatches] = useState<Batch[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [stage, setStage] = useState<StageFilter>('')
  const [status, setStatus] = useState<LotStatus | ''>('')
  const [overview, setOverview] = useState<StatsOverview | null>(null)
  const [attention, setAttention] = useState<AttentionSummary | null>(null)
  const [pending, setPending] = useState<Batch[] | null>(null)

  const isAdmin = actor?.role === 'ADMIN'
  const canCreate = actor?.role === 'FARMER' || isAdmin
  const showAttention = isAdmin || actor?.role === 'INSPECTOR'

  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, 300)
    return () => clearTimeout(handle)
  }, [searchInput])

  useEffect(() => {
    if (view !== 'list') return
    setLoading(true)
    setError('')
    batchApi
      .list({ page, pageSize: PAGE_SIZE, search: search || undefined, stage: stage || undefined, status: status || undefined })
      .then((res) => {
        setBatches(res.items)
        setTotal(res.total)
      })
      .catch(() => setError('Không thể tải danh sách lô hàng'))
      .finally(() => setLoading(false))
  }, [page, search, stage, status, view])

  useEffect(() => {
    statsApi.overview().then(setOverview).catch(() => {})
    statsApi.attention().then(setAttention).catch(() => {})
    if (!isAdmin) batchApi.pending().then(setPending).catch(() => setPending([]))
  }, [isAdmin])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasAside =
    (!isAdmin && !!pending && pending.length > 0) ||
    (showAttention && !!attention && needsAttention(attention))
  const firstName = actor?.name?.split(' ').pop() ?? ''

  return (
    <div className="page-shell">
      <main className="page-container space-y-5">
        <PageHeader
          title={`Chào ${firstName}`}
          subtitle={actor ? `${actor.organization}` : undefined}
          action={
            canCreate ? (
              <Link to="/batches/new" className={buttonClass('primary', 'md')}>
                <Plus className="w-4 h-4" /> Lô hàng mới
              </Link>
            ) : (
              <Link to="/tasks" className={buttonClass('primary', 'md')}>
                <ListChecks className="w-4 h-4" /> Việc cần làm{pending && pending.length > 0 ? ` (${pending.length})` : ''}
              </Link>
            )
          }
        />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard icon={<Activity className="w-5 h-5" />} tone="success" label="Đang lưu thông" value={overview?.activeBatches ?? '–'} />
          <StatCard
            icon={<Clock3 className="w-5 h-5" />}
            tone={attention && attention.stalledCount > 0 ? 'warning' : 'neutral'}
            label="Chờ quá 3 ngày"
            value={attention?.stalledCount ?? '–'}
          />
          <StatCard
            icon={<ShieldAlert className="w-5 h-5" />}
            tone={overview && overview.openAnomalyCount > 0 ? 'warning' : 'neutral'}
            label="Cảnh báo chưa xử lý"
            value={overview?.openAnomalyCount ?? '–'}
          />
          <StatCard icon={<Siren className="w-5 h-5" />} tone="danger" label="Đã thu hồi" value={overview?.recalledBatches ?? '–'} />
        </div>

        {/* Wide screens: the lot list gets the room, today's work sits beside it. */}
        <div className={`grid grid-cols-1 gap-5 items-start ${hasAside ? 'xl:grid-cols-3' : ''}`}>
          <section className={`space-y-3 min-w-0 ${hasAside ? 'xl:col-span-2' : ''}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100 mr-auto">Tất cả lô hàng</h2>
            <div role="tablist" className="flex rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
              {(['list', 'kanban'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={`text-sm px-3.5 py-2 transition-colors ${view === v ? 'bg-brand-600 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'}`}
                >
                  {v === 'list' ? 'Danh sách' : 'Theo khâu'}
                </button>
              ))}
            </div>
          </div>

          {view === 'kanban' ? (
            <KanbanBoard
              onShowAll={(s) => {
                setStage(s)
                setPage(1)
                setView('list')
              }}
            />
          ) : (
            <>
              <div className="flex gap-2 flex-wrap sm:flex-nowrap">
                <input
                  type="search"
                  aria-label="Tìm lô hàng"
                  placeholder="Tìm theo tên sản phẩm, xuất xứ, mã lô..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className={`flex-1 min-w-0 ${inputClass}`}
                />
                <select
                  aria-label="Lọc theo khâu"
                  value={stage}
                  onChange={(e) => {
                    setStage(e.target.value as StageFilter)
                    setPage(1)
                  }}
                  className={`${inputClass} sm:w-48`}
                >
                  <option value="">Mọi khâu</option>
                  {stageColumns(catalog).map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.key === 'NONE' ? c.label : `Khâu gần nhất: ${c.label}`}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Lọc theo trạng thái"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value as LotStatus | '')
                    setPage(1)
                  }}
                  className={`${inputClass} sm:w-44`}
                >
                  <option value="">Mọi trạng thái</option>
                  {(Object.keys(STATUS_LABELS) as LotStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>

              {loading && <SkeletonCardList rows={5} />}
              {error && <p className="text-center text-rose-500 dark:text-rose-400 py-16 text-sm">{error}</p>}

              {!loading && !error && batches.length === 0 && (
                <div className={cardClass()}>
                  <EmptyState
                    icon={<Package className="w-6 h-6" />}
                    title={search || stage || status ? 'Không có lô hàng phù hợp' : 'Chưa có lô hàng nào'}
                    description={search || stage || status ? 'Thử bỏ bớt bộ lọc.' : canCreate ? 'Tạo lô đầu tiên khi bạn thu hoạch.' : 'Lô hàng sẽ xuất hiện khi đối tác bắt đầu ghi nhận.'}
                    action={
                      !search && !stage && !status && canCreate ? (
                        <Link to="/batches/new" className={buttonClass('primary', 'sm')}>
                          <Plus className="w-4 h-4" /> Lô hàng mới
                        </Link>
                      ) : undefined
                    }
                  />
                </div>
              )}

              {!loading && (
                <div className="space-y-2">
                  {batches.map((b) => (
                    <BatchRow key={b.id} batch={b} />
                  ))}
                </div>
              )}

              {!loading && !error && total > PAGE_SIZE && (
                <nav className="flex items-center justify-center gap-3" aria-label="Phân trang">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className={buttonClass('secondary', 'sm')}
                  >
                    ← Trước
                  </button>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Trang {page} / {totalPages} · {total} lô
                  </span>
                  <button
                    type="button"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className={buttonClass('secondary', 'sm')}
                  >
                    Sau →
                  </button>
                </nav>
              )}
            </>
          )}
          </section>

          {hasAside && (
          <aside className="space-y-5 min-w-0 xl:sticky xl:top-20">
            {/* My work first — this is what most people open the app for. */}
            {!isAdmin && pending && pending.length > 0 && (
              <section className={cardClass()}>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Đang chờ bạn xử lý ({pending.length})</h2>
                  <Link to="/tasks" className="text-xs text-brand-600 dark:text-brand-400 font-medium hover:underline">
                    Xem tất cả →
                  </Link>
                </div>
                <div className="space-y-2">
                  {pending.slice(0, 3).map((b) => (
                    <BatchRow key={b.id} batch={b} to={b.status === 'ACTIVE' ? `/record?batchId=${b.id}` : `/batch/${b.id}`} action={nextStepLabel(b, catalog) ?? undefined} />
                  ))}
                </div>
              </section>
            )}
            {showAttention && attention && (
              <AttentionCard
                attention={attention}
                isAdmin={isAdmin}
                onStatus={(s) => {
                  setStatus(s)
                  setStage('')
                  setPage(1)
                  setView('list')
                }}
              />
            )}
          </aside>
          )}
        </div>
      </main>
    </div>
  )
}
