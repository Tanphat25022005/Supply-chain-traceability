/**
 * Writes docs/test-vectors/phase1.json — fixed inputs and the hashes/roots/
 * proofs they must produce (docs/SPEC_PHASE1.md). Both the backend
 * (tests/specVectors.test.ts) and the browser verifier
 * (frontend/src/lib/verify/verify.test.ts) are checked against this file, so
 * an implementation can only change together with an intentional regeneration:
 *
 *   npx ts-node --transpile-only scripts/generate-test-vectors.ts
 */
import { createHash } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { canonicalize } from '../src/ledger/canonicalJson';
import {
  claimCommitment,
  computeEventHashV3,
  computeEventHashV4,
  disclose,
  discloseV3,
  eventClaims,
  GENESIS_HASH,
  HashableEvent,
  publicClaimNames,
} from '../src/ledger/hashChain';
import { buildMerkleTree } from '../src/ledger/merkle';

/** Deterministic "random" salts so the file is reproducible. */
const salt = (label: string) => createHash('sha256').update(`tracechain-test-vector:${label}`).digest('hex');

/** Data keys disclosed to a public verifier — per event, from its field schema (the v3 cases use the pre-schema lists). */
const events: Array<{ label: string; event: HashableEvent; publicDataKeys: string[] }> = [
  {
    label: 'harvest',
    publicDataKeys: ['harvestDate', 'variety', 'cultivation'],
    event: {
      batchId: '6f1c1f9e-2a8d-4a43-9d3f-6f0b1f2a3c4d',
      sequenceNumber: 0,
      prevHash: GENESIS_HASH,
      stage: 'HARVEST',
      kind: 'OBSERVE',
      links: [],
      actorId: '0d6c3a51-9b1e-4a11-8f5a-1c2d3e4f5a6b',
      timestamp: new Date('2026-10-01T03:15:00.000Z'),
      location: 'Cầu Đất, Đà Lạt, Lâm Đồng',
      notes: 'Giá thu mua nội bộ 52.000đ/kg',
      data: { harvestDate: '2026-09-30', variety: 'Robusta TR4', cultivation: 'VIETGAP', moisture: 13.5 },
    },
  },
  {
    label: 'merge',
    publicDataKeys: ['method'],
    event: {
      batchId: '9a7d8b52-4c3e-4f1a-b2d9-3e5f6a7b8c9d',
      sequenceNumber: 0,
      prevHash: GENESIS_HASH,
      stage: 'PROCESSING',
      kind: 'MERGE',
      // Deliberately unsorted: the hash must not depend on input order.
      links: [
        { lotId: 'f2000000-0000-4000-8000-000000000002', quantity: 120.5, unit: 'kg', headHash: 'b'.repeat(64), eventCount: 2 },
        { lotId: 'f1000000-0000-4000-8000-000000000001', quantity: 80, unit: 'kg', headHash: 'a'.repeat(64), eventCount: 1 },
      ],
      actorId: '1e2d3c4b-5a69-4788-8796-a5b4c3d2e1f0',
      timestamp: new Date('2026-10-02T08:00:00.000Z'),
      location: 'Xưởng Bảo Lộc',
      notes: undefined,
      data: { method: 'WET' },
    },
  },
];

const hashCases = events.map(({ label, event, publicDataKeys }) => {
  const claimSalts = Object.fromEntries(eventClaims(event).map((c) => [c.name, salt(`${label}:${c.name}`)]));
  const hash = computeEventHashV3(event, claimSalts);
  const visible = publicClaimNames(publicDataKeys);
  return {
    label,
    event: { ...event, timestamp: event.timestamp.toISOString() },
    publicDataKeys,
    claimSalts,
    commitments: Object.fromEntries(eventClaims(event).map((c) => [c.name, claimCommitment(c.name, c.value, claimSalts[c.name])])),
    hash,
    publicDisclosure: discloseV3(event, claimSalts, (name) => visible.has(name)),
  };
});

/**
 * v4 (docs/SPEC_PHASE1_5.md §0.5): the envelope also commits to occurredAt —
 * here a QC recorded the morning after it happened, and a recall (custody
 * event, public `reason`).
 */
const v4Events: Array<{ label: string; event: HashableEvent; publicDataKeys: string[] }> = [
  {
    label: 'quality-check-late',
    publicDataKeys: ['result', 'grade', 'screenSize', 'standard', 'certificateNo'],
    event: {
      batchId: '9a7d8b52-4c3e-4f1a-b2d9-3e5f6a7b8c9d',
      sequenceNumber: 3,
      prevHash: 'c'.repeat(64),
      stage: 'QUALITY_CHECK',
      kind: 'OBSERVE',
      links: [],
      actorId: '2f3e4d5c-6b7a-4899-a0b1-c2d3e4f5a6b7',
      timestamp: new Date('2026-10-06T01:30:00.000Z'),
      occurredAt: new Date('2026-10-05T09:00:00.000Z'),
      location: 'Trung tâm kiểm định VN',
      notes: undefined,
      data: { result: 'PASS', grade: 'G1', screenSize: 'S16', moisture: 12.3, standard: 'TCVN 4193:2014', certificateNo: 'KĐ-2026-1008' },
    },
  },
  {
    label: 'recall',
    publicDataKeys: ['reason'],
    event: {
      batchId: '9a7d8b52-4c3e-4f1a-b2d9-3e5f6a7b8c9d',
      sequenceNumber: 4,
      prevHash: 'd'.repeat(64),
      stage: 'QUALITY_CHECK',
      kind: 'RECALL',
      links: [],
      actorId: '2f3e4d5c-6b7a-4899-a0b1-c2d3e4f5a6b7',
      timestamp: new Date('2026-10-07T08:00:00.000Z'),
      occurredAt: new Date('2026-10-07T08:00:00.000Z'),
      location: 'Trung tâm kiểm định VN',
      notes: undefined,
      data: { reason: 'Ochratoxin A vượt ngưỡng' },
    },
  },
];

const hashV4Cases = v4Events.map(({ label, event, publicDataKeys }) => {
  const claimSalts = Object.fromEntries(eventClaims(event).map((c) => [c.name, salt(`v4:${label}:${c.name}`)]));
  const visible = publicClaimNames(publicDataKeys);
  return {
    label,
    event: { ...event, timestamp: event.timestamp.toISOString(), occurredAt: event.occurredAt!.toISOString() },
    publicDataKeys,
    claimSalts,
    hash: computeEventHashV4(event, claimSalts),
    publicDisclosure: disclose(event, claimSalts, (name) => visible.has(name), 4),
  };
});

const leafHashes = Array.from({ length: 7 }, (_, i) => createHash('sha256').update(`leaf-${i}`).digest('hex'));
const merkleCases = [1, 2, 3, 5, 7].map((n) => {
  const leaves = leafHashes.slice(0, n);
  const tree = buildMerkleTree(leaves);
  return { leaves, root: tree.root, proofs: tree.proofs };
});

const out = {
  spec: 'docs/SPEC_PHASE1.md',
  note: 'Generated by backend/scripts/generate-test-vectors.ts — do not edit by hand.',
  jcsExample: { input: { b: [1, 'x'], a: { d: true, c: null } }, canonical: canonicalize({ b: [1, 'x'], a: { d: true, c: null } }) },
  hashV3: hashCases,
  hashV4: hashV4Cases,
  merkle: merkleCases,
};

const dir = join(__dirname, '..', '..', 'docs', 'test-vectors');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'phase1.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${join(dir, 'phase1.json')}`);
