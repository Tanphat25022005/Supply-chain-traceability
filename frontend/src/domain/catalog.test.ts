import { describe, expect, it } from 'vitest'
import type { Batch } from '../api/client'
import { fixtureCatalog as catalog } from '../test/catalogFixture'
import { canActOn, describeEventData, formatFieldValue, isFieldRequired, nextStepLabel, toEventData } from './catalog'

function lot(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'b-1',
    productName: 'Cà phê',
    productType: 'Cà phê quả tươi',
    productTypeId: 'pt-cherry',
    origin: 'Cầu Đất',
    quantity: 1000,
    unit: 'kg',
    createdAt: '2026-10-01T00:00:00Z',
    createdBy: 'f-1',
    currentStage: null,
    status: 'ACTIVE',
    isRecalled: false,
    metadata: {},
    headHash: '0'.repeat(64),
    eventCount: 0,
    consumedQuantity: 0,
    lostQuantity: 0,
    workflowId: 'wf-export',
    ...overrides,
  }
}

describe('workflow rules in the browser (mirror of backend/src/domain/workflow.ts)', () => {
  it('offers the next steps up to the first required one; optional steps may be skipped', () => {
    const rules = catalog.rules('wf-export')!
    expect(rules.nextCandidates(1).map((s) => s.stage)).toEqual(['COLLECTION', 'PROCESSING'])
    expect(rules.nextCandidates(3).map((s) => s.stage)).toEqual(['WAREHOUSING', 'QUALITY_CHECK'])
    expect(rules.nextIsExternal(7)).toBe(true) // after EXPORT only the buyer
    expect(rules.isFinal('IMPORT_RECEIPT')).toBe(true)
    // A reworked lot must pass inspection again even where inspection is optional (legacy chain).
    const legacy = catalog.rules('wf-generic')!
    expect(legacy.nextCandidates(2).map((s) => s.stage)).toEqual(['QUALITY_CHECK', 'PACKAGING', 'DISTRIBUTION', 'RETAIL'])
    expect(legacy.nextCandidates(2, { metadata: { reinspect: true } }).map((s) => s.stage)).toEqual(['QUALITY_CHECK'])
  })

  it('says what this person may record now, and why not', () => {
    const atHarvest = lot({ currentStage: 'HARVEST', assignedToActorId: 'p-1' })
    const rules = catalog.rules(atHarvest.workflowId)!
    expect(rules.recordable(atHarvest, 'PROCESSOR').map((s) => s.stage)).toEqual(['PROCESSING'])
    expect(rules.recordable(atHarvest, 'COLLECTOR').map((s) => s.stage)).toEqual(['COLLECTION'])
    expect(rules.skippedRequired(atHarvest, 'QUALITY_CHECK').map((s) => s.stage)).toEqual(['PROCESSING'])

    expect(canActOn({ id: 'p-1', role: 'PROCESSOR' }, atHarvest, catalog)).toBe(true)
    expect(canActOn({ id: 'p-2', role: 'PROCESSOR' }, atHarvest, catalog)).toBe(false) // handed to someone else
    expect(canActOn({ id: 'p-1', role: 'INSPECTOR' }, atHarvest, catalog)).toBe(false) // not their step
    expect(canActOn({ id: 'a-1', role: 'ADMIN' }, atHarvest, catalog)).toBe(true)
    for (const status of ['IN_TRANSIT', 'ON_HOLD', 'REJECTED', 'RECALLED'] as const) {
      expect(canActOn({ id: 'p-1', role: 'PROCESSOR' }, { ...atHarvest, status }, catalog)).toBe(false)
    }
    expect(nextStepLabel(atHarvest, catalog)).toBe('Thu gom hoặc Chế biến')
    expect(nextStepLabel(lot({ currentStage: 'IMPORT_RECEIPT' }), catalog)).toBeNull()
  })
})

describe('catalog lookups', () => {
  it('lists the units of a product: generic weight units, then its own packaging', () => {
    expect(catalog.unitsFor('pt-green').map((u) => u.code)).toEqual(['kg', 'tấn', 'bao'])
    expect(catalog.unitsFor('pt-cherry').map((u) => u.code)).toEqual(['kg', 'tấn'])
  })

  it("picks a product group's own schema, else the generic one", () => {
    expect(catalog.currentSchema('COFFEE', 'HARVEST')?.id).toBe(2)
    expect(catalog.currentSchema('OTHER', 'HARVEST')?.id).toBe(3)
    expect(catalog.workflowsFor('COFFEE').map((w) => w.code)).toEqual(['COFFEE_EXPORT', 'GENERIC_RETAIL'])
    expect(catalog.workflowsFor('OTHER').map((w) => w.code)).toEqual(['GENERIC_RETAIL'])
  })
})

describe('field values', () => {
  const qc = catalog.schemaById(1)!.fields

  it('formats option codes, dates and units for people', () => {
    expect(formatFieldValue(qc[0], 'PASS')).toBe('Đạt')
    expect(formatFieldValue(undefined, '2026-09-30')).toBe('30/09/2026')
    expect(formatFieldValue(qc[2], 11.5)).toBe('11,5 %')
  })

  it('keeps only the public facts for the consumer page, and labels server-added keys', () => {
    expect(describeEventData(qc, { result: 'PASS', moisture: 12 }, { publicOnly: true }).map((r) => r.key)).toEqual(['result'])
    expect(describeEventData(qc, { result: 'FAIL', lateReason: 'Mất sóng' }).map((r) => r.label)).toEqual(['Kết quả', 'Lý do ghi muộn'])
  })

  it('turns form strings into the payload and knows conditional requirements', () => {
    expect(toEventData(qc, { result: 'PASS', moisture: '12.5', conditions: ' ' })).toEqual({ result: 'PASS', moisture: 12.5 })
    expect(isFieldRequired(qc[1], { result: 'PASS' })).toBe(false)
    expect(isFieldRequired(qc[1], { result: 'PASS_WITH_CONDITIONS' })).toBe(true)
  })
})
