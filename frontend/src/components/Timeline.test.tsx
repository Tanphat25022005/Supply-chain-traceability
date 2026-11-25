import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Timeline from './Timeline'
import { Actor, TraceEvent } from '../api/client'
import { fixtureCatalog } from '../test/catalogFixture'

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: 'evt-1',
    batchId: 'batch-1',
    stage: 'HARVEST',
    actorId: 'actor-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    occurredAt: '2026-01-01T00:00:00.000Z',
    location: 'Đà Lạt',
    data: {},
    hash: 'a'.repeat(64),
    prevHash: '0'.repeat(64),
    sequenceNumber: 0,
    hashVersion: 4,
    kind: 'OBSERVE',
    links: [],
    ...overrides,
  }
}

describe('Timeline', () => {
  it('shows an empty state when there are no events', () => {
    render(<Timeline events={[]} />)
    expect(screen.getByText(/Chưa có sự kiện nào/)).toBeInTheDocument()
  })

  it('renders one entry per event, in the order given', () => {
    const events = [makeEvent({ id: 'e1', stage: 'HARVEST' }), makeEvent({ id: 'e2', stage: 'PROCESSING', sequenceNumber: 1 })]
    render(<Timeline events={events} catalog={fixtureCatalog} />)
    expect(screen.getByText('Thu hoạch')).toBeInTheDocument()
    expect(screen.getByText('Chế biến')).toBeInTheDocument()
    expect(screen.getByText(/2 khâu/)).toBeInTheDocument()
  })

  it('says who recorded each step and shows its facts with the schema labels, not raw codes', () => {
    const actor: Actor = { id: 'actor-1', name: 'Trần B', role: 'INSPECTOR', organization: 'Trung tâm KĐ', createdAt: '', isActive: true }
    render(
      <Timeline
        events={[makeEvent({ stage: 'QUALITY_CHECK', data: { result: 'PASS', moisture: 11.5 }, fieldSchemaId: 1 })]}
        actorsById={new Map([[actor.id, actor]])}
        catalog={fixtureCatalog}
      />,
    )
    expect(screen.getByText('Trung tâm KĐ')).toBeInTheDocument()
    expect(screen.getByText('Đạt')).toBeInTheDocument()
    expect(screen.getByText('11,5 %')).toBeInTheDocument()
    // The hash is still available, but tucked away behind "Chi tiết kỹ thuật".
    expect(screen.getByText(/Chi tiết kỹ thuật/)).toBeInTheDocument()
  })

  it('shows the location and notes for each event', () => {
    render(<Timeline events={[makeEvent({ location: 'Xưởng A', notes: 'kiểm tra kỹ' })]} />)
    expect(screen.getByText(/Xưởng A/)).toBeInTheDocument()
    expect(screen.getByText(/kiểm tra kỹ/)).toBeInTheDocument()
  })

  it('shows when it happened, and when it was recorded if that was later', () => {
    render(<Timeline events={[makeEvent({ occurredAt: '2026-01-01T00:00:00.000Z', timestamp: '2026-01-04T02:00:00.000Z' })]} />)
    expect(screen.getByText(/ghi lúc/)).toBeInTheDocument()
  })

  it('lists hand-overs and recalls as ledger entries between the steps', () => {
    const receiver: Actor = { id: 'p-1', name: 'Lê C', role: 'PROCESSOR', organization: 'Nhà máy', createdAt: '', isActive: true }
    render(
      <Timeline
        events={[
          makeEvent(),
          makeEvent({ id: 'e2', sequenceNumber: 1, kind: 'TRANSFER_OUT', data: { toActorId: 'p-1', quantity: 1000, unit: 'kg' } }),
          makeEvent({ id: 'e3', sequenceNumber: 2, kind: 'RECALL', data: { reason: 'Nấm mốc' } }),
        ]}
        actorsById={new Map([[receiver.id, receiver]])}
      />,
    )
    expect(screen.getByText('Bàn giao')).toBeInTheDocument()
    expect(screen.getByText(/Nhà máy · Lê C/)).toBeInTheDocument()
    expect(screen.getByText('Thu hồi')).toBeInTheDocument()
    expect(screen.getByText(/Lý do: Nấm mốc/)).toBeInTheDocument()
    expect(screen.getByText(/1 khâu, 2 lần/)).toBeInTheDocument()
  })
})
