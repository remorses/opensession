// Pure tests for deterministic agenda placement and the shared anonymous projection.
import { describe, expect, test } from 'vitest'
import {
  autoPlaceSessions,
  buildEmbedOutput,
  buildPublicWidgetScript,
  isPublicProgramSession,
  projectPublicProgram,
  parseEmbedPresets,
  renderPublicWidgetHtml,
  renderPublicWidgetXml,
  summarizeProgramPublication,
  type PublicProgramSource,
  type EmbedPreset,
} from './public-program.ts'
import { nextTrackColor } from './utils.ts'

describe('track palette defaults', () => {
  test('selects distinct unused colors before cycling the palette', () => {
    expect([
      nextTrackColor([]),
      nextTrackColor(['#2563eb']),
      nextTrackColor(['#2563EB', '#7c3aed']),
    ]).toMatchInlineSnapshot(`
      [
        "#2563eb",
        "#7c3aed",
        "#db2777",
      ]
    `)
  })
})

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
  test('summarizes the scheduled public handoff before publication', () => {
    expect(summarizeProgramPublication([
      { status: 'ACCEPTED', visibility: 'PUBLIC', roomId: 'room', startsAt: 100, endsAt: 200 },
      { status: 'ACCEPTED', visibility: 'PRIVATE', roomId: 'room', startsAt: 200, endsAt: 300 },
      { status: 'ACCEPTED', visibility: 'PRIVATE', roomId: null, startsAt: null, endsAt: null },
      { status: 'PENDING', visibility: 'PRIVATE', roomId: 'room', startsAt: 300, endsAt: 400 },
    ])).toEqual({ publicScheduledCount: 1, privateScheduledCount: 1 })
  })

  test('uses one eligibility gate and keeps cross-feed ids consistent', () => {
    const source: PublicProgramSource = {
      event: {
        id: 'event', name: 'DevFlow Conf 2027', slug: 'devflow', status: 'ACTIVE',
        timezone: 'America/Los_Angeles', startsAt: 1, endsAt: 2,
        location: 'Moscone West', description: 'Conference', programPublishedAt: 3,
      },
      sessions: [
        session({ id: 'visible', status: 'ACCEPTED', visibility: 'PUBLIC', startsAt: 100, endsAt: 200 }),
        session({ id: 'private', status: 'ACCEPTED', visibility: 'PRIVATE', startsAt: 100, endsAt: 200 }),
        session({ id: 'pending', status: 'PENDING', visibility: 'PUBLIC', startsAt: 100, endsAt: 200 }),
        session({ id: 'unplaced', status: 'ACCEPTED', visibility: 'PUBLIC', startsAt: null, endsAt: null }),
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

  test('renders basic HTML, XML, and the styled embed script from the shared projection', () => {
    const program = projectPublicProgram({
      event: {
        id: 'event', name: 'DevFlow & Friends', slug: 'devflow', status: 'ACTIVE',
        timezone: 'America/Los_Angeles', startsAt: Date.UTC(2027, 4, 12), endsAt: Date.UTC(2027, 4, 13),
        location: 'Moscone <West>', description: 'Conference', programPublishedAt: 3,
      },
      sessions: [session({
        id: 'visible',
        status: 'ACCEPTED',
        visibility: 'PUBLIC',
        startsAt: Date.UTC(2027, 4, 12, 16),
        endsAt: Date.UTC(2027, 4, 12, 16, 30),
      })],
    })
    if (!program) throw new Error('expected a published program')

    expect(renderPublicWidgetHtml({ program, view: 'sessions', filters: {}, fields: ['time', 'room'] })).toMatchInlineSnapshot(`"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DevFlow &amp; Friends sessions</title></head><body><main><h1>DevFlow &amp; Friends</h1><article><h2>visible</h2><p>Wed, May 12 · 09:00 – 09:30</p><p>Main Stage</p></article></main></body></html>"`)
    expect(renderPublicWidgetXml({ program, view: 'sessions', filters: {} })).toMatchInlineSnapshot(`"<?xml version="1.0" encoding="UTF-8"?><program><event id="event"><name>DevFlow &amp; Friends</name><slug>devflow</slug></event><sessions><session id="visible"><title>visible</title><description>visible description</description><startsAt>1810137600000</startsAt><endsAt>1810139400000</endsAt><room>Main Stage</room><track>AI Engineering</track><format>Talk</format><speakers><speaker id="speaker-visible">Priya Raman</speaker></speakers></session></sessions></program>"`)
    expect(buildPublicWidgetScript({
      iframeUrl: 'https://opensession.dev/embed/devflow/sessions?track=ai',
      title: 'DevFlow "sessions"',
    })).toMatchInlineSnapshot(`
      "(()=>{const s=document.currentScript;if(!s)return;const f=document.createElement('iframe');f.src=\"https://opensession.dev/embed/devflow/sessions?track=ai\";f.title=\"DevFlow \\\"sessions\\\"\";f.loading='lazy';f.style.cssText='width:100%;height:720px;border:0';f.allow='clipboard-write';s.insertAdjacentElement('afterend',f)})();"
    `)
  })
})

describe('embed presets', () => {
  const preset: EmbedPreset = {
    name: 'AI sessions',
    enabled: true,
    widget: 'sessions',
    outputFormat: 'html',
    accent: '#123abc',
    compact: true,
    trackId: 'track/ai',
    formatId: 'talk',
    roomId: '',
    visibleFields: ['description', 'speakers', 'time'],
  }

  test('strictly parses the versioned local storage document and removes malformed rows', () => {
    expect(parseEmbedPresets(JSON.stringify({
      version: 1,
      presets: [
        preset,
        { ...preset, name: '', enabled: 'yes' },
        { ...preset, name: 'Unexpected', extra: true },
        { ...preset, name: 'Bad field', visibleFields: ['description', 'privateEmail'] },
      ],
    }))).toMatchInlineSnapshot(`
      [
        {
          "accent": "#123abc",
          "compact": true,
          "enabled": true,
          "formatId": "talk",
          "name": "AI sessions",
          "outputFormat": "html",
          "roomId": "",
          "trackId": "track/ai",
          "visibleFields": [
            "description",
            "speakers",
            "time",
          ],
          "widget": "sessions",
        },
      ]
    `)
    expect(parseEmbedPresets('{broken')).toEqual([])
    expect(parseEmbedPresets(JSON.stringify({ version: 2, presets: [preset] }))).toEqual([])
  })

  test('uses one serializer for exact hosted URLs and snippets', () => {
    expect(buildEmbedOutput({
      appUrl: 'https://opensession.dev/base',
      eventSlug: 'Dev Flow',
      eventName: 'DevFlow & Friends',
      config: preset,
    })).toMatchInlineSnapshot(`
      {
        "output": "<iframe src=\"https://opensession.dev/public/Dev%20Flow/widget.html?accent=%23123abc&amp;compact=1&amp;track=track%2Fai&amp;format=talk&amp;fields=description%2Cspeakers%2Ctime&amp;widget=sessions\" title=\"DevFlow &amp; Friends sessions\" loading=\"lazy\" style=\"width:100%;height:720px;border:0\"></iframe>",
        "outputUrl": "https://opensession.dev/public/Dev%20Flow/widget.html?accent=%23123abc&compact=1&track=track%2Fai&format=talk&fields=description%2Cspeakers%2Ctime&widget=sessions",
        "widgetUrl": "https://opensession.dev/embed/Dev%20Flow/sessions?accent=%23123abc&compact=1&track=track%2Fai&format=talk&fields=description%2Cspeakers%2Ctime",
      }
    `)

    expect(buildEmbedOutput({
      appUrl: 'https://opensession.dev',
      eventSlug: 'devflow',
      eventName: 'DevFlow',
      config: { ...preset, outputFormat: 'ical', roomId: 'main room' },
    })).toMatchInlineSnapshot(`
      {
        "output": "https://opensession.dev/public/devflow/schedule.ics?track=track%2Fai&format=talk&room=main+room",
        "outputUrl": "https://opensession.dev/public/devflow/schedule.ics?track=track%2Fai&format=talk&room=main+room",
        "widgetUrl": "https://opensession.dev/embed/devflow/sessions?accent=%23123abc&compact=1&track=track%2Fai&format=talk&room=main+room&fields=description%2Cspeakers%2Ctime",
      }
    `)
  })
})

function session({ id, status, visibility, startsAt, endsAt }: {
  id: string
  status: string
  visibility: 'PUBLIC' | 'PRIVATE'
  startsAt: number | null
  endsAt: number | null
}) {
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
