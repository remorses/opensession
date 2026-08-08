// Pure tests for the RFC 5545 builder: stable UID across invite/update/cancel,
// SEQUENCE growth, TEXT escaping, 75-octet folding, and UTC conversion.

import { describe, expect, test } from 'vitest'
import {
  buildIcsCalendar,
  buildIcsEvent,
  escapeIcsText,
  foldIcsLine,
  icsUid,
  toIcsUtc,
} from './ics.ts'

/** ICS is CRLF by spec; normalize for readable inline snapshots. CRLF itself
 *  is asserted separately so the normalization cannot hide a regression. */
const lf = (ics: string) => ics.replace(/\r\n/g, '\n')

const base = {
  sessionId: '01JAAAAAAAAAAAAAAAAAAAAAAA',
  appDomain: 'opensession.dev',
  sequence: 0,
  title: 'Shipping RSC on the edge',
  description: 'A talk about React Server Components.',
  startsAt: Date.UTC(2026, 9, 12, 17, 30, 0),
  endsAt: Date.UTC(2026, 9, 12, 18, 0, 0),
  roomName: 'Main Hall',
  location: 'Moscone West',
  url: 'https://opensession.dev/portal/aie',
  organizerEmail: 'notifications@opensession.dev',
  organizerName: 'OpenSession',
  attendees: [{ email: 'speaker@example.com', name: 'Ada Lovelace' }],
}

describe('toIcsUtc', () => {
  test('formats epoch ms as a UTC date-time', () => {
    expect(toIcsUtc(Date.UTC(2026, 9, 12, 17, 30, 0))).toMatchInlineSnapshot(
      `"20261012T173000Z"`,
    )
  })
})

describe('escapeIcsText', () => {
  test('escapes backslash, semicolon, comma and newlines', () => {
    expect(escapeIcsText('a\\b;c,d\ne')).toMatchInlineSnapshot(`"a\\\\b\\;c\\,d\\ne"`)
  })
})

describe('foldIcsLine', () => {
  test('leaves short lines untouched', () => {
    expect(foldIcsLine('SUMMARY:short')).toMatchInlineSnapshot(`"SUMMARY:short"`)
  })

  test('folds at 75 octets with a leading space on continuations', () => {
    const folded = foldIcsLine(`DESCRIPTION:${'x'.repeat(200)}`)
    const lines = folded.split('\r\n')
    expect(lines.map((line) => new TextEncoder().encode(line).length)).toMatchInlineSnapshot(`
      [
        75,
        75,
        64,
      ]
    `)
    expect(lines.slice(1).every((line) => line.startsWith(' '))).toBe(true)
  })

  test('never splits a multi-byte code point', () => {
    const folded = foldIcsLine(`SUMMARY:${'é'.repeat(80)}`)
    for (const line of folded.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
    // Unfolding must reproduce the original string exactly.
    expect(folded.split('\r\n ').join('')).toBe(`SUMMARY:${'é'.repeat(80)}`)
  })
})

describe('buildIcsEvent', () => {
  test('REQUEST invite', () => {
    expect('\n' + lf(buildIcsEvent({ ...base, method: 'REQUEST' }))).toMatchInlineSnapshot(`
      "
      BEGIN:VCALENDAR
      VERSION:2.0
      PRODID:-//OpenSession//OpenSession//EN
      CALSCALE:GREGORIAN
      METHOD:REQUEST
      BEGIN:VEVENT
      UID:session-01JAAAAAAAAAAAAAAAAAAAAAAA@opensession.dev
      SEQUENCE:0
      DTSTAMP:20261012T173000Z
      DTSTART:20261012T173000Z
      DTEND:20261012T180000Z
      SUMMARY:Shipping RSC on the edge
      DESCRIPTION:A talk about React Server Components.
      LOCATION:Main Hall\\, Moscone West
      URL:https://opensession.dev/portal/aie
      ORGANIZER;CN="OpenSession":mailto:notifications@opensession.dev
      ATTENDEE;CN="Ada Lovelace";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=
       TRUE:mailto:speaker@example.com
      STATUS:CONFIRMED
      END:VEVENT
      END:VCALENDAR
      "
    `)
  })

  test('an update keeps the UID and only grows SEQUENCE', () => {
    const invite = buildIcsEvent({ ...base, method: 'REQUEST', sequence: 0 })
    const update = buildIcsEvent({
      ...base,
      method: 'REQUEST',
      sequence: 3,
      startsAt: Date.UTC(2026, 9, 12, 19, 0, 0),
      endsAt: Date.UTC(2026, 9, 12, 19, 30, 0),
    })
    const uid = `UID:${icsUid(base.sessionId, base.appDomain)}`
    expect(invite).toContain(uid)
    expect(update).toContain(uid)
    expect(invite).toContain('SEQUENCE:0')
    expect(update).toContain('SEQUENCE:3')
    expect(update).toContain('DTSTART:20261012T190000Z')
  })

  test('CANCEL forces STATUS:CANCELLED', () => {
    const ics = buildIcsEvent({ ...base, method: 'CANCEL', sequence: 4 })
    expect(ics).toContain('METHOD:CANCEL')
    expect(ics).toContain('STATUS:CANCELLED')
    expect(ics).toContain(`UID:${icsUid(base.sessionId, base.appDomain)}`)
  })

  test('escapes an attacker-controlled title', () => {
    const ics = buildIcsEvent({
      ...base,
      method: 'REQUEST',
      title: 'Break; me, please\nEND:VEVENT',
      description: null,
      roomName: null,
      location: null,
      url: null,
      attendees: [],
    })
    expect(ics).toContain('SUMMARY:Break\\; me\\, please\\nEND:VEVENT')
    // The injected END:VEVENT stayed inside the SUMMARY value: exactly one
    // real content line closes the component.
    const lines = ics.split('\r\n')
    expect(lines.filter((line) => line === 'END:VEVENT')).toMatchInlineSnapshot(`
      [
        "END:VEVENT",
      ]
    `)
  })

  test('uses CRLF line endings', () => {
    const ics = buildIcsEvent({ ...base, method: 'REQUEST' })
    expect(ics.endsWith('\r\n')).toBe(true)
    expect(/[^\r]\n/.test(ics)).toBe(false)
  })

  test('omits optional lines when absent', () => {
    expect(
      '\n' +
        lf(buildIcsEvent({
          sessionId: 'S1',
          appDomain: 'opensession.dev',
          sequence: 0,
          title: 'Lunch',
          startsAt: Date.UTC(2026, 9, 12, 12, 0, 0),
          endsAt: Date.UTC(2026, 9, 12, 13, 0, 0),
          organizerEmail: 'notifications@opensession.dev',
          method: 'REQUEST',
        })),
    ).toMatchInlineSnapshot(`
      "
      BEGIN:VCALENDAR
      VERSION:2.0
      PRODID:-//OpenSession//OpenSession//EN
      CALSCALE:GREGORIAN
      METHOD:REQUEST
      BEGIN:VEVENT
      UID:session-S1@opensession.dev
      SEQUENCE:0
      DTSTAMP:20261012T120000Z
      DTSTART:20261012T120000Z
      DTEND:20261012T130000Z
      SUMMARY:Lunch
      ORGANIZER:mailto:notifications@opensession.dev
      STATUS:CONFIRMED
      END:VEVENT
      END:VCALENDAR
      "
    `)
  })
})

describe('buildIcsCalendar', () => {
  test('emits a PUBLISH calendar with one VEVENT per session', () => {
    const ics = buildIcsCalendar([
      { ...base, sessionId: 'A' },
      { ...base, sessionId: 'B', title: 'Second talk' },
    ])
    expect(ics).toContain('METHOD:PUBLISH')
    expect(ics.split('BEGIN:VEVENT').length - 1).toBe(2)
    expect(ics).toContain('UID:session-A@opensession.dev')
    expect(ics).toContain('UID:session-B@opensession.dev')
  })
})
