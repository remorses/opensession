// Server-side agenda scheduling: place, move, or clear a session's slot, keep
// eventSession.icsSequence honest, and push the SCHEDULE_* calendar mails
// through the Task 7 outbox. Callers (actions.tsx) authenticate FIRST and hand
// in the already-tenancy-checked { db, event }.
//
// Three rules make calendar clients behave:
//   1. The wall clock is authoritative. The UI sends { dayKey, startMinute,
//      durationMinutes } and the epochs are derived HERE with the event's
//      timezone, so the browser never does timezone math.
//   2. icsSequence only grows when an ALREADY scheduled session changes. A
//      first placement ships the current sequence (usually 0); a reschedule and
//      an unschedule bump it. A same-SEQUENCE update is silently dropped by
//      Gmail/Outlook/iCal, which is exactly the bug this prevents.
//   3. The invite body is snapshotted into the outbox row together with that
//      sequence (send.ts never re-renders it), so a retry days later still
//      sends the message that matches its SEQUENCE.
//
// Conflicts never block: a placement that overlaps is returned to the caller as
// a warning, and the same call with confirmConflicts: true writes it.

import { env } from 'cloudflare:workers'
import * as orm from 'drizzle-orm'
import * as schema from 'db/schema'
import type { getDb } from '../db.ts'
import {
  conflictsForPlacement,
  type Conflict,
  formatDayLabel,
  minutesToLabel,
  toZonedSlot,
  zonedEpoch,
  type ConflictSession,
} from './conflicts.ts'
import { dedupeKeys, enqueueAndSend, replyToFor } from './emails/send.ts'
import { buildIcsEvent } from './ics.ts'

type Db = ReturnType<typeof getDb>
type EventRow = typeof schema.event.$inferSelect

/** Longest slot the grid accepts, so a typo cannot swallow a whole day. */
export const MAX_SLOT_MINUTES = 12 * 60

export type PlacementConflict = {
  sessionId: string
  title: string
  reason: 'ROOM' | 'SPEAKER'
  /** Room name or the shared speaker names — what to show in the warning. */
  detail: string
  /** "Mon, Oct 12 · 09:00 – 09:45" in the event timezone. */
  timeLabel: string
}

export type ScheduleResult = {
  scheduled: boolean
  /** Non-empty when the placement was refused pending confirmation, or when it
   *  was confirmed and written anyway (so the UI can keep warning). */
  conflicts: PlacementConflict[]
  sessionId: string
  icsSequence: number
  emailsQueued: number
}

/** Sessions that may occupy an agenda slot: accepted talks and service blocks. */
function isSchedulable(row: { kind: 'CONTENT' | 'SERVICE'; status: string }): boolean {
  return row.kind === 'SERVICE' || row.status === 'ACCEPTED'
}

/** Every session the agenda cares about, with the joins the views need. */
export async function loadAgendaSessions(db: Db, eventId: string) {
  const rows = await db.query.eventSession.findMany({
    where: { eventId },
    with: {
      room: true,
      track: true,
      format: true,
      participants: {
        with: { speaker: true },
        orderBy: { sortOrder: 'asc' },
      },
    },
    orderBy: { startsAt: 'asc', createdAt: 'asc' },
  })
  return rows.filter(isSchedulable)
}

export function speakerDisplayName(speaker: {
  firstName: string | null
  lastName: string | null
  email: string
}): string {
  const name = [speaker.firstName, speaker.lastName].filter(Boolean).join(' ').trim()
  return name || speaker.email
}

function toConflictSession(row: {
  id: string
  roomId: string | null
  startsAt: number | null
  endsAt: number | null
  participants: Array<{ speakerId: string }>
}): ConflictSession {
  return {
    id: row.id,
    roomId: row.roomId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    speakerIds: row.participants.map((part) => part.speakerId),
  }
}

/** "Mon, Oct 12 · 09:00 – 09:45" in the event timezone (server-only Intl). */
export function scheduleLabel(
  startsAt: number,
  endsAt: number,
  timezone: string,
): string {
  const start = toZonedSlot(startsAt, timezone)
  const end = toZonedSlot(endsAt, timezone)
  return `${formatDayLabel(start.dayKey)} · ${minutesToLabel(start.minutes)} – ${minutesToLabel(end.minutes)}`
}

function appDomain(): string {
  try {
    return new URL(env.APP_URL).host
  } catch {
    return 'opensession.dev'
  }
}

type AgendaRow = Awaited<ReturnType<typeof loadAgendaSessions>>[number]

function describeConflicts({
  conflicts,
  candidateId,
  byId,
  rooms,
  timezone,
}: {
  conflicts: Conflict[]
  candidateId: string
  byId: Map<string, AgendaRow>
  rooms: Map<string, string>
  timezone: string
}): PlacementConflict[] {
  const out: PlacementConflict[] = []
  for (const conflict of conflicts) {
    const otherId = conflict.aId === candidateId ? conflict.bId : conflict.aId
    const other = byId.get(otherId)
    if (!other) continue
    const speakerNames = (conflict.speakerIds ?? []).map((speakerId) => {
      const part = other.participants.find((row) => row.speakerId === speakerId)
      return part?.speaker ? speakerDisplayName(part.speaker) : 'Speaker'
    })
    out.push({
      sessionId: otherId,
      title: other.title?.trim() || 'Untitled',
      reason: conflict.reason,
      detail:
        conflict.reason === 'ROOM'
          ? (rooms.get(conflict.roomId ?? '') ?? 'Same room')
          : speakerNames.join(', ') || 'Shared speaker',
      timeLabel:
        other.startsAt != null && other.endsAt != null
          ? scheduleLabel(other.startsAt, other.endsAt, timezone)
          : '',
    })
  }
  return out
}

/**
 * Enqueue one calendar mail per participant speaker. The ICS body is built
 * once (all attendees listed) and snapshotted with the sequence it belongs to.
 */
async function sendScheduleMails({
  db,
  event,
  session,
  roomName,
  startsAt,
  endsAt,
  sequence,
  kind,
  now,
}: {
  db: Db
  event: EventRow
  session: AgendaRow
  roomName: string | null
  startsAt: number
  endsAt: number
  sequence: number
  kind: 'SCHEDULE_INVITE' | 'SCHEDULE_UPDATE' | 'SCHEDULE_CANCEL'
  now: number
}): Promise<number> {
  const speakers = session.participants
    .map((part) => part.speaker)
    .filter((speaker): speaker is NonNullable<typeof speaker> => Boolean(speaker?.email))
  if (speakers.length === 0) return 0

  const method = kind === 'SCHEDULE_CANCEL' ? 'CANCEL' : 'REQUEST'
  const organizerEmail = replyToFor(event.contactEmail)
  const title = session.title?.trim() || 'Session'
  const icsBody = buildIcsEvent({
    method,
    sessionId: session.id,
    appDomain: appDomain(),
    sequence,
    title,
    description: session.description,
    startsAt,
    endsAt,
    roomName,
    location: event.location,
    url: `${env.APP_URL}/portal/${event.slug}`,
    organizerEmail,
    organizerName: event.name,
    attendees: speakers.map((speaker) => ({
      email: speaker.email,
      name: speakerDisplayName(speaker),
    })),
    stamp: now,
  })

  const context = {
    eventName: event.name,
    eventSlug: event.slug,
    appUrl: env.APP_URL,
    timezone: event.timezone,
  }
  let queued = 0
  for (const speaker of speakers) {
    const result = await enqueueAndSend({
      db,
      eventId: event.id,
      toEmail: speaker.email,
      speakerId: speaker.id,
      sessionId: session.id,
      dedupeKey: dedupeKeys.ics(session.id, speaker.id, sequence),
      replyTo: organizerEmail,
      now,
      ics: { method, sequence, body: icsBody },
      payload: {
        kind,
        context: { ...context, recipientName: speaker.firstName },
        data: {
          sessionId: session.id,
          sessionTitle: title,
          startsAt,
          endsAt,
          roomName,
        },
      },
    })
    if (result.inserted) queued += 1
  }
  return queued
}

/**
 * Place or move a session. Returns `scheduled: false` with the conflicts when
 * the placement overlaps and the caller has not confirmed yet — nothing is
 * written in that case.
 */
export async function scheduleSessionSlot({
  db,
  event,
  sessionId,
  roomId,
  dayKey,
  startMinute,
  durationMinutes,
  confirmConflicts,
  now,
}: {
  db: Db
  event: EventRow
  sessionId: string
  roomId: string
  dayKey: string
  startMinute: number
  durationMinutes: number
  confirmConflicts: boolean
  now: number
}): Promise<ScheduleResult> {
  const sessions = await loadAgendaSessions(db, event.id)
  const session = sessions.find((row) => row.id === sessionId)
  if (!session) throw new Error('Session not found or not schedulable')

  const room = await db.query.room.findFirst({ where: { id: roomId, eventId: event.id } })
  if (!room) throw new Error('Room not found')

  const startsAt = zonedEpoch(dayKey, startMinute, event.timezone)
  const endsAt = startsAt + durationMinutes * 60_000

  const byId = new Map(sessions.map((row) => [row.id, row]))
  const rooms = new Map(
    sessions.flatMap((row) => (row.room ? [[row.room.id, row.room.name] as const] : [])),
  )
  rooms.set(room.id, room.name)

  const conflicts = describeConflicts({
    conflicts: conflictsForPlacement({
      candidate: { ...toConflictSession(session), roomId, startsAt, endsAt },
      others: sessions.map(toConflictSession),
    }),
    candidateId: session.id,
    byId,
    rooms,
    timezone: event.timezone,
  })
  if (conflicts.length > 0 && !confirmConflicts) {
    return {
      scheduled: false,
      conflicts,
      sessionId: session.id,
      icsSequence: session.icsSequence,
      emailsQueued: 0,
    }
  }

  const unchanged =
    session.roomId === roomId && session.startsAt === startsAt && session.endsAt === endsAt
  if (unchanged) {
    return {
      scheduled: true,
      conflicts,
      sessionId: session.id,
      icsSequence: session.icsSequence,
      emailsQueued: 0,
    }
  }

  const wasScheduled =
    session.roomId != null && session.startsAt != null && session.endsAt != null
  const sequence = wasScheduled ? session.icsSequence + 1 : session.icsSequence

  await db
    .update(schema.eventSession)
    .set({ roomId, startsAt, endsAt, icsSequence: sequence, updatedAt: now })
    .where(
      orm.and(
        orm.eq(schema.eventSession.id, session.id),
        orm.eq(schema.eventSession.eventId, event.id),
      ),
    )
    .limit(1)

  const emailsQueued = await sendScheduleMails({
    db,
    event,
    session,
    roomName: room.name,
    startsAt,
    endsAt,
    sequence,
    kind: wasScheduled ? 'SCHEDULE_UPDATE' : 'SCHEDULE_INVITE',
    now,
  })

  return { scheduled: true, conflicts, sessionId: session.id, icsSequence: sequence, emailsQueued }
}

/**
 * Clear a session's slot and send the cancellation. The ICS carries the OLD
 * times (a CANCEL must reference the event the client already has) under a
 * bumped SEQUENCE.
 */
export async function clearSessionSlot({
  db,
  event,
  sessionId,
  now,
}: {
  db: Db
  event: EventRow
  sessionId: string
  now: number
}): Promise<ScheduleResult> {
  const sessions = await loadAgendaSessions(db, event.id)
  const session = sessions.find((row) => row.id === sessionId)
  if (!session) throw new Error('Session not found or not schedulable')
  if (session.startsAt == null || session.endsAt == null) {
    return {
      scheduled: false,
      conflicts: [],
      sessionId,
      icsSequence: session.icsSequence,
      emailsQueued: 0,
    }
  }

  const sequence = session.icsSequence + 1
  const previousStart = session.startsAt
  const previousEnd = session.endsAt

  await db
    .update(schema.eventSession)
    .set({ roomId: null, startsAt: null, endsAt: null, icsSequence: sequence, updatedAt: now })
    .where(
      orm.and(
        orm.eq(schema.eventSession.id, session.id),
        orm.eq(schema.eventSession.eventId, event.id),
      ),
    )
    .limit(1)

  const emailsQueued = await sendScheduleMails({
    db,
    event,
    session,
    roomName: session.room?.name ?? null,
    startsAt: previousStart,
    endsAt: previousEnd,
    sequence,
    kind: 'SCHEDULE_CANCEL',
    now,
  })

  return { scheduled: false, conflicts: [], sessionId, icsSequence: sequence, emailsQueued }
}
