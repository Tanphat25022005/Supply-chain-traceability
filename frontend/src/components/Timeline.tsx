import { ArrowRightLeft, Ban, Clock, MapPin, PauseCircle, PlayCircle, Trash2, UserRound } from 'lucide-react'
import { Actor, CUSTODY_EVENT_LABELS, CustodyEventKind, isStageEvent, stageIcon, TRANSFORMATION_LABELS, TransformationKind, TraceEvent } from '../api/client'
import { Catalog, describeEventData, formatDateTime } from '../domain/catalog'
import { cardClass } from './ui/Card'
import EmptyState from './ui/EmptyState'

interface Props {
  events: TraceEvent[]
  /** Directory used to show who recorded each step; unknown ids fall back to "Không rõ". */
  actorsById?: Map<string, Actor>
  /** Labels and field definitions; without it, codes are shown as recorded. */
  catalog?: Catalog
  /** The lot's product group — picks the right field labels for older events. */
  categoryCode?: string
}

export function formatTs(iso: string): string {
  return formatDateTime(iso)
}

const CUSTODY_ICONS: Record<CustodyEventKind, typeof Clock> = {
  TRANSFER_OUT: ArrowRightLeft,
  TRANSFER_ACCEPT: ArrowRightLeft,
  TRANSFER_REJECT: Ban,
  TRANSFER_CANCEL: Ban,
  HOLD: PauseCircle,
  RELEASE: PlayCircle,
  RECALL: Ban,
  DISPOSE: Trash2,
}

/** More than a few minutes between happening and recording is worth showing. */
const LATE_MS = 10 * 60 * 1000

/**
 * The lot's story for the people working on it: what happened, when it
 * happened (and when it was recorded, if later), who did it, where, the facts
 * recorded — and every hand-over, hold and recall, which are on the ledger too.
 * The hash linkage is one click away ("Chi tiết kỹ thuật").
 */
export default function Timeline({ events, actorsById, catalog, categoryCode }: Props) {
  if (events.length === 0) {
    return (
      <div className={cardClass()}>
        <EmptyState icon={<Clock className="w-6 h-6" />} title="Chưa có sự kiện nào được ghi nhận" />
      </div>
    )
  }

  const stageCount = events.filter((e) => isStageEvent(e.kind)).length
  const label = (code: string) => catalog?.stageLabel(code) ?? code

  return (
    <div className={cardClass()}>
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-5">
        Hành trình lô hàng{' '}
        <span className="text-slate-400 dark:text-slate-500 font-normal">
          ({stageCount} khâu{events.length > stageCount ? `, ${events.length - stageCount} lần bàn giao / thay đổi trạng thái` : ''})
        </span>
      </h3>

      <ol className="relative">
        <div className="absolute left-[15px] top-4 bottom-4 w-px bg-gradient-to-b from-brand-200 dark:from-brand-500/30 via-slate-200 dark:via-slate-700 to-transparent" />

        <div className="space-y-5">
          {events.map((event) => {
            const who = actorsById?.get(event.actorId)
            const stageEvent = isStageEvent(event.kind)
            const late = new Date(event.timestamp).getTime() - new Date(event.occurredAt ?? event.timestamp).getTime() > LATE_MS

            if (!stageEvent) {
              const kind = event.kind as CustodyEventKind
              const Icon = CUSTODY_ICONS[kind] ?? ArrowRightLeft
              const toActor = typeof event.data?.toActorId === 'string' ? actorsById?.get(event.data.toActorId) : undefined
              const danger = kind === 'RECALL' || kind === 'DISPOSE' || kind === 'TRANSFER_REJECT'
              const facts = describeEventData([], event.data ?? {}, { hide: ['toActorId', 'transferId', 'sourceLotId', 'unit'] })
              return (
                <li key={event.id} className="relative pl-10 list-none">
                  <div
                    className={`absolute left-1 w-6 h-6 rounded-full flex items-center justify-center border ${
                      danger
                        ? 'bg-rose-50 border-rose-200 text-rose-600 dark:bg-rose-500/10 dark:border-rose-500/30 dark:text-rose-400'
                        : 'bg-white border-slate-200 text-slate-500 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-400'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
                    <p className="text-slate-700 dark:text-slate-200">
                      <span className="font-semibold">{CUSTODY_EVENT_LABELS[kind] ?? kind}</span>
                      {toActor && <span> → {toActor.organization} · {toActor.name}</span>}
                      {who && <span className="text-slate-400 dark:text-slate-500"> · bởi {who.organization}</span>}
                    </p>
                    <time dateTime={event.occurredAt} className="text-slate-400 dark:text-slate-500 whitespace-nowrap">
                      {formatTs(event.occurredAt ?? event.timestamp)}
                    </time>
                  </div>
                  {facts.length > 0 && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{facts.map((f) => `${f.label}: ${f.value}`).join(' · ')}</p>
                  )}
                </li>
              )
            }

            const StageIcon = stageIcon(event.stage)
            const fields = catalog?.fieldsForEvent(event, categoryCode) ?? []
            const facts = describeEventData(fields, event.data ?? {})
            return (
              <li key={event.id} className="relative pl-10 animate-fade-in list-none">
                <div className="absolute left-0 w-8 h-8 rounded-full bg-gradient-to-br from-brand-50 to-brand-100 dark:from-brand-500/10 dark:to-brand-500/20 border-2 border-brand-200 dark:border-brand-500/30 flex items-center justify-center text-brand-600 dark:text-brand-400 select-none shadow-sm">
                  <StageIcon className="w-4 h-4" />
                </div>

                <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-3.5 border border-slate-100 dark:border-slate-700">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold text-sm text-slate-900 dark:text-slate-50">
                      {label(event.stage)}
                      {event.kind !== 'OBSERVE' && (
                        <span className="ml-1.5 text-xs font-medium text-brand-600 dark:text-brand-400">
                          · {TRANSFORMATION_LABELS[event.kind as TransformationKind]}
                        </span>
                      )}
                    </p>
                    <div className="text-right flex-shrink-0">
                      <time dateTime={event.occurredAt} className="block text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {formatTs(event.occurredAt ?? event.timestamp)}
                      </time>
                      {late && (
                        <span className="block text-[11px] text-amber-600 dark:text-amber-400 whitespace-nowrap" title="Thời điểm hệ thống ghi nhận">
                          ghi lúc {formatTs(event.timestamp)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-1.5 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                    <p className="flex items-center gap-1.5">
                      <UserRound className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      {who ? (
                        <span>
                          <span className="font-medium">{who.organization}</span>
                          <span className="text-slate-400 dark:text-slate-500"> · {who.name}</span>
                        </span>
                      ) : (
                        <span className="text-slate-400">Không rõ người thực hiện</span>
                      )}
                    </p>
                    <p className="flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" /> {event.location}
                    </p>
                  </div>

                  {facts.length > 0 && (
                    <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                      {facts.map((f) => (
                        <div key={f.key} className="min-w-0">
                          <dt className="text-slate-400 dark:text-slate-500">{f.label}</dt>
                          <dd className="text-slate-800 dark:text-slate-100 font-medium truncate" title={f.value}>
                            {f.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}

                  {event.notes && <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 italic">"{event.notes}"</p>}

                  <details className="mt-2.5 group">
                    <summary className="text-[11px] text-slate-400 dark:text-slate-500 cursor-pointer select-none hover:text-slate-600 dark:hover:text-slate-300 list-none">
                      <span className="group-open:hidden">▸</span>
                      <span className="hidden group-open:inline">▾</span> Chi tiết kỹ thuật
                    </summary>
                    <div className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500 font-mono break-all space-y-0.5">
                      <p>seq {event.sequenceNumber} · v{event.hashVersion}</p>
                      <p>prev: {event.prevHash}</p>
                      <p className="text-brand-500 dark:text-brand-400">hash: {event.hash}</p>
                    </div>
                  </details>
                </div>
              </li>
            )
          })}
        </div>
      </ol>
    </div>
  )
}
