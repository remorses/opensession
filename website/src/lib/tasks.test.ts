// Pure tests for acceptance-time task assignment planning and definition shape.
import { describe, expect, test } from 'vitest'
import {
  assertTaskDefinitionShape,
  buildAssignmentsForAcceptance,
  defaultManualTaskDefinitions,
  summarizeAssignmentProgress,
} from './tasks.ts'

describe('buildAssignmentsForAcceptance', () => {
  const defs = [
    { id: 'td-speaker', eventId: 'evt-1', target: 'SPEAKER' as const, dueAt: 100 },
    { id: 'td-sub', eventId: 'evt-1', target: 'SUBMISSION' as const, dueAt: 200 },
  ]

  test('SPEAKER rows omit sessionId; SUBMISSION rows include it', () => {
    const rows = buildAssignmentsForAcceptance({
      taskDefs: defs,
      participants: [{ speakerId: 'sp-a' }, { speakerId: 'sp-b' }],
      sessionId: 'ses-1',
      now: 9_000,
    })
    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "createdAt": 9000,
          "dueAt": 100,
          "eventId": "evt-1",
          "sessionId": null,
          "speakerId": "sp-a",
          "status": "NOT_STARTED",
          "taskDefinitionId": "td-speaker",
          "updatedAt": 9000,
        },
        {
          "createdAt": 9000,
          "dueAt": 100,
          "eventId": "evt-1",
          "sessionId": null,
          "speakerId": "sp-b",
          "status": "NOT_STARTED",
          "taskDefinitionId": "td-speaker",
          "updatedAt": 9000,
        },
        {
          "createdAt": 9000,
          "dueAt": 200,
          "eventId": "evt-1",
          "sessionId": "ses-1",
          "speakerId": "sp-a",
          "status": "NOT_STARTED",
          "taskDefinitionId": "td-sub",
          "updatedAt": 9000,
        },
        {
          "createdAt": 9000,
          "dueAt": 200,
          "eventId": "evt-1",
          "sessionId": "ses-1",
          "speakerId": "sp-b",
          "status": "NOT_STARTED",
          "taskDefinitionId": "td-sub",
          "updatedAt": 9000,
        },
      ]
    `)
  })

  test('dedupes duplicate participant speaker ids', () => {
    const rows = buildAssignmentsForAcceptance({
      taskDefs: [defs[0]!],
      participants: [{ speakerId: 'sp-a' }, { speakerId: 'sp-a' }],
      sessionId: 'ses-1',
      now: 1,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.speakerId).toBe('sp-a')
  })

  test('empty participants yields no assignments', () => {
    expect(
      buildAssignmentsForAcceptance({
        taskDefs: defs,
        participants: [],
        sessionId: 'ses-1',
        now: 1,
      }),
    ).toEqual([])
  })
})

describe('assertTaskDefinitionShape', () => {
  test('manual forbids formId; form requires matching PORTAL form', () => {
    expect(() =>
      assertTaskDefinitionShape({
        source: 'MANUAL',
        target: 'SPEAKER',
        formId: null,
      }),
    ).not.toThrow()
    expect(() =>
      assertTaskDefinitionShape({
        source: 'MANUAL',
        target: 'SPEAKER',
        formId: 'f1',
      }),
    ).toThrow(/cannot link a form/)
    expect(() =>
      assertTaskDefinitionShape({
        source: 'FORM',
        target: 'SPEAKER',
        formId: 'f1',
        form: { purpose: 'PORTAL', target: 'SPEAKER' },
      }),
    ).not.toThrow()
    expect(() =>
      assertTaskDefinitionShape({
        source: 'FORM',
        target: 'SPEAKER',
        formId: 'f1',
        form: { purpose: 'CFP', target: 'SUBMISSION' },
      }),
    ).toThrow(/PORTAL form/)
    expect(() =>
      assertTaskDefinitionShape({
        source: 'FORM',
        target: 'SPEAKER',
        formId: 'f1',
        form: { purpose: 'PORTAL', target: 'SUBMISSION' },
      }),
    ).toThrow(/must match task target/)
  })
})

describe('summarizeAssignmentProgress / defaults', () => {
  test('progress counts by status', () => {
    expect(
      summarizeAssignmentProgress([
        { status: 'COMPLETED' },
        { status: 'COMPLETED' },
        { status: 'IN_PROGRESS' },
        { status: 'NOT_STARTED' },
      ]),
    ).toEqual({ total: 4, completed: 2, inProgress: 1, notStarted: 1 })
  })

  test('default manual task definitions', () => {
    expect(defaultManualTaskDefinitions('evt', 42)).toMatchInlineSnapshot(`
      [
        {
          "createdAt": 42,
          "dueAt": null,
          "eventId": "evt",
          "formId": null,
          "instructionsHtml": null,
          "sortOrder": 0,
          "source": "MANUAL",
          "target": "SPEAKER",
          "title": "Complete Speaker Profile",
        },
        {
          "createdAt": 42,
          "dueAt": null,
          "eventId": "evt",
          "formId": null,
          "instructionsHtml": null,
          "sortOrder": 1,
          "source": "MANUAL",
          "target": "SUBMISSION",
          "title": "Upload Session Materials",
        },
      ]
    `)
  })
})
