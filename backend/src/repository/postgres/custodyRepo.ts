import { Database, isUuid } from '../../db/database';
import { BatchHold, Transfer, TransferStatus } from '../../domain/types';

type Row = Record<string, unknown>;
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

function toTransfer(r: Row): Transfer {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    batchId: r.batch_id as string,
    fromActorId: r.from_actor_id as string,
    toActorId: r.to_actor_id as string,
    status: r.status as TransferStatus,
    previousStatus: r.previous_status as Transfer['previousStatus'],
    quantity: Number(r.quantity),
    unit: r.unit as string,
    packageCount: opt(r.package_count as number | null),
    vehicle: opt(r.vehicle as string | null),
    documentNo: opt(r.document_no as string | null),
    receivedQuantity: r.received_quantity === null ? undefined : Number(r.received_quantity),
    responseReason: opt(r.response_reason as string | null),
    createdAt: r.created_at as Date,
    respondedAt: opt(r.responded_at as Date | null),
    outEventId: r.out_event_id as string,
    responseEventId: opt(r.response_event_id as string | null),
  };
}

function toHold(r: Row): BatchHold {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    batchId: r.batch_id as string,
    reason: r.reason as string,
    sourceBatchId: opt(r.source_batch_id as string | null),
    previousStatus: r.previous_status as BatchHold['previousStatus'],
    heldBy: r.held_by as string,
    heldAt: r.held_at as Date,
    holdEventId: r.hold_event_id as string,
    releasedAt: opt(r.released_at as Date | null),
    releasedBy: opt(r.released_by as string | null),
    releaseReason: opt(r.release_reason as string | null),
    releaseEventId: opt(r.release_event_id as string | null),
  };
}

/** Transfers awaiting the receiver, with what the task list needs to show them. */
export interface IncomingTransfer extends Transfer {
  productName: string;
  fromName: string;
  fromOrganization: string;
}

/**
 * Hand-overs (transfers) and holds — migration 018. Both tables are written
 * once and answered/closed once; the database refuses any other change.
 */
export class PostgresCustodyRepo {
  constructor(private readonly db: Database) {}

  // ── Transfers ───────────────────────────────────────────────────────────

  async createTransfer(t: Omit<Transfer, 'status' | 'receivedQuantity' | 'responseReason' | 'respondedAt' | 'responseEventId'>): Promise<Transfer> {
    const r = await this.db.query<Row>(
      `INSERT INTO transfers (id, tenant_id, batch_id, from_actor_id, to_actor_id, status, previous_status, quantity, unit,
                              package_count, vehicle, document_no, created_at, out_event_id)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        t.id,
        t.tenantId,
        t.batchId,
        t.fromActorId,
        t.toActorId,
        t.previousStatus,
        t.quantity,
        t.unit,
        t.packageCount ?? null,
        t.vehicle ?? null,
        t.documentNo ?? null,
        t.createdAt,
        t.outEventId,
      ],
    );
    return toTransfer(r.rows[0]);
  }

  async findTransferForUpdate(id: string): Promise<Transfer | null> {
    if (!isUuid(id)) return null;
    const r = await this.db.query<Row>('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [id]);
    return r.rows[0] ? toTransfer(r.rows[0]) : null;
  }

  async pendingTransferFor(batchId: string): Promise<Transfer | null> {
    const r = await this.db.query<Row>("SELECT * FROM transfers WHERE batch_id = $1 AND status = 'PENDING'", [batchId]);
    return r.rows[0] ? toTransfer(r.rows[0]) : null;
  }

  async transfersOf(batchId: string): Promise<Transfer[]> {
    if (!isUuid(batchId)) return [];
    const r = await this.db.query<Row>('SELECT * FROM transfers WHERE batch_id = $1 ORDER BY created_at', [batchId]);
    return r.rows.map(toTransfer);
  }

  async respond(
    id: string,
    status: Exclude<TransferStatus, 'PENDING'>,
    v: { receivedQuantity?: number; reason?: string; respondedAt: Date; responseEventId: string },
  ): Promise<Transfer> {
    const r = await this.db.query<Row>(
      `UPDATE transfers SET status = $2, received_quantity = $3, response_reason = $4, responded_at = $5, response_event_id = $6
        WHERE id = $1 RETURNING *`,
      [id, status, v.receivedQuantity ?? null, v.reason ?? null, v.respondedAt, v.responseEventId],
    );
    return toTransfer(r.rows[0]);
  }

  /** Pending transfers addressed to an actor (or every pending one in the tenant, for ADMIN). */
  async incoming(tenantId: string, actorId: string, all: boolean): Promise<IncomingTransfer[]> {
    const r = await this.db.query<Row>(
      `SELECT t.*, b.product_name, a.name AS from_name, a.organization AS from_organization
         FROM transfers t
         JOIN batches b ON b.id = t.batch_id
         JOIN actors a ON a.id = t.from_actor_id
        WHERE t.tenant_id = $1 AND t.status = 'PENDING' AND ($3 OR t.to_actor_id = $2)
        ORDER BY t.created_at`,
      [tenantId, actorId, all],
    );
    return r.rows.map((x) => ({
      ...toTransfer(x),
      productName: x.product_name as string,
      fromName: x.from_name as string,
      fromOrganization: x.from_organization as string,
    }));
  }

  /** Transfers sent by an actor that the receiver hasn't answered yet. */
  async outgoing(tenantId: string, actorId: string): Promise<Transfer[]> {
    const r = await this.db.query<Row>(
      "SELECT * FROM transfers WHERE tenant_id = $1 AND status = 'PENDING' AND from_actor_id = $2 ORDER BY created_at",
      [tenantId, actorId],
    );
    return r.rows.map(toTransfer);
  }

  // ── Holds ───────────────────────────────────────────────────────────────

  async createHold(h: Omit<BatchHold, 'releasedAt' | 'releasedBy' | 'releaseReason' | 'releaseEventId'>): Promise<BatchHold> {
    const r = await this.db.query<Row>(
      `INSERT INTO batch_holds (id, tenant_id, batch_id, reason, source_batch_id, previous_status, held_by, held_at, hold_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [h.id, h.tenantId, h.batchId, h.reason, h.sourceBatchId ?? null, h.previousStatus, h.heldBy, h.heldAt, h.holdEventId],
    );
    return toHold(r.rows[0]);
  }

  async openHold(batchId: string): Promise<BatchHold | null> {
    const r = await this.db.query<Row>('SELECT * FROM batch_holds WHERE batch_id = $1 AND released_at IS NULL', [batchId]);
    return r.rows[0] ? toHold(r.rows[0]) : null;
  }

  async holdsOf(batchId: string): Promise<BatchHold[]> {
    if (!isUuid(batchId)) return [];
    const r = await this.db.query<Row>('SELECT * FROM batch_holds WHERE batch_id = $1 ORDER BY held_at', [batchId]);
    return r.rows.map(toHold);
  }

  async releaseHold(id: string, v: { releasedBy: string; reason: string; at: Date; eventId: string }): Promise<BatchHold> {
    const r = await this.db.query<Row>(
      `UPDATE batch_holds SET released_at = $2, released_by = $3, release_reason = $4, release_event_id = $5
        WHERE id = $1 RETURNING *`,
      [id, v.at, v.releasedBy, v.reason, v.eventId],
    );
    return toHold(r.rows[0]);
  }
}
