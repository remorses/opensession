// Pure tests for the agenda conflict engine and the day-grid helpers.
// Written before conflicts.ts (TDD): they pin the half-open interval rule
// (touching edges never conflict), the ROOM/SPEAKER reasons, and the
// timezone-aware bucketing the day/week views render from.

import { describe, expect, test } from 'vitest'
import {
  buildDayGrid,
  eventDayKeys,
  findConflicts,
  formatDayLabel,
  minutesToLabel,
  nextIcsSequence,
  sessionsOverlap,
  toZonedSlot,
  zonedEpoch,
} from './conflicts.ts'

/** 2026-10-12 09:00 UTC as the base clock for the interval tests. */
const H = 3_600_000
const base = Date.UTC(2026, 9, 12, 9, 0, 0)

function session(
  id: string,
  opts: {
    roomId?: string | null
    from?: number
    to?: number
    speakerIds?: string[]
  } = {},
) {
  return {
    id,
    roomId: opts.roomId ?? null,
    startsAt: opts.from ?? null,
    endsAt: opts.to ?? null,
    speakerIds: opts.speakerIds ?? [],
  }
}

describe('sessionsOverlap', () => {
  test('touching edges do not overlap', () => {
    expect(
      sessionsOverlap(
        { startsAt: base, endsAt: base + H },
        { startsAt: base + H, endsAt: base + 2 * H },
      ),
    ).toMatchInlineSnapshot(`false`)
  })

  test('identical ranges overlap', () => {
    expect(
      sessionsOverlap(
        { startsAt: base, endsAt: base + H },
        { startsAt: base, endsAt: base + H },
      ),
    ).toMatchInlineSnapshot(`true`)
  })

  test('one range fully containing another overlaps', () => {
    expect(
      sessionsOverlap(
        { startsAt: base, endsAt: base + 4 * H },
        { startsAt: base + H, endsAt: base + 2 * H },
      ),
    ).toMatchInlineSnapshot(`true`)
  })

  test('unscheduled rows never overlap', () => {
    expect(
      sessionsOverlap(
        { startsAt: null, endsAt: null },
        { startsAt: base, endsAt: base + H },
      ),
    ).toMatchInlineSnapshot(`false`)
  })

  test('zero-length and inverted ranges never overlap', () => {
    expect(
      sessionsOverlap(
        { startsAt: base, endsAt: base },
        { startsAt: base, endsAt: base + H },
      ),
    ).toMatchInlineSnapshot(`false`)
  })
})

describe('findConflicts', () => {
  test('same room and overlapping times conflict', () => {
    const rows = [
      session('a', { roomId: 'r1', from: base, to: base + H, speakerIds: ['s1'] }),
      session('b', { roomId: 'r1', from: base + H / 2, to: base + 2 * H, speakerIds: ['s2'] }),
    ]
    expect(findConflicts(rows)).toMatchInlineSnapshot(`
      [
        {
          "aId": "a",
          "bId": "b",
          "reason": "ROOM",
          "roomId": "r1",
        },
      ]
    `)
  })

  test('same room but touching edges do not conflict', () => {
    const rows = [
      session('a', { roomId: 'r1', from: base, to: base + H }),
      session('b', { roomId: 'r1', from: base + H, to: base + 2 * H }),
    ]
    expect(findConflicts(rows)).toMatchInlineSnapshot(`[]`)
  })

  test('shared speaker in different rooms conflicts', () => {
    const rows = [
      session('a', { roomId: 'r1', from: base, to: base + H, speakerIds: ['s1', 's2'] }),
      session('b', { roomId: 'r2', from: base + H / 2, to: base + 2 * H, speakerIds: ['s2'] }),
    ]
    expect(findConflicts(rows)).toMatchInlineSnapshot(`
      [
        {
          "aId": "a",
          "bId": "b",
          "reason": "SPEAKER",
          "speakerIds": [
            "s2",
          ],
        },
      ]
    `)
  })

  test('same room AND shared speaker reports both reasons', () => {
    const rows = [
      session('a', { roomId: 'r1', from: base, to: base + H, speakerIds: ['s1'] }),
      session('b', { roomId: 'r1', from: base, to: base + H, speakerIds: ['s1'] }),
    ]
    expect(findConflicts(rows)).toMatchInlineSnapshot(`
      [
        {
          "aId": "a",
          "bId": "b",
          "reason": "ROOM",
          "roomId": "r1",
        },
        {
          "aId": "a",
          "bId": "b",
          "reason": "SPEAKER",
          "speakerIds": [
            "s1",
          ],
        },
      ]
    `)
  })

  test('different speakers in different rooms never conflict', () => {
    const rows = [
      session('a', { roomId: 'r1', from: base, to: base + H, speakerIds: ['s1'] }),
      session('b', { roomId: 'r2', from: base, to: base + H, speakerIds: ['s2'] }),
    ]
    expect(findConflicts(rows)).toMatchInlineSnapshot(`[]`)
  })

  test('unscheduled sessions are ignored even with the same speaker', () => {
    const rows = [
      session('a', { roomId: 'r1', from: base, to: base + H, speakerIds: ['s1'] }),
      session('b', { speakerIds: ['s1'] }),
      session('c', { roomId: 'r1', speakerIds: ['s1'] }),
    ]
    expect(findConflicts(rows)).toMatchInlineSnapshot(`[]`)
  })

  test('null room is not a room match', () => {
    const rows = [
      session('a', { roomId: null, from: base, to: base + H }),
      session('b', { roomId: null, from: base, to: base + H }),
    ]
    expect(findConflicts(rows)).toMatchInlineSnapshot(`[]`)
  })

  test('pairs are ordered by start time then id', () => {
    const rows = [
      session('c', { roomId: 'r1', from: base + H, to: base + 3 * H }),
      session('a', { roomId: 'r1', from: base, to: base + 2 * H }),
      session('b', { roomId: 'r1', from: base, to: base + 2 * H }),
    ]
    expect(findConflicts(rows).map((row) => `${row.aId}-${row.bId}`)).toMatchInlineSnapshot(`
      [
        "a-b",
        "a-c",
        "b-c",
      ]
    `)
  })
})

describe('timezone helpers', () => {
  test('zonedEpoch converts a wall clock in the event timezone', () => {
    const epoch = zonedEpoch('2026-10-12', 9 * 60, 'America/Los_Angeles')
    expect(new Date(epoch).toISOString()).toMatchInlineSnapshot(`"2026-10-12T16:00:00.000Z"`)
  })

  test('toZonedSlot maps an epoch back to day + minutes', () => {
    const epoch = Date.UTC(2026, 9, 12, 16, 30)
    expect(toZonedSlot(epoch, 'America/Los_Angeles')).toMatchInlineSnapshot(`
      {
        "dayKey": "2026-10-12",
        "minutes": 570,
      }
    `)
  })

  test('zonedEpoch round-trips across the DST fall-back boundary', () => {
    // 2026-11-01 is the US DST end date: 09:00 local is PST (UTC-8).
    const epoch = zonedEpoch('2026-11-01', 9 * 60, 'America/Los_Angeles')
    expect({
      iso: new Date(epoch).toISOString(),
      back: toZonedSlot(epoch, 'America/Los_Angeles'),
    }).toMatchInlineSnapshot(`
      {
        "back": {
          "dayKey": "2026-11-01",
          "minutes": 540,
        },
        "iso": "2026-11-01T17:00:00.000Z",
      }
    `)
  })

  test('eventDayKeys lists every local day of the event', () => {
    const startsAt = Date.UTC(2026, 9, 12, 7, 0)
    const endsAt = Date.UTC(2026, 9, 14, 23, 0)
    expect(eventDayKeys(startsAt, endsAt, 'America/Los_Angeles')).toMatchInlineSnapshot(`
      [
        "2026-10-12",
        "2026-10-13",
        "2026-10-14",
      ]
    `)
  })

  test('labels are deterministic strings, safe to render on the client', () => {
    expect({
      day: formatDayLabel('2026-10-12'),
      time: minutesToLabel(9 * 60 + 45),
      midnight: minutesToLabel(0),
    }).toMatchInlineSnapshot(`
      {
        "day": "Mon, Oct 12",
        "midnight": "00:00",
        "time": "09:45",
      }
    `)
  })
})

describe('buildDayGrid', () => {
  const rooms = [
    { id: 'r1', name: 'Main Stage' },
    { id: 'r2', name: 'Hall A' },
  ]

  test('buckets sessions into room columns and 15-minute rows', () => {
    const grid = buildDayGrid({
      dayKey: '2026-10-12',
      timezone: 'America/Los_Angeles',
      rooms,
      sessions: [
        {
          id: 'a',
          roomId: 'r1',
          startsAt: zonedEpoch('2026-10-12', 9 * 60, 'America/Los_Angeles'),
          endsAt: zonedEpoch('2026-10-12', 9 * 60 + 45, 'America/Los_Angeles'),
        },
        {
          id: 'b',
          roomId: 'r2',
          startsAt: zonedEpoch('2026-10-12', 10 * 60, 'America/Los_Angeles'),
          endsAt: zonedEpoch('2026-10-12', 11 * 60, 'America/Los_Angeles'),
        },
      ],
    })
    expect({
      startMinute: grid.startMinute,
      endMinute: grid.endMinute,
      rowCount: grid.slots.length,
      columns: grid.columns.map((column) => ({
        roomId: column.roomId,
        items: column.items.map((item) => ({
          id: item.session.id,
          startRow: item.startRow,
          rowSpan: item.rowSpan,
        })),
      })),
    }).toMatchInlineSnapshot(`
      {
        "columns": [
          {
            "items": [
              {
                "id": "a",
                "rowSpan": 3,
                "startRow": 4,
              },
            ],
            "roomId": "r1",
          },
          {
            "items": [
              {
                "id": "b",
                "rowSpan": 4,
                "startRow": 8,
              },
            ],
            "roomId": "r2",
          },
        ],
        "endMinute": 1080,
        "rowCount": 40,
        "startMinute": 480,
      }
    `)
  })

  test('window grows to fit sessions outside the default 08:00-18:00 range', () => {
    const grid = buildDayGrid({
      dayKey: '2026-10-12',
      timezone: 'UTC',
      rooms,
      sessions: [
        {
          id: 'early',
          roomId: 'r1',
          startsAt: Date.UTC(2026, 9, 12, 6, 30),
          endsAt: Date.UTC(2026, 9, 12, 7, 0),
        },
        {
          id: 'late',
          roomId: 'r2',
          startsAt: Date.UTC(2026, 9, 12, 19, 0),
          endsAt: Date.UTC(2026, 9, 12, 20, 30),
        },
      ],
    })
    expect({ startMinute: grid.startMinute, endMinute: grid.endMinute })
      .toMatchInlineSnapshot(`
        {
          "endMinute": 1260,
          "startMinute": 360,
        }
      `)
  })

  test('sessions on other days or unknown rooms are left out', () => {
    const grid = buildDayGrid({
      dayKey: '2026-10-12',
      timezone: 'UTC',
      rooms,
      sessions: [
        {
          id: 'other-day',
          roomId: 'r1',
          startsAt: Date.UTC(2026, 9, 13, 9, 0),
          endsAt: Date.UTC(2026, 9, 13, 10, 0),
        },
        {
          id: 'unknown-room',
          roomId: 'r9',
          startsAt: Date.UTC(2026, 9, 12, 9, 0),
          endsAt: Date.UTC(2026, 9, 12, 10, 0),
        },
        { id: 'unscheduled', roomId: null, startsAt: null, endsAt: null },
      ],
    })
    expect(grid.columns.flatMap((column) => column.items.map((item) => item.session.id)))
      .toMatchInlineSnapshot(`[]`)
  })

  test('overlapping blocks in one room get side-by-side lanes', () => {
    const grid = buildDayGrid({
      dayKey: '2026-10-12',
      timezone: 'UTC',
      rooms,
      sessions: [
        { id: 'a', roomId: 'r1', startsAt: Date.UTC(2026, 9, 12, 9), endsAt: Date.UTC(2026, 9, 12, 10, 30) },
        { id: 'b', roomId: 'r1', startsAt: Date.UTC(2026, 9, 12, 9, 15), endsAt: Date.UTC(2026, 9, 12, 9, 45) },
        // Starts after the cluster ends: back to a full-width single lane.
        { id: 'c', roomId: 'r1', startsAt: Date.UTC(2026, 9, 12, 11), endsAt: Date.UTC(2026, 9, 12, 12) },
      ],
    })
    expect(
      grid.columns[0]!.items.map((item) => ({
        id: item.session.id,
        lane: item.lane,
        laneCount: item.laneCount,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "id": "a",
          "lane": 0,
          "laneCount": 2,
        },
        {
          "id": "b",
          "lane": 1,
          "laneCount": 2,
        },
        {
          "id": "c",
          "lane": 0,
          "laneCount": 1,
        },
      ]
    `)
  })

  test('a session crossing midnight is clamped to the day window', () => {
    const grid = buildDayGrid({
      dayKey: '2026-10-12',
      timezone: 'UTC',
      rooms,
      sessions: [
        {
          id: 'overnight',
          roomId: 'r1',
          startsAt: Date.UTC(2026, 9, 12, 23, 0),
          endsAt: Date.UTC(2026, 9, 13, 1, 0),
        },
      ],
    })
    const [item] = grid.columns[0]!.items
    expect({
      startMinute: grid.startMinute,
      endMinute: grid.endMinute,
      startRow: item?.startRow,
      rowSpan: item?.rowSpan,
    }).toMatchInlineSnapshot(`
      {
        "endMinute": 1440,
        "rowSpan": 4,
        "startMinute": 480,
        "startRow": 60,
      }
    `)
  })
})

describe('nextIcsSequence', () => {
  test('the first ever placement keeps sequence 0', () => {
    expect(nextIcsSequence({ current: 0, wasScheduled: false })).toBe(0)
  })

  test('moving a scheduled session always moves the revision forward', () => {
    expect(nextIcsSequence({ current: 0, wasScheduled: true })).toBe(1)
    expect(nextIcsSequence({ current: 7, wasScheduled: true })).toBe(8)
  })

  test('re-placing a cancelled session never reuses the cancel sequence', () => {
    // place(0) -> cancel(1) -> re-place must be 2, not 1. Reusing 1 would hit
    // the existing ics:{session}:{speaker}:1 dedupe key and silently drop the
    // invite, leaving the speaker unaware the talk is back on.
    expect(nextIcsSequence({ current: 1, wasScheduled: false })).toBe(2)
  })

  test('a full place / cancel / re-place / move chain strictly increases', () => {
    const chain: number[] = []
    let current = 0
    current = nextIcsSequence({ current, wasScheduled: false }) // place
    chain.push(current)
    current = nextIcsSequence({ current, wasScheduled: true }) // cancel
    chain.push(current)
    current = nextIcsSequence({ current, wasScheduled: false }) // re-place
    chain.push(current)
    current = nextIcsSequence({ current, wasScheduled: true }) // move
    chain.push(current)
    expect(chain).toMatchInlineSnapshot(`
      [
        0,
        1,
        2,
        3,
      ]
    `)
  })
})

describe('zonedEpoch across DST transitions', () => {
  test('a normal day round-trips exactly', () => {
    const t = zonedEpoch('2026-07-01', 9 * 60 + 30, 'Europe/Rome')
    expect(toZonedSlot(t, 'Europe/Rome')).toMatchInlineSnapshot(`
      {
        "dayKey": "2026-07-01",
        "minutes": 570,
      }
    `)
  })

  test('spring-forward gap resolves AFTER the jump, never before', () => {
    // New York jumps 02:00 -> 03:00 on 2026-03-08, so 02:30 never happens.
    // Resolving backwards would land on 01:30, an hour EARLIER than typed.
    const ny = toZonedSlot(zonedEpoch('2026-03-08', 150, 'America/New_York'), 'America/New_York')
    // Rome jumps 02:00 -> 03:00 on 2026-03-29. Same rule, opposite offset sign.
    const rome = toZonedSlot(zonedEpoch('2026-03-29', 150, 'Europe/Rome'), 'Europe/Rome')
    expect({ ny, rome }).toMatchInlineSnapshot(`
      {
        "ny": {
          "dayKey": "2026-03-08",
          "minutes": 210,
        },
        "rome": {
          "dayKey": "2026-03-29",
          "minutes": 210,
        },
      }
    `)
  })

  test('fall-back overlap picks the first occurrence', () => {
    // New York repeats 01:00-02:00 on 2026-11-01, so 01:30 happens twice.
    const t = zonedEpoch('2026-11-01', 90, 'America/New_York')
    expect(toZonedSlot(t, 'America/New_York')).toMatchInlineSnapshot(`
      {
        "dayKey": "2026-11-01",
        "minutes": 90,
      }
    `)
    // The earlier of the two instants is EDT (UTC-4), i.e. 05:30Z not 06:30Z.
    expect(new Date(t).toISOString()).toMatchInlineSnapshot(`"2026-11-01T05:30:00.000Z"`)
  })

  test('midnight on a transition day still lands on that day', () => {
    expect(toZonedSlot(zonedEpoch('2026-03-29', 0, 'Europe/Rome'), 'Europe/Rome'))
      .toMatchInlineSnapshot(`
        {
          "dayKey": "2026-03-29",
          "minutes": 0,
        }
      `)
  })
})
