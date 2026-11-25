import { v4 as uuidv4 } from 'uuid';
import { Database, isUniqueViolation } from '../db/database';
import { FieldSchema } from '../domain/fieldSchema';
import { Actor, Stage, Workflow } from '../domain/types';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { IAuditLogRepo } from '../repository/interfaces';
import {
  ConversionFactor,
  PostgresCatalogRepo,
  ProcessRatio,
  ProductCategory,
  ProductSettings,
  ProductType,
  Unit,
  UnmappedGroup,
  YieldCap,
} from '../repository/postgres/catalogRepo';

export interface CatalogView {
  stages: Stage[];
  workflows: Workflow[];
  categories: ProductCategory[];
  productTypes: ProductType[];
  units: Unit[];
  fieldSchemas: FieldSchema[];
}

export interface ReferenceDataView {
  conversionFactors: ConversionFactor[];
  processRatios: ProcessRatio[];
  yieldCaps: YieldCap[];
  productSettings: ProductSettings[];
}

export type ReferenceTable = 'conversion_factors' | 'process_ratios' | 'yield_caps' | 'product_settings';

export interface CreateProductTypeDTO {
  categoryCode: string;
  code: string;
  name: string;
  baseUnit: 'kg' | 'cái';
  gtin?: string;
  defaultWorkflowCode?: string;
  aliases?: string[];
}

export interface UpdateProductTypeDTO {
  name: string;
  gtin?: string | null;
  defaultWorkflowCode?: string | null;
  aliases?: string[];
  active: boolean;
}

export interface CreateUnitDTO {
  productTypeId: string;
  code: string;
  label: string;
  factor: number;
}

export interface MapUnmappedDTO {
  /** The old free-text product type of the lots. */
  productType: string;
  unit: string;
  productTypeId: string;
  /** Base units per old unit — required when the old unit isn't one the catalog knows for this product. */
  unitFactor?: number;
}

/**
 * The catalog as an API (docs/SPEC_PHASE1_5.md §1–§4): what everyone reads
 * (stages, workflow templates, product types, units, field schemas), what a
 * tenant ADMIN may add (own product types and units), the queue of old lots
 * waiting to be linked to the catalog, and the mass-balance reference data —
 * platform values with sources, tenant overrides on top. Every change lands
 * in the tenant's audit log.
 */
export class CatalogService {
  constructor(
    private readonly db: Database,
    private readonly catalog: PostgresCatalogRepo,
    private readonly auditLogRepo: IAuditLogRepo,
  ) {}

  /** The platform catalog — public (the consumer and verifier pages render labels and fields from it). */
  async publicCatalog(): Promise<CatalogView> {
    return this.view();
  }

  /** The catalog as a tenant sees it: platform rows plus its own product types and units. */
  async tenantCatalog(actor: Actor): Promise<CatalogView> {
    return this.db.withTenant(actor.tenantId, () => this.view());
  }

  private async view(): Promise<CatalogView> {
    const [stages, workflows, categories, productTypes, units, fieldSchemas] = await Promise.all([
      this.catalog.stages(),
      this.catalog.workflows(),
      this.catalog.categories(),
      this.catalog.productTypes(),
      this.catalog.units(),
      this.catalog.fieldSchemas(),
    ]);
    return { stages, workflows, categories, productTypes, units, fieldSchemas };
  }

  // ── Tenant product types and units ──────────────────────────────────────

  async createProductType(admin: Actor, dto: CreateProductTypeDTO): Promise<ProductType> {
    this.requireAdmin(admin);
    return this.db.withTenant(admin.tenantId, async () => {
      if (!(await this.catalog.categories()).some((c) => c.code === dto.categoryCode)) {
        throw new ValidationError('Unknown product group', [{ field: 'categoryCode', code: 'invalid_option', message: 'unknown category' }]);
      }
      // A tenant type may not shadow a platform one under the same name or alias.
      const clash = await this.catalog.resolveProductType(dto.name);
      if (clash) throw new ConflictError(`A product type named like "${dto.name}" already exists (${clash.code})`);
      await this.checkWorkflow(dto.defaultWorkflowCode, dto.categoryCode);
      try {
        const created = await this.catalog.createProductType({
          id: uuidv4(),
          tenantId: admin.tenantId,
          categoryCode: dto.categoryCode,
          code: dto.code.trim().toUpperCase(),
          name: dto.name.trim(),
          baseUnit: dto.baseUnit,
          gtin: dto.gtin,
          defaultWorkflowCode: dto.defaultWorkflowCode,
          aliases: (dto.aliases ?? []).map((a) => a.trim()).filter(Boolean),
          createdBy: admin.id,
        });
        await this.audit(admin, 'PRODUCT_TYPE_CREATED', 'product_type', created.id, { code: created.code, name: created.name });
        return created;
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictError('Product type code or name already exists');
        throw err;
      }
    });
  }

  async updateProductType(admin: Actor, id: string, dto: UpdateProductTypeDTO): Promise<ProductType> {
    this.requireAdmin(admin);
    return this.db.withTenant(admin.tenantId, async () => {
      const existing = await this.catalog.productTypeById(id);
      if (!existing || existing.tenantId !== admin.tenantId) throw new NotFoundError('Product type not found (platform types cannot be edited)');
      await this.checkWorkflow(dto.defaultWorkflowCode ?? undefined, existing.categoryCode);
      const updated = await this.catalog.updateProductType(id, {
        name: dto.name.trim(),
        gtin: dto.gtin ?? null,
        defaultWorkflowCode: dto.defaultWorkflowCode ?? null,
        aliases: (dto.aliases ?? existing.aliases).map((a) => a.trim()).filter(Boolean),
        active: dto.active,
      });
      await this.audit(admin, 'PRODUCT_TYPE_UPDATED', 'product_type', id, { before: existing, after: updated });
      return updated!;
    });
  }

  async createUnit(admin: Actor, dto: CreateUnitDTO): Promise<Unit> {
    this.requireAdmin(admin);
    return this.db.withTenant(admin.tenantId, async () => {
      const productType = await this.catalog.productTypeById(dto.productTypeId);
      if (!productType) throw new NotFoundError('Product type not found');
      if (await this.catalog.unitFor(productType, dto.code)) throw new ConflictError(`Unit "${dto.code}" already exists for ${productType.name}`);
      const unit = await this.catalog.createUnit({
        id: uuidv4(),
        tenantId: admin.tenantId,
        productTypeId: productType.id,
        baseUnit: productType.baseUnit,
        code: dto.code.trim(),
        label: dto.label.trim(),
        factor: dto.factor,
      });
      await this.audit(admin, 'UNIT_CREATED', 'unit', unit.id, { productTypeId: productType.id, code: unit.code, factor: unit.factor });
      return unit;
    });
  }

  // ── Mapping queue ───────────────────────────────────────────────────────

  async unmapped(admin: Actor): Promise<UnmappedGroup[]> {
    this.requireAdmin(admin);
    return this.db.withTenant(admin.tenantId, () => this.catalog.unmappedGroups(admin.tenantId));
  }

  /** Links every old lot with this free-text type and unit to a catalog product — an admin's explicit decision, never a guess. */
  async mapUnmapped(admin: Actor, dto: MapUnmappedDTO): Promise<{ mapped: number }> {
    this.requireAdmin(admin);
    return this.db.withTenant(admin.tenantId, async () => {
      const productType = await this.catalog.productTypeById(dto.productTypeId);
      if (!productType || !productType.active) throw new NotFoundError('Product type not found');
      const known = await this.catalog.unitFor(productType, dto.unit);
      const factor = dto.unitFactor ?? known?.factor;
      if (!factor) {
        throw new ValidationError(`How many ${productType.baseUnit} is one "${dto.unit}"? — unitFactor is required`, [
          { field: 'unitFactor', code: 'required', message: 'unitFactor is required for an unknown unit' },
        ]);
      }
      const mapped = await this.catalog.mapGroup(admin.tenantId, dto.productType, dto.unit, productType, factor);
      await this.audit(admin, 'BATCHES_MAPPED_TO_CATALOG', 'product_type', productType.id, {
        oldProductType: dto.productType,
        unit: dto.unit,
        unitFactor: factor,
        mapped,
      });
      return { mapped };
    });
  }

  // ── Reference data ──────────────────────────────────────────────────────

  async referenceData(actor: Actor): Promise<ReferenceDataView> {
    return this.db.withTenant(actor.tenantId, () => this.catalog.referenceData());
  }

  async setConversionFactor(admin: Actor, v: { fromTypeId: string; toTypeId: string; min: number; max: number; source: string }): Promise<ReferenceDataView> {
    this.requireAdmin(admin);
    this.checkRatio(v.min, v.max, false);
    return this.db.withTenant(admin.tenantId, async () => {
      await this.requireTypes(v.fromTypeId, v.toTypeId);
      if (v.fromTypeId === v.toTypeId) throw new ValidationError('A conversion is between two different products');
      const before = await this.catalog.conversionFactor(v.fromTypeId, v.toTypeId);
      await this.catalog.upsertConversionFactor(admin.tenantId, { ...v, source: v.source.trim(), updatedBy: admin.id });
      await this.audit(admin, 'REFERENCE_DATA_CHANGED', 'conversion_factors', `${v.fromTypeId}:${v.toTypeId}`, { before, after: v });
      return this.catalog.referenceData();
    });
  }

  async setProcessRatio(
    admin: Actor,
    v: { kind: ProcessRatio['kind']; categoryCode: string | null; min: number; max: number; source: string },
  ): Promise<ReferenceDataView> {
    this.requireAdmin(admin);
    this.checkRatio(v.min, v.max, true);
    return this.db.withTenant(admin.tenantId, async () => {
      const before = await this.catalog.processRatio(v.kind, v.categoryCode);
      await this.catalog.upsertProcessRatio(admin.tenantId, { ...v, source: v.source.trim(), updatedBy: admin.id });
      await this.audit(admin, 'REFERENCE_DATA_CHANGED', 'process_ratios', `${v.kind}:${v.categoryCode ?? '*'}`, { before, after: v });
      return this.catalog.referenceData();
    });
  }

  async setYieldCap(admin: Actor, v: { productTypeId: string; region: string | null; maxKgPerHa: number; source: string }): Promise<ReferenceDataView> {
    this.requireAdmin(admin);
    if (!(v.maxKgPerHa > 0)) throw new ValidationError('maxKgPerHa must be positive');
    return this.db.withTenant(admin.tenantId, async () => {
      await this.requireTypes(v.productTypeId);
      await this.catalog.upsertYieldCap(admin.tenantId, { ...v, region: v.region?.trim() || null, source: v.source.trim(), updatedBy: admin.id });
      await this.audit(admin, 'REFERENCE_DATA_CHANGED', 'yield_caps', `${v.productTypeId}:${v.region ?? '*'}`, { after: v });
      return this.catalog.referenceData();
    });
  }

  async setProductSettings(
    admin: Actor,
    v: { productTypeId: string; transitLossTolerance: number; maxBackdateDays: number; source: string },
  ): Promise<ReferenceDataView> {
    this.requireAdmin(admin);
    return this.db.withTenant(admin.tenantId, async () => {
      await this.requireTypes(v.productTypeId);
      const before = await this.catalog.productSettings(v.productTypeId);
      await this.catalog.upsertProductSettings(admin.tenantId, { ...v, source: v.source.trim(), updatedBy: admin.id });
      await this.audit(admin, 'REFERENCE_DATA_CHANGED', 'product_settings', v.productTypeId, { before, after: v });
      return this.catalog.referenceData();
    });
  }

  /** Drops one of the tenant's overrides — the platform value applies again. */
  async deleteOverride(admin: Actor, table: ReferenceTable, id: string): Promise<ReferenceDataView> {
    this.requireAdmin(admin);
    return this.db.withTenant(admin.tenantId, async () => {
      if (!(await this.catalog.deleteOverride(table, id, admin.tenantId))) {
        throw new NotFoundError('Override not found (platform values cannot be deleted)');
      }
      await this.audit(admin, 'REFERENCE_DATA_CHANGED', table, id, { deleted: true });
      return this.catalog.referenceData();
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private requireAdmin(actor: Actor): void {
    if (actor.role !== 'ADMIN') throw new ForbiddenError('Only an admin can change the catalog');
  }

  private checkRatio(min: number, max: number, atMostOne: boolean): void {
    if (!(min > 0) || !(max >= min) || (atMostOne && max > 1)) {
      throw new ValidationError(`Ratios must satisfy 0 < min ≤ max${atMostOne ? ' ≤ 1' : ''}`, [
        { field: 'max', code: 'invalid_option', message: 'invalid ratio bounds' },
      ]);
    }
  }

  private async requireTypes(...ids: string[]): Promise<void> {
    for (const id of ids) if (!(await this.catalog.productTypeById(id))) throw new NotFoundError('Product type not found');
  }

  private async checkWorkflow(code: string | undefined, categoryCode: string): Promise<void> {
    if (!code) return;
    const workflow = await this.catalog.latestWorkflow(code);
    if (!workflow) throw new ValidationError(`Unknown workflow ${code}`, [{ field: 'defaultWorkflowCode', code: 'invalid_option', message: 'unknown workflow' }]);
    if (workflow.categoryCode && workflow.categoryCode !== categoryCode) {
      throw new ValidationError(`Workflow ${code} belongs to another product group`, [
        { field: 'defaultWorkflowCode', code: 'invalid_option', message: 'workflow belongs to another product group' },
      ]);
    }
  }

  private async audit(actor: Actor, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.auditLogRepo.create({
      id: uuidv4(),
      actorId: actor.id,
      tenantId: actor.tenantId,
      action,
      entityType,
      entityId,
      metadata: JSON.parse(JSON.stringify(metadata)),
      createdAt: new Date(),
    });
  }
}
