// RFC 5545 iCalendar generation (pure — no DB, no worker imports).
//
// Two consumers: the SCHEDULE_INVITE/UPDATE/CANCEL emails attach a single
// VEVENT with METHOD:REQUEST|CANCEL, and the public /public/:slug/schedule.ics
// feed (Task 9) emits a multi-VEVENT PUBLISH calendar.
//
// Two rules make calendar updates work instead of duplicating entries in
// Gmail/Outlook/iCal:
//   1. UID is STABLE per session forever — `session-{id}@{appDomain}`.
//   2. SEQUENCE increases on every change. A reschedule is a METHOD:REQUEST
//      with a higher SEQUENCE, never a new UID.
// Clients silently ignore an update whose SEQUENCE did not grow, so
// eventSession.icsSequence must be bumped by the agenda writer (Task 8).

export type IcsMethod = 'REQUEST' | 'CANCEL'

export type IcsAttendee = {
  email: string
  name?: string | null
}

export type IcsEventInput = {
  sessionId: string
  /** Bare host used to namespace the UID, e.g. "opensession.dev". */
  appDomain: string
  sequence: number
  title: string
  description?: string | null
  /** Epoch ms. */
  startsAt: number
  /** Epoch ms. */
  endsAt: number
  /** Room name and/or venue — joined into LOCATION. */
  roomName?: string | null
  location?: string | null
  url?: string | null
  organizerEmail: string
  organizerName?: string | null
  attendees?: IcsAttendee[]
  cancelled?: boolean
  /** Epoch ms used for DTSTAMP; defaults to startsAt so output is deterministic. */
  stamp?: number
}

const PRODID = '-//OpenSession//OpenSession//EN'

/** RFC 5545 §3.3.11 TEXT escaping. Order matters: backslash first. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * RFC 5545 §3.1 content line folding: no line may exceed 75 OCTETS (not
 * characters). Continuation lines start with a single space. We fold on the
 * UTF-8 byte length and never split a multi-byte code point, otherwise
 * non-ASCII titles produce a corrupt file.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line

  const out: string[] = []
  let current = ''
  let currentBytes = 0
  // First line budget is 75; continuation lines lose one octet to the leading space.
  let budget = 75
  for (const char of line) {
    const size = encoder.encode(char).length
    if (currentBytes + size > budget) {
      out.push(current)
      current = ''
      currentBytes = 0
      budget = 74
    }
    current += char
    currentBytes += size
  }
  if (current) out.push(current)
  return out.map((part, index) => (index === 0 ? part : ` ${part}`)).join('\r\n')
}

/** Epoch ms → RFC 5545 UTC date-time (`20260812T173000Z`). */
export function toIcsUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export function icsUid(sessionId: string, appDomain: string): string {
  return `session-${sessionId}@${appDomain}`
}

function nameParam(name: string | null | undefined): string {
  if (!name) return ''
  // CN is a param value: quote it and strip the characters that would break
  // the parameter grammar (RFC 5545 §3.1 forbids DQUOTE inside a quoted string).
  return `;CN="${name.replace(/["\\;:,\r\n]/g, ' ').trim()}"`
}

/** VEVENT body lines (unfolded). Shared by the single-event and calendar builders. */
function veventLines(input: IcsEventInput): string[] {
  const stamp = input.stamp ?? input.startsAt
  const locationParts = [input.roomName, input.location].filter(
    (part): part is string => Boolean(part && part.trim()),
  )
  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${icsUid(input.sessionId, input.appDomain)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(input.sequence))}`,
    `DTSTAMP:${toIcsUtc(stamp)}`,
    `DTSTART:${toIcsUtc(input.startsAt)}`,
    `DTEND:${toIcsUtc(input.endsAt)}`,
    `SUMMARY:${escapeIcsText(input.title)}`,
  ]
  if (input.description?.trim()) {
    lines.push(`DESCRIPTION:${escapeIcsText(input.description)}`)
  }
  if (locationParts.length > 0) {
    lines.push(`LOCATION:${escapeIcsText(locationParts.join(', '))}`)
  }
  if (input.url) lines.push(`URL:${escapeIcsText(input.url)}`)
  lines.push(
    `ORGANIZER${nameParam(input.organizerName)}:mailto:${input.organizerEmail}`,
  )
  for (const attendee of input.attendees ?? []) {
    lines.push(
      `ATTENDEE${nameParam(attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee.email}`,
    )
  }
  lines.push(`STATUS:${input.cancelled ? 'CANCELLED' : 'CONFIRMED'}`)
  lines.push('END:VEVENT')
  return lines
}

function wrapCalendar(method: string, bodyLines: string[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    ...bodyLines,
    'END:VCALENDAR',
  ]
  return lines.map(foldIcsLine).join('\r\n') + '\r\n'
}

/**
 * One VEVENT wrapped in a VCALENDAR, ready to attach as `text/calendar`.
 * An update is a REQUEST with a higher SEQUENCE — same UID, never a new one.
 */
export function buildIcsEvent(
  input: IcsEventInput & { method: IcsMethod },
): string {
  const cancelled = input.method === 'CANCEL' ? true : (input.cancelled ?? false)
  return wrapCalendar(input.method, veventLines({ ...input, cancelled }))
}

/** Multi-event PUBLISH calendar for the public schedule feed (Task 9). */
export function buildIcsCalendar(events: IcsEventInput[]): string {
  return wrapCalendar('PUBLISH', events.flatMap((event) => veventLines(event)))
}
