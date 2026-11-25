-- 018: Lot status, holds, two-way transfers, occurred-at time, hash v4
-- (docs/SPEC_PHASE1_5.md §0 — "Đợt 0").
--
-- 1. A lot has a status instead of a bare "recalled" flag:
--      ACTIVE      — normal
--      IN_TRANSIT  — handed over, waiting for the receiver to confirm
--      ON_HOLD     — frozen pending investigation (e.g. an input lot was recalled)
--      REJECTED    — failed inspection; only rework, downgrade or disposal remain
--      RECALLED    — withdrawn; final (the goods may still be destroyed)
--      DESTROYED   — disposed of with a record; final
--      CONSUMED    — entirely used up by merges/splits/transformations (or lost)
--    Allowed transitions are enforced here, not just in the application.
-- 2. Every status change is a ledger event (RECALL, HOLD, RELEASE, DISPOSE,
--    TRANSFER_*), so it is hash-chained and anchored like any stage record.
-- 3. A hand-over is a transfer the receiver accepts (with the quantity they
--    weighed) or rejects; custody moves only on acceptance.
-- 4. occurred_at (declared: when it happened) is separate from timestamp
--    (server: when it was recorded). Hash v4 commits to both.

-- ── Lot status ──────────────────────────────────────────────────────────────
ALTER TABLE batches ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (
  status IN ('ACTIVE', 'IN_TRANSIT', 'ON_HOLD', 'REJECTED', 'RECALLED', 'DESTROYED', 'CONSUMED')
);
-- Quantity that left the lot without going into another lot: transit
-- shortfall, disposal. consumed + lost never exceeds quantity.
ALTER TABLE batches ADD COLUMN lost_quantity NUMERIC NOT NULL DEFAULT 0 CHECK (lost_quantity >= 0);

UPDATE batches SET status = 'RECALLED' WHERE is_recalled;
UPDATE batches SET status = 'CONSUMED' WHERE NOT is_recalled AND consumed_quantity >= quantity;

ALTER TABLE batches DROP CONSTRAINT batches_recall_reason_required;
ALTER TABLE batches DROP COLUMN is_recalled;
-- Kept as a derived column: reports and older queries keep working.
ALTER TABLE batches ADD COLUMN is_recalled BOOLEAN GENERATED ALWAYS AS (status = 'RECALLED') STORED;
ALTER TABLE batches ADD CONSTRAINT batches_recall_reason_required CHECK (status <> 'RECALLED' OR recall_reason IS NOT NULL);

ALTER TABLE batches DROP CONSTRAINT batches_consumed_within_quantity;
ALTER TABLE batches ADD CONSTRAINT batches_consumed_within_quantity CHECK (
  consumed_quantity >= 0 AND consumed_quantity + lost_quantity <= quantity
);

CREATE INDEX idx_batches_tenant_status ON batches (tenant_id, status);

-- ── Guard: what may change on a lot, and how ────────────────────────────────
CREATE OR REPLACE FUNCTION batches_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workflow_id IS DISTINCT FROM OLD.workflow_id THEN
    RAISE EXCEPTION 'batch %: workflow cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.event_count < OLD.event_count THEN
    RAISE EXCEPTION 'batch %: ledger head cannot move backwards', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.consumed_quantity < OLD.consumed_quantity THEN
    RAISE EXCEPTION 'batch %: consumed quantity cannot decrease', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lost_quantity < OLD.lost_quantity THEN
    RAISE EXCEPTION 'batch %: lost quantity cannot decrease', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.current_stage IS NOT NULL AND (
       NEW.current_stage IS NULL
       OR workflow_position(NEW.workflow_id, NEW.current_stage) < workflow_position(OLD.workflow_id, OLD.current_stage)
     ) THEN
    RAISE EXCEPTION 'batch %: current_stage cannot regress from % to %', OLD.id, OLD.current_stage, NEW.current_stage
      USING ERRCODE = 'check_violation';
  END IF;

  -- Nothing left: an open lot becomes CONSUMED by itself.
  IF NEW.consumed_quantity + NEW.lost_quantity >= NEW.quantity AND NEW.status IN ('ACTIVE', 'REJECTED') THEN
    NEW.status := 'CONSUMED';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'ACTIVE'     AND NEW.status IN ('IN_TRANSIT', 'ON_HOLD', 'REJECTED', 'RECALLED', 'DESTROYED', 'CONSUMED'))
    OR (OLD.status = 'IN_TRANSIT' AND NEW.status IN ('ACTIVE', 'REJECTED', 'ON_HOLD', 'RECALLED', 'CONSUMED'))
    OR (OLD.status = 'ON_HOLD'    AND NEW.status IN ('ACTIVE', 'REJECTED', 'IN_TRANSIT', 'RECALLED', 'DESTROYED'))
    OR (OLD.status = 'REJECTED'   AND NEW.status IN ('IN_TRANSIT', 'ON_HOLD', 'RECALLED', 'DESTROYED', 'CONSUMED'))
    OR (OLD.status = 'CONSUMED'   AND NEW.status IN ('RECALLED'))
    OR (OLD.status = 'RECALLED'   AND NEW.status IN ('DESTROYED'))
  ) THEN
    RAISE EXCEPTION 'batch %: status cannot change from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ── Ledger events: new kinds, occurred_at, hash v4 ──────────────────────────
ALTER TABLE trace_events DROP CONSTRAINT trace_events_kind_check;
ALTER TABLE trace_events ADD CONSTRAINT trace_events_kind_check CHECK (kind IN (
  'OBSERVE',
  -- lineage: the first event of a lot made from other lots
  'MERGE', 'SPLIT', 'TRANSFORM', 'REWORK', 'DOWNGRADE',
  -- custody and status
  'TRANSFER_OUT', 'TRANSFER_ACCEPT', 'TRANSFER_REJECT', 'TRANSFER_CANCEL',
  'HOLD', 'RELEASE', 'RECALL', 'DISPOSE'
));

ALTER TABLE trace_events DROP CONSTRAINT trace_events_links_consistent;
ALTER TABLE trace_events ADD CONSTRAINT trace_events_links_consistent CHECK (
  (kind IN ('MERGE', 'SPLIT', 'TRANSFORM', 'REWORK', 'DOWNGRADE') AND sequence_number = 0 AND jsonb_array_length(links) > 0)
  OR (kind NOT IN ('MERGE', 'SPLIT', 'TRANSFORM', 'REWORK', 'DOWNGRADE') AND links = '[]'::jsonb)
);

ALTER TABLE trace_events DROP CONSTRAINT trace_events_lineage_needs_v3;
ALTER TABLE trace_events ADD CONSTRAINT trace_events_lineage_needs_v3 CHECK (hash_version >= 3 OR kind = 'OBSERVE');

ALTER TABLE trace_events DROP CONSTRAINT trace_events_hash_version_salt;
ALTER TABLE trace_events ADD CONSTRAINT trace_events_hash_version_salt CHECK (
  (hash_version = 1 AND salt IS NULL AND claim_salts IS NULL)
  OR (hash_version = 2 AND salt ~ '^[0-9a-f]{64}$' AND claim_salts IS NULL)
  OR (hash_version IN (3, 4) AND salt IS NULL AND jsonb_typeof(claim_salts) = 'object')
);

-- Existing events: they happened when they were recorded. The ledger is
-- append-only, so the one-off backfill runs with its guard switched off.
ALTER TABLE trace_events ADD COLUMN occurred_at TIMESTAMPTZ;
ALTER TABLE trace_events DISABLE TRIGGER trace_events_append_only;
UPDATE trace_events SET occurred_at = "timestamp";
ALTER TABLE trace_events ENABLE TRIGGER trace_events_append_only;
ALTER TABLE trace_events ALTER COLUMN occurred_at SET NOT NULL;
ALTER TABLE trace_events ADD CONSTRAINT trace_events_occurred_not_future CHECK (occurred_at <= "timestamp" + interval '5 minutes');
-- Before v4 the hash didn't cover occurred_at, so for those it can only equal the recorded time.
ALTER TABLE trace_events ADD CONSTRAINT trace_events_occurred_needs_v4 CHECK (hash_version >= 4 OR occurred_at = "timestamp");
CREATE INDEX idx_trace_events_tenant_occurred ON trace_events (tenant_id, occurred_at);

CREATE OR REPLACE FUNCTION ledger_append_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  b RECORD;
  prev_occurred TIMESTAMPTZ;
BEGIN
  SELECT tenant_id, head_hash, event_count, status, workflow_id
    INTO b
    FROM batches
   WHERE id = NEW.batch_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger: batch % does not exist', NEW.batch_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF b.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'ledger: event tenant does not match batch tenant' USING ERRCODE = 'check_violation';
  END IF;
  IF b.status = 'DESTROYED' THEN
    RAISE EXCEPTION 'ledger: batch % was destroyed, no further events allowed', NEW.batch_id USING ERRCODE = 'check_violation';
  END IF;
  IF b.status = 'RECALLED' AND NEW.kind <> 'DISPOSE' THEN
    RAISE EXCEPTION 'ledger: batch % is recalled, no further events allowed', NEW.batch_id USING ERRCODE = 'check_violation';
  END IF;
  IF b.status = 'CONSUMED' AND NEW.kind <> 'RECALL' THEN
    RAISE EXCEPTION 'ledger: batch % has been fully consumed, no further events allowed', NEW.batch_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF workflow_position(b.workflow_id, NEW.stage) IS NULL THEN
    RAISE EXCEPTION 'ledger: stage % is not part of batch %''s workflow', NEW.stage, NEW.batch_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.sequence_number <> b.event_count THEN
    RAISE EXCEPTION 'ledger: expected sequence_number %, got %', b.event_count, NEW.sequence_number
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.prev_hash <> b.head_hash THEN
    RAISE EXCEPTION 'ledger: prev_hash does not match the current head of batch %', NEW.batch_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- What happened later in a lot's life can't have happened before what came earlier.
  IF b.event_count > 0 THEN
    SELECT occurred_at INTO prev_occurred
      FROM trace_events
     WHERE batch_id = NEW.batch_id AND sequence_number = b.event_count - 1;
    IF NEW.occurred_at < prev_occurred THEN
      RAISE EXCEPTION 'ledger: occurred_at % is earlier than the previous event of batch % (%)', NEW.occurred_at, NEW.batch_id, prev_occurred
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE batches
     SET head_hash = NEW.hash,
         event_count = event_count + 1
   WHERE id = NEW.batch_id;

  RETURN NEW;
END;
$$;

ALTER TABLE transformations DROP CONSTRAINT transformations_kind_check;
ALTER TABLE transformations ADD CONSTRAINT transformations_kind_check CHECK (
  kind IN ('MERGE', 'SPLIT', 'TRANSFORM', 'REWORK', 'DOWNGRADE')
);

-- ── Holds ───────────────────────────────────────────────────────────────────
CREATE TABLE batch_holds (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL,
  batch_id          UUID NOT NULL,
  reason            TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  -- The recalled lot that caused this hold, when it was put on automatically.
  source_batch_id   UUID,
  previous_status   TEXT NOT NULL CHECK (previous_status IN ('ACTIVE', 'IN_TRANSIT', 'REJECTED')),
  held_by           UUID NOT NULL,
  held_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  hold_event_id     UUID NOT NULL,
  released_at       TIMESTAMPTZ,
  released_by       UUID,
  release_reason    TEXT CHECK (release_reason IS NULL OR length(trim(release_reason)) BETWEEN 1 AND 1000),
  release_event_id  UUID,
  FOREIGN KEY (batch_id, tenant_id)         REFERENCES batches (id, tenant_id),
  FOREIGN KEY (source_batch_id, tenant_id)  REFERENCES batches (id, tenant_id),
  FOREIGN KEY (held_by, tenant_id)          REFERENCES actors (id, tenant_id),
  FOREIGN KEY (released_by, tenant_id)      REFERENCES actors (id, tenant_id),
  FOREIGN KEY (hold_event_id, tenant_id)    REFERENCES trace_events (id, tenant_id),
  FOREIGN KEY (release_event_id, tenant_id) REFERENCES trace_events (id, tenant_id),
  CONSTRAINT batch_holds_release_complete CHECK (
    (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL AND release_event_id IS NULL)
    OR (released_at IS NOT NULL AND released_by IS NOT NULL AND release_reason IS NOT NULL AND release_event_id IS NOT NULL)
  )
);

-- At most one open hold per lot.
CREATE UNIQUE INDEX uq_batch_holds_open ON batch_holds (batch_id) WHERE released_at IS NULL;
CREATE INDEX idx_batch_holds_batch ON batch_holds (batch_id, held_at);

-- A hold is written once and closed once.
CREATE FUNCTION batch_holds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'batch hold %: already released', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.batch_id, NEW.reason, NEW.source_batch_id, NEW.previous_status, NEW.held_by, NEW.held_at, NEW.hold_event_id)
     IS DISTINCT FROM (OLD.batch_id, OLD.reason, OLD.source_batch_id, OLD.previous_status, OLD.held_by, OLD.held_at, OLD.hold_event_id) THEN
    RAISE EXCEPTION 'batch hold %: only the release may be recorded', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER batch_holds_guard BEFORE UPDATE ON batch_holds FOR EACH ROW EXECUTE FUNCTION batch_holds_guard();
CREATE TRIGGER batch_holds_no_delete BEFORE DELETE ON batch_holds FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Transfers (hand-over with receiver confirmation) ────────────────────────
CREATE TABLE transfers (
  id                 UUID PRIMARY KEY,
  tenant_id          UUID NOT NULL,
  batch_id           UUID NOT NULL,
  from_actor_id      UUID NOT NULL,
  to_actor_id        UUID NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
  -- The lot's status before it went into transit — restored on reject/cancel.
  previous_status    TEXT NOT NULL CHECK (previous_status IN ('ACTIVE', 'REJECTED')),
  quantity           NUMERIC NOT NULL CHECK (quantity > 0),
  unit               TEXT NOT NULL,
  package_count      INTEGER CHECK (package_count IS NULL OR package_count > 0),
  vehicle            TEXT CHECK (vehicle IS NULL OR length(vehicle) <= 40),
  document_no        TEXT CHECK (document_no IS NULL OR length(document_no) <= 60),
  received_quantity  NUMERIC CHECK (received_quantity IS NULL OR received_quantity >= 0),
  response_reason    TEXT CHECK (response_reason IS NULL OR length(response_reason) <= 1000),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at       TIMESTAMPTZ,
  out_event_id       UUID NOT NULL,
  response_event_id  UUID,
  FOREIGN KEY (batch_id, tenant_id)          REFERENCES batches (id, tenant_id),
  FOREIGN KEY (from_actor_id, tenant_id)     REFERENCES actors (id, tenant_id),
  FOREIGN KEY (to_actor_id, tenant_id)       REFERENCES actors (id, tenant_id),
  FOREIGN KEY (out_event_id, tenant_id)      REFERENCES trace_events (id, tenant_id),
  FOREIGN KEY (response_event_id, tenant_id) REFERENCES trace_events (id, tenant_id),
  CONSTRAINT transfers_distinct_parties CHECK (from_actor_id <> to_actor_id),
  CONSTRAINT transfers_response_complete CHECK (
    (status = 'PENDING' AND responded_at IS NULL AND response_event_id IS NULL AND received_quantity IS NULL)
    OR (status <> 'PENDING' AND responded_at IS NOT NULL AND response_event_id IS NOT NULL)
  ),
  CONSTRAINT transfers_accept_has_quantity CHECK (status <> 'ACCEPTED' OR received_quantity IS NOT NULL),
  CONSTRAINT transfers_reject_has_reason CHECK (status <> 'REJECTED' OR response_reason IS NOT NULL)
);

CREATE UNIQUE INDEX uq_transfers_pending ON transfers (batch_id) WHERE status = 'PENDING';
CREATE INDEX idx_transfers_to_pending ON transfers (to_actor_id) WHERE status = 'PENDING';
CREATE INDEX idx_transfers_batch ON transfers (batch_id, created_at);

-- A transfer is answered once; its terms never change.
CREATE FUNCTION transfers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'transfer %: already %', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.batch_id, NEW.from_actor_id, NEW.to_actor_id, NEW.previous_status, NEW.quantity, NEW.unit,
      NEW.package_count, NEW.vehicle, NEW.document_no, NEW.created_at, NEW.out_event_id)
     IS DISTINCT FROM
     (OLD.batch_id, OLD.from_actor_id, OLD.to_actor_id, OLD.previous_status, OLD.quantity, OLD.unit,
      OLD.package_count, OLD.vehicle, OLD.document_no, OLD.created_at, OLD.out_event_id) THEN
    RAISE EXCEPTION 'transfer %: only the response may be recorded', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transfers_guard BEFORE UPDATE ON transfers FOR EACH ROW EXECUTE FUNCTION transfers_guard();
CREATE TRIGGER transfers_no_delete BEFORE DELETE ON transfers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Anomaly types ───────────────────────────────────────────────────────────
ALTER TABLE anomalies DROP CONSTRAINT anomalies_type_check;
ALTER TABLE anomalies ADD CONSTRAINT anomalies_type_check CHECK (type IN (
  'STAGE_SKIPPED', 'DUPLICATE_STAGE', 'OUT_OF_ORDER', 'CHAIN_TAMPERED', 'MASS_BALANCE_VIOLATION',
  'QUANTITY_DISCREPANCY',   -- received less than was sent, beyond the product's tolerance
  'LATE_ENTRY',             -- recorded long after it happened
  'RECALL_INVESTIGATION',   -- a related lot (upstream or sibling) was recalled
  'QC_CONDITION',           -- passed inspection on conditions that must still be met
  'CONFLICT_OF_INTEREST'    -- inspected by the same organization that processed the lot
));

-- ── Privileges + row-level security ─────────────────────────────────────────
GRANT UPDATE (status, lost_quantity) ON batches TO tracechain_app;
GRANT SELECT, INSERT ON batch_holds, transfers TO tracechain_app;
GRANT UPDATE (released_at, released_by, release_reason, release_event_id) ON batch_holds TO tracechain_app;
GRANT UPDATE (status, received_quantity, response_reason, responded_at, response_event_id) ON transfers TO tracechain_app;

ALTER TABLE batch_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfers   ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_holds
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON transfers
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
