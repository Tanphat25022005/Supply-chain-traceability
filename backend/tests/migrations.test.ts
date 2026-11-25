import { Client, Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { assertSchemaUpToDate, loadMigrationFiles, migrate } from '../src/db/migrator';
import { TraceEvent } from '../src/domain/types';
import { computeEventHashV1, GENESIS_HASH, verifyChainDetailed } from '../src/ledger/hashChain';
import { withDatabase } from './setup/pgUrls';

const LEGACY_KEY = 'legacy-key-from-old-env';
let counter = 0;

/** A brand-new, empty database for one test — migrations need to start from nothing. */
async function freshDatabase(): Promise<{ pool: Pool; drop: () => Promise<void> }> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL!;
  const name = `tc_mig_w${process.env.JEST_WORKER_ID ?? '1'}_${counter++}_${Date.now()}`;
  const admin = new Client({ connectionString: withDatabase(adminUrl, 'postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const pool = new Pool({ connectionString: withDatabase(adminUrl, name), max: 2 });
  return {
    pool,
    drop: async () => {
      await pool.end();
      const c = new Client({ connectionString: withDatabase(adminUrl, 'postgres') });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

// Fresh databases run CREATE EXTENSION postgis, which takes seconds — slower still while other suites run.
jest.setTimeout(120_000);

describe('migrator', () => {
  it('applies every migration on an empty database, then is a no-op', async () => {
    const { pool, drop } = await freshDatabase();
    try {
      const first = await migrate(pool);
      expect(first.applied).toEqual(loadMigrationFiles().map((f) => f.name));
      const second = await migrate(pool);
      expect(second).toEqual({ applied: [], alreadyApplied: first.applied.length });
      await expect(assertSchemaUpToDate(pool)).resolves.toBeUndefined();
    } finally {
      await drop();
    }
  });

  it('serialises concurrent runs (advisory lock) — two replicas booting at once', async () => {
    const { pool, drop } = await freshDatabase();
    try {
      const [a, b] = await Promise.all([migrate(pool), migrate(pool)]);
      expect(a.applied.length + b.applied.length).toBe(loadMigrationFiles().length);
    } finally {
      await drop();
    }
  });

  it('refuses to start on a schema that is behind, uninitialised, or was edited after being applied', async () => {
    const { pool, drop } = await freshDatabase();
    try {
      await expect(assertSchemaUpToDate(pool)).rejects.toThrow(/not initialised/);

      await migrate(pool, { targetVersion: 5 });
      await expect(assertSchemaUpToDate(pool)).rejects.toThrow(/pending migrations: 006_/);

      await migrate(pool);
      await pool.query("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = 3");
      await expect(assertSchemaUpToDate(pool)).rejects.toThrow(/modified after being applied/);
      await expect(migrate(pool)).rejects.toThrow(/modified after being applied/);
    } finally {
      await drop();
    }
  });

  it('upgrades a populated pre-006 database: backfills tenants, chain heads and keeps legacy v1 chains verifiable', async () => {
    const { pool, drop } = await freshDatabase();
    try {
      // ── State as the old application left it (schema 001–005, HMAC events) ──
      await migrate(pool, { targetVersion: 5 });
      const tenantId = '00000000-0000-0000-0000-000000000001'; // backfilled demo tenant from 005
      const actorId = uuidv4();
      const batchId = uuidv4();
      await pool.query(
        `INSERT INTO actors (id, name, email, password_hash, role, organization, tenant_id)
         VALUES ($1, 'Old Farmer', 'old@farm.vn', 'x', 'FARMER', 'Farm', $2)`,
        [actorId, tenantId],
      );
      await pool.query(
        `INSERT INTO batches (id, product_name, product_type, origin, quantity, unit, created_by, tenant_id, current_stage)
         VALUES ($1, 'Cà phê', 'Nông sản', 'Đắk Lắk', 100, 'kg', $2, $3, 'PROCESSING')`,
        [batchId, actorId, tenantId],
      );
      // Two more old lots: an alias that maps ("Lúa gạo" → Gạo, counted in "bao" — known for rice),
      // and a name the catalog doesn't know, which must wait for an admin instead of being guessed.
      const riceId = uuidv4();
      const unknownId = uuidv4();
      await pool.query(
        `INSERT INTO batches (id, product_name, product_type, origin, quantity, unit, created_by, tenant_id)
         VALUES ($1, 'Gạo', 'Lúa gạo', 'Sóc Trăng', 20, 'bao', $3, $4),
                ($2, 'Thứ lạ', 'Hàng tự gõ', 'x', 3, 'thùng', $3, $4)`,
        [riceId, unknownId, actorId, tenantId],
      );
      const legacy: TraceEvent[] = [];
      for (const [seq, stage] of (['HARVEST', 'PROCESSING'] as const).entries()) {
        const unhashed = {
          batchId,
          stage,
          actorId,
          timestamp: new Date(Date.UTC(2026, 0, 1 + seq)),
          location: `loc ${seq}`,
          notes: undefined,
          data: { seq },
          prevHash: seq === 0 ? GENESIS_HASH : legacy[seq - 1].hash,
          sequenceNumber: seq,
        };
        const event: TraceEvent = {
          ...unhashed,
          occurredAt: unhashed.timestamp,
          id: uuidv4(),
          tenantId,
          hashVersion: 1,
          hash: computeEventHashV1(unhashed, LEGACY_KEY),
          kind: 'OBSERVE',
          links: [],
        };
        legacy.push(event);
        await pool.query(
          `INSERT INTO trace_events (id, batch_id, stage, actor_id, timestamp, location, data, hash, prev_hash, sequence_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [event.id, batchId, stage, actorId, event.timestamp, event.location, JSON.stringify(event.data), event.hash, event.prevHash, seq],
        );
      }
      await pool.query(
        `INSERT INTO refresh_tokens (token, actor_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
        ['f'.repeat(64), actorId],
      );

      // ── Upgrade ──
      const result = await migrate(pool);
      expect(result.applied.map((n) => n.slice(0, 3))).toEqual([
        '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019',
      ]);

      // 015: catalog mapping — exact names and curated aliases only.
      const mapped = await pool.query(
        `SELECT b.id, b.product_type, pt.code, b.unit_factor::float AS factor, b.quantity_base::float AS base, b.status, w.code AS workflow
           FROM batches b LEFT JOIN product_types pt ON pt.id = b.product_type_id JOIN workflow_templates w ON w.id = b.workflow_id`,
      );
      const byId = new Map(mapped.rows.map((r) => [r.id, r]));
      expect(byId.get(batchId)).toMatchObject({ product_type: 'Nông sản khác', code: 'OTHER_PRODUCE', factor: 1, base: 100, workflow: 'GENERIC_RETAIL', status: 'ACTIVE' });
      expect(byId.get(riceId)).toMatchObject({ product_type: 'Gạo', code: 'RICE_MILLED', factor: 50, base: 1000 });
      expect(byId.get(unknownId)).toMatchObject({ product_type: 'Hàng tự gõ', code: null, factor: null, base: null });

      const batch = await pool.query('SELECT head_hash, event_count FROM batches WHERE id = $1', [batchId]);
      expect(batch.rows[0]).toEqual({ head_hash: legacy[1].hash, event_count: 2 });

      const events = await pool.query('SELECT tenant_id, hash_version, salt FROM trace_events ORDER BY sequence_number');
      expect(events.rows).toEqual([
        { tenant_id: tenantId, hash_version: 1, salt: null },
        { tenant_id: tenantId, hash_version: 1, salt: null },
      ]);
      const tokens = await pool.query('SELECT tenant_id FROM refresh_tokens');
      expect(tokens.rows).toEqual([{ tenant_id: tenantId }]);

      // The migrated chain still verifies — including against the backfilled head.
      const verification = verifyChainDetailed(legacy, {
        legacyKey: LEGACY_KEY,
        head: { hash: batch.rows[0].head_hash, eventCount: batch.rows[0].event_count },
      });
      expect(verification).toMatchObject({ valid: true, headMatches: true, legacyEventCount: 2 });

      // And new events must extend that exact head.
      await expect(
        pool.query(
          `INSERT INTO trace_events (id, batch_id, tenant_id, stage, actor_id, location, data, hash, prev_hash,
                                     sequence_number, hash_version, salt, timestamp, occurred_at)
           VALUES ($1, $2, $3, 'QUALITY_CHECK', $4, 'x', '{}', $5, $6, 2, 2, $7, now(), now())`,
          [uuidv4(), batchId, tenantId, actorId, 'c'.repeat(64), legacy[1].hash, 'a'.repeat(64)],
        ),
      ).resolves.toBeDefined();
    } finally {
      await drop();
    }
  });
});
