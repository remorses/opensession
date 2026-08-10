// Shared pure model for Phase 5: deterministic auto-placement and the only
// projection allowed to feed anonymous pages, JSON, ICS, and iframe widgets.
import {
  eventDayKeys,
  formatDayLabel,
  formatSlotRange,
  toZonedSlot,
} from './conflicts.ts'

export type AutoPlaceSession = {
  id: string
  roomId: string | null
  dayKey: string | null
  startMinute: number | null
  endMinute: number | null
  durationMinutes: number
  speakerIds: string[]
}

export type AutoPlacement = {
  sessionId: string
  roomId: string
  dayKey: string
  startMinute: number
  durationMinutes: number
}

export type AutoPlaceResult = {
  placements: AutoPlacement[]
  unplacedSessionIds: string[]
}

type OccupiedSlot = {
  sessionId: string
  roomId: string
  dayKey: string
  startMinute: number
  endMinute: number
  speakerIds: string[]
}

/**
 * Stable first-fit packing. Existing placements are fixed. Unscheduled rows,
 * days, rooms, and 15-minute candidates are all traversed in a defined order.
 */
export function autoPlaceSessions({
  days,
  rooms,
  sessions,
  startMinute = 8 * 60,
  endMinute = 18 * 60,
}: {
  days: string[]
  rooms: Array<{ id: string }>
  sessions: AutoPlaceSession[]
  startMinute?: number
  endMinute?: number
}): AutoPlaceResult {
  const occupied: OccupiedSlot[] = sessions.flatMap((session) =>
    session.roomId && session.dayKey && session.startMinute != null && session.endMinute != null
      ? [{
          sessionId: session.id,
          roomId: session.roomId,
          dayKey: session.dayKey,
          startMinute: session.startMinute,
          endMinute: session.endMinute,
          speakerIds: [...new Set(session.speakerIds)].sort(),
        }]
      : [],
  )
  const waiting = sessions
    .filter((session) => !session.roomId || !session.dayKey || session.startMinute == null || session.endMinute == null)
    .sort((a, b) => a.id.localeCompare(b.id))
  const sortedDays = [...days]
  const sortedRooms = [...rooms].sort((a, b) => a.id.localeCompare(b.id))
  const placements: AutoPlacement[] = []
  const unplacedSessionIds: string[] = []

  for (const session of waiting) {
    const durationMinutes = Math.max(5, Math.ceil(session.durationMinutes / 5) * 5)
    let selected: OccupiedSlot | null = null
    for (const dayKey of sortedDays) {
      for (let minute = startMinute; minute + durationMinutes <= endMinute; minute += 15) {
        for (const room of sortedRooms) {
          const candidate: OccupiedSlot = {
            sessionId: session.id,
            roomId: room.id,
            dayKey,
            startMinute: minute,
            endMinute: minute + durationMinutes,
            speakerIds: [...new Set(session.speakerIds)].sort(),
          }
          const conflict = occupied.some((slot) => {
            if (
              slot.dayKey !== candidate.dayKey
              || slot.startMinute >= candidate.endMinute
              || candidate.startMinute >= slot.endMinute
            ) return false
            if (slot.roomId === candidate.roomId) return true
            return candidate.speakerIds.some((speakerId) => slot.speakerIds.includes(speakerId))
          })
          if (!conflict) {
            selected = candidate
            break
          }
        }
        if (selected) break
      }
      if (selected) break
    }
    if (!selected) {
      unplacedSessionIds.push(session.id)
      continue
    }
    occupied.push(selected)
    placements.push({
      sessionId: selected.sessionId,
      roomId: selected.roomId,
      dayKey: selected.dayKey,
      startMinute: selected.startMinute,
      durationMinutes,
    })
  }

  return { placements, unplacedSessionIds }
}

export type PublicProgramSource = {
  event: {
    id: string
    name: string
    slug: string
    status: string
    timezone: string
    startsAt: number
    endsAt: number
    location: string | null
    description: string | null
    programPublishedAt: number | null
  }
  sessions: Array<{
    id: string
    kind: 'CONTENT' | 'SERVICE'
    status: string
    visibility: 'PUBLIC' | 'PRIVATE'
    title: string | null
    description: string | null
    startsAt: number | null
    endsAt: number | null
    roomId: string | null
    coverImageFileId: string | null
    room: { id: string; name: string } | null
    track: { id: string; name: string; color: string } | null
    format: { id: string; name: string } | null
    participants: Array<{
      role: 'SPEAKER' | 'MODERATOR'
      sortOrder: number
      speaker: {
        id: string
        firstName: string
        lastName: string
        bio: string | null
        jobTitle: string | null
        companyName: string | null
        headshotFileId: string | null
        avatarUrl: string | null
      } | null
    }>
  }>
}

export type PublicSpeaker = {
  id: string
  firstName: string
  lastName: string
  name: string
  bio: string | null
  jobTitle: string | null
  companyName: string | null
  photoUrl: string | null
  sessionIds: string[]
}

export type PublicSession = {
  id: string
  kind: 'CONTENT' | 'SERVICE'
  title: string
  description: string | null
  startsAt: number
  endsAt: number
  dayKey: string
  dayLabel: string
  startMinute: number
  endMinute: number
  timeLabel: string
  room: { id: string; name: string }
  track: { id: string; name: string; color: string } | null
  format: { id: string; name: string } | null
  coverImageUrl: string | null
  speakers: PublicSpeaker[]
}

export type PublicEvent = {
  id: string
  name: string
  slug: string
  timezone: string
  startsAt: number
  endsAt: number
  location: string | null
  description: string | null
  programPublishedAt: number
}

export type PublicProgram = {
  event: PublicEvent
  days: string[]
  rooms: Array<{ id: string; name: string }>
  tracks: Array<{ id: string; name: string; color: string }>
  formats: Array<{ id: string; name: string }>
  sessions: PublicSession[]
  speakers: PublicSpeaker[]
}

function publicFileUrl(fileId: string | null): string | null {
  return fileId ? `/files/${encodeURIComponent(fileId)}` : null
}

export function isPublicProgramSession(
  event: Pick<PublicProgramSource['event'], 'status' | 'programPublishedAt'>,
  session: Pick<PublicProgramSource['sessions'][number], 'status' | 'visibility' | 'roomId' | 'startsAt' | 'endsAt'>,
): boolean {
  return event.status === 'ACTIVE'
    && event.programPublishedAt != null
    && session.status === 'ACCEPTED'
    && session.visibility === 'PUBLIC'
    && session.roomId != null
    && session.startsAt != null
    && session.endsAt != null
    && session.endsAt > session.startsAt
}

type ProgramPublicationSession = Pick<
  PublicProgramSource['sessions'][number],
  'status' | 'visibility' | 'roomId' | 'startsAt' | 'endsAt'
>

/** Counts accepted scheduled rows by the visibility gate used by public output. */
export function summarizeProgramPublication(sessions: ProgramPublicationSession[]) {
  let publicScheduledCount = 0
  let privateScheduledCount = 0
  for (const session of sessions) {
    const scheduled = session.status === 'ACCEPTED'
      && session.roomId != null
      && session.startsAt != null
      && session.endsAt != null
      && session.endsAt > session.startsAt
    if (!scheduled) continue
    if (session.visibility === 'PUBLIC') publicScheduledCount += 1
    else privateScheduledCount += 1
  }
  return { publicScheduledCount, privateScheduledCount }
}

/** ACTIVE + published event, then ACCEPTED + PUBLIC + scheduled rows only. */
export function projectPublicProgram(source: PublicProgramSource): PublicProgram | null {
  if (source.event.status !== 'ACTIVE' || source.event.programPublishedAt == null) return null

  const eligible = source.sessions.filter((session) => isPublicProgramSession(source.event, session) && session.room != null)
  const speakerSessionIds = new Map<string, string[]>()
  const speakerById = new Map<string, PublicSpeaker>()
  for (const session of eligible) {
    for (const participant of session.participants) {
      const speaker = participant.speaker
      if (!speaker) continue
      const ids = speakerSessionIds.get(speaker.id) ?? []
      ids.push(session.id)
      speakerSessionIds.set(speaker.id, ids)
      speakerById.set(speaker.id, {
        id: speaker.id,
        firstName: speaker.firstName,
        lastName: speaker.lastName,
        name: `${speaker.firstName} ${speaker.lastName}`.trim(),
        bio: speaker.bio,
        jobTitle: speaker.jobTitle,
        companyName: speaker.companyName,
        photoUrl: publicFileUrl(speaker.headshotFileId) ?? speaker.avatarUrl,
        sessionIds: [],
      })
    }
  }
  for (const [id, speaker] of speakerById) {
    speaker.sessionIds = [...new Set(speakerSessionIds.get(id) ?? [])].sort()
  }

  const sessions = eligible.map((session): PublicSession => {
    const startsAt = session.startsAt!
    const endsAt = session.endsAt!
    const start = toZonedSlot(startsAt, source.event.timezone)
    const end = toZonedSlot(endsAt, source.event.timezone)
    const endMinute = end.dayKey === start.dayKey ? end.minutes : 24 * 60
    return {
      id: session.id,
      kind: session.kind,
      title: session.title?.trim() || 'Untitled',
      description: session.description,
      startsAt,
      endsAt,
      dayKey: start.dayKey,
      dayLabel: formatDayLabel(start.dayKey),
      startMinute: start.minutes,
      endMinute,
      timeLabel: formatSlotRange(start.minutes, endMinute),
      room: session.room!,
      track: session.track,
      format: session.format,
      coverImageUrl: publicFileUrl(session.coverImageFileId),
      speakers: session.participants.flatMap((participant) => {
        const speaker = participant.speaker ? speakerById.get(participant.speaker.id) : null
        return speaker ? [speaker] : []
      }),
    }
  }).sort((a, b) => a.startsAt - b.startsAt || a.room.name.localeCompare(b.room.name) || a.id.localeCompare(b.id))

  const speakers = [...speakerById.values()].sort(
    (a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.id.localeCompare(b.id),
  )
  const rooms = uniqueBy(sessions.map((session) => session.room), (row) => row.id)
    .sort((a, b) => a.name.localeCompare(b.name))
  const tracks = uniqueBy(sessions.flatMap((session) => session.track ? [session.track] : []), (row) => row.id)
    .sort((a, b) => a.name.localeCompare(b.name))
  const formats = uniqueBy(sessions.flatMap((session) => session.format ? [session.format] : []), (row) => row.id)
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    event: {
      id: source.event.id,
      name: source.event.name,
      slug: source.event.slug,
      timezone: source.event.timezone,
      startsAt: source.event.startsAt,
      endsAt: source.event.endsAt,
      location: source.event.location,
      description: source.event.description,
      programPublishedAt: source.event.programPublishedAt,
    },
    days: eventDayKeys(source.event.startsAt, source.event.endsAt, source.event.timezone),
    rooms,
    tracks,
    formats,
    sessions,
    speakers,
  }
}

function uniqueBy<T>(rows: T[], key: (row: T) => string): T[] {
  return [...new Map(rows.map((row) => [key(row), row])).values()]
}

export type PublicProgramFilters = {
  q?: string
  track?: string
  format?: string
  room?: string
}

export type PublicWidgetView = 'sessions' | 'speakers' | 'agenda' | 'itinerary' | 'gallery'
export const PUBLIC_WIDGET_FIELDS = [
  'description', 'speakers', 'track', 'format', 'room', 'time',
  'photo', 'jobTitle', 'company', 'bio', 'sessions',
] as const
export type PublicWidgetField = (typeof PUBLIC_WIDGET_FIELDS)[number]
const publicWidgetFieldSet: ReadonlySet<string> = new Set(PUBLIC_WIDGET_FIELDS)

export function filterPublicSessions(sessions: PublicSession[], filters: PublicProgramFilters): PublicSession[] {
  const query = filters.q?.trim().toLocaleLowerCase('en-US') ?? ''
  return sessions.filter((session) => {
    if (filters.track && session.track?.id !== filters.track) return false
    if (filters.format && session.format?.id !== filters.format) return false
    if (filters.room && session.room.id !== filters.room) return false
    if (!query) return true
    return [session.title, session.description, ...session.speakers.map((speaker) => speaker.name)]
      .some((value) => value?.toLocaleLowerCase('en-US').includes(query))
  })
}

export function filterPublicSpeakers(speakers: PublicSpeaker[], query?: string): PublicSpeaker[] {
  const normalized = query?.trim().toLocaleLowerCase('en-US') ?? ''
  return normalized
    ? speakers.filter((speaker) => speaker.name.toLocaleLowerCase('en-US').includes(normalized))
    : speakers
}

export function parsePublicWidgetFields(fields?: string): PublicWidgetField[] | undefined {
  return fields?.split(',').filter((field): field is PublicWidgetField => publicWidgetFieldSet.has(field))
}

export function selectPublicWidgetData({ program, view, filters }: {
  program: PublicProgram
  view: PublicWidgetView
  filters: PublicProgramFilters
}) {
  if (view === 'speakers' || view === 'gallery') {
    return { event: program.event, speakers: filterPublicSpeakers(program.speakers, filters.q) }
  }
  return { event: program.event, sessions: filterPublicSessions(program.sessions, filters) }
}

function escapeMarkup(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fieldIsVisible(fields: PublicWidgetField[] | undefined, field: PublicWidgetField): boolean {
  return !fields || fields.includes(field)
}

/** Basic, unstyled HTML output for websites that do not want the interactive widget. */
export function renderPublicWidgetHtml(
  { program, view, filters, fields }: {
    program: PublicProgram
    view: PublicWidgetView
    filters: PublicProgramFilters
    fields?: PublicWidgetField[]
  },
): string {
  const title = `${program.event.name} ${view}`
  const body = view === 'speakers' || view === 'gallery'
    ? filterPublicSpeakers(program.speakers, filters.q).map((speaker) => {
        const sessions = program.sessions.filter((session) => speaker.sessionIds.includes(session.id))
        return `<article><h2>${escapeMarkup(speaker.name)}</h2>${fieldIsVisible(fields, 'jobTitle') && speaker.jobTitle ? `<p>${escapeMarkup(speaker.jobTitle)}</p>` : ''}${fieldIsVisible(fields, 'company') && speaker.companyName ? `<p>${escapeMarkup(speaker.companyName)}</p>` : ''}${fieldIsVisible(fields, 'bio') && speaker.bio ? `<p>${escapeMarkup(speaker.bio)}</p>` : ''}${fieldIsVisible(fields, 'sessions') ? `<ul>${sessions.map((session) => `<li>${escapeMarkup(session.title)}${fieldIsVisible(fields, 'time') ? ` · ${escapeMarkup(session.dayLabel)} · ${escapeMarkup(session.timeLabel)}` : ''}${fieldIsVisible(fields, 'room') ? ` · ${escapeMarkup(session.room.name)}` : ''}</li>`).join('')}</ul>` : ''}</article>`
      }).join('')
    : filterPublicSessions(program.sessions, filters).map((session) => `<article><h2>${escapeMarkup(session.title)}</h2>${fieldIsVisible(fields, 'description') && session.description ? `<p>${escapeMarkup(session.description)}</p>` : ''}${fieldIsVisible(fields, 'time') ? `<p>${escapeMarkup(session.dayLabel)} · ${escapeMarkup(session.timeLabel)}</p>` : ''}${fieldIsVisible(fields, 'room') ? `<p>${escapeMarkup(session.room.name)}</p>` : ''}${fieldIsVisible(fields, 'speakers') ? `<p>${session.speakers.map((speaker) => escapeMarkup(speaker.name)).join(', ')}</p>` : ''}${fieldIsVisible(fields, 'track') && session.track ? `<p>Track: ${escapeMarkup(session.track.name)}</p>` : ''}${fieldIsVisible(fields, 'format') && session.format ? `<p>Format: ${escapeMarkup(session.format.name)}</p>` : ''}</article>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeMarkup(title)}</title></head><body><main><h1>${escapeMarkup(program.event.name)}</h1>${body}</main></body></html>`
}

/** XML feed output built from the same projected rows as pages, JSON, and iCal. */
export function renderPublicWidgetXml({ program, view, filters }: {
  program: PublicProgram
  view: PublicWidgetView
  filters: PublicProgramFilters
}): string {
  const event = `<event id="${escapeMarkup(program.event.id)}"><name>${escapeMarkup(program.event.name)}</name><slug>${escapeMarkup(program.event.slug)}</slug></event>`
  if (view === 'speakers' || view === 'gallery') {
    const speakers = filterPublicSpeakers(program.speakers, filters.q).map((speaker) => `<speaker id="${escapeMarkup(speaker.id)}"><name>${escapeMarkup(speaker.name)}</name><bio>${escapeMarkup(speaker.bio ?? '')}</bio><jobTitle>${escapeMarkup(speaker.jobTitle ?? '')}</jobTitle><company>${escapeMarkup(speaker.companyName ?? '')}</company><sessionIds>${speaker.sessionIds.map((id) => `<sessionId>${escapeMarkup(id)}</sessionId>`).join('')}</sessionIds></speaker>`).join('')
    return `<?xml version="1.0" encoding="UTF-8"?><program>${event}<speakers>${speakers}</speakers></program>`
  }
  const sessions = filterPublicSessions(program.sessions, filters).map((session) => `<session id="${escapeMarkup(session.id)}"><title>${escapeMarkup(session.title)}</title><description>${escapeMarkup(session.description ?? '')}</description><startsAt>${session.startsAt}</startsAt><endsAt>${session.endsAt}</endsAt><room>${escapeMarkup(session.room.name)}</room><track>${escapeMarkup(session.track?.name ?? '')}</track><format>${escapeMarkup(session.format?.name ?? '')}</format><speakers>${session.speakers.map((speaker) => `<speaker id="${escapeMarkup(speaker.id)}">${escapeMarkup(speaker.name)}</speaker>`).join('')}</speakers></session>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><program>${event}<sessions>${sessions}</sessions></program>`
}

/** Single external script output. It inserts the live iframe after its script tag. */
export function buildPublicWidgetScript({ iframeUrl, title }: { iframeUrl: string; title: string }): string {
  return `(()=>{const s=document.currentScript;if(!s)return;const f=document.createElement('iframe');f.src=${JSON.stringify(iframeUrl)};f.title=${JSON.stringify(title)};f.loading='lazy';f.style.cssText='width:100%;height:720px;border:0';f.allow='clipboard-write';s.insertAdjacentElement('afterend',f)})();`
}
