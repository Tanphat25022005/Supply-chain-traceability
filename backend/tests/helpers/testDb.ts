import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { AppContext, createContext } from '../../src/bootstrap';
import { Database } from '../../src/db/database';
import { APP_DB_ROLE } from '../../src/db/roles';
import { Actor, ActorRole, Tenant } from '../../src/domain/types';
import { PostgresActorRepo } from '../../src/repository/postgres/actorRepo';
import { PostgresTenantRepo } from '../../src/repository/postgres/tenantRepo';
import { APP_ROLE_TEST_PASSWORD, withDatabase, workerDatabaseName } from '../setup/pgUrls';

export const TEST_JWT_SECRET = 'test-jwt-secret';
export const TEST_LEGACY_KEY = 'test-legacy-ledger-key';

export interface TestDb {
  /** The application's Database, connected as the least-privilege `tracechain_app` role. */
  db: Database;
  /** Superuser pool for test setup and for simulating attacks that bypass the app (tampering). */
  ownerPool: Pool;
  ctx: AppContext;
}

/** Tenant data, wiped before every test. */
const TENANT_TABLES = [
  'anchor_leaves',
  'anchors',
  'batch_holds',
  'transfers',
  'anomalies',
  'audit_logs',
  'refresh_tokens',
  'transformation_outputs',
  'transformation_inputs',
  'transformations',
  'trace_events',
  'batches',
  'plots',
  'invitations',
];
/** Catalog tables shared by the platform and tenants: only the tenant rows go, the platform rows (migrations 015–019) stay. */
const CATALOG_TABLES = ['product_settings', 'yield_caps', 'process_ratios', 'conversion_factors', 'units', 'product_types'];

/**
 * Registers beforeAll/beforeEach/afterAll hooks for a test file and returns
 * an accessor. Every test starts from empty tables in this worker's own
 * database (see setup/globalSetup.ts).
 */
export function useTestDatabase(options: { legacyKey?: string } = {}): () => TestDb {
  let current: TestDb | undefined;

  beforeAll(() => {
    const adminUrl = process.env.TEST_PG_ADMIN_URL;
    if (!adminUrl) throw new Error('TEST_PG_ADMIN_URL missing — tests must run through jest globalSetup');
    const database = workerDatabaseName(process.env.JEST_WORKER_ID ?? '1');

    const ownerPool = new Pool({ connectionString: withDatabase(adminUrl, database), max: 2 });
    const appPool = new Pool({
      connectionString: withDatabase(adminUrl, database, { user: APP_DB_ROLE, password: APP_ROLE_TEST_PASSWORD }),
      max: 10,
    });
    const db = new Database(appPool);
    const ctx = createContext(db, {
      jwtSecret: TEST_JWT_SECRET,
      legacyLedgerKey: options.legacyKey ?? TEST_LEGACY_KEY,
      auth: { bcryptCost: 4, accessTokenTtlSeconds: 3600 },
    });
    current = { db, ownerPool, ctx };
  });

  beforeEach(async () => {
    // replica mode skips (non-ALWAYS) triggers — the append-only guards and
    // the foreign-key checks — so the per-test reset can delete in any order.
    // (TRUNCATE ... CASCADE would also wipe the platform catalog, which
    // references tenants.)
    const client = await current!.ownerPool.connect();
    try {
      await client.query('SET session_replication_role = replica');
      for (const table of TENANT_TABLES) await client.query(`DELETE FROM ${table}`);
      for (const table of CATALOG_TABLES) await client.query(`DELETE FROM ${table} WHERE tenant_id IS NOT NULL`);
      await client.query('DELETE FROM actors');
      await client.query('DELETE FROM tenants');
    } finally {
      await client.query('RESET session_replication_role');
      client.release();
    }
  });

  afterAll(async () => {
    await current?.db.close();
    await current?.ownerPool.end();
  });

  return () => {
    if (!current) throw new Error('useTestDatabase() accessor called outside a test');
    return current;
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

export async function createTenant(t: TestDb, slug = `t-${uuidv4().slice(0, 8)}`): Promise<Tenant> {
  const tenant = { id: uuidv4(), slug, name: `Tenant ${slug}`, createdAt: new Date() };
  const created = await new PostgresTenantRepo(t.db).insertIfAbsent(tenant);
  if (!created) throw new Error(`tenant slug ${slug} already exists`);
  return created;
}

/** Inserts an actor directly (no bcrypt) through the app role — for tests that don't exercise login. */
export async function createActor(t: TestDb, tenant: Tenant, role: ActorRole, overrides: Partial<Actor> = {}): Promise<Actor> {
  const id = overrides.id ?? uuidv4();
  const actor: Actor = {
    id,
    name: `${role} ${id.slice(0, 4)}`,
    email: `${role.toLowerCase()}-${id}@test.local`,
    passwordHash: 'not-a-real-hash',
    role,
    organization: `${role} Org`,
    tenantId: tenant.id,
    createdAt: new Date(),
    isActive: true,
    ...overrides,
  };
  await t.db.withTenant(tenant.id, () => new PostgresActorRepo(t.db).create(actor));
  return actor;
}

/** Runs SQL as the superuser with triggers disabled — the "attacker with direct DB access" for tamper tests. */
export async function asAttacker(t: TestDb, sql: string, params: unknown[] = []): Promise<void> {
  const client = await t.ownerPool.connect();
  try {
    await client.query('SET session_replication_role = replica');
    await client.query(sql, params);
  } finally {
    await client.query('RESET session_replication_role');
    client.release();
  }
}

export const sampleBatch = {
  productName: 'Cà phê Robusta',
  productType: 'Nông sản',
  origin: 'Buôn Ma Thuột, Đắk Lắk',
  quantity: 1000,
  unit: 'kg',
};

/**
 * Minimal data that satisfies each stage's generic field schema (migration
 * 017) — the server now refuses a stage record missing a required field.
 */
export const STAGE_DATA: Record<string, Record<string, string | number | boolean>> = {
  HARVEST: {},
  COLLECTION: { collectionPoint: 'Điểm thu mua' },
  DRYING: { method: 'SUN', moisture: 12.5 },
  PROCESSING: { method: 'WET' },
  MILLING: {},
  ROASTING: { roastLevel: 'MEDIUM' },
  WAREHOUSING: { warehouseName: 'Kho A' },
  QUALITY_CHECK: { result: 'PASS' },
  PACKAGING: { packageType: 'BAG_60KG', packageCount: 10 },
  CONTAINER_STUFFING: { containerNo: 'MSKU1234567', sealNo: 'S-1', bagCount: 10 },
  EXPORT: {
    customsDeclarationNo: '305000000001',
    containerNo: 'MSKU1234567',
    sealNo: 'S-1',
    billOfLading: 'BL-1',
    phytoCertNo: 'KD-1',
    portOfLoading: 'Cát Lái',
    portOfDischarge: 'Hamburg',
    importerName: 'Importer GmbH',
  },
  COLD_CHAIN: { destination: 'Kho lạnh', temperature: 4 },
  DISTRIBUTION: { destination: 'Kho phân phối' },
  RETAIL: { storeName: 'Cửa hàng' },
  IMPORT_RECEIPT: { receivedQuantity: 1, condition: 'GOOD' },
};

/** Coffee lots follow COFFEE_EXPORT (required steps, collector/exporter roles). */
export const coffeeCherry = { ...sampleBatch, productName: 'Cà phê quả tươi', productType: 'Cà phê quả tươi' };

/** The receiver confirms the lot's pending hand-over (the full quantity unless given). */
export async function acceptHandOver(t: TestDb, receiver: Actor, batchId: string, receivedQuantity?: number, occurredAt?: Date) {
  const pending = (await t.ctx.supplyChainService.listIncomingTransfers(receiver)).find((x) => x.batchId === batchId);
  if (!pending) throw new Error(`no hand-over of ${batchId} waiting for ${receiver.role}`);
  return t.ctx.supplyChainService.respondTransfer(receiver, pending.id, {
    accept: true,
    receivedQuantity: receivedQuantity ?? pending.quantity,
    occurredAt,
  });
}

/**
 * Records a stage with valid minimal data; when it hands the lot to someone
 * else, that person accepts — the old one-step hand-off, now two-way.
 */
export async function step(
  t: TestDb,
  actor: Actor,
  batchId: string,
  stage: string,
  opts: { assignNextTo?: Actor; data?: Record<string, string | number | boolean>; location?: string; occurredAt?: Date } = {},
) {
  const event = await t.ctx.supplyChainService.recordEvent(actor, {
    batchId,
    stage,
    location: opts.location ?? `loc ${stage}`,
    data: { ...STAGE_DATA[stage], ...opts.data },
    assignNextTo: opts.assignNextTo?.id,
    occurredAt: opts.occurredAt,
  });
  if (opts.assignNextTo && opts.assignNextTo.id !== actor.id) {
    const pending = (await t.ctx.supplyChainService.listIncomingTransfers(opts.assignNextTo)).find((x) => x.batchId === batchId);
    // Received the moment it was handed over, so a back-dated next step stays possible.
    if (pending) await acceptHandOver(t, opts.assignNextTo, batchId, undefined, opts.occurredAt);
  }
  return event;
}
