// Pure reminder scheduling decisions (no DB, no env) so the cron's "who gets
// nudged today" logic is unit-testable without a worker runtime.
//
// The cron runs every 5 minutes, so a naive "dueAt is near" test would fire 288
// times a day. Two things stop that: these predicates are true for a whole
// 24-hour window, and the caller's dedupe key is bucketed by calendar day in
// the event timezone. One nudge per item per day, maximum.

export const DAY_MS = 24 * 60 * 60 * 1000

/** Days before the deadline that get a nudge, plus the deadline day itself. */
export const TASK_REMINDER_DAYS: readonly number[] = [3, 1, 0]
export const DRAFT_REMINDER_DAYS: readonly number[] = [3, 1, 0]

/** Stop nagging after this many days past due, so a task nobody will ever do
 *  does not mail the speaker forever. */
export const OVERDUE_REMINDER_MAX_DAYS = 7

/**
 * Whole days from `now` to `target`, rounded down. 3.9 days out is "3 days
 * left"; 2 hours out is "0 days left" (due today); anything past is negative.
 */
export function daysUntil(target: number, now: number): number {
  return Math.floor((target - now) / DAY_MS)
}

export type ReminderDecision = { due: false } | { due: true; daysUntil: number }

/**
 * Task assignment nudges: 3 days out, 1 day out, the day it is due, then once
 * a day while overdue up to OVERDUE_REMINDER_MAX_DAYS.
 */
export function taskReminderDecision(
  dueAt: number | null,
  now: number,
): ReminderDecision {
  // No deadline means no reminder. Chasing an open-ended task is the
  // organizer's job, not the cron's.
  if (dueAt == null) return { due: false }
  const days = daysUntil(dueAt, now)
  if (TASK_REMINDER_DAYS.includes(days)) {
    return { due: true, daysUntil: days }
  }
  if (days < 0 && days >= -OVERDUE_REMINDER_MAX_DAYS) {
    return { due: true, daysUntil: days }
  }
  return { due: false }
}

/**
 * Unsubmitted CFP drafts: 3 days before the form closes, 1 day before, and on
 * the closing day. Never after close — the draft can no longer be submitted,
 * so a nudge would only be annoying.
 */
export function draftReminderDecision(
  // null closesAt = no deadline → no draft-close reminders
  closesAt: number | null,
  now: number,
): ReminderDecision {
  if (closesAt == null) return { due: false }
  const days = daysUntil(closesAt, now)
  if (DRAFT_REMINDER_DAYS.includes(days)) {
    return { due: true, daysUntil: days }
  }
  return { due: false }
}

/** Human copy for the Emails > Reminders admin tab. Kept next to the offsets
 *  so the documented schedule cannot drift from the implemented one. */
export function describeReminderSchedule(): string[] {
  return [
    `Task assignments: ${TASK_REMINDER_DAYS.join(', ')} days before the due date, then once a day while overdue for up to ${OVERDUE_REMINDER_MAX_DAYS} days.`,
    `Unsubmitted CFP drafts: ${DRAFT_REMINDER_DAYS.join(', ')} days before the form closes.`,
    'One reminder per item per calendar day in the event timezone, enforced by the outbox dedupe key.',
    'The cron runs every 5 minutes; it also closes forms past their deadline, retries failed mail, and cleans up unreferenced uploads.',
  ]
}
