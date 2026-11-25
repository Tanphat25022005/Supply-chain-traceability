import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Clock3, Combine, Inbox, PartyPopper, Plus, Send, TriangleAlert } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useCatalog } from '../context/CatalogContext'
import { actorsApi, Actor, batchApi, Batch, IncomingTransfer, stageIcon, Transfer, transferApi } from '../api/client'
import { canActOn, daysSince, formatDateTime, nextStepLabel, relativeDays } from '../domain/catalog'
import TransferResponse from '../components/TransferResponse'
import PageHeader from '../components/ui/PageHeader'
import EmptyState from '../components/ui/EmptyState'
import { buttonClass } from '../components/ui/Button'
import { cardClass } from '../components/ui/Card'
import { SkeletonCardList } from '../components/ui/Skeleton'

/**
 * The work inbox: hand-overs waiting for this person to confirm, then every
 * lot waiting on them (oldest first) one click from exactly the step it
 * needs — including lots that failed inspection and must be reworked,
 * downgraded or disposed of — and the hand-overs they sent that the other
 * side hasn't answered yet.
 */
export default function TaskQueue() {
  const { actor } = useAuth()
  const { catalog } = useCatalog()
  const [batches, setBatches] = useState<Batch[] | null>(null)
  const [incoming, setIncoming] = useState<IncomingTransfer[]>([])
  const [outgoing, setOutgoing] = useState<Transfer[]>([])
  const [actors, setActors] = useState<Actor[]>([])

  const load = useCallback(() => {
    batchApi.pending().then(setBatches).catch(() => setBatches([]))
    transferApi.incoming().then(setIncoming).catch(() => setIncoming([]))
    transferApi.outgoing().then(setOutgoing).catch(() => setOutgoing([]))
  }, [])

  useEffect(() => {
    load()
    actorsApi.list().then(setActors).catch(() => {})
  }, [load])

  const sorted = useMemo(
    () =>
      [...(batches ?? [])].sort(
        (a, b) => new Date(a.lastEventAt ?? a.createdAt).getTime() - new Date(b.lastEventAt ?? b.createdAt).getTime(),
      ),
    [batches],
  )
  const actorsById = useMemo(() => new Map(actors.map((a) => [a.id, a])), [actors])
  const canCreate = actor?.role === 'FARMER' || actor?.role === 'ADMIN'
  const canTransform = ['COLLECTOR', 'PROCESSOR', 'WAREHOUSE', 'EXPORTER', 'DISTRIBUTOR', 'ADMIN'].includes(actor?.role ?? '')
  const nothing = batches?.length === 0 && incoming.length === 0

  return (
    <div className="page-shell">
      <main className="page-container space-y-5">
        <PageHeader
          title="Việc cần làm"
          subtitle={actor?.role === 'ADMIN' ? 'Mọi lô hàng đang chờ trong không gian làm việc.' : 'Hàng được bàn giao cho bạn và các lô bạn đang giữ.'}
          action={
            (canCreate || canTransform) && (
              <div className="flex gap-2 flex-wrap">
                {canTransform && (
                  <Link to="/lots/transform" className={buttonClass('secondary', 'md')}>
                    <Combine className="w-4 h-4" /> Gộp / tách / chế biến
                  </Link>
                )}
                {canCreate && (
                  <Link to="/batches/new" className={buttonClass('primary', 'md')}>
                    <Plus className="w-4 h-4" /> Lô hàng mới
                  </Link>
                )}
              </div>
            )
          }
        />

        {incoming.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              <Inbox className="w-4 h-4 text-sky-500" /> Chờ bạn xác nhận nhận hàng ({incoming.length})
            </h2>
            <ul className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {incoming.map((t) => (
                <li key={t.id} className={cardClass({ padding: 'md', className: 'space-y-2 border-sky-200 dark:border-sky-500/30' })}>
                  <div className="flex items-start justify-between gap-2">
                    <Link to={`/batch/${t.batchId}`} className="font-semibold text-slate-900 dark:text-slate-50 hover:underline truncate">
                      {t.productName}
                    </Link>
                    {(daysSince(t.createdAt) ?? 0) >= 2 && <span className="text-xs text-amber-600 font-medium whitespace-nowrap">Chờ {relativeDays(t.createdAt)}</span>}
                  </div>
                  <TransferResponse transfer={t} onDone={load} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {batches === null && <SkeletonCardList rows={3} />}
        {nothing && (
          <div className={cardClass()}>
            <EmptyState
              icon={<PartyPopper className="w-6 h-6" />}
              title="Không có việc nào đang chờ bạn"
              description={canCreate ? 'Bắt đầu một lô mới khi bạn thu hoạch.' : 'Lô hàng sẽ xuất hiện ở đây khi khâu trước bàn giao cho bạn.'}
            />
          </div>
        )}

        {sorted.length > 0 && (
          <section className="space-y-2">
            {incoming.length > 0 && <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Lô bạn đang giữ ({sorted.length})</h2>}
            <ul className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
              {sorted.map((b, i) => {
                const rejected = b.status === 'REJECTED'
                const next = nextStepLabel(b, catalog)
                const rules = catalog?.rules(b.workflowId)
                const nextStage = rules?.nextCandidates(rules.position(b.currentStage), b)[0]?.stage
                const Icon = rejected ? TriangleAlert : stageIcon(nextStage)
                // I hold it, but what comes next is someone else's: it waits on my hand-over.
                const actionable = actor ? canActOn(actor, b, catalog) : false
                const since = b.lastEventAt ?? b.createdAt
                const overdue = (daysSince(since) ?? 0) >= 3
                const creator = actorsById.get(b.createdBy)
                return (
                  <li key={b.id} className="animate-slide-up" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                    <Link
                      to={actionable ? `/record?batchId=${b.id}` : `/batch/${b.id}`}
                      className={cardClass({ hover: true, padding: 'md', className: `flex items-center gap-3 ${rejected ? 'border-rose-200 dark:border-rose-500/30' : ''}` })}
                    >
                      <span
                        className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                          rejected ? 'bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400' : 'bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400'
                        }`}
                      >
                        <Icon className="w-5 h-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-slate-900 dark:text-slate-50 truncate">{b.productName}</p>
                        <p className="text-sm text-slate-500 dark:text-slate-400 truncate">
                          {b.quantity.toLocaleString('vi-VN')} {b.unit} · {b.origin}
                          {creator && ` · ${creator.organization}`}
                        </p>
                        <p className={`text-xs mt-0.5 flex items-center gap-1 ${overdue ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-slate-400 dark:text-slate-500'}`}>
                          <Clock3 className="w-3 h-3" /> Chờ từ {relativeDays(since)}
                        </p>
                      </div>
                      <span className={buttonClass(rejected ? 'danger' : 'secondary', 'sm', 'flex-shrink-0')}>
                        {rejected ? 'Xử lý lô không đạt' : actionable ? next : 'Cần bàn giao'}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {outgoing.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              <Send className="w-4 h-4 text-slate-400" /> Bạn đã bàn giao, đang chờ bên nhận xác nhận ({outgoing.length})
            </h2>
            <ul className="space-y-1.5">
              {outgoing.map((t) => {
                const to = actorsById.get(t.toActorId)
                return (
                  <li key={t.id} className="text-sm text-slate-600 dark:text-slate-300">
                    <Link to={`/batch/${t.batchId}`} className="hover:underline">
                      {t.quantity.toLocaleString('vi-VN')} {t.unit} → {to ? `${to.organization} · ${to.name}` : 'người nhận'}
                    </Link>{' '}
                    <span className="text-xs text-slate-400">· {formatDateTime(t.createdAt)}</span>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </main>
    </div>
  )
}
