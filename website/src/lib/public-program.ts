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

function overlaps(a: Pick<OccupiedSlot, 'startMinute' | 'endMinute'>, b: Pick<OccupiedSlot, 'startMinute' | 'endMinute'>) {
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute
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
            if (slot.dayKey !== candidate.dayKey || !overlaps(slot, candidate)) return false
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
