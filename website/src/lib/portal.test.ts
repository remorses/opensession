// Pure tests for speaker portal ownership, assignment filters, and rules.
import { describe, expect, test } from 'vitest'
import {
  assignmentOwnedBySpeaker,
  canCompleteManualAssignment,
  canEditSession,
  canSubmitFormAssignment,
  canViewSession,
  canWithdrawSession,
  countOpenAssignments,
  filterPortalAssignments,
  parsePortalTasksTab,
  speakerDisplayImage,
} from './portal.ts'

const baseSession = {
  id: 'ses_1',
  status: 'PENDING' as const,
  submitterSpeakerId: 'sp_owner',
  participantSpeakerIds: ['sp_owner', 'sp_co'],
}

describe('portal ownership', () => {
  test('submitter and participants can view', () => {
    expect(canViewSession('sp_owner', baseSession)).toBe(true)
    expect(canViewSession('sp_co', baseSession)).toBe(true)
    expect(canViewSession('sp_other', baseSession)).toBe(false)
  })

  test('only PENDING owners can edit', () => {
    expect(canEditSession({ speakerId: 'sp_owner', session: baseSession })).toBe(true)
    expect(canEditSession({ speakerId: 'sp_co', session: baseSession })).toBe(true)
    expect(canEditSession({ speakerId: 'sp_owner', session: baseSession, formIsOpen: false })).toBe(false)
    expect(canEditSession({ speakerId: 'sp_owner', session: { ...baseSession, status: 'ACCEPTED' } })).toBe(false)
    expect(canEditSession({ speakerId: 'sp_other', session: baseSession })).toBe(false)
  })

  test('owners can withdraw from PENDING', () => {
    expect(canWithdrawSession('sp_owner', baseSession)).toBe(true)
    expect(canWithdrawSession('sp_other', baseSession)).toBe(false)
    expect(canWithdrawSession('sp_owner', { ...baseSession, status: 'ACCEPTED' })).toBe(false)
  })
})

describe('portal assignments', () => {
  const rows = [
    {
      id: 'a1',
      speakerId: 'sp_1',
      sessionId: null,
      status: 'NOT_STARTED' as const,
      target: 'SPEAKER' as const,
      source: 'FORM' as const,
      formId: 'f1',
    },
    {
      id: 'a2',
      speakerId: 'sp_1',
      sessionId: 'ses_1',
      status: 'IN_PROGRESS' as const,
      target: 'SUBMISSION' as const,
      source: 'MANUAL' as const,
      formId: null,
    },
    {
      id: 'a3',
      speakerId: 'sp_1',
      sessionId: null,
      status: 'COMPLETED' as const,
      target: 'SPEAKER' as const,
      source: 'MANUAL' as const,
      formId: null,
    },
  ]

  test('filters tabs', () => {
    expect(filterPortalAssignments(rows, 'all')).toHaveLength(3)
    expect(filterPortalAssignments(rows, 'mine').map((row) => row.id)).toEqual(['a1', 'a3'])
    expect(filterPortalAssignments(rows, 'submission').map((row) => row.id)).toEqual(['a2'])
  })

  test('parse tab defaults to all', () => {
    expect(parsePortalTasksTab(undefined)).toBe('all')
    expect(parsePortalTasksTab('mine')).toBe('mine')
    expect(parsePortalTasksTab('nope')).toBe('all')
  })

  test('manual complete and form submit rules', () => {
    expect(canCompleteManualAssignment(rows[1]!)).toBe(true)
    expect(canCompleteManualAssignment(rows[0]!)).toBe(false)
    expect(canCompleteManualAssignment(rows[2]!)).toBe(false)
    expect(canSubmitFormAssignment(rows[0]!)).toBe(true)
    expect(canSubmitFormAssignment(rows[1]!)).toBe(false)
    expect(canSubmitFormAssignment({ ...rows[0]!, status: 'COMPLETED' })).toBe(true)
  })

  test('ownership helper', () => {
    expect(assignmentOwnedBySpeaker(rows[0]!, 'sp_1')).toBe(true)
    expect(assignmentOwnedBySpeaker(rows[0]!, 'sp_2')).toBe(false)
  })

  test('open assignment count', () => {
    expect(countOpenAssignments(rows)).toBe(2)
  })
})

describe('speakerDisplayImage', () => {
  test('prefers headshot file over Google avatar', () => {
    expect(speakerDisplayImage({
      headshotFileId: 'file_1',
      avatarUrl: 'https://example.com/a.png',
    })).toBe('/files/file_1')
    expect(speakerDisplayImage({
      headshotFileId: null,
      avatarUrl: 'https://example.com/a.png',
    })).toBe('https://example.com/a.png')
    expect(speakerDisplayImage({ headshotFileId: null, avatarUrl: null })).toBeNull()
  })
})
