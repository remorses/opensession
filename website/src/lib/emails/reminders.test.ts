// Pure tests for the reminder offsets. The cron fires every 5 minutes, so the
// important property is that each predicate is true across a whole day window
// (day bucketing then collapses it to one send) and false everywhere else.

import { describe, expect, test } from 'vitest'
import {
  DAY_MS,
  daysUntil,
  describeReminderSchedule,
  draftReminderDecision,
  OVERDUE_REMINDER_MAX_DAYS,
  taskReminderDecision,
} from './reminders.ts'

const now = Date.UTC(2026, 8, 1, 12, 0, 0)
const inDays = (days: number, offsetMs = 0) => now + days * DAY_MS + offsetMs

describe('daysUntil', () => {
  test('rounds down toward the deadline', () => {
    expect(daysUntil(inDays(3), now)).toBe(3)
    expect(daysUntil(inDays(3) - 1, now)).toBe(2)
    expect(daysUntil(now + 2 * 60 * 60 * 1000, now)).toBe(0)
    expect(daysUntil(now - 1, now)).toBe(-1)
    expect(daysUntil(inDays(-2), now)).toBe(-2)
  })
})

describe('taskReminderDecision', () => {
  test('fires on the 3-day, 1-day and due-day windows', () => {
    const table = [-8, -7, -1, 0, 1, 2, 3, 4, 5].map((days) => [
      days,
      taskReminderDecision(inDays(days), now),
    ])
    expect(Object.fromEntries(table)).toMatchInlineSnapshot(`
      {
        "-1": {
          "daysUntil": -1,
          "due": true,
        },
        "-7": {
          "daysUntil": -7,
          "due": true,
        },
        "-8": {
          "due": false,
        },
        "0": {
          "daysUntil": 0,
          "due": true,
        },
        "1": {
          "daysUntil": 1,
          "due": true,
        },
        "2": {
          "due": false,
        },
        "3": {
          "daysUntil": 3,
          "due": true,
        },
        "4": {
          "due": false,
        },
        "5": {
          "due": false,
        },
      }
    `)
  })

  test('keeps nudging while overdue, then gives up', () => {
    expect(taskReminderDecision(now - 1, now)).toMatchInlineSnapshot(`
      {
        "daysUntil": -1,
        "due": true,
      }
    `)
    expect(taskReminderDecision(inDays(-OVERDUE_REMINDER_MAX_DAYS) + 1, now).due).toBe(true)
    expect(taskReminderDecision(inDays(-OVERDUE_REMINDER_MAX_DAYS - 1), now).due).toBe(false)
  })

  test('stays true across the whole 3-day window', () => {
    // Any moment inside the 24h window that rounds to "3 days left" must fire,
    // otherwise a cron tick could step over the reminder entirely.
    expect(taskReminderDecision(inDays(3), now).due).toBe(true)
    expect(taskReminderDecision(inDays(4) - 1, now).due).toBe(true)
    expect(taskReminderDecision(inDays(4), now).due).toBe(false)
  })

  test('a task with no deadline is never chased', () => {
    expect(taskReminderDecision(null, now)).toMatchInlineSnapshot(`
      {
        "due": false,
      }
    `)
  })
})

describe('draftReminderDecision', () => {
  test('fires before close and never after', () => {
    const table = [-1, 0, 1, 2, 3, 4].map((days) => [
      days,
      draftReminderDecision(inDays(days), now).due,
    ])
    expect(Object.fromEntries(table)).toMatchInlineSnapshot(`
      {
        "-1": false,
        "0": true,
        "1": true,
        "2": false,
        "3": true,
        "4": false,
      }
    `)
  })

  test('a form with no close date never reminds', () => {
    expect(draftReminderDecision(null, now).due).toBe(false)
  })
})

describe('describeReminderSchedule', () => {
  test('documents the implemented offsets', () => {
    expect('\n' + describeReminderSchedule().join('\n')).toMatchInlineSnapshot(`
      "
      Task assignments: 3, 1, 0 days before the due date, then once a day while overdue for up to 7 days.
      Unsubmitted CFP drafts: 3, 1, 0 days before the form closes.
      One reminder per item per calendar day in the event timezone, enforced by the outbox dedupe key.
      The cron runs every 5 minutes; it also closes forms past their deadline, retries failed mail, and cleans up unreferenced uploads."
    `)
  })
})
