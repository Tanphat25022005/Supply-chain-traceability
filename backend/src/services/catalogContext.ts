import { Batch, Workflow } from '../domain/types';
import { WorkflowRules } from '../domain/workflow';
import { ValidationError } from '../errors';
import { PostgresCatalogRepo, ProductType } from '../repository/postgres/catalogRepo';

/** Used when a product type names no default workflow. */
export const FALLBACK_WORKFLOW_CODE = 'GENERIC_RETAIL';

/**
 * What services need from the catalog about one lot: the rules of the
 * workflow it pins, and the product group its fields are defined for.
 * Workflow rules are immutable per template version, so they are memoised.
 */
export class CatalogContext {
  private readonly rulesCache = new Map<string, WorkflowRules>();

  constructor(readonly catalog: PostgresCatalogRepo) {}

  async rules(workflowId: string): Promise<WorkflowRules> {
    const cached = this.rulesCache.get(workflowId);
    if (cached) return cached;
    const workflow = await this.catalog.workflowById(workflowId);
    if (!workflow) throw new Error(`Unknown workflow ${workflowId}`);
    const rules = new WorkflowRules(workflow, await this.catalog.stageMap());
    this.rulesCache.set(workflowId, rules);
    return rules;
  }

  rulesFor(batch: Pick<Batch, 'workflowId'>): Promise<WorkflowRules> {
    return this.rules(batch.workflowId);
  }

  /** The lot's product type (visible within the current tenant scope), if it has one. */
  async productTypeOf(batch: Pick<Batch, 'productTypeId'>): Promise<ProductType | null> {
    return batch.productTypeId ? this.catalog.productTypeById(batch.productTypeId) : null;
  }

  async categoryOf(batch: Pick<Batch, 'productTypeId'>): Promise<string | null> {
    return (await this.productTypeOf(batch))?.categoryCode ?? null;
  }

  /**
   * A catalog product type from an id, or else a code/name/alias. Unknown or
   * inactive is a validation error — the catalog is the only source of types.
   */
  async resolveProductType(id: string | undefined, text: string | undefined): Promise<ProductType> {
    const found = id ? await this.catalog.productTypeById(id) : text ? await this.catalog.resolveProductType(text) : null;
    if (!found || !found.active) {
      throw new ValidationError(`Unknown product type "${id ?? text ?? ''}" — choose one from the catalog`, [
        { field: id ? 'productTypeId' : 'productType', code: 'invalid_option', message: 'product type is not in the catalog' },
      ]);
    }
    return found;
  }

  /** The workflow a new lot of this product follows: the requested template, else the product's default. */
  async workflowForNewLot(productType: ProductType, code?: string): Promise<Workflow> {
    const wanted = code ?? productType.defaultWorkflowCode ?? FALLBACK_WORKFLOW_CODE;
    const workflow = await this.catalog.latestWorkflow(wanted);
    if (!workflow) {
      throw new ValidationError(`Unknown workflow ${wanted}`, [{ field: 'workflowCode', code: 'invalid_option', message: 'unknown workflow' }]);
    }
    if (workflow.categoryCode && workflow.categoryCode !== productType.categoryCode) {
      throw new ValidationError(`Workflow ${wanted} is not for ${productType.name}`, [
        { field: 'workflowCode', code: 'invalid_option', message: 'workflow belongs to another product group' },
      ]);
    }
    return workflow;
  }
}
