import { Database, isUuid } from '../../db/database';
import { FieldDef, FieldSchema } from '../../domain/fieldSchema';
import { ActorRole, Stage, StageKind, TransformationKind, Workflow } from '../../domain/types';

export interface ProductCategory {
  code: string;
  name: string;
  sortOrder: number;
}

export interface ProductType {
  id: string;
  /** null = platform catalog (every tenant sees it). */
  tenantId: string | null;
  categoryCode: string;
  code: string;
  name: string;
  baseUnit: 'kg' | 'cái';
  gtin?: string;
  defaultWorkflowCode?: string;
  aliases: string[];
  active: boolean;
  createdAt: Date;
}

export interface Unit {
  id: string;
  tenantId: string | null;
  /** null = generic for every product of this base unit. */
  productTypeId: string | null;
  baseUnit: 'kg' | 'cái';
  code: string;
  label: string;
  /** Base units per one of this unit. */
  factor: number;
}

interface Sourced {
  id: string;
  /** null = platform default; otherwise this tenant's override. */
  tenantId: string | null;
  source: string;
  updatedBy?: string;
  updatedAt: Date;
}

export interface ConversionFactor extends Sourced {
  fromTypeId: string;
  toTypeId: string;
  min: number;
  max: number;
}

export interface ProcessRatio extends Sourced {
  kind: Extract<TransformationKind, 'MERGE' | 'SPLIT' | 'REWORK' | 'DOWNGRADE'>;
  categoryCode: string | null;
  min: number;
  max: number;
}

export interface YieldCap extends Sourced {
  productTypeId: string;
  region: string | null;
  maxKgPerHa: number;
}

export interface ProductSettings extends Sourced {
  productTypeId: string;
  transitLossTolerance: number;
  maxBackdateDays: number;
}

/** Used when neither the platform nor the tenant has settings for a product type. */
export const DEFAULT_PRODUCT_SETTINGS = { transitLossTolerance: 0.01, maxBackdateDays: 7, source: 'Mặc định hệ thống' };

export interface UnmappedGroup {
  productType: string;
  unit: string;
  batchCount: number;
  /** Already linked to a product type, only the unit conversion is missing. */
  productTypeId?: string;
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v);
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

function toProductType(r: Row): ProductType {
  return {
    id: r.id as string,
    tenantId: (r.tenant_id as string | null) ?? null,
    categoryCode: r.category_code as string,
    code: r.code as string,
    name: r.name as string,
    baseUnit: r.base_unit as 'kg' | 'cái',
    gtin: opt(r.gtin as string | null),
    defaultWorkflowCode: opt(r.default_workflow_code as string | null),
    aliases: (r.aliases as string[]) ?? [],
    active: r.active as boolean,
    createdAt: r.created_at as Date,
  };
}

function toUnit(r: Row): Unit {
  return {
    id: r.id as string,
    tenantId: (r.tenant_id as string | null) ?? null,
    productTypeId: (r.product_type_id as string | null) ?? null,
    baseUnit: r.base_unit as 'kg' | 'cái',
    code: r.code as string,
    label: r.label as string,
    factor: num(r.factor),
  };
}

function sourced(r: Row): Sourced {
  return {
    id: r.id as string,
    tenantId: (r.tenant_id as string | null) ?? null,
    source: r.source as string,
    updatedBy: opt(r.updated_by as string | null),
    updatedAt: r.updated_at as Date,
  };
}

/**
 * The catalog: stages, workflow templates, product types, units, field
 * schemas and mass-balance reference data (migrations 015–019).
 *
 * Stages, workflows and field schemas are platform data that only ever grow
 * by new versions (append-only triggers), so they are loaded once and kept.
 * Everything tenant-aware is queried through row-level security each time:
 * outside a tenant scope only platform rows are visible.
 */
export class PostgresCatalogRepo {
  private platform?: Promise<{ stages: Stage[]; workflows: Workflow[]; schemas: FieldSchema[]; categories: ProductCategory[] }>;

  constructor(private readonly db: Database) {}

  // ── Platform data (cached) ──────────────────────────────────────────────

  private loadPlatform() {
    if (!this.platform) {
      this.platform = (async () => {
        // Straight on the pool: the cache must not belong to whichever request's transaction asked first.
        const q = (sql: string) => this.db.pool.query<Row>(sql);
        const [stages, workflows, steps, schemas, categories] = await Promise.all([
          q('SELECT code, label, kind, sort_order FROM stages ORDER BY sort_order'),
          q('SELECT id, code, version, name, description, category_code, active FROM workflow_templates ORDER BY code, version'),
          q('SELECT workflow_id, position, stage_code, required, roles FROM workflow_steps ORDER BY workflow_id, position'),
          q('SELECT id, category_code, stage_code, version, fields FROM field_schemas ORDER BY id'),
          q('SELECT code, name, sort_order FROM product_categories ORDER BY sort_order'),
        ]);
        return {
          stages: stages.rows.map((r) => ({ code: r.code as string, label: r.label as string, kind: r.kind as StageKind, sortOrder: num(r.sort_order) })),
          workflows: workflows.rows.map((w) => ({
            id: w.id as string,
            code: w.code as string,
            version: num(w.version),
            name: w.name as string,
            description: w.description as string,
            categoryCode: (w.category_code as string | null) ?? null,
            active: w.active as boolean,
            steps: steps.rows
              .filter((s) => s.workflow_id === w.id)
              .map((s) => ({ position: num(s.position), stage: s.stage_code as string, required: s.required as boolean, roles: s.roles as ActorRole[] })),
          })),
          schemas: schemas.rows.map((r) => ({
            id: num(r.id),
            categoryCode: (r.category_code as string | null) ?? null,
            stage: r.stage_code as string,
            version: num(r.version),
            fields: r.fields as FieldDef[],
          })),
          categories: categories.rows.map((r) => ({ code: r.code as string, name: r.name as string, sortOrder: num(r.sort_order) })),
        };
      })().catch((err) => {
        this.platform = undefined; // retry next time rather than caching a failure
        throw err;
      });
    }
    return this.platform;
  }

  async stages(): Promise<Stage[]> {
    return (await this.loadPlatform()).stages;
  }

  async stageMap(): Promise<Map<string, Stage>> {
    return new Map((await this.stages()).map((s) => [s.code, s]));
  }

  async categories(): Promise<ProductCategory[]> {
    return (await this.loadPlatform()).categories;
  }

  async workflows(): Promise<Workflow[]> {
    return (await this.loadPlatform()).workflows;
  }

  async workflowById(id: string): Promise<Workflow | undefined> {
    return (await this.workflows()).find((w) => w.id === id);
  }

  /** The newest active version of a template. */
  async latestWorkflow(code: string): Promise<Workflow | undefined> {
    return (await this.workflows())
      .filter((w) => w.code === code && w.active)
      .sort((a, b) => b.version - a.version)[0];
  }

  async fieldSchemas(): Promise<FieldSchema[]> {
    return (await this.loadPlatform()).schemas;
  }

  async schemaById(id: number): Promise<FieldSchema | undefined> {
    return (await this.fieldSchemas()).find((s) => s.id === id);
  }

  /** The current schema for a product group and stage: the group's own if it has one, else the generic one. */
  async currentSchema(categoryCode: string | null | undefined, stage: string): Promise<FieldSchema | null> {
    const all = (await this.fieldSchemas()).filter((s) => s.stage === stage);
    const newest = (list: FieldSchema[]) => list.sort((a, b) => b.version - a.version)[0];
    return (categoryCode ? newest(all.filter((s) => s.categoryCode === categoryCode)) : undefined) ?? newest(all.filter((s) => s.categoryCode === null)) ?? null;
  }

  // ── Product types & units (RLS: platform + own tenant) ──────────────────

  async productTypes(): Promise<ProductType[]> {
    const r = await this.db.query<Row>(
      `SELECT pt.* FROM product_types pt
         JOIN product_categories c ON c.code = pt.category_code
        ORDER BY c.sort_order, pt.tenant_id NULLS FIRST, pt.name`,
    );
    return r.rows.map(toProductType);
  }

  async productTypeById(id: string): Promise<ProductType | null> {
    if (!isUuid(id)) return null;
    const r = await this.db.query<Row>('SELECT * FROM product_types WHERE id = $1', [id]);
    return r.rows[0] ? toProductType(r.rows[0]) : null;
  }

  /**
   * A product type by code, exact name or curated alias — compared without
   * case, diacritics or extra spaces. The tenant's own entry wins over the
   * platform's. No fuzzy matching: an unknown name is an error, not a guess.
   */
  async resolveProductType(text: string): Promise<ProductType | null> {
    const r = await this.db.query<Row>(
      `SELECT * FROM product_types pt
        WHERE pt.active
          AND (pt.code = upper(trim($1))
               OR catalog_norm(pt.name) = catalog_norm($1)
               OR catalog_norm($1) IN (SELECT catalog_norm(a) FROM unnest(pt.aliases) a))
        ORDER BY pt.tenant_id NULLS LAST, (catalog_norm(pt.name) = catalog_norm($1)) DESC
        LIMIT 1`,
      [text],
    );
    return r.rows[0] ? toProductType(r.rows[0]) : null;
  }

  async units(): Promise<Unit[]> {
    const r = await this.db.query<Row>('SELECT * FROM units ORDER BY product_type_id NULLS FIRST, factor');
    return r.rows.map(toUnit);
  }

  /** Units a lot of this product type may be counted in: generic ones for its base unit, plus its packaging units. */
  async unitsFor(productType: Pick<ProductType, 'id' | 'baseUnit'>): Promise<Unit[]> {
    const r = await this.db.query<Row>(
      `SELECT * FROM units
        WHERE (product_type_id = $1 OR (product_type_id IS NULL AND base_unit = $2))
        ORDER BY product_type_id NULLS FIRST, tenant_id NULLS FIRST, factor`,
      [productType.id, productType.baseUnit],
    );
    return r.rows.map(toUnit);
  }

  /** The unit matching `code` for a product type (tenant's own first, product-specific before generic). */
  async unitFor(productType: Pick<ProductType, 'id' | 'baseUnit'>, code: string): Promise<Unit | null> {
    const r = await this.db.query<Row>(
      `SELECT * FROM units
        WHERE (product_type_id = $1 OR (product_type_id IS NULL AND base_unit = $2))
          AND catalog_norm(code) = catalog_norm($3)
        ORDER BY tenant_id NULLS LAST, product_type_id NULLS LAST
        LIMIT 1`,
      [productType.id, productType.baseUnit, code],
    );
    return r.rows[0] ? toUnit(r.rows[0]) : null;
  }

  async createProductType(t: Omit<ProductType, 'createdAt' | 'active'> & { createdBy: string }): Promise<ProductType> {
    const r = await this.db.query<Row>(
      `INSERT INTO product_types (id, tenant_id, category_code, code, name, base_unit, gtin, default_workflow_code, aliases, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [t.id, t.tenantId, t.categoryCode, t.code, t.name, t.baseUnit, t.gtin ?? null, t.defaultWorkflowCode ?? null, t.aliases, t.createdBy],
    );
    return toProductType(r.rows[0]);
  }

  async updateProductType(
    id: string,
    changes: { name: string; gtin: string | null; defaultWorkflowCode: string | null; aliases: string[]; active: boolean },
  ): Promise<ProductType | null> {
    const r = await this.db.query<Row>(
      `UPDATE product_types SET name = $2, gtin = $3, default_workflow_code = $4, aliases = $5, active = $6
        WHERE id = $1 RETURNING *`,
      [id, changes.name, changes.gtin, changes.defaultWorkflowCode, changes.aliases, changes.active],
    );
    return r.rows[0] ? toProductType(r.rows[0]) : null;
  }

  async createUnit(u: Omit<Unit, 'id'> & { id: string }): Promise<Unit> {
    const r = await this.db.query<Row>(
      `INSERT INTO units (id, tenant_id, product_type_id, base_unit, code, label, factor)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [u.id, u.tenantId, u.productTypeId, u.baseUnit, u.code, u.label, u.factor],
    );
    return toUnit(r.rows[0]);
  }

  // ── Mapping queue: lots from before the catalog ─────────────────────────

  async unmappedGroups(tenantId: string): Promise<UnmappedGroup[]> {
    const r = await this.db.query<Row>(
      `SELECT product_type, unit, product_type_id, count(*) AS n
         FROM batches
        WHERE tenant_id = $1 AND (product_type_id IS NULL OR unit_factor IS NULL)
        GROUP BY product_type, unit, product_type_id
        ORDER BY count(*) DESC, product_type`,
      [tenantId],
    );
    return r.rows.map((x) => ({
      productType: x.product_type as string,
      unit: x.unit as string,
      batchCount: num(x.n),
      productTypeId: opt(x.product_type_id as string | null),
    }));
  }

  /** Links every unmapped lot with this (old name, unit) to a catalog product and conversion; returns how many. */
  async mapGroup(tenantId: string, oldName: string, unit: string, productType: ProductType, unitFactor: number): Promise<number> {
    const r = await this.db.query(
      `UPDATE batches
          SET product_type_id = $4,
              product_type = CASE WHEN product_type_id IS NULL THEN $5 ELSE product_type END,
              base_unit = $6,
              unit_factor = $7
        WHERE tenant_id = $1 AND product_type = $2 AND unit = $3
          AND (product_type_id IS NULL OR (product_type_id = $4 AND unit_factor IS NULL))`,
      [tenantId, oldName, unit, productType.id, productType.name, productType.baseUnit, unitFactor],
    );
    return r.rowCount ?? 0;
  }

  // ── Reference data: tenant override wins over the platform value ────────

  async conversionFactor(fromTypeId: string, toTypeId: string): Promise<ConversionFactor | null> {
    const r = await this.db.query<Row>(
      `SELECT * FROM conversion_factors WHERE from_type_id = $1 AND to_type_id = $2
        ORDER BY tenant_id NULLS LAST LIMIT 1`,
      [fromTypeId, toTypeId],
    );
    const x = r.rows[0];
    return x ? { ...sourced(x), fromTypeId: x.from_type_id as string, toTypeId: x.to_type_id as string, min: num(x.min_ratio), max: num(x.max_ratio) } : null;
  }

  async processRatio(kind: ProcessRatio['kind'], categoryCode: string | null | undefined): Promise<ProcessRatio | null> {
    const r = await this.db.query<Row>(
      `SELECT * FROM process_ratios
        WHERE kind = $1 AND (category_code IS NULL OR category_code = $2)
        ORDER BY tenant_id NULLS LAST, category_code NULLS LAST LIMIT 1`,
      [kind, categoryCode ?? null],
    );
    const x = r.rows[0];
    return x ? { ...sourced(x), kind: x.kind as ProcessRatio['kind'], categoryCode: (x.category_code as string | null) ?? null, min: num(x.min_ratio), max: num(x.max_ratio) } : null;
  }

  /** The cap for a product type in the region `origin` names (most specific match wins). */
  async yieldCap(productTypeId: string, origin: string): Promise<YieldCap | null> {
    const r = await this.db.query<Row>(
      `SELECT * FROM yield_caps
        WHERE product_type_id = $1
          AND (region IS NULL OR position(catalog_norm(region) IN catalog_norm($2)) > 0)
        ORDER BY region IS NULL, tenant_id NULLS LAST LIMIT 1`,
      [productTypeId, origin],
    );
    const x = r.rows[0];
    return x ? { ...sourced(x), productTypeId: x.product_type_id as string, region: (x.region as string | null) ?? null, maxKgPerHa: num(x.max_kg_per_ha) } : null;
  }

  async productSettings(productTypeId: string | undefined): Promise<Pick<ProductSettings, 'transitLossTolerance' | 'maxBackdateDays' | 'source'>> {
    if (!productTypeId) return DEFAULT_PRODUCT_SETTINGS;
    const r = await this.db.query<Row>(
      'SELECT * FROM product_settings WHERE product_type_id = $1 ORDER BY tenant_id NULLS LAST LIMIT 1',
      [productTypeId],
    );
    const x = r.rows[0];
    return x
      ? { transitLossTolerance: num(x.transit_loss_tolerance), maxBackdateDays: num(x.max_backdate_days), source: x.source as string }
      : DEFAULT_PRODUCT_SETTINGS;
  }

  /** Every visible row of each reference table — the admin's "số liệu tham chiếu" page. */
  async referenceData(): Promise<{
    conversionFactors: ConversionFactor[];
    processRatios: ProcessRatio[];
    yieldCaps: YieldCap[];
    productSettings: ProductSettings[];
  }> {
    const [cf, pr, yc, ps] = await Promise.all([
      this.db.query<Row>('SELECT * FROM conversion_factors ORDER BY from_type_id, to_type_id, tenant_id NULLS FIRST'),
      this.db.query<Row>('SELECT * FROM process_ratios ORDER BY kind, category_code NULLS FIRST, tenant_id NULLS FIRST'),
      this.db.query<Row>('SELECT * FROM yield_caps ORDER BY product_type_id, region NULLS FIRST, tenant_id NULLS FIRST'),
      this.db.query<Row>('SELECT * FROM product_settings ORDER BY product_type_id, tenant_id NULLS FIRST'),
    ]);
    return {
      conversionFactors: cf.rows.map((x) => ({ ...sourced(x), fromTypeId: x.from_type_id as string, toTypeId: x.to_type_id as string, min: num(x.min_ratio), max: num(x.max_ratio) })),
      processRatios: pr.rows.map((x) => ({ ...sourced(x), kind: x.kind as ProcessRatio['kind'], categoryCode: (x.category_code as string | null) ?? null, min: num(x.min_ratio), max: num(x.max_ratio) })),
      yieldCaps: yc.rows.map((x) => ({ ...sourced(x), productTypeId: x.product_type_id as string, region: (x.region as string | null) ?? null, maxKgPerHa: num(x.max_kg_per_ha) })),
      productSettings: ps.rows.map((x) => ({
        ...sourced(x),
        productTypeId: x.product_type_id as string,
        transitLossTolerance: num(x.transit_loss_tolerance),
        maxBackdateDays: num(x.max_backdate_days),
      })),
    };
  }

  async upsertConversionFactor(tenantId: string, v: { fromTypeId: string; toTypeId: string; min: number; max: number; source: string; updatedBy: string }): Promise<void> {
    const updated = await this.db.query(
      `UPDATE conversion_factors SET min_ratio = $4, max_ratio = $5, source = $6, updated_by = $7, updated_at = now()
        WHERE tenant_id = $1 AND from_type_id = $2 AND to_type_id = $3`,
      [tenantId, v.fromTypeId, v.toTypeId, v.min, v.max, v.source, v.updatedBy],
    );
    if (updated.rowCount) return;
    await this.db.query(
      `INSERT INTO conversion_factors (tenant_id, from_type_id, to_type_id, min_ratio, max_ratio, source, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, v.fromTypeId, v.toTypeId, v.min, v.max, v.source, v.updatedBy],
    );
  }

  async upsertProcessRatio(tenantId: string, v: { kind: ProcessRatio['kind']; categoryCode: string | null; min: number; max: number; source: string; updatedBy: string }): Promise<void> {
    const updated = await this.db.query(
      `UPDATE process_ratios SET min_ratio = $4, max_ratio = $5, source = $6, updated_by = $7, updated_at = now()
        WHERE tenant_id = $1 AND kind = $2 AND category_code IS NOT DISTINCT FROM $3`,
      [tenantId, v.kind, v.categoryCode, v.min, v.max, v.source, v.updatedBy],
    );
    if (updated.rowCount) return;
    await this.db.query(
      `INSERT INTO process_ratios (tenant_id, kind, category_code, min_ratio, max_ratio, source, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, v.kind, v.categoryCode, v.min, v.max, v.source, v.updatedBy],
    );
  }

  async upsertYieldCap(tenantId: string, v: { productTypeId: string; region: string | null; maxKgPerHa: number; source: string; updatedBy: string }): Promise<void> {
    const updated = await this.db.query(
      `UPDATE yield_caps SET max_kg_per_ha = $4, source = $5, updated_by = $6, updated_at = now()
        WHERE tenant_id = $1 AND product_type_id = $2 AND catalog_norm(region) IS NOT DISTINCT FROM catalog_norm($3)`,
      [tenantId, v.productTypeId, v.region, v.maxKgPerHa, v.source, v.updatedBy],
    );
    if (updated.rowCount) return;
    await this.db.query(
      `INSERT INTO yield_caps (tenant_id, product_type_id, region, max_kg_per_ha, source, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, v.productTypeId, v.region, v.maxKgPerHa, v.source, v.updatedBy],
    );
  }

  async upsertProductSettings(tenantId: string, v: { productTypeId: string; transitLossTolerance: number; maxBackdateDays: number; source: string; updatedBy: string }): Promise<void> {
    const updated = await this.db.query(
      `UPDATE product_settings SET transit_loss_tolerance = $3, max_backdate_days = $4, source = $5, updated_by = $6, updated_at = now()
        WHERE tenant_id = $1 AND product_type_id = $2`,
      [tenantId, v.productTypeId, v.transitLossTolerance, v.maxBackdateDays, v.source, v.updatedBy],
    );
    if (updated.rowCount) return;
    await this.db.query(
      `INSERT INTO product_settings (tenant_id, product_type_id, transit_loss_tolerance, max_backdate_days, source, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, v.productTypeId, v.transitLossTolerance, v.maxBackdateDays, v.source, v.updatedBy],
    );
  }

  /** Removes one of the tenant's own overrides (RLS keeps platform rows out of reach). */
  async deleteOverride(table: 'conversion_factors' | 'process_ratios' | 'yield_caps' | 'product_settings', id: string, tenantId: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const r = await this.db.query(`DELETE FROM ${table} WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    return (r.rowCount ?? 0) > 0;
  }
}

export { ZERO_UUID };
