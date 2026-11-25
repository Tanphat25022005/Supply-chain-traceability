import { v4 as uuidv4 } from 'uuid';
import { Actor, Batch, EventKind, EventLink, SupplyChainStage, TraceEvent } from '../domain/types';
import { sealEvent } from '../ledger/hashChain';
import { IEventRepo } from '../repository/interfaces';

export interface AppendSpec {
  stage: SupplyChainStage;
  kind: EventKind;
  actor: Pick<Actor, 'id'>;
  location: string;
  notes?: string;
  data?: Record<string, unknown>;
  /** When it happened; defaults to the recording time. */
  occurredAt?: Date;
  links?: EventLink[];
  fieldSchemaId?: number;
}

/**
 * Appends hash-chained (v4) events to a lot's ledger. The caller holds the
 * lot's row lock; the database trigger re-checks the linkage regardless.
 *
 * `batch` is advanced in place (headHash, eventCount) so that a second append
 * in the same transaction — a stage record followed by its hand-over, a
 * recall closing a pending transfer — chains onto the first.
 */
export class LedgerWriter {
  constructor(private readonly eventRepo: IEventRepo) {}

  async append(batch: Batch, spec: AppendSpec): Promise<TraceEvent> {
    const now = new Date();
    const unhashed = {
      batchId: batch.id,
      stage: spec.stage,
      actorId: spec.actor.id,
      timestamp: now,
      occurredAt: spec.occurredAt ?? now,
      location: spec.location,
      notes: spec.notes,
      data: spec.data ?? {},
      prevHash: batch.headHash,
      sequenceNumber: batch.eventCount,
      kind: spec.kind,
      links: spec.links ?? [],
    };
    const { hash, claimSalts, hashVersion } = sealEvent(unhashed);
    const event: TraceEvent = {
      ...unhashed,
      id: uuidv4(),
      tenantId: batch.tenantId,
      hashVersion,
      claimSalts,
      hash,
      fieldSchemaId: spec.fieldSchemaId,
    };
    await this.eventRepo.create(event);
    batch.headHash = hash;
    batch.eventCount += 1;
    batch.lastEventAt = now;
    return event;
  }
}
