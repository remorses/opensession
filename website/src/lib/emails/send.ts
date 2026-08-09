// Email outbox: enqueue, send, drain.
//
// Every outbound mail becomes an `email_message` row FIRST, then a send is
// attempted. The unique index on `dedupe_key` IS the idempotency gate — two
// concurrent cron ticks racing on the same reminder both insert, one loses the
// conflict, and only one mail goes out. Never send without inserting first.
//
// The row is a full snapshot (subject, html, text, ics). A retry days later
// must deliver the exact message that was queued, so nothing is re-rendered
// from live rows at send time.
//
// Sending uses the Cloudflare Email Service builder overload, which supports
// attachments directly — no hand-rolled MIME. The ICS goes out as a
// `text/calendar; method=...` attachment named invite.ics.

import { env } from 'cloudflare:workers'
import * as orm from 'drizzle-orm'
import * as schema from 'db/schema'
import type { getDb } from '../../db.ts'
import { buildEmail, type EmailKind, type EmailPayload } from './templates.ts'

type Db = ReturnType<typeof getDb>
type EmailRow = typeof schema.emailMessage.$inferSelect

/** Envelope sender. opensession.dev is onboarded to Cloudflare Email Sending
 *  and wrangler.jsonc pins this as the only allowed sender address. */
export const EMAIL_SENDER = {
  email: 'notifications@opensession.dev',
  name: 'OpenSession',
} as const

/** Retries beyond this are pointless; the row stays FAILED for manual retry. */
export const MAX_SEND_ATTEMPTS = 5

/** Upper bound of rows a single cron tick will push, so one invocation cannot
 *  blow the worker CPU limit on a large backlog. */
export const OUTBOX_BATCH_SIZE = 25

/**
 * Dedupe keys live here and nowhere else. Every caller must build its key
 * through this map so the formats cannot drift between the enqueue site and
 * the cron that would otherwise re-enqueue the same mail.
 */
export const dedupeKeys = {
  submission: (formResponseId: string) => `submission:${formResponseId}`,
  decision: (sessionId: string, speakerId: string) => `decision:${sessionId}:${speakerId}`,
  taskAssigned: (assignmentId: string) => `task-assigned:${assignmentId}`,
  /** Day-bucketed: a 5-minute cron must not re-send the same nudge 288 times. */
  taskReminder: (assignmentId: string, day: string) =>
    `reminder:task:${assignmentId}:${day}`,
  draftReminder: (formResponseId: string, day: string) =>
    `reminder:draft:${formResponseId}:${day}`,
  ics: (sessionId: string, speakerId: string, sequence: number) =>
    `ics:${sessionId}:${speakerId}:${sequence}`,
  reviewerInvite: (invitationId: string) => `reviewer-invite:${invitationId}`,
  reviewReminder: (formId: string, reviewerId: string, day: string) =>
    `reminder:review:${formId}:${reviewerId}:${day}`,
} as const

/** `YYYY-MM-DD` in the event's timezone, so "one reminder per day" means the
 *  organizer's day and not a UTC day that splits their evening in half. */
export function dayBucket(epochMs: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs))
}

/** Reply-To must reach a human. Falls back to the platform sender so a mail is
 *  never sent with replies going nowhere. */
export function replyToFor(contactEmail: string | null | undefined): string {
  const trimmed = contactEmail?.trim()
  return trimmed ? trimmed : EMAIL_SENDER.email
}

export type EnqueueInput = {
  db: Db
  eventId: string
  toEmail: string
  dedupeKey: string
  payload: EmailPayload
  speakerId?: string | null
  contactId?: string | null
  sessionId?: string | null
  batchId?: string | null
  /** Rendered iCalendar. Present only for the SCHEDULE_* kinds. */
  ics?: { method: 'REQUEST' | 'CANCEL'; sequence: number; body: string } | null
}

export type EnqueueResult = { inserted: boolean; row: EmailRow | null }

/** Insert the outbox row. `inserted: false` means an identical message was
 *  already queued or sent — that is success, not an error. */
export async function enqueueEmail(input: EnqueueInput): Promise<EnqueueResult> {
  const built = buildEmail(input.payload)
  const inserted = await input.db
    .insert(schema.emailMessage)
    .values({
      eventId: input.eventId,
      kind: input.payload.kind satisfies EmailKind,
      dedupeKey: input.dedupeKey,
      batchId: input.batchId ?? null,
      toEmail: input.toEmail,
      speakerId: input.speakerId ?? null,
      contactId: input.contactId ?? null,
      sessionId: input.sessionId ?? null,
      subject: built.subject,
      bodyHtml: built.html,
      bodyText: built.text,
      icsMethod: input.ics?.method ?? null,
      icsSequence: input.ics?.sequence ?? null,
      icsBody: input.ics?.body ?? null,
    })
    .onConflictDoNothing({ target: schema.emailMessage.dedupeKey })
    .returning()
  return { inserted: inserted.length > 0, row: inserted[0] ?? null }
}

function truncateError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 500 ? `${text.slice(0, 497)}...` : text
}

export type SendOutcome =
  | { status: 'SENT'; messageId: string | null }
  | { status: 'FAILED'; error: string }
  | { status: 'SKIPPED' }

/**
 * Send ONE outbox row and write the result back. Never throws: a broken email
 * must not take down the request or the rest of the cron batch.
 */
export async function sendEmailMessage({
  db,
  row,
  replyTo,
  now,
}: {
  db: Db
  row: EmailRow
  replyTo: string
  now: number
}): Promise<SendOutcome> {
  // Local Workerd tests exercise the real outbox and every caller, but must
  // never deliver mail to the outside world. Keep the row QUEUED so tests do
  // not claim a message was sent when transport was intentionally disabled.
  if (env.EMAIL_DELIVERY_DISABLED === 'true') return { status: 'SKIPPED' }
  try {
    const result = await env.EMAIL.send({
      from: EMAIL_SENDER,
      replyTo,
      to: row.toEmail,
      subject: row.subject,
      html: row.bodyHtml,
      ...(row.bodyText ? { text: row.bodyText } : {}),
      ...(row.icsBody && row.icsMethod
        ? {
            attachments: [
              {
                disposition: 'attachment' as const,
                filename: 'invite.ics',
                type: `text/calendar; charset=utf-8; method=${row.icsMethod}`,
                content: row.icsBody,
              },
            ],
          }
        : {}),
    })
    await db
      .update(schema.emailMessage)
      .set({
        status: 'SENT',
        sentAt: now,
        lastAttemptAt: now,
        attemptCount: row.attemptCount + 1,
        errorMessage: null,
      })
      .where(orm.eq(schema.emailMessage.id, row.id))
      .limit(1)
    return { status: 'SENT', messageId: result?.messageId ?? null }
  } catch (error) {
    const message = truncateError(error)
    await db
      .update(schema.emailMessage)
      .set({
        status: 'FAILED',
        lastAttemptAt: now,
        attemptCount: row.attemptCount + 1,
        errorMessage: message,
      })
      .where(orm.eq(schema.emailMessage.id, row.id))
      .limit(1)
    console.error(`email ${row.id} (${row.kind}) failed: ${message}`)
    return { status: 'FAILED', error: message }
  }
}

/**
 * Exponential backoff between retries: 1, 2, 4, 8, 16 minutes. A row that was
 * just attempted is skipped so a 5-minute cron does not burn all 5 attempts in
 * 25 minutes against a provider outage.
 */
export function retryDueAt(attemptCount: number, lastAttemptAt: number): number {
  const minutes = Math.min(2 ** Math.max(0, attemptCount - 1), 16)
  return lastAttemptAt + minutes * 60_000
}

export type DrainSummary = { attempted: number; sent: number; failed: number }

/**
 * Push queued mail. Picks QUEUED rows plus FAILED rows under the attempt cap
 * whose backoff has elapsed, oldest first, bounded by `limit`.
 */
export async function drainOutbox({
  db,
  now,
  limit = OUTBOX_BATCH_SIZE,
  eventId,
}: {
  db: Db
  now: number
  limit?: number
  /** Restrict to one event (used by the admin retry action). */
  eventId?: string
}): Promise<DrainSummary> {
  if (env.EMAIL_DELIVERY_DISABLED === 'true') {
    return { attempted: 0, sent: 0, failed: 0 }
  }
  const candidates = await db.query.emailMessage.findMany({
    where: {
      status: { in: ['QUEUED', 'FAILED'] },
      attemptCount: { lt: MAX_SEND_ATTEMPTS },
      ...(eventId ? { eventId } : {}),
    },
    orderBy: { createdAt: 'asc' },
    // Over-fetch because the backoff filter below is not expressible in the
    // object-where API; the slice back to `limit` happens after filtering.
    limit: limit * 4,
  })
  const due = candidates
    .filter((row) => {
      if (row.status === 'QUEUED') return true
      return row.lastAttemptAt == null || retryDueAt(row.attemptCount, row.lastAttemptAt) <= now
    })
    .slice(0, limit)
  if (due.length === 0) return { attempted: 0, sent: 0, failed: 0 }

  // One lookup for the Reply-To of every event represented in this batch.
  const eventIds = [...new Set(due.map((row) => row.eventId))]
  const events = await db.query.event.findMany({
    where: { id: { in: eventIds } },
    columns: { id: true, contactEmail: true },
  })
  const replyToByEvent = new Map(
    events.map((row) => [row.id, replyToFor(row.contactEmail)]),
  )

  const summary: DrainSummary = { attempted: 0, sent: 0, failed: 0 }
  for (const row of due) {
    summary.attempted += 1
    const outcome = await sendEmailMessage({
      db,
      row,
      replyTo: replyToByEvent.get(row.eventId) ?? EMAIL_SENDER.email,
      now,
    })
    if (outcome.status === 'SENT') summary.sent += 1
    else summary.failed += 1
  }
  return summary
}

/**
 * Enqueue then immediately try to send, returning whether it reached SENT.
 * Callers that need to act on delivery (stamping notifiedAt) use the result;
 * everything else can ignore it because the cron is the safety net.
 *
 * When the dedupe key already exists this returns `{ inserted: false, sent:
 * false }` WITHOUT re-sending. That is deliberate: re-running Notify must never
 * mail a speaker twice. If that earlier row is stuck in FAILED, the cron's
 * backoff retry owns it, not this path.
 */
export async function enqueueAndSend(
  input: EnqueueInput & { replyTo: string; now: number },
): Promise<{ inserted: boolean; sent: boolean }> {
  const { inserted, row } = await enqueueEmail(input)
  if (!row) return { inserted, sent: false }
  if (env.EMAIL_DELIVERY_DISABLED === 'true') return { inserted, sent: false }
  const outcome = await sendEmailMessage({
    db: input.db,
    row,
    replyTo: input.replyTo,
    now: input.now,
  })
  return { inserted, sent: outcome.status === 'SENT' }
}
