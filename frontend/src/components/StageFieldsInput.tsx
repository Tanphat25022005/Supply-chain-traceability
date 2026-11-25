import { Globe } from 'lucide-react'
import { FieldDef } from '../api/client'
import { isFieldRequired } from '../domain/catalog'
import { inputClass, labelClass } from './ui/field'

export type StageValues = Record<string, string>

export { toEventData } from '../domain/catalog'

function FieldInput({
  field,
  id,
  value,
  required,
  onChange,
}: {
  field: FieldDef
  id: string
  value: string
  required: boolean
  onChange: (v: string) => void
}) {
  if (field.type === 'select' || field.type === 'boolean') {
    const options = field.type === 'boolean' ? [{ value: 'true', label: 'Có' }, { value: 'false', label: 'Không' }] : field.options ?? []
    return (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} required={required} className={inputClass}>
        <option value="">— Chọn —</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  const input = (
    <input
      id={id}
      type={field.type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      required={required}
      placeholder={field.placeholder}
      min={field.min}
      max={field.max}
      maxLength={field.maxLength}
      step={field.type === 'number' ? 'any' : undefined}
      inputMode={field.type === 'number' ? 'decimal' : undefined}
      className={`${inputClass} ${field.unit ? 'pr-14' : ''}`}
    />
  )
  if (!field.unit) return input
  return (
    <div className="relative">
      {input}
      <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-sm text-slate-400 pointer-events-none">{field.unit}</span>
    </div>
  )
}

/**
 * The facts a stage records, drawn from the field schema of the lot's product
 * group × stage (server-side the same schema validates the payload).
 */
export default function StageFieldsInput({
  fields,
  values,
  onChange,
}: {
  fields: FieldDef[]
  values: StageValues
  onChange: (next: StageValues) => void
}) {
  if (fields.length === 0) return <p className="text-sm text-slate-400">Khâu này không có trường thông tin riêng.</p>
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-4">
      {fields.map((field) => {
        const id = `stage-field-${field.key}`
        const required = isFieldRequired(field, values)
        // A conditionally required field appears only when its condition can apply.
        if (field.requiredWhen && !required && !values[field.key]) return null
        return (
          <div key={field.key} className={field.type === 'text' && !field.unit ? 'sm:col-span-2' : ''}>
            <label htmlFor={id} className={`${labelClass} flex items-center gap-1.5`}>
              {field.label}
              {required && <span className="text-rose-500">*</span>}
              {field.public && (
                <span title="Hiển thị trên trang tra cứu công khai" className="text-slate-400 dark:text-slate-500">
                  <Globe className="w-3.5 h-3.5" aria-label="Công khai" />
                </span>
              )}
            </label>
            <FieldInput
              field={field}
              id={id}
              value={values[field.key] ?? ''}
              required={required}
              onChange={(v) => onChange({ ...values, [field.key]: v })}
            />
          </div>
        )
      })}
    </div>
  )
}
