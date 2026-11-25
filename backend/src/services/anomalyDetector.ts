import { v4 as uuidv4 } from 'uuid';
import { Anomaly, isStageEvent, TraceEvent } from '../domain/types';
import { genericRetailRules, WorkflowRules } from '../domain/workflow';

/** A detected anomaly before it's attached to a tenant — this module is a pure scan over events with no tenant context of its own; the caller stamps `tenantId` (from the batch) at persistence time. */
export type DetectedAnomaly = Omit<Anomaly, 'tenantId'>;

/**
 * Anomalies are derived from a batch's event history, against the order of
 * the workflow the lot follows. Only stage events count — hand-overs, holds
 * and recalls are custody records, not steps. Callers may run this over the
 * full history (read paths) or incrementally against just the latest event
 * (write path, to decide what to persist) since the function is a pure,
 * deterministic scan.
 *
 * Skipping a required step is refused before it is ever written; what is
 * reported here is skipping an optional one — HIGH when it is an inspection
 * (a lot that never saw QC is a red flag even where QC is optional), LOW
 * otherwise (e.g. a farmer selling straight to the mill without a collector).
 */
export function detectAnomalies(events: TraceEvent[], rules: WorkflowRules = genericRetailRules()): DetectedAnomaly[] {
  const anomalies: DetectedAnomaly[] = [];
  const seenStages = new Set<string>();
  let highest = 0;
  let first = true;

  for (const event of events) {
    if (!isStageEvent(event.kind)) continue;
    const position = rules.position(event.stage);
    if (position === undefined) continue;
    const label = rules.label(event.stage);
    // A lot born from a merge/split/transform inherits its inputs' history:
    // starting at, say, PROCESSING is not a skipped HARVEST.
    if (first && event.kind !== undefined && event.kind !== 'OBSERVE') highest = position - 1;
    first = false;

    if (seenStages.has(event.stage)) {
      anomalies.push({
        id: uuidv4(),
        type: 'DUPLICATE_STAGE',
        severity: 'MEDIUM',
        message: `Khâu "${label}" đã được ghi nhận nhiều lần cho lô hàng này`,
        batchId: event.batchId,
        eventId: event.id,
        detectedAt: event.timestamp,
        resolved: false,
      });
    }
    seenStages.add(event.stage);

    if (position < highest) {
      anomalies.push({
        id: uuidv4(),
        type: 'OUT_OF_ORDER',
        severity: 'HIGH',
        message: `Khâu "${label}" được ghi sau khâu có thứ tự cao hơn — sai thứ tự chuỗi cung ứng`,
        batchId: event.batchId,
        eventId: event.id,
        detectedAt: event.timestamp,
        resolved: false,
      });
    } else if (position > highest + 1) {
      const skipped = rules.between(highest, position);
      const inspection = skipped.some((s) => rules.kind(s.stage) === 'INSPECTION');
      anomalies.push({
        id: uuidv4(),
        type: 'STAGE_SKIPPED',
        severity: inspection ? 'HIGH' : 'LOW',
        message: `Bỏ qua khâu ${skipped.map((s) => rules.label(s.stage)).join(', ')} trước khi ghi "${label}"`,
        batchId: event.batchId,
        eventId: event.id,
        detectedAt: event.timestamp,
        resolved: false,
      });
    }

    if (position > highest) highest = position;
  }

  return anomalies;
}

/** Anomalies introduced specifically by the newest event (last in `events`), for persistence at write time. */
export function detectNewAnomalies(events: TraceEvent[], rules?: WorkflowRules): DetectedAnomaly[] {
  if (events.length === 0) return [];
  const newEvent = events[events.length - 1];
  return detectAnomalies(events, rules).filter((a) => a.eventId === newEvent.id);
}
