import { Database } from '../../db/database';
import { AnomalyType, LotStatus, SupplyChainStage, TransformationKind } from '../../domain/types';
import { PostgresCatalogRepo } from './catalogRepo';
import { escapeLike } from './sql';

export interface ReportFilters {
  from: Date;
  to: Date;
  productType?: string;
  origin?: string;
  /** Only lots following this workflow template (any version). */
  workflowCode?: string;
}

export interface KpiValue {
  value: number;
  /** Same measure over the equally long window right before `from` — null when it can't be computed. */
  previous: number | null;
  /** 12 equal buckets across the window, oldest first. */
  trend: number[];
}

/** Actual yield of one kind of process against the reference range (docs/SPEC_PHASE1_5.md §3). */
export interface ProcessLoss {
  kind: TransformationKind;
  fromTypeId: string;
  toTypeId: string;
  fromType: string;
  toType: string;
  count: number;
  inKg: number;
  outKg: number;
  /** Mean of output/input over the transformations. */
  avgRatio: number;
  /** Reference range and where it comes from; null when the catalog has none. */
  min: number | null;
  max: number | null;
  source: string | null;
  /** Transformations whose ratio fell outside [min, max]. */
  outOfRange: number;
}

export interface ReportData {
  window: { from: Date; to: Date; previousFrom: Date };
  kpis: {
    batches: KpiValue;
    volumeKg: KpiValue;
    events: KpiValue;
    completionRate: KpiValue;
    recallRate: KpiValue;
    openAnomalies: KpiValue;
    avgLeadTimeDays: KpiValue;
    anchoredRate: KpiValue;
  };
  monthly: Array<{ month: string; batches: number; events: number; volumeKg: number; recalls: number; anomalies: number }>;
  funnel: Array<{ stage: SupplyChainStage; batches: number }>;
  stageDurations: Array<{ from: SupplyChainStage; to: SupplyChainStage; avgHours: number; samples: number }>;
  byProductType: Array<{ productType: string; batches: number; volumeKg: number }>;
  byOrigin: Array<{ origin: string; batches: number; anomalies: number; recalls: number }>;
  anomaliesByType: Array<{ type: AnomalyType; open: number; resolved: number }>;
  organizations: Array<{ organization: string; events: number; batches: number; anomalies: number; avgWaitHours: number | null }>;
  statusBreakdown: Array<{ status: LotStatus; batches: number }>;
  losses: {
    processes: ProcessLoss[];
    transit: { accepted: number; rejected: number; pending: number; sentKg: number; shortfallKg: number; discrepancies: number };
    disposedKg: number;
  };
  /** Options for the filter controls, independent of the current filter. */
  options: { productTypes: string[]; origins: string[]; workflows: Array<{ code: string; name: string }> };
}

/** Weight in kg of a lot row aliased `x` — null for counted goods and lots not yet mapped to the catalog. */
const kg = (x: string) => `CASE WHEN ${x}.base_unit = 'kg' THEN ${x}.quantity_base END`;
const STAGE_KINDS = `('OBSERVE', 'MERGE', 'SPLIT', 'TRANSFORM', 'REWORK', 'DOWNGRADE')`;
const BUCKETS = 12;

/**
 * Aggregates for the Reports dashboard, all computed in Postgres over the
 * filtered lots (created inside the window, optional product type / origin /
 * workflow). Durations use when things happened (occurred_at), weights the
 * catalog conversion. Runs inside the tenant's scope.
 */
export class PostgresReportRepo {
  constructor(
    private readonly db: Database,
    /** For the reference ranges in the loss section. */
    private readonly catalog?: PostgresCatalogRepo,
  ) {}

  async report(tenantId: string, f: ReportFilters): Promise<ReportData> {
    const span = f.to.getTime() - f.from.getTime();
    const previousFrom = new Date(f.from.getTime() - span);
    const type = f.productType ?? null;
    const origin = f.origin ? escapeLike(f.origin) : null;
    const workflow = f.workflowCode ?? null;

    // Lots in [lo, hi) matching the dimension filters.
    const lots = (lo: string, hi: string) => `
      SELECT b.* FROM batches b
       WHERE b.tenant_id = $1 AND b.created_at >= ${lo} AND b.created_at < ${hi}
         AND ($4::text IS NULL OR b.product_type = $4)
         AND ($5::text IS NULL OR b.origin ILIKE '%' || $5 || '%')
         AND ($6::text IS NULL OR b.workflow_id IN (SELECT id FROM workflow_templates WHERE code = $6))`;
    // Same SQL for both windows — only the bounds in $2/$3 differ.
    const params = [tenantId, f.from, f.to, type, origin, workflow];
    const prevParams = [tenantId, previousFrom, f.from, type, origin, workflow];
    const cur = lots('$2', '$3');

    // ── KPIs, current vs previous window ──
    const kpiSql = (scope: string) => `
      WITH f AS (${scope}),
      ev AS (SELECT e.* FROM trace_events e JOIN f ON f.id = e.batch_id),
      lead AS (
        SELECT f.id,
               EXTRACT(EPOCH FROM (
                 max(e.occurred_at) FILTER (WHERE e.kind IN ${STAGE_KINDS} AND workflow_is_final(f.workflow_id, e.stage))
                 - min(e.occurred_at))) / 86400 AS days
          FROM f JOIN trace_events e ON e.batch_id = f.id
         GROUP BY f.id
      )
      SELECT
        (SELECT count(*) FROM f)                                                  AS batches,
        (SELECT COALESCE(sum(${kg('f')}), 0) FROM f)                              AS volume_kg,
        (SELECT count(*) FROM ev)                                                 AS events,
        (SELECT count(*) FROM f WHERE workflow_is_final(f.workflow_id, f.current_stage)) AS completed,
        (SELECT count(*) FROM f WHERE f.status = 'RECALLED')                      AS recalled,
        (SELECT count(*) FROM anomalies a JOIN f ON f.id = a.batch_id WHERE NOT a.resolved) AS open_anomalies,
        (SELECT avg(days) FROM lead WHERE days IS NOT NULL)                       AS lead_days,
        (SELECT count(*) FROM ev JOIN anchor_leaves l ON l.event_id = ev.id
                               JOIN anchors an ON an.id = l.anchor_id AND an.status = 'confirmed') AS anchored`;
    type KpiRow = {
      batches: string;
      volume_kg: string;
      events: string;
      completed: string;
      recalled: string;
      open_anomalies: string;
      lead_days: string | null;
      anchored: string;
    };
    const [curK, prevK] = await Promise.all([
      this.db.query<KpiRow>(kpiSql(cur), params),
      this.db.query<KpiRow>(kpiSql(cur), prevParams),
    ]);
    const derive = (r: KpiRow) => {
      const batches = Number(r.batches);
      const events = Number(r.events);
      return {
        batches,
        volumeKg: Number(r.volume_kg),
        events,
        completionRate: batches ? (Number(r.completed) / batches) * 100 : 0,
        recallRate: batches ? (Number(r.recalled) / batches) * 100 : 0,
        openAnomalies: Number(r.open_anomalies),
        avgLeadTimeDays: r.lead_days === null ? null : Number(r.lead_days),
        anchoredRate: events ? (Number(r.anchored) / events) * 100 : 0,
      };
    };
    const c = derive(curK.rows[0]);
    const p = derive(prevK.rows[0]);

    // ── 12-bucket sparklines over the current window ──
    const trendRows = await this.db.query<{ bucket: number; batches: string; volume_kg: string; recalled: string; completed: string; events: string; anomalies: string }>(
      `WITH f AS (${cur}),
       fb AS (SELECT f.*, width_bucket(EXTRACT(EPOCH FROM f.created_at), EXTRACT(EPOCH FROM $2::timestamptz), EXTRACT(EPOCH FROM $3::timestamptz), ${BUCKETS}) AS bucket FROM f)
       SELECT g.bucket,
              (SELECT count(*) FROM fb WHERE fb.bucket = g.bucket) AS batches,
              (SELECT COALESCE(sum(${kg('fb')}), 0) FROM fb WHERE fb.bucket = g.bucket) AS volume_kg,
              (SELECT count(*) FROM fb WHERE fb.bucket = g.bucket AND fb.status = 'RECALLED') AS recalled,
              (SELECT count(*) FROM fb WHERE fb.bucket = g.bucket AND workflow_is_final(fb.workflow_id, fb.current_stage)) AS completed,
              (SELECT count(*) FROM trace_events e JOIN fb ON fb.id = e.batch_id WHERE fb.bucket = g.bucket) AS events,
              (SELECT count(*) FROM anomalies a JOIN fb ON fb.id = a.batch_id WHERE fb.bucket = g.bucket AND NOT a.resolved) AS anomalies
         FROM generate_series(1, ${BUCKETS}) AS g(bucket)
        ORDER BY g.bucket`,
      params,
    );
    const col = (k: keyof (typeof trendRows.rows)[number]) => trendRows.rows.map((r) => Number(r[k]));
    const tBatches = col('batches');
    const ratio = (num: number[], den: number[]) => num.map((n, i) => (den[i] ? (n / den[i]) * 100 : 0));

    // ── Monthly performance ──
    const monthly = await this.db.query<{ month: string; batches: string; events: string; volume_kg: string; recalls: string; anomalies: string }>(
      `WITH f AS (${cur}),
       m AS (SELECT generate_series(date_trunc('month', $2::timestamptz), date_trunc('month', $3::timestamptz - interval '1 microsecond'), interval '1 month') AS month)
       SELECT to_char(m.month, 'YYYY-MM') AS month,
              (SELECT count(*) FROM f WHERE date_trunc('month', f.created_at) = m.month) AS batches,
              (SELECT count(*) FROM trace_events e JOIN f ON f.id = e.batch_id WHERE date_trunc('month', e.occurred_at) = m.month) AS events,
              (SELECT COALESCE(sum(${kg('f')}), 0) FROM f WHERE date_trunc('month', f.created_at) = m.month) AS volume_kg,
              (SELECT count(*) FROM f WHERE f.status = 'RECALLED' AND date_trunc('month', f.created_at) = m.month) AS recalls,
              (SELECT count(*) FROM anomalies a JOIN f ON f.id = a.batch_id WHERE date_trunc('month', a.detected_at) = m.month) AS anomalies
         FROM m ORDER BY m.month`,
      params,
    );

    // ── Funnel: lots that reached each stage of their own workflow ──
    const funnel = await this.db.query<{ stage: string; batches: string }>(
      `WITH f AS (${cur}),
       st AS (SELECT DISTINCT ws.stage_code, s.sort_order
                FROM f JOIN workflow_steps ws ON ws.workflow_id = f.workflow_id
                JOIN stages s ON s.code = ws.stage_code)
       SELECT st.stage_code AS stage,
              count(f.id) FILTER (WHERE workflow_position(f.workflow_id, f.current_stage) >= workflow_position(f.workflow_id, st.stage_code)) AS batches
         FROM st LEFT JOIN f ON workflow_position(f.workflow_id, st.stage_code) IS NOT NULL
        GROUP BY st.stage_code, st.sort_order
        ORDER BY st.sort_order`,
      params,
    );

    // ── Average time between consecutive stage records (when they happened) ──
    const durations = await this.db.query<{ from_stage: string; to_stage: string; avg_hours: string; samples: string }>(
      `WITH f AS (${cur}),
       ev AS (
         SELECT e.stage, e.occurred_at,
                lag(e.stage) OVER w AS prev_stage, lag(e.occurred_at) OVER w AS prev_at,
                workflow_position(f.workflow_id, e.stage) AS pos,
                lag(workflow_position(f.workflow_id, e.stage)) OVER w AS prev_pos
           FROM trace_events e JOIN f ON f.id = e.batch_id
          WHERE e.kind IN ${STAGE_KINDS}
         WINDOW w AS (PARTITION BY e.batch_id ORDER BY e.sequence_number)
       )
       SELECT prev_stage AS from_stage, stage AS to_stage,
              avg(EXTRACT(EPOCH FROM (occurred_at - prev_at)) / 3600) AS avg_hours, count(*) AS samples
         FROM ev JOIN stages s ON s.code = ev.prev_stage
        WHERE prev_stage IS NOT NULL AND pos > prev_pos
        GROUP BY prev_stage, stage, s.sort_order
        ORDER BY s.sort_order, avg_hours`,
      params,
    );

    const byType = await this.db.query<{ product_type: string; batches: string; volume_kg: string }>(
      `WITH f AS (${cur})
       SELECT f.product_type, count(*) AS batches, COALESCE(sum(${kg('f')}), 0) AS volume_kg
         FROM f GROUP BY f.product_type ORDER BY batches DESC, f.product_type LIMIT 12`,
      params,
    );

    const byOrigin = await this.db.query<{ origin: string; batches: string; anomalies: string; recalls: string }>(
      `WITH f AS (${cur})
       SELECT f.origin, count(DISTINCT f.id) AS batches,
              count(a.id) AS anomalies,
              count(DISTINCT f.id) FILTER (WHERE f.status = 'RECALLED') AS recalls
         FROM f LEFT JOIN anomalies a ON a.batch_id = f.id
        GROUP BY f.origin ORDER BY batches DESC, f.origin LIMIT 10`,
      params,
    );

    const anomalyTypes = await this.db.query<{ type: AnomalyType; open: string; resolved: string }>(
      `WITH f AS (${cur})
       SELECT a.type, count(*) FILTER (WHERE NOT a.resolved) AS open, count(*) FILTER (WHERE a.resolved) AS resolved
         FROM anomalies a JOIN f ON f.id = a.batch_id
        GROUP BY a.type ORDER BY count(*) DESC`,
      params,
    );

    // Waiting time = from when the previous step happened to when this organization recorded its own.
    const orgs = await this.db.query<{ organization: string; events: string; batches: string; anomalies: string; avg_wait_hours: string | null }>(
      `WITH f AS (${cur}),
       ev AS (
         SELECT e.id, e.batch_id, e.actor_id, e.timestamp, e.kind,
                lag(e.occurred_at) OVER (PARTITION BY e.batch_id ORDER BY e.sequence_number) AS prev_at
           FROM trace_events e JOIN f ON f.id = e.batch_id
       )
       SELECT ac.organization,
              count(ev.id) AS events,
              count(DISTINCT ev.batch_id) AS batches,
              (SELECT count(*) FROM anomalies a WHERE a.event_id IN (SELECT ev2.id FROM ev ev2 JOIN actors ac2 ON ac2.id = ev2.actor_id WHERE ac2.organization = ac.organization)) AS anomalies,
              avg(EXTRACT(EPOCH FROM (ev.timestamp - ev.prev_at)) / 3600) FILTER (WHERE ev.kind IN ${STAGE_KINDS}) AS avg_wait_hours
         FROM ev JOIN actors ac ON ac.id = ev.actor_id
        GROUP BY ac.organization
        ORDER BY events DESC, ac.organization LIMIT 15`,
      params,
    );

    const statuses = await this.db.query<{ status: LotStatus; batches: string }>(
      `WITH f AS (${cur}) SELECT f.status, count(*) AS batches FROM f GROUP BY f.status ORDER BY count(*) DESC`,
      params,
    );

    const losses = await this.losses(cur, params);

    const options = await this.db.query<{ kind: string; value: string; label: string | null }>(
      `SELECT DISTINCT 'type' AS kind, product_type AS value, NULL AS label FROM batches WHERE tenant_id = $1
       UNION SELECT DISTINCT 'origin', origin, NULL FROM batches WHERE tenant_id = $1
       UNION SELECT DISTINCT 'workflow', w.code, w.name FROM batches b JOIN workflow_templates w ON w.id = b.workflow_id WHERE b.tenant_id = $1
       ORDER BY kind, value`,
      [tenantId],
    );

    const kpi = (value: number, previous: number | null, trend: number[]): KpiValue => ({ value, previous, trend });
    return {
      window: { from: f.from, to: f.to, previousFrom },
      kpis: {
        batches: kpi(c.batches, p.batches, tBatches),
        volumeKg: kpi(c.volumeKg, p.volumeKg, col('volume_kg')),
        events: kpi(c.events, p.events, col('events')),
        completionRate: kpi(c.completionRate, p.batches ? p.completionRate : null, ratio(col('completed'), tBatches)),
        recallRate: kpi(c.recallRate, p.batches ? p.recallRate : null, ratio(col('recalled'), tBatches)),
        openAnomalies: kpi(c.openAnomalies, p.openAnomalies, col('anomalies')),
        avgLeadTimeDays: kpi(c.avgLeadTimeDays ?? 0, p.avgLeadTimeDays, []),
        anchoredRate: kpi(c.anchoredRate, p.events ? p.anchoredRate : null, []),
      },
      monthly: monthly.rows.map((r) => ({
        month: r.month,
        batches: Number(r.batches),
        events: Number(r.events),
        volumeKg: Number(r.volume_kg),
        recalls: Number(r.recalls),
        anomalies: Number(r.anomalies),
      })),
      funnel: funnel.rows.map((r) => ({ stage: r.stage, batches: Number(r.batches) })),
      stageDurations: durations.rows.map((r) => ({
        from: r.from_stage,
        to: r.to_stage,
        avgHours: Number(r.avg_hours),
        samples: Number(r.samples),
      })),
      byProductType: byType.rows.map((r) => ({ productType: r.product_type, batches: Number(r.batches), volumeKg: Number(r.volume_kg) })),
      byOrigin: byOrigin.rows.map((r) => ({ origin: r.origin, batches: Number(r.batches), anomalies: Number(r.anomalies), recalls: Number(r.recalls) })),
      anomaliesByType: anomalyTypes.rows.map((r) => ({ type: r.type, open: Number(r.open), resolved: Number(r.resolved) })),
      organizations: orgs.rows.map((r) => ({
        organization: r.organization,
        events: Number(r.events),
        batches: Number(r.batches),
        anomalies: Number(r.anomalies),
        avgWaitHours: r.avg_wait_hours === null ? null : Number(r.avg_wait_hours),
      })),
      statusBreakdown: statuses.rows.map((r) => ({ status: r.status, batches: Number(r.batches) })),
      losses,
      options: {
        productTypes: options.rows.filter((o) => o.kind === 'type').map((o) => o.value),
        origins: options.rows.filter((o) => o.kind === 'origin').map((o) => o.value),
        workflows: options.rows.filter((o) => o.kind === 'workflow').map((o) => ({ code: o.value, name: o.label ?? o.value })),
      },
    };
  }

  /** "Hao hụt theo công đoạn": each process's actual yield against its reference range, transit shortfall, disposals. */
  private async losses(cur: string, params: unknown[]): Promise<ReportData['losses']> {
    const perTransformation = await this.db.query<{ kind: TransformationKind; from_type: string; to_type: string; from_name: string; to_name: string; in_kg: string; out_kg: string }>(
      `WITH f AS (${cur}),
       t AS (
         SELECT DISTINCT tr.id, tr.kind FROM transformations tr
           JOIN transformation_outputs o ON o.transformation_id = tr.id
           JOIN f ON f.id = o.lot_id
       )
       SELECT t.kind,
              (SELECT min(ib.product_type_id::text) FROM transformation_inputs ti JOIN batches ib ON ib.id = ti.lot_id WHERE ti.transformation_id = t.id) AS from_type,
              (SELECT min(ob.product_type_id::text) FROM transformation_outputs o JOIN batches ob ON ob.id = o.lot_id WHERE o.transformation_id = t.id) AS to_type,
              (SELECT min(ib.product_type) FROM transformation_inputs ti JOIN batches ib ON ib.id = ti.lot_id WHERE ti.transformation_id = t.id) AS from_name,
              (SELECT min(ob.product_type) FROM transformation_outputs o JOIN batches ob ON ob.id = o.lot_id WHERE o.transformation_id = t.id) AS to_name,
              (SELECT sum(ti.quantity * ib.unit_factor) FILTER (WHERE ib.base_unit = 'kg')
                 FROM transformation_inputs ti JOIN batches ib ON ib.id = ti.lot_id WHERE ti.transformation_id = t.id) AS in_kg,
              (SELECT sum(ob.quantity_base) FILTER (WHERE ob.base_unit = 'kg')
                 FROM transformation_outputs o JOIN batches ob ON ob.id = o.lot_id WHERE o.transformation_id = t.id) AS out_kg
         FROM t
        LIMIT 5000`,
      params,
    );
    const groups = new Map<string, ProcessLoss & { ratios: number[] }>();
    for (const r of perTransformation.rows) {
      const inKg = Number(r.in_kg);
      const outKg = Number(r.out_kg);
      if (!r.from_type || !r.to_type || !(inKg > 0) || !(outKg >= 0)) continue;
      const key = `${r.kind}|${r.from_type}|${r.to_type}`;
      const g =
        groups.get(key) ??
        ({ kind: r.kind, fromTypeId: r.from_type, toTypeId: r.to_type, fromType: r.from_name, toType: r.to_name, count: 0, inKg: 0, outKg: 0, avgRatio: 0, min: null, max: null, source: null, outOfRange: 0, ratios: [] } as ProcessLoss & { ratios: number[] });
      g.count += 1;
      g.inKg += inKg;
      g.outKg += outKg;
      g.ratios.push(outKg / inKg);
      groups.set(key, g);
    }
    const processes: ProcessLoss[] = [];
    for (const g of groups.values()) {
      let bounds: { min: number; max: number; source: string } | null = null;
      if (this.catalog) {
        bounds =
          g.kind === 'TRANSFORM'
            ? await this.catalog.conversionFactor(g.fromTypeId, g.toTypeId)
            : await this.catalog.processRatio(g.kind, (await this.catalog.productTypeById(g.toTypeId))?.categoryCode);
      }
      const { ratios, ...rest } = g;
      processes.push({
        ...rest,
        avgRatio: ratios.reduce((a, b) => a + b, 0) / ratios.length,
        min: bounds?.min ?? null,
        max: bounds?.max ?? null,
        source: bounds?.source ?? null,
        outOfRange: bounds ? ratios.filter((x) => x < bounds!.min - 1e-9 || x > bounds!.max + 1e-9).length : 0,
      });
    }
    processes.sort((a, b) => b.count - a.count);

    const transit = await this.db.query<{ accepted: string; rejected: string; pending: string; sent_kg: string; short_kg: string; discrepancies: string }>(
      `WITH f AS (${cur})
       SELECT count(*) FILTER (WHERE t.status = 'ACCEPTED') AS accepted,
              count(*) FILTER (WHERE t.status = 'REJECTED') AS rejected,
              count(*) FILTER (WHERE t.status = 'PENDING')  AS pending,
              COALESCE(sum(t.quantity * f.unit_factor) FILTER (WHERE t.status = 'ACCEPTED' AND f.base_unit = 'kg'), 0) AS sent_kg,
              COALESCE(sum((t.quantity - t.received_quantity) * f.unit_factor) FILTER (WHERE t.status = 'ACCEPTED' AND f.base_unit = 'kg'), 0) AS short_kg,
              (SELECT count(*) FROM anomalies a JOIN f f2 ON f2.id = a.batch_id WHERE a.type = 'QUANTITY_DISCREPANCY') AS discrepancies
         FROM transfers t JOIN f ON f.id = t.batch_id`,
      params,
    );
    const disposed = await this.db.query<{ kg: string | null }>(
      `WITH f AS (${cur})
       SELECT sum((e.data->>'quantity')::numeric * f.unit_factor) AS kg
         FROM trace_events e JOIN f ON f.id = e.batch_id
        WHERE e.kind = 'DISPOSE' AND f.base_unit = 'kg'`,
      params,
    );
    const t = transit.rows[0];
    return {
      processes,
      transit: {
        accepted: Number(t.accepted),
        rejected: Number(t.rejected),
        pending: Number(t.pending),
        sentKg: Number(t.sent_kg),
        shortfallKg: Number(t.short_kg),
        discrepancies: Number(t.discrepancies),
      },
      disposedKg: Number(disposed.rows[0]?.kg ?? 0),
    };
  }
}
