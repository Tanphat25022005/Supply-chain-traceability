import { Database } from '../../db/database';
import { AttentionSummary, StatsByDay, StatsByOrigin, StatsByStage, StatsOverview, TRANSFER_OVERDUE_DAYS } from '../../domain/types';
import { IStatsRepo } from '../interfaces';
import { BATCH_COLUMNS, BatchRow, HAS_REMAINING, toBatch } from './batchRepo';

/** Dashboard aggregates computed by Postgres — no table is ever pulled into application memory. */
export class PostgresStatsRepo implements IStatsRepo {
  constructor(private readonly db: Database) {}

  async overview(tenantId: string): Promise<StatsOverview> {
    const result = await this.db.query<{
      total_batches: string;
      recalled_batches: string;
      total_events: string;
      anomaly_count: string;
      open_anomaly_count: string;
    }>(
      `SELECT
         (SELECT count(*) FROM batches WHERE tenant_id = $1)                      AS total_batches,
         (SELECT count(*) FROM batches WHERE tenant_id = $1 AND is_recalled)      AS recalled_batches,
         (SELECT count(*) FROM trace_events WHERE tenant_id = $1)                 AS total_events,
         (SELECT count(*) FROM anomalies WHERE tenant_id = $1)                    AS anomaly_count,
         (SELECT count(*) FROM anomalies WHERE tenant_id = $1 AND NOT resolved)   AS open_anomaly_count`,
      [tenantId],
    );
    const row = result.rows[0];
    const totalBatches = Number(row.total_batches);
    const recalledBatches = Number(row.recalled_batches);
    return {
      totalBatches,
      activeBatches: totalBatches - recalledBatches,
      recalledBatches,
      totalEvents: Number(row.total_events),
      anomalyCount: Number(row.anomaly_count),
      openAnomalyCount: Number(row.open_anomaly_count),
    };
  }

  /** Stage records per stage (custody/status events excluded), in the stage catalog's display order. */
  async eventCountByStage(tenantId: string): Promise<StatsByStage[]> {
    const result = await this.db.query<{ stage: string; count: string }>(
      `SELECT e.stage, count(*) AS count
         FROM trace_events e JOIN stages s ON s.code = e.stage
        WHERE e.tenant_id = $1 AND e.kind IN ('OBSERVE', 'MERGE', 'SPLIT', 'TRANSFORM', 'REWORK', 'DOWNGRADE')
        GROUP BY e.stage, s.sort_order
        ORDER BY s.sort_order`,
      [tenantId],
    );
    return result.rows.map((r) => ({ stage: r.stage, count: Number(r.count) }));
  }

  /** The most recent `days` calendar days (UTC) that had any batch created, oldest first. */
  async batchesPerDay(tenantId: string, days: number): Promise<StatsByDay[]> {
    const result = await this.db.query<{ date: string; count: string }>(
      `SELECT date, count FROM (
         SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, count(*) AS count
           FROM batches
          WHERE tenant_id = $1
          GROUP BY 1
          ORDER BY 1 DESC
          LIMIT $2
       ) recent
       ORDER BY date ASC`,
      [tenantId, days],
    );
    return result.rows.map((r) => ({ date: r.date, count: Number(r.count) }));
  }

  async attention(tenantId: string, stalledAfterDays: number, limit: number): Promise<AttentionSummary> {
    // "Last activity" = newest event, or creation for a batch nobody has touched yet.
    const lastActivity = `COALESCE((SELECT max(e.timestamp) FROM trace_events e WHERE e.batch_id = b.id), b.created_at)`;
    // Open, workable lots that haven't reached the last step of their own workflow.
    const stalledWhere = `b.tenant_id = $1
        AND b.status = 'ACTIVE'
        AND ${HAS_REMAINING}
        AND NOT workflow_is_final(b.workflow_id, b.current_stage)
        AND ${lastActivity} < now() - make_interval(days => $2)`;
    const params = [tenantId, stalledAfterDays];

    const [stalled, counts] = await Promise.all([
      this.db.query<BatchRow>(
        `SELECT ${BATCH_COLUMNS} FROM batches b WHERE ${stalledWhere}
          ORDER BY ${lastActivity} ASC, b.id
          LIMIT $3`,
        [...params, limit],
      ),
      this.db.query<{ stalled: string; open_anomalies: string; overdue_transfers: string; on_hold: string; rejected: string }>(
        `SELECT (SELECT count(*) FROM batches b WHERE ${stalledWhere}) AS stalled,
                (SELECT count(*) FROM anomalies WHERE tenant_id = $1 AND NOT resolved) AS open_anomalies,
                (SELECT count(*) FROM transfers WHERE tenant_id = $1 AND status = 'PENDING'
                    AND created_at < now() - make_interval(days => $3)) AS overdue_transfers,
                (SELECT count(*) FROM batches WHERE tenant_id = $1 AND status = 'ON_HOLD') AS on_hold,
                (SELECT count(*) FROM batches WHERE tenant_id = $1 AND status = 'REJECTED') AS rejected`,
        [...params, TRANSFER_OVERDUE_DAYS],
      ),
    ]);

    const c = counts.rows[0];
    return {
      stalledBatches: stalled.rows.map(toBatch),
      stalledCount: Number(c.stalled),
      openAnomalyCount: Number(c.open_anomalies),
      overdueTransferCount: Number(c.overdue_transfers),
      onHoldCount: Number(c.on_hold),
      rejectedCount: Number(c.rejected),
    };
  }

  async byOrigin(tenantId: string): Promise<StatsByOrigin[]> {
    const result = await this.db.query<{ origin: string; batch_count: string; anomaly_count: string }>(
      `SELECT b.origin,
              count(DISTINCT b.id) AS batch_count,
              count(a.id)          AS anomaly_count
         FROM batches b
         LEFT JOIN anomalies a ON a.batch_id = b.id
        WHERE b.tenant_id = $1
        GROUP BY b.origin
        ORDER BY batch_count DESC, b.origin ASC`,
      [tenantId],
    );
    return result.rows.map((r) => ({
      origin: r.origin,
      batchCount: Number(r.batch_count),
      anomalyCount: Number(r.anomaly_count),
    }));
  }
}
