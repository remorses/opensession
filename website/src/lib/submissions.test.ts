// Pure tests for session status transitions, queue helpers, tab filters,
// search and CSV export.
import { describe, expect, test } from 'vitest'
import {
  ABSTRACTS_STATUS_TABS,
  abstractsToCsv,
  applyTransition,
  canTransition,
  countSessionsByTab,
  filterSessionsByTab,
  planBulkStatusUpdate,
  planNotifyQueue,
  sessionMatchesQuery,
  statusesForTab,
  type SessionStatus,
  type TransitionableSession,
} from './submissions.ts'

const base = (status: SessionStatus, overrides: Partial<TransitionableSession> = {}): TransitionableSession => ({
  status,
  title: 'Talk title',
  submittedAt: status === 'DRAFT' ? null : 1_000,
  decidedAt: null,
  withdrawnAt: null,
  ...overrides,
})

describe('canTransition', () => {
  test('allows the documented happy path', () => {
    expect(canTransition('DRAFT', 'PENDING')).toBe(true)
    expect(canTransition('PENDING', 'ACCEPT_QUEUE')).toBe(true)
    expect(canTransition('ACCEPT_QUEUE', 'ACCEPTED')).toBe(true)
    expect(canTransition('PENDING', 'DECLINE_QUEUE')).toBe(true)
    expect(canTransition('DECLINE_QUEUE', 'DECLINED')).toBe(true)
  })

  test('allows unqueue and cross-queue moves', () => {
    expect(canTransition('ACCEPT_QUEUE', 'PENDING')).toBe(true)
    expect(canTransition('DECLINE_QUEUE', 'PENDING')).toBe(true)
    expect(canTransition('ACCEPT_QUEUE', 'DECLINE_QUEUE')).toBe(true)
    expect(canTransition('DECLINE_QUEUE', 'ACCEPT_QUEUE')).toBe(true)
  })

  test('allows withdraw from draft/pending/queues', () => {
    expect(canTransition('DRAFT', 'WITHDRAWN')).toBe(true)
    expect(canTransition('PENDING', 'WITHDRAWN')).toBe(true)
    expect(canTransition('ACCEPT_QUEUE', 'WITHDRAWN')).toBe(true)
    expect(canTransition('DECLINE_QUEUE', 'WITHDRAWN')).toBe(true)
  })

  test('rejects terminal and illegal edges', () => {
    expect(canTransition('ACCEPTED', 'PENDING')).toBe(false)
    expect(canTransition('DECLINED', 'PENDING')).toBe(false)
    expect(canTransition('WITHDRAWN', 'PENDING')).toBe(false)
    expect(canTransition('DRAFT', 'ACCEPTED')).toBe(false)
    expect(canTransition('PENDING', 'ACCEPTED')).toBe(false)
    expect(canTransition('PENDING', 'PENDING')).toBe(false)
  })
})

describe('applyTransition', () => {
  test('stamps submittedAt on first move to PENDING', () => {
    const patch = applyTransition(base('DRAFT', { submittedAt: null }), 'PENDING', 5_000)
    expect(patch).toMatchInlineSnapshot(`
      {
        "decidedAt": null,
        "status": "PENDING",
        "submittedAt": 5000,
        "updatedAt": 5000,
        "withdrawnAt": null,
      }
    `)
  })

  test('keeps existing submittedAt when re-entering PENDING', () => {
    const patch = applyTransition(
      base('ACCEPT_QUEUE', { submittedAt: 2_000 }),
      'PENDING',
      9_000,
    )
    expect(patch.submittedAt).toBe(2_000)
    expect(patch.status).toBe('PENDING')
  })

  test('stamps decidedAt on ACCEPT and DECLINE finals', () => {
    expect(applyTransition(base('ACCEPT_QUEUE'), 'ACCEPTED', 7_000).decidedAt).toBe(7_000)
    expect(applyTransition(base('DECLINE_QUEUE'), 'DECLINED', 8_000).decidedAt).toBe(8_000)
  })

  test('stamps withdrawnAt on withdraw', () => {
    expect(applyTransition(base('PENDING'), 'WITHDRAWN', 6_000).withdrawnAt).toBe(6_000)
  })

  test('never invents notifiedAt (field absent from patch)', () => {
    const patch = applyTransition(base('ACCEPT_QUEUE'), 'ACCEPTED', 1)
    expect('notifiedAt' in patch).toBe(false)
  })

  test('rejects illegal transitions', () => {
    expect(() => applyTransition(base('ACCEPTED'), 'PENDING', 1)).toThrow(
      /Cannot move session/,
    )
  })

  test('backfills Untitled when non-draft has empty title', () => {
    const patch = applyTransition(base('PENDING', { title: '   ' }), 'ACCEPT_QUEUE', 1)
    expect(patch.title).toBe('Untitled')
    expect(patch.status).toBe('ACCEPT_QUEUE')
    // Keeps a real title when present.
    expect(applyTransition(base('PENDING', { title: 'Talk' }), 'ACCEPT_QUEUE', 1).title).toBe(
      undefined,
    )
  })
})

describe('planBulkStatusUpdate / planNotifyQueue', () => {
  test('bulk skips illegal rows and keeps legal ones', () => {
    const planned = planBulkStatusUpdate(
      [
        { id: 'a', ...base('PENDING') },
        { id: 'b', ...base('ACCEPTED') },
        { id: 'c', ...base('DRAFT', { title: null }) },
      ],
      'ACCEPT_QUEUE',
      10,
    )
    expect(planned.map((row) => row.id)).toEqual(['a'])
    expect(planned[0]!.status).toBe('ACCEPT_QUEUE')
  })

  test('notify only finalises the matching queue', () => {
    const accept = planNotifyQueue(
      [
        { id: 'a', ...base('ACCEPT_QUEUE') },
        { id: 'b', ...base('DECLINE_QUEUE') },
        { id: 'c', ...base('PENDING') },
      ],
      'accept',
      11,
    )
    expect(accept).toMatchInlineSnapshot(`
      [
        {
          "decidedAt": 11,
          "from": "ACCEPT_QUEUE",
          "id": "a",
          "status": "ACCEPTED",
          "submittedAt": 1000,
          "updatedAt": 11,
          "withdrawnAt": null,
        },
      ]
    `)

    const decline = planNotifyQueue(
      [{ id: 'b', ...base('DECLINE_QUEUE') }],
      'decline',
      12,
    )
    expect(decline[0]!.status).toBe('DECLINED')
    expect(decline[0]!.decidedAt).toBe(12)
  })
})

describe('status tabs', () => {
  test('maps each tab to the right DB statuses', () => {
    expect(statusesForTab('pending')).toEqual(['PENDING'])
    expect(statusesForTab('accept-queue')).toEqual(['ACCEPT_QUEUE'])
    expect(statusesForTab('all')).toBeNull()
    expect(ABSTRACTS_STATUS_TABS.map((t) => t.value)).toMatchInlineSnapshot(`
      [
        "all",
        "pending",
        "accept-queue",
        "accepted",
        "decline-queue",
        "declined",
        "withdrawn",
        "drafts",
      ]
    `)
  })

  test('filters and counts by tab', () => {
    const sessions = [
      { status: 'PENDING' as const },
      { status: 'PENDING' as const },
      { status: 'ACCEPT_QUEUE' as const },
      { status: 'DRAFT' as const },
    ]
    expect(filterSessionsByTab(sessions, 'pending')).toHaveLength(2)
    expect(countSessionsByTab(sessions)).toMatchInlineSnapshot(`
      {
        "accept-queue": 1,
        "accepted": 0,
        "all": 4,
        "decline-queue": 0,
        "declined": 0,
        "drafts": 1,
        "pending": 2,
        "withdrawn": 0,
      }
    `)
  })
})

describe('sessionMatchesQuery / abstractsToCsv', () => {
  test('search is case-insensitive across title speakers track format', () => {
    const row = {
      title: 'Building with Workers',
      trackName: 'Platform',
      formatName: 'Talk',
      speakerNames: ['Ada Lovelace'],
    }
    expect(sessionMatchesQuery(row, 'workers')).toBe(true)
    expect(sessionMatchesQuery(row, 'ada')).toBe(true)
    expect(sessionMatchesQuery(row, 'platform')).toBe(true)
    expect(sessionMatchesQuery(row, 'missing')).toBe(false)
    expect(sessionMatchesQuery(row, '  ')).toBe(true)
  })

  test('csv escapes commas quotes and newlines', () => {
    const csv = abstractsToCsv([
      {
        status: 'PENDING',
        title: 'Hello, "world"',
        trackName: null,
        formatName: 'Talk',
        speakerNames: ['Ada', 'Grace'],
        formName: 'CFP',
        notifiedAt: null,
        submittedAt: 1_700_000_000_000,
      },
    ])
    expect(csv).toMatchInlineSnapshot(`
      "status,title,track,format,speakers,form,notified_at,submitted_at
      PENDING,"Hello, ""world""",,Talk,Ada; Grace,CFP,,1700000000000
      "
    `)
  })
})
