// Workerd integration tests for Phase 5 publication, anonymous feeds, iframe
// headers, migration state, and agenda writes on real Miniflare D1.
import { env } from 'cloudflare:workers'
import dedent from 'string-dedent'
import { beforeAll, describe, expect, test } from 'vitest'
import { app, loadPublicProgram } from '../src/app.tsx'
import { getDb } from '../src/db.ts'
import { scheduleSessionSlot } from '../src/lib/agenda-server.ts'

const now = Date.UTC(2027, 4, 12, 16)
const ids = {
  user: 'public-program-user',
  org: 'public-program-org',
  event: 'public-program-event',
  room: 'public-program-room',
  track: 'public-program-track',
  format: 'public-program-format',
  speaker: 'public-program-speaker',
  visible: 'public-program-visible',
  private: 'public-program-private',
  waiting: 'public-program-waiting',
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(dedent`
      INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES (?, 'Jordan Alvarez', 'public-program@example.test', 1, ?, ?)
    `).bind(ids.user, now, now),
    env.DB.prepare(dedent`
      INSERT INTO org (org_id, owner_user_id, kind, name, created_at, updated_at)
      VALUES (?, ?, 'team', 'Program Org', ?, ?)
    `).bind(ids.org, ids.user, now, now),
    env.DB.prepare(dedent`
      INSERT INTO event (id, org_id, name, slug, status, timezone, starts_at, ends_at, location, created_at, updated_at)
      VALUES (?, ?, 'DevFlow Conf 2027', 'public-program', 'ACTIVE', 'UTC', ?, ?, 'Moscone West', ?, ?)
    `).bind(ids.event, ids.org, now, now + 2 * 86_400_000, now, now),
    env.DB.prepare("INSERT INTO room (id, event_id, name, sort_order) VALUES (?, ?, 'Main Stage', 0)").bind(ids.room, ids.event),
    env.DB.prepare("INSERT INTO track (id, event_id, name, color, sort_order, created_at) VALUES (?, ?, 'AI Engineering', '#334455', 0, ?)").bind(ids.track, ids.event, now),
    env.DB.prepare("INSERT INTO format (id, event_id, name, default_duration_minutes, sort_order) VALUES (?, ?, 'Talk', 30, 0)").bind(ids.format, ids.event),
    env.DB.prepare(dedent`
      INSERT INTO speaker (id, event_id, email, first_name, last_name, job_title, company_name, status, created_at, updated_at)
      VALUES (?, ?, 'priya-public@example.test', 'Priya', 'Raman', 'Principal Engineer', 'Latticework Systems', 'CONFIRMED', ?, ?)
    `).bind(ids.speaker, ids.event, now, now),
    ...[
      [ids.visible, 'Published talk', 'PUBLIC', now, now + 30 * 60_000],
      [ids.private, 'Private talk', 'PRIVATE', now + 60 * 60_000, now + 90 * 60_000],
      [ids.waiting, 'Waiting talk', 'PUBLIC', null, null],
    ].map(([id, title, visibility, startsAt, endsAt]) => env.DB.prepare(dedent`
      INSERT INTO event_session (id, event_id, kind, status, title, description, visibility, track_id, format_id, room_id, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, 'CONTENT', 'ACCEPTED', ?, 'Program description', ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, ids.event, title, visibility, ids.track, ids.format, startsAt == null ? null : ids.room, startsAt, endsAt, now, now)),
    env.DB.prepare(dedent`
      INSERT INTO session_participant (id, event_id, session_id, speaker_id, role, confirmation_status, sort_order, created_at)
      VALUES ('public-program-participant', ?, ?, ?, 'SPEAKER', 'CONFIRMED', 0, ?)
    `).bind(ids.event, ids.visible, ids.speaker, now),
  ])
})

describe('published anonymous program', () => {
  test('migration adds an independent nullable publication column', async () => {
    const columns = await env.DB.prepare("SELECT name FROM pragma_table_info('event') WHERE name = 'program_published_at'").all()
    expect(columns.results).toEqual([{ name: 'program_published_at' }])
  })

  test('unpublish hides every route, publish exposes only approved scheduled rows', async () => {
    expect(await loadPublicProgram('public-program')).toBeNull()
    expect((await app.handle(new Request('http://localhost/public/public-program/schedule.json'))).status).toBe(404)

    await env.DB.prepare('UPDATE event SET program_published_at = ? WHERE id = ?').bind(now + 1, ids.event).run()
    const response = await app.handle(new Request('http://localhost/public/public-program/schedule.json'))
    const body = await response.json<any>()
    expect({ status: response.status, ids: body.sessions.map((row: any) => row.id) }).toEqual({
      status: 200,
      ids: [ids.visible],
    })
    expect(JSON.stringify(body)).not.toContain('Private talk')
    expect(JSON.stringify(body)).not.toContain('Waiting talk')
    expect(Object.keys(body.event).sort()).toEqual([
      'description',
      'endsAt',
      'id',
      'location',
      'name',
      'programPublishedAt',
      'slug',
      'startsAt',
      'timezone',
    ])
    for (const view of ['sessions', 'speakers', 'agenda', 'itinerary', 'gallery']) {
      expect((await app.handle(new Request(`http://localhost/public/public-program/${view}`))).status).toBe(200)
      expect((await app.handle(new Request(`http://localhost/embed/public-program/${view}`))).status).toBe(200)
    }
  })

  test('writes a placement and serves the same row through JSON and ICS', async () => {
    const db = getDb()
    const event = await db.query.event.findFirst({ where: { id: ids.event } })
    if (!event) throw new Error('fixture event missing')
    const result = await scheduleSessionSlot({
      db,
      event,
      sessionId: ids.waiting,
      roomId: ids.room,
      dayKey: '2027-05-13',
      startMinute: 10 * 60,
      durationMinutes: 30,
      confirmConflicts: false,
      now: now + 2,
    })
    expect(result.scheduled).toBe(true)
    const jsonResponse = await app.handle(new Request('http://localhost/public/public-program/schedule.json'))
    const jsonBody = await jsonResponse.text()
    const icsResponse = await app.handle(new Request('http://localhost/public/public-program/schedule.ics'))
    const icsBody = await icsResponse.text()
    expect(jsonBody).toContain(ids.waiting)
    expect(icsBody).toContain(`session-${ids.waiting}@`)
    expect(icsResponse.headers.get('access-control-allow-origin')).toBe('*')
  })

  test('iframe routes accept safe options, reject unsafe values, and allow framing', async () => {
    const response = await app.handle(new Request('http://localhost/embed/public-program/sessions?accent=%23123456&compact=1'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe('frame-ancestors *')
    expect(response.headers.get('x-frame-options')).toBeNull()
    expect((await response.text())).toContain('Published talk')

    const invalid = await app.handle(new Request('http://localhost/embed/public-program/sessions?accent=javascript%3Aalert(1)'))
    expect(invalid.status).toBe(400)
  })
})
