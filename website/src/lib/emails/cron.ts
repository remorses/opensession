// The scheduled() handler's work: close forms past their deadline, enqueue
// reminder mail, drain the outbox, and garbage-collect unreferenced uploads.
//
// Wired from app.tsx's default export; wrangler.jsonc runs it every 5 minutes.
//
// Two invariants keep a 5-minute cadence from spamming people:
//   - the reminder predicates in reminders.ts are true for a whole day window
//   - the dedupe key is bucketed by calendar day in the EVENT's timezone
// so an item can produce at most one reminder per day no matter how often the
// cron fires, or how many workers fire it concurrently.
//
// Every step is isolated: a failure in one must not skip the others, otherwise
// a single bad row would permanently block the outbox.

import { env } from 'cloudflare:workers'
import * as orm from 'drizzle-orm'
import * as schema from 'db/schema'
import { getDb } from '../../db.ts'
import { draftReminderDecision, taskReminderDecision } from './reminders.ts'
import {
  dayBucket,
  dedupeKeys,
  drainOutbox,
  enqueueEmail,
  OUTBOX_BATCH_SIZE,
} from './send.ts'
import type { EmailContext } from './templates.ts'

type Db = ReturnType<typeof getDb>

/** Uploads younger than this are never collected: a file row exists for a
 *  short window before the response that references it is written. */
export const FILE_GC_GRACE_MS = 24 * 60 * 60 * 1000

/** Bound every scan so one tick cannot exceed the worker CPU limit. */
const SCAN_LIMIT = 200

export type CronReport = {
  formsClosed: number
  draftRemindersQueued: number
  taskRemindersQueued: number
  outbox: { attempted: number; sent: number; failed: number }
  filesCollected: number
  errors: string[]
}

function contextFor(event: {
  name: string
  slug: string
  timezone: string
}): EmailContext {
  return {
    eventName: event.name,
    eventSlug: event.slug,
    appUrl: env.APP_URL,
    timezone: event.timezone,
  }
}

/** Run one step, recording the failure instead of aborting the whole cron. */
async function step<T>(
  label: string,
  errors: string[],
  fallback: T,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`cron step ${label} failed: ${message}`)
    errors.push(`${label}: ${message}`)
    return fallback
  }
}

export async function runCron({ now }: { now: number }): Promise<CronReport> {
  const db = getDb()
  const errors: string[] = []

  const formsClosed = await step('close-forms', errors, 0, () => closeExpiredForms(db, now))
  const draftRemindersQueued = await step('draft-reminders', errors, 0, () =>
    enqueueDraftReminders(db, now),
  )
  const taskRemindersQueued = await step('task-reminders', errors, 0, () =>
    enqueueTaskReminders(db, now),
  )
  const outbox = await step(
    'drain-outbox',
    errors,
    { attempted: 0, sent: 0, failed: 0 },
    () => drainOutbox({ db, now, limit: OUTBOX_BATCH_SIZE }),
  )
  const filesCollected = await step('file-gc', errors, 0, () => collectOrphanFiles(db, now))

  const report: CronReport = {
    formsClosed,
    draftRemindersQueued,
    taskRemindersQueued,
    outbox,
    filesCollected,
    errors,
  }
  console.log(`cron ${new Date(now).toISOString()} ${JSON.stringify(report)}`)
  return report
}

/** OPEN forms with a closesAt in the past stop accepting submissions.
 *  Forms with null closesAt stay OPEN forever until status changes. */
async function closeExpiredForms(db: Db, now: number): Promise<number> {
  const expired = await db.query.form.findMany({
    where: { status: 'OPEN', closesAt: { lte: now, isNotNull: true } },
    columns: { id: true },
    limit: SCAN_LIMIT,
  })
  if (expired.length === 0) return 0
  await db
    .update(schema.form)
    .set({ status: 'CLOSED', updatedAt: now })
    .where(
      orm.inArray(
        schema.form.id,
        expired.map((row) => row.id),
      ),
    )
  return expired.length
}

/** Unsubmitted CFP drafts whose form is about to close. */
async function enqueueDraftReminders(db: Db, now: number): Promise<number> {
  const drafts = await db.query.formResponse.findMany({
    where: { status: 'DRAFT' },
    with: {
      form: { with: { event: true } },
      speaker: true,
    },
    limit: SCAN_LIMIT,
  })
  let queued = 0
  for (const draft of drafts) {
    const form = draft.form
    if (!form || form.purpose !== 'CFP' || form.status !== 'OPEN') continue
    const event = form.event
    if (!event) continue
    const decision = draftReminderDecision(form.closesAt, now)
    if (!decision.due) continue
    const speaker = draft.speaker
    if (!speaker?.email) continue

    const context = contextFor(event)
    const { inserted } = await enqueueEmail({
      db,
      eventId: event.id,
      toEmail: speaker.email,
      speakerId: speaker.id,
      dedupeKey: dedupeKeys.draftReminder(draft.id, dayBucket(now, event.timezone)),
      payload: {
        kind: 'DRAFT_REMINDER',
        context: { ...context, recipientName: speaker.firstName },
        data: {
          formName: form.name,
          formSlug: form.slug,
          closesAt: form.closesAt ?? now,
          daysUntilClose: decision.daysUntil,
        },
      },
    })
    if (inserted) queued += 1
  }
  return queued
}

/** Open task assignments approaching or past their due date. */
async function enqueueTaskReminders(db: Db, now: number): Promise<number> {
  const assignments = await db.query.taskAssignment.findMany({
    where: { status: { in: ['NOT_STARTED', 'IN_PROGRESS'] }, dueAt: { isNotNull: true } },
    with: {
      taskDefinition: true,
      speaker: true,
      session: true,
    },
    limit: SCAN_LIMIT,
  })
  const due = assignments.filter((row) => taskReminderDecision(row.dueAt, now).due)
  if (due.length === 0) return 0
  // taskAssignment has no `event` relation (eventId is denormalized), so load
  // the events for this batch in one query instead of per row.
  const events = await db.query.event.findMany({
    where: { id: { in: [...new Set(due.map((row) => row.eventId))] } },
    columns: { id: true, name: true, slug: true, timezone: true },
  })
  const eventById = new Map(events.map((row) => [row.id, row]))

  let queued = 0
  for (const assignment of due) {
    const decision = taskReminderDecision(assignment.dueAt, now)
    if (!decision.due) continue
    const event = eventById.get(assignment.eventId)
    const speaker = assignment.speaker
    const definition = assignment.taskDefinition
    if (!event || !speaker?.email || !definition) continue

    const { inserted } = await enqueueEmail({
      db,
      eventId: event.id,
      toEmail: speaker.email,
      speakerId: speaker.id,
      sessionId: assignment.sessionId,
      dedupeKey: dedupeKeys.taskReminder(assignment.id, dayBucket(now, event.timezone)),
      payload: {
        kind: 'TASK_REMINDER',
        context: { ...contextFor(event), recipientName: speaker.firstName },
        data: {
          assignmentId: assignment.id,
          taskTitle: definition.title,
          dueAt: assignment.dueAt,
          sessionTitle: assignment.session?.title ?? null,
          daysUntilDue: decision.daysUntil,
        },
      },
    })
    if (inserted) queued += 1
  }
  return queued
}

/**
 * Delete R2 objects nothing points at any more.
 *
 * ONE guarded statement does the whole decision: a row is removed only if it is
 * older than the grace period AND no reference exists at that instant. Checking
 * references in JS first and deleting afterwards is racy — an upload attached in
 * between would have its reference nulled (the FKs are ON DELETE SET NULL) while
 * its R2 object is already gone, losing a speaker's slides for good.
 *
 * DB first, then R2. A leaked object costs pennies and a later sweep can find it
 * by storage key; a deleted object referenced by a live row is unrecoverable.
 *
 * Task-slot files are live before a final form response exists, so their direct
 * assignment reference is also part of the guard.
 */
async function collectOrphanFiles(db: Db, now: number): Promise<number> {
  const cutoff = now - FILE_GC_GRACE_MS
  const deleted = await db.all<{ storage_key: string }>(orm.sql`
    DELETE FROM file
    WHERE created_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM form_field_value WHERE file_id = file.id)
      AND NOT EXISTS (SELECT 1 FROM speaker WHERE headshot_file_id = file.id)
      AND NOT EXISTS (SELECT 1 FROM event_session WHERE cover_image_file_id = file.id)
      AND NOT EXISTS (SELECT 1 FROM event WHERE logo_file_id = file.id)
      AND task_assignment_id IS NULL
    RETURNING storage_key
  `)
  for (const row of deleted) {
    await env.FILES.delete(row.storage_key)
  }
  return deleted.length
}
