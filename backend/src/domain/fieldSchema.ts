import { FieldIssue } from '../errors';

/**
 * Field definitions per product group × stage (migration 017). The same
 * definition drives the form in the browser and the check on the server, so
 * a direct API call can't store what the form wouldn't accept.
 */
export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'boolean';
  required?: boolean;
  /** Required only when another field has one of these values (e.g. conditions when result = PASS_WITH_CONDITIONS). */
  requiredWhen?: { key: string; in: string[] };
  /** Shown on the consumer page and disclosed to public verifiers. */
  public?: boolean;
  unit?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  placeholder?: string;
  options?: FieldOption[];
}

export interface FieldSchema {
  id: number;
  /** null = the generic schema for the stage. */
  categoryCode: string | null;
  stage: string;
  version: number;
  fields: FieldDef[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_LENGTH = 500;

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function isRequired(def: FieldDef, data: Record<string, unknown>): boolean {
  if (def.required) return true;
  if (def.requiredWhen) return def.requiredWhen.in.includes(String(data[def.requiredWhen.key] ?? ''));
  return false;
}

function checkValue(def: FieldDef, value: unknown): FieldIssue | null {
  const issue = (code: FieldIssue['code'], message: string): FieldIssue => ({ field: def.key, code, message });
  switch (def.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return issue('not_a_number', `${def.key} must be a number`);
      if (def.min !== undefined && value < def.min) return issue('below_min', `${def.key} must be at least ${def.min}`);
      if (def.max !== undefined && value > def.max) return issue('above_max', `${def.key} must be at most ${def.max}`);
      return null;
    }
    case 'date': {
      if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        return issue('not_a_date', `${def.key} must be a date (YYYY-MM-DD)`);
      }
      return null;
    }
    case 'select': {
      if (typeof value !== 'string' || !(def.options ?? []).some((o) => o.value === value)) {
        return issue('invalid_option', `${def.key} must be one of ${(def.options ?? []).map((o) => o.value).join(', ')}`);
      }
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : issue('not_a_boolean', `${def.key} must be true or false`);
    default: {
      if (typeof value !== 'string') return issue('not_text', `${def.key} must be text`);
      const max = def.maxLength ?? DEFAULT_MAX_LENGTH;
      if (value.length > max) return issue('too_long', `${def.key} must be at most ${max} characters`);
      return null;
    }
  }
}

/**
 * Problems with `data` under `schema`; empty when it is acceptable.
 * `systemKeys` are keys the service itself adds (e.g. lateReason) — allowed
 * although the form doesn't show them.
 */
export function validateEventData(schema: FieldSchema | null, data: Record<string, unknown>, systemKeys: string[] = []): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const defs = schema?.fields ?? [];
  const known = new Map(defs.map((d) => [d.key, d]));
  for (const key of Object.keys(data)) {
    if (known.has(key) || systemKeys.includes(key)) continue;
    issues.push({ field: key, code: 'unknown_field', message: `${key} is not a field of this stage` });
  }
  for (const def of defs) {
    const value = data[def.key];
    if (isEmpty(value)) {
      if (isRequired(def, data)) issues.push({ field: def.key, code: 'required', message: `${def.key} is required` });
      continue;
    }
    const problem = checkValue(def, value);
    if (problem) issues.push(problem);
  }
  return issues;
}

/** Data keys the schema marks public. */
export function publicKeys(schema: FieldSchema | null): string[] {
  return (schema?.fields ?? []).filter((f) => f.public).map((f) => f.key);
}
