import { ConflictError, ValidationError } from '../errors';

/** Clocks disagree a little; a "now" from the browser may be slightly ahead of the server. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OccurredAtCheck {
  occurredAt: Date;
  /** Recorded more than the product's max_backdate_days after it happened. */
  late: boolean;
  /** Whole days between happening and recording. */
  daysLate: number;
}

/**
 * Validates a declared "when it happened" (docs/SPEC_PHASE1_5.md §0.5):
 *   • not in the future (a few minutes ahead is clock skew and becomes "now");
 *   • not before what the lot already went through (`notBefore`);
 *   • further back than `maxBackdateDays` only with a reason (flagged LATE_ENTRY).
 */
export function checkOccurredAt(
  declared: Date | undefined,
  now: Date,
  notBefore: Date | undefined,
  maxBackdateDays: number,
  lateReason: string | undefined,
): OccurredAtCheck {
  let occurredAt = declared ?? now;
  if (occurredAt.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    throw new ConflictError('occurredAt is in the future');
  }
  if (occurredAt > now) occurredAt = now;
  if (notBefore && occurredAt < notBefore) {
    if (!declared) occurredAt = notBefore; // "now" a hair behind a skewed previous event
    else throw new ConflictError('occurredAt is earlier than what this lot already went through');
  }
  const daysLate = Math.floor((now.getTime() - occurredAt.getTime()) / DAY_MS);
  const late = now.getTime() - occurredAt.getTime() > maxBackdateDays * DAY_MS;
  if (late && !lateReason?.trim()) {
    throw new ValidationError(`Recorded ${daysLate} days after it happened — a lateReason is required (limit ${maxBackdateDays} days)`, [
      { field: 'lateReason', code: 'required', message: 'lateReason is required for a late entry' },
    ]);
  }
  return { occurredAt, late, daysLate };
}
