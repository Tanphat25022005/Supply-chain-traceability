import { z } from 'zod';

const ROLES = ['FARMER', 'COLLECTOR', 'PROCESSOR', 'WAREHOUSE', 'INSPECTOR', 'EXPORTER', 'DISTRIBUTOR', 'RETAILER', 'IMPORTER', 'ADMIN'] as const;
/** IMPORTER comes from a receipt link, never from an invitation or a role change. */
const ASSIGNABLE_ROLES = ['FARMER', 'COLLECTOR', 'PROCESSOR', 'WAREHOUSE', 'INSPECTOR', 'EXPORTER', 'DISTRIBUTOR', 'RETAILER', 'ADMIN'] as const;
const LOT_STATUSES = ['ACTIVE', 'IN_TRANSIT', 'ON_HOLD', 'REJECTED', 'RECALLED', 'DESTROYED', 'CONSUMED'] as const;

/** A stage code of the catalog — which ones a lot may use is checked against its workflow. */
const stageCode = z.string().trim().regex(/^[A-Z][A-Z_]{1,40}$/, 'Stage code');
const reason = z.string().trim().min(1).max(1000);
/** When something happened — ISO date-time; the service refuses the future and checks the past. */
const occurredAt = z.coerce.date().optional();
const lateReason = z.string().trim().min(1).max(500).optional();

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const registerBase = {
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  password: z.string().min(8).max(200),
  organization: z.string().trim().min(1).max(200),
};

/**
 * Two ways in, and neither lets the registrant pick a role:
 *   • `workspace` founds a new tenant — the registrant becomes its ADMIN;
 *   • `invite` redeems a code an ADMIN issued — the role is the invitation's.
 * Joining an existing tenant by knowing its slug is no longer possible.
 */
export const registerSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('workspace'),
    ...registerBase,
    // Workspace identifier (like a Slack workspace slug). Lowercase + hyphens
    // only, matching how it's displayed/typed (e.g. "acme-coffee").
    tenantSlug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(60)
      .regex(/^[a-z0-9-]+$/, 'Chỉ dùng chữ thường, số và dấu gạch ngang'),
    tenantName: z.string().trim().min(1).max(200),
  }),
  z.object({
    mode: z.literal('invite'),
    ...registerBase,
    inviteCode: z.string().trim().min(8).max(40),
  }),
]);

export const createInvitationSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
  email: z.string().trim().email().optional(),
  note: z.string().trim().max(200).optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

/** A catalog product type, by id or by code/name/alias. */
const productTypeRef = {
  productTypeId: z.string().uuid().optional(),
  productType: z.string().trim().min(1).max(200).optional(),
};
const hasProductType = (v: { productTypeId?: string; productType?: string }) => !!(v.productTypeId || v.productType);

export const createBatchSchema = z
  .object({
    productName: z.string().trim().min(1).max(200),
    ...productTypeRef,
    origin: z.string().trim().min(1).max(200),
    quantity: z.number().finite().positive(),
    unit: z.string().trim().min(1).max(50),
    metadata: z.record(z.string(), z.unknown()).optional(),
    plotId: z.string().uuid().optional(),
    workflowCode: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,40}$/).optional(),
  })
  .refine(hasProductType, 'productTypeId or productType is required');

const scalar = z.union([z.string().trim().max(500), z.number().finite(), z.boolean()]);

export const createTransformationSchema = z.object({
  kind: z.enum(['MERGE', 'SPLIT', 'TRANSFORM', 'REWORK', 'DOWNGRADE']),
  stage: stageCode,
  location: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
  data: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), scalar).optional(),
  inputs: z
    .array(z.object({ lotId: z.string().uuid(), quantity: z.number().finite().positive() }))
    .min(1)
    .max(500),
  outputs: z
    .array(
      z
        .object({
          productName: z.string().trim().min(1).max(200),
          ...productTypeRef,
          quantity: z.number().finite().positive(),
          unit: z.string().trim().min(1).max(50),
        })
        .refine(hasProductType, 'productTypeId or productType is required'),
    )
    .min(1)
    .max(50),
  assignNextTo: z.string().uuid().optional(),
  occurredAt,
  lateReason,
});

const position = z.array(z.number().finite()).min(2).max(3);
const ring = z.array(position).min(4);
export const geometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: position }),
  z.object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring).min(1)).min(1) }),
]);

export const createPlotSchema = z.object({
  code: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  geometry: geometrySchema,
  declaredAreaHa: z.number().finite().positive().max(100000).optional(),
  ownerActorId: z.string().uuid().optional(),
});

export const importPlotsSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z
    .array(z.object({ type: z.literal('Feature').optional(), geometry: geometrySchema, properties: z.record(z.string(), z.unknown()).nullish() }))
    .min(1)
    .max(1000),
});

export const handOffSchema = z.object({
  assignNextTo: z.string().uuid(),
});

export const createTransferSchema = z.object({
  toActorId: z.string().uuid(),
  packageCount: z.number().int().positive().max(1_000_000).optional(),
  vehicle: z.string().trim().min(1).max(40).optional(),
  documentNo: z.string().trim().min(1).max(60).optional(),
  location: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
  occurredAt,
  lateReason,
});

export const respondTransferSchema = z
  .object({
    accept: z.boolean(),
    receivedQuantity: z.number().finite().min(0).optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
    location: z.string().trim().min(1).max(200).optional(),
    occurredAt,
    lateReason,
  })
  .refine((v) => (v.accept ? v.receivedQuantity !== undefined : !!v.reason), 'accept needs receivedQuantity; reject needs reason');

export const recallBatchSchema = z.object({
  reason,
  /** true: recall every lot made from this one; otherwise they are put on hold for investigation. */
  cascade: z.boolean().optional(),
});

export const reasonSchema = z.object({ reason });

export const disposeBatchSchema = z.object({
  recordNo: z.string().trim().min(1).max(60),
  method: z.string().trim().min(1).max(200),
  witness: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000).optional(),
  occurredAt,
});

export const receiptLinkSchema = z.object({
  importerName: z.string().trim().min(1).max(200),
  days: z.number().int().min(1).max(90).default(30),
});

export const importReceiptSchema = z.object({
  token: z.string().min(10),
  receivedQuantity: z.number().finite().min(0),
  condition: z.enum(['GOOD', 'DAMAGED', 'REJECTED']),
  location: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
});

// Stage-specific facts (moisture, grade, destination...). Flat key → scalar
// only: the values end up in the hash preimage and on printed reports, so
// nested objects or huge blobs have no business here.
const eventDataValue = z.union([z.string().trim().max(500), z.number().finite(), z.boolean()]);
const eventDataSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), eventDataValue)
  .refine((d) => Object.keys(d).length <= 30, 'Too many data fields');

export const recordEventSchema = z.object({
  batchId: z.string().trim().min(1),
  stage: stageCode,
  location: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
  data: eventDataSchema.optional(),
  // Who takes custody next — required (enforced in SupplyChainService, not
  // here, since it's conditional on role/stage) for non-ADMIN actors advancing
  // to a non-terminal stage.
  assignNextTo: z.string().trim().min(1).optional(),
  occurredAt,
  lateReason,
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Capped at 500 rather than 100: the Kanban board and the "existing batch"
  // picker in RecordEvent both need a single unpaginated-feeling fetch of
  // every open batch, which comfortably fits below that ceiling at demo scale.
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
  search: z.string().trim().max(200).optional(),
  // A stage, or NONE for batches with no event yet — powers the Kanban columns.
  stage: z.union([stageCode, z.literal('NONE')]).optional(),
  status: z.enum(LOT_STATUSES).optional(),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  organization: z.string().trim().min(1).max(200).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

export const anomalyListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  // z.coerce.boolean() would turn the string "false" into `true` (any non-empty
  // string is truthy) — parse the literal query values explicitly instead.
  resolved: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
});

export const setActorStatusSchema = z.object({
  isActive: z.boolean(),
});

export const setActorRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
});

// ── Catalog ─────────────────────────────────────────────────────────────────

const workflowCode = z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,40}$/);

export const createProductTypeSchema = z.object({
  categoryCode: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,30}$/),
  code: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{1,40}$/),
  name: z.string().trim().min(1).max(120),
  baseUnit: z.enum(['kg', 'cái']),
  gtin: z.string().trim().regex(/^([0-9]{8}|[0-9]{12,14})$/).optional(),
  defaultWorkflowCode: workflowCode.optional(),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
});

export const updateProductTypeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  gtin: z.string().trim().regex(/^([0-9]{8}|[0-9]{12,14})$/).nullable().optional(),
  defaultWorkflowCode: workflowCode.nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  active: z.boolean(),
});

export const createUnitSchema = z.object({
  productTypeId: z.string().uuid(),
  code: z.string().trim().min(1).max(30),
  label: z.string().trim().min(1).max(60),
  factor: z.number().finite().positive().max(1_000_000),
});

export const mapUnmappedSchema = z.object({
  productType: z.string().min(1).max(200),
  unit: z.string().min(1).max(50),
  productTypeId: z.string().uuid(),
  unitFactor: z.number().finite().positive().max(1_000_000).optional(),
});

const source = z.string().trim().min(3).max(500);
const ratio = z.number().finite().positive().max(1000);

export const conversionFactorSchema = z.object({
  fromTypeId: z.string().uuid(),
  toTypeId: z.string().uuid(),
  min: ratio,
  max: ratio,
  source,
});

export const processRatioSchema = z.object({
  kind: z.enum(['MERGE', 'SPLIT', 'REWORK', 'DOWNGRADE']),
  categoryCode: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,30}$/).nullable(),
  min: z.number().finite().positive().max(1),
  max: z.number().finite().positive().max(1),
  source,
});

export const yieldCapSchema = z.object({
  productTypeId: z.string().uuid(),
  region: z.string().trim().min(2).max(100).nullable(),
  maxKgPerHa: z.number().finite().positive().max(1_000_000),
  source,
});

export const productSettingsSchema = z.object({
  productTypeId: z.string().uuid(),
  transitLossTolerance: z.number().finite().min(0).max(0.5),
  maxBackdateDays: z.number().int().min(0).max(365),
  source,
});

export const exportBatchesQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  origin: z.string().trim().max(200).optional(),
  format: z.enum(['csv', 'json']).default('csv'),
});

export const verificationLinkSchema = z.object({
  days: z.number().int().min(1).max(30).default(7),
});

export const reportQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    productType: z.string().trim().min(1).max(200).optional(),
    origin: z.string().trim().min(1).max(200).optional(),
    workflowCode: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,40}$/).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, 'from must be before to');
