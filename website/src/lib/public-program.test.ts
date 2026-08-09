// Pure tests for deterministic agenda placement and the shared anonymous projection.
import { describe, expect, test } from 'vitest'
import {
  autoPlaceSessions,
  isPublicProgramSession,
  projectPublicProgram,
  type PublicProgramSource,
} from './public-program.ts'

const DAY = '2027-05-12'

describe('automatic agenda placement', () => {
  test('keeps scheduled rows and deterministically places conflict-free sessions', () => {
    const input = {
      days: [DAY, '2027-05-13'],
      rooms: [{ id: 'room-a' }, { id: 'room-b' }],
      startMinute: 9 * 60,
      endMinute: 12 * 60,
      sessions: [
        { id: 'fixed', roomId: 'room-a', dayKey: DAY, startMinute: 9 * 60, endMinute: 9 * 60 + 30, durationMinutes: 30, speakerIds: ['priya'] },
        { id: 'shared', roomId: null, dayKey: null, startMinute: null, endMinute: null, durationMinutes: 30, speakerIds: ['priya'] },
        { id: 'free', roomId: null, dayKey: null, startMinute: null, endMinute: null, durationMinutes: 30, speakerIds: ['marcus'] },
      ],
    }

    expect(autoPlaceSessions(input)).toMatchInlineSnapshot(`
      {
        "placements": [
          {
            "dayKey": "2027-05-12",
            "durationMinutes": 30,
            "roomId": "room-b",
            "sessionId": "free",
            "startMinute": 540,
          },
          {
            "dayKey": "2027-05-12",
            "durationMinutes": 30,
            "roomId": "room-a",
            "sessionId": "shared",
            "startMinute": 570,
          },
        ],
        "unplacedSessionIds": [],
      }
    `)
    expect(autoPlaceSessions(input)).toEqual(autoPlaceSessions(input))
  })

  test('returns sessions that cannot fit without inventing a conflicting slot', () => {
    expect(autoPlaceSessions({
      days: [DAY],
      rooms: [{ id: 'room-a' }],
      startMinute: 9 * 60,
      endMinute: 9 * 60 + 30,
      sessions: [
        { id: 'fixed', roomId: 'room-a', dayKey: DAY, startMinute: 9 * 60, endMinute: 9 * 60 + 30, durationMinutes: 30, speakerIds: [] },
        { id: 'waiting', roomId: null, dayKey: null, startMinute: null, endMinute: null, durationMinutes: 30, speakerIds: [] },
      ],
    })).toEqual({ placements: [], unplacedSessionIds: ['waiting'] })
  })
})

describe('public program projection', () => {
  test('uses one eligibility gate and keeps cross-feed ids consistent', () => {
    const source: PublicProgramSource = {
      event: {
        id: 'event', name: 'DevFlow Conf 2027', slug: 'devflow', status: 'ACTIVE',
        timezone: 'America/Los_Angeles', startsAt: 1, endsAt: 2,
        location: 'Moscone West', description: 'Conference', programPublishedAt: 3,
      },
      sessions: [
        session('visible', 'ACCEPTED', 'PUBLIC', 100, 200),
        session('private', 'ACCEPTED', 'PRIVATE', 100, 200),
        session('pending', 'PENDING', 'PUBLIC', 100, 200),
        session('unplaced', 'ACCEPTED', 'PUBLIC', null, null),
      ],
    }

    const program = projectPublicProgram(source)
    expect(program?.sessions.map((row) => row.id)).toEqual(['visible'])
    expect(program?.speakers.map((row) => row.id)).toEqual(['speaker-visible'])
    expect(program?.speakers[0]?.sessionIds).toEqual(['visible'])
    expect(projectPublicProgram({ ...source, event: { ...source.event, programPublishedAt: null } })).toBeNull()
    expect(projectPublicProgram({ ...source, event: { ...source.event, status: 'DRAFT' } })).toBeNull()
    expect(Object.keys(program?.event ?? {}).sort()).toMatchInlineSnapshot(`
      [
        "description",
        "endsAt",
        "id",
        "location",
        "name",
        "programPublishedAt",
        "slug",
        "startsAt",
        "timezone",
      ]
    `)
  })

  test('uses the same publication gate for anonymous file references', () => {
    const event = { status: 'ACTIVE', programPublishedAt: 3 }
    expect(isPublicProgramSession(event, {
      status: 'ACCEPTED', visibility: 'PUBLIC', roomId: 'room', startsAt: 100, endsAt: 200,
    })).toBe(true)
    expect(isPublicProgramSession({ ...event, programPublishedAt: null }, {
      status: 'ACCEPTED', visibility: 'PUBLIC', roomId: 'room', startsAt: 100, endsAt: 200,
    })).toBe(false)
    expect(isPublicProgramSession(event, {
      status: 'ACCEPTED', visibility: 'PUBLIC', roomId: null, startsAt: null, endsAt: null,
    })).toBe(false)
  })
})

function session(id: string, status: string, visibility: 'PUBLIC' | 'PRIVATE', startsAt: number | null, endsAt: number | null) {
  return {
    id,
    kind: 'CONTENT' as const,
    status,
    visibility,
    title: id,
    description: `${id} description`,
    startsAt,
    endsAt,
    roomId: startsAt == null ? null : 'room',
    room: startsAt == null ? null : { id: 'room', name: 'Main Stage' },
    track: { id: 'track', name: 'AI Engineering', color: '#334455' },
    format: { id: 'format', name: 'Talk' },
    coverImageFileId: null,
    participants: [{
      role: 'SPEAKER' as const,
      sortOrder: 0,
      speaker: {
        id: `speaker-${id}`, firstName: 'Priya', lastName: 'Raman', bio: 'Bio',
        jobTitle: 'Principal Engineer', companyName: 'Latticework Systems',
        headshotFileId: null, avatarUrl: null,
      },
    }],
  }
}
