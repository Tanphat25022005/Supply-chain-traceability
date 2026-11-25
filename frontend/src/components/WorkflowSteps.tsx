import { Workflow } from '../api/client'
import { useCatalog } from '../context/CatalogContext'

/**
 * A workflow's steps as chips, required ones marked — with the lot's current
 * position highlighted when given. Lets people see the rules before they hit them.
 */
export default function WorkflowSteps({
  workflow,
  currentStage,
  className = '',
}: {
  workflow: Workflow
  currentStage?: string | null
  className?: string
}) {
  const { catalog } = useCatalog()
  const rules = catalog?.rules(workflow.id)
  const at = rules?.position(currentStage) ?? 0
  return (
    <ol className={`flex flex-wrap items-center gap-1 text-[11px] ${className}`} aria-label={`Các khâu của quy trình ${workflow.name}`}>
      {workflow.steps.map((s, i) => {
        const done = s.position <= at
        const now = s.position === at
        return (
          <li key={s.stage} className="flex items-center gap-1">
            <span
              className={`px-2 py-0.5 rounded-full border ${
                now
                  ? 'bg-brand-600 text-white border-brand-600'
                  : done
                    ? 'bg-brand-50 text-brand-700 border-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:border-brand-500/30'
                    : 'bg-white text-slate-600 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700'
              } ${s.required ? 'font-semibold' : 'border-dashed'}`}
              title={s.required ? 'Bắt buộc — không bỏ qua được' : 'Không bắt buộc — có thể bỏ qua'}
            >
              {catalog?.stageLabel(s.stage) ?? s.stage}
            </span>
            {i < workflow.steps.length - 1 && <span className="text-slate-300 dark:text-slate-600">→</span>}
          </li>
        )
      })}
      <li className="w-full text-slate-400 dark:text-slate-500 mt-0.5">Viền liền = bắt buộc · viền đứt = có thể bỏ qua</li>
    </ol>
  )
}
