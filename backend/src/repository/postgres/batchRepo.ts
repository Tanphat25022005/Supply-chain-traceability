import { Database, isUuid } from '../../db/database';
import { ActorRole, Batch, BatchListQuery, LotStatus, PaginatedResult, SupplyChainStage } from '../../domain/types';
import { BatchExportFilters, IBatchRepo, NewBatch } from '../interfaces';
import { escapeLike, involvesActor, WithTotal } from './sql';

export interface BatchRow {
  id: string;
  product_name: string;
  product_type: string;
  origin: string;
  quantity: string;
  unit: string;
  created_at: Date;
  created_by: string;
  tenant_id: string;
  current_stage: SupplyChainStage | null;
  status: LotStatus;
  is_recalled: boolean;
  recall_reason: string | null;
  metadata: Record<string, unknown>;
  assigned_to_actor_id: string | null;
  head_hash: string;
  event_count: number;
  last_event_at: Date | null;
  consumed_quantity: string;
  lost_quantity: string;
  plot_id: string | null;
  product_type_id: string | null;
  base_unit: 'kg' | 'cái' | null;
  unit_factor: string | null;
  quantity_base: string | null;
  workflow_id: string;
}

// last_event_at rides on the UNIQUE (batch_id, sequence_number) index: the
// newest event is the one with the highest sequence number.
export const BATCH_COLUMNS = `b.id, b.product_name, b.product_type, b.origin, b.quantity, b.unit, b.created_at, b.created_by,
  b.tenant_id, b.current_stage, b.status, b.is_recalled, b.recall_reason, b.metadata, b.assigned_to_actor_id,
  b.head_hash, b.event_count, b.consumed_quantity, b.lost_quantity, b.plot_id,
  b.product_type_id, b.base_unit, b.unit_factor, b.quantity_base, b.workflow_id,
  (SELECT le.timestamp FROM trace_events le WHERE le.batch_id = b.id
    ORDER BY le.sequence_number DESC LIMIT 1) AS last_event_at`;

export function toBatch(row: BatchRow): Batch {
  return {
    id: row.id,
    productName: row.product_name,
    productType: row.product_type,
    origin: row.origin,
    quantity: Number(row.quantity),
    unit: row.unit,
    createdAt: row.created_at,
    createdBy: row.created_by,
    tenantId: row.tenant_id,
    currentStage: row.current_stage,
    status: row.status,
    isRecalled: row.is_recalled,
    recallReason: row.recall_reason ?? undefined,
    metadata: row.metadata,
    assignedToActorId: row.assigned_to_actor_id ?? undefined,
    headHash: row.head_hash,
    eventCount: row.event_count,
    lastEventAt: row.last_event_at ?? undefined,
    consumedQuantity: Number(row.consumed_quantity),
    lostQuantity: Number(row.lost_quantity),
    plotId: row.plot_id ?? undefined,
    productTypeId: row.product_type_id ?? undefined,
    baseUnit: row.base_unit ?? undefined,
    unitFactor: row.unit_factor === null ? undefined : Number(row.unit_factor),
    quantityBase: row.quantity_base === null ? undefined : Number(row.quantity_base),
    workflowId: row.workflow_id,
  };
}

/** Lots that still hold goods: the database's view of remainingOf() > 0. */
export const HAS_REMAINING = 'b.consumed_quantity + b.lost_quantity < b.quantity';

export class PostgresBatchRepo implements IBatchRepo {
  constructor(private readonly db: Database) {}

  async create(batch: NewBatch): Promise<Batch> {
    // head_hash / event_count are deliberately omitted: they start at their
    // defaults (genesis, 0) and only the ledger trigger may advance them.
    // status starts ACTIVE and is_recalled is derived from it (migration 018).
    const result = await this.db.query<BatchRow>(
      `INSERT INTO batches AS b (id, product_name, product_type, origin, quantity, unit, created_at, created_by,
                                 tenant_id, current_stage, metadata, assigned_to_actor_id, plot_id,
                                 product_type_id, base_unit, unit_factor, workflow_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING ${BATCH_COLUMNS}`,
      [
        batch.id,
        batch.productName,
        batch.productType,
        batch.origin,
        batch.quantity,
        batch.unit,
        batch.createdAt,
        batch.createdBy,
        batch.tenantId,
        batch.currentStage,
        JSON.stringify(batch.metadata ?? {}),
        batch.assignedToActorId ?? null,
        batch.plotId ?? null,
        batch.productTypeId ?? null,
        batch.baseUnit ?? null,
        batch.unitFactor ?? null,
        batch.workflowId,
      ],
    );
    return toBatch(result.rows[0]);
  }

  async findById(id: string): Promise<Batch | null> {
    if (!isUuid(id)) return null;
    const result = await this.db.query<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM batches b WHERE b.id = $1`, [id]);
    return result.rows[0] ? toBatch(result.rows[0]) : null;
  }

  async findByIds(ids: string[]): Promise<Batch[]> {
    const valid = ids.filter(isUuid);
    if (valid.length === 0) return [];
    const result = await this.db.query<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM batches b WHERE b.id = ANY ($1::uuid[])`, [valid]);
    return result.rows.map(toBatch);
  }

  async findByIdForUpdate(id: string): Promise<Batch | null> {
    if (!isUuid(id)) return null;
    const result = await this.db.query<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM batches b WHERE b.id = $1 FOR UPDATE`, [id]);
    return result.rows[0] ? toBatch(result.rows[0]) : null;
  }

  async resolveTenantId(batchId: string): Promise<string | null> {
    if (!isUuid(batchId)) return null;
    const result = await this.db.query<{ tenant_id: string | null }>('SELECT resolve_batch_tenant($1) AS tenant_id', [
      batchId,
    ]);
    return result.rows[0]?.tenant_id ?? null;
  }

  async hasAnyInTenant(tenantId: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM batches WHERE tenant_id = $1) AS exists',
      [tenantId],
    );
    return result.rows[0].exists;
  }

  async findPageByTenant(
    tenantId: string,
    { page, pageSize, search, stage, status }: BatchListQuery,
  ): Promise<PaginatedResult<Batch>> {
    const offset = (page - 1) * pageSize;
    const term = search?.trim() ? search.trim() : null;
    // $4: NULL = any stage, 'NONE' = no event recorded yet, otherwise that exact current stage.
    // $5: NULL = any status.
    const where = `b.tenant_id = $1
      AND ($2::text IS NULL
           OR b.product_name ILIKE '%' || $2 || '%'
           OR b.origin ILIKE '%' || $2 || '%'
           OR b.id::text LIKE $3 || '%')
      AND ($4::text IS NULL
           OR ($4 = 'NONE' AND b.current_stage IS NULL)
           OR b.current_stage = $4)
      AND ($5::text IS NULL OR b.status = $5)`;
    const params = [
      tenantId,
      term ? escapeLike(term) : null,
      term ? escapeLike(term.toLowerCase()) : null,
      stage ?? null,
      status ?? null,
    ];

    // One statement → items and total come from the same snapshot.
    const result = await this.db.query<BatchRow & WithTotal>(
      `SELECT ${BATCH_COLUMNS}, count(*) OVER () AS total_count
         FROM batches b
        WHERE ${where}
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT $6 OFFSET $7`,
      [...params, pageSize, offset],
    );

    let total = result.rows[0] ? Number(result.rows[0].total_count) : 0;
    if (result.rows.length === 0 && offset > 0) {
      // Past the last page: the window count had no row to ride on.
      const count = await this.db.query<{ count: string }>(`SELECT count(*) AS count FROM batches b WHERE ${where}`, params);
      total = Number(count.rows[0].count);
    }
    return { items: result.rows.map(toBatch), total, page, pageSize };
  }

  async findForExport(tenantId: string, { from, to, origin }: BatchExportFilters): Promise<Batch[]> {
    const result = await this.db.query<BatchRow>(
      `SELECT ${BATCH_COLUMNS}
         FROM batches b
        WHERE b.tenant_id = $1
          AND ($2::timestamptz IS NULL OR b.created_at >= $2)
          AND ($3::timestamptz IS NULL OR b.created_at <= $3)
          AND ($4::text IS NULL OR b.origin ILIKE '%' || $4 || '%')
        ORDER BY b.created_at DESC, b.id DESC`,
      [tenantId, from ?? null, to ?? null, origin ? escapeLike(origin) : null],
    );
    return result.rows.map(toBatch);
  }

  async findPendingFor(tenantId: string, actorId: string, role: ActorRole, isAdmin: boolean): Promise<Batch[]> {
    // Open lots that haven't reached the last step of their workflow and are
    // mine to act on: I hold them (to record the next step, hand them on, or —
    // after a failed inspection — rework or dispose of them), or nobody holds
    // them and the next step is one my role records. ADMIN sees every one.
    const result = await this.db.query<BatchRow>(
      `SELECT ${BATCH_COLUMNS}
         FROM batches b
        WHERE b.tenant_id = $1
          AND b.status IN ('ACTIVE', 'REJECTED')
          AND ${HAS_REMAINING}
          AND NOT workflow_is_final(b.workflow_id, b.current_stage)
          AND (
                $4
                OR b.assigned_to_actor_id = $2
                OR (b.assigned_to_actor_id IS NULL AND EXISTS (
                      SELECT 1 FROM workflow_steps ws
                       WHERE ws.workflow_id = b.workflow_id
                         AND ws.position = COALESCE(workflow_position(b.workflow_id, b.current_stage), 0) + 1
                         AND $3 = ANY (ws.roles)))
              )
        ORDER BY b.created_at DESC, b.id DESC`,
      [tenantId, actorId, role, isAdmin],
    );
    return result.rows.map(toBatch);
  }

  async findInCustody(tenantId: string, actorId: string, isAdmin: boolean): Promise<Batch[]> {
    const result = await this.db.query<BatchRow>(
      `SELECT ${BATCH_COLUMNS}
         FROM batches b
        WHERE b.tenant_id = $1
          AND b.status IN ('ACTIVE', 'REJECTED')
          AND b.event_count > 0
          AND ${HAS_REMAINING}
          AND ($3 OR b.assigned_to_actor_id = $2)
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT 1000`,
      [tenantId, actorId, isAdmin],
    );
    return result.rows.map(toBatch);
  }

  async findInvolving(tenantId: string, actorId: string): Promise<Batch[]> {
    const result = await this.db.query<BatchRow>(
      `SELECT ${BATCH_COLUMNS}
         FROM batches b
        WHERE b.tenant_id = $1 AND ${involvesActor('$2')}
        ORDER BY b.created_at DESC, b.id DESC`,
      [tenantId, actorId],
    );
    return result.rows.map(toBatch);
  }

  async findPageAfter(tenantId: string, afterId: string | null, limit: number): Promise<Batch[]> {
    const result = await this.db.query<BatchRow>(
      `SELECT ${BATCH_COLUMNS}
         FROM batches b
        WHERE b.tenant_id = $1 AND ($2::uuid IS NULL OR b.id > $2)
        ORDER BY b.id
        LIMIT $3`,
      [tenantId, afterId, limit],
    );
    return result.rows.map(toBatch);
  }

  async advanceStage(id: string, stage: SupplyChainStage, assignedToActorId: string | null): Promise<void> {
    await this.db.query('UPDATE batches SET current_stage = $2, assigned_to_actor_id = $3 WHERE id = $1', [
      id,
      stage,
      assignedToActorId,
    ]);
  }

  async reassign(id: string, assignedToActorId: string | null): Promise<void> {
    await this.db.query('UPDATE batches SET assigned_to_actor_id = $2 WHERE id = $1', [id, assignedToActorId]);
  }

  /**
   * Changes a lot's status (the database checks the transition) and,
   * optionally, custody and the lost quantity, in one statement — so a
   * concurrent writer can't be overwritten by a stale copy.
   */
  async setStatus(
    id: string,
    status: LotStatus,
    opts: { assignedToActorId?: string | null; addLost?: number; recallReason?: string } = {},
  ): Promise<Batch> {
    const sets = ['status = $2'];
    const params: unknown[] = [id, status];
    if (opts.assignedToActorId !== undefined) {
      params.push(opts.assignedToActorId);
      sets.push(`assigned_to_actor_id = $${params.length}`);
    }
    if (opts.addLost) {
      params.push(opts.addLost);
      sets.push(`lost_quantity = lost_quantity + $${params.length}`);
    }
    if (opts.recallReason !== undefined) {
      params.push(opts.recallReason);
      sets.push(`recall_reason = $${params.length}`);
    }
    const result = await this.db.query<BatchRow>(
      `UPDATE batches AS b SET ${sets.join(', ')} WHERE b.id = $1 RETURNING ${BATCH_COLUMNS}`,
      params,
    );
    if (!result.rows[0]) throw new Error(`batch ${id} vanished during a status change`);
    return toBatch(result.rows[0]);
  }
}
