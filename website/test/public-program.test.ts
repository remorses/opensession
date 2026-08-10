// Workerd integration tests for Phase 5 publication, anonymous feeds, iframe
// headers, migration state, and agenda writes on real Miniflare D1.
import { env } from 'cloudflare:workers'
import { createSpiceflowFetch } from 'spiceflow/client'
import { SpiceflowTestResponse } from 'spiceflow/testing'
import dedent from 'string-dedent'
import { beforeAll, describe, expect, test } from 'vitest'
import { app, loadPublicProgram } from '../src/app.tsx'
import { getDb } from '../src/db.ts'
import { applyAutoPlacementPlan, scheduleSessionSlot } from '../src/lib/agenda-server.ts'

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
  short: 'public-program-short',
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
      [ids.short, 'Ten minute briefing', 'PUBLIC', now + 2 * 60 * 60_000, now + 130 * 60_000],
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
      ids: [ids.visible, ids.short],
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

  test('publishes cover images but keeps custom response uploads private', async () => {
    await env.DB.prepare('UPDATE event SET program_published_at = ? WHERE id = ?').bind(now + 1, ids.event).run()
    await env.DB.batch([
      env.DB.prepare(dedent`
        INSERT INTO form (id, event_id, purpose, target, name, slug, status, created_at, updated_at)
        VALUES ('public-file-form', ?, 'CFP', 'SUBMISSION', 'CFP', 'public-file-cfp', 'OPEN', ?, ?)
      `).bind(ids.event, now, now),
      env.DB.prepare(dedent`
        INSERT INTO form_version (id, form_id, mdx_source, created_at)
        VALUES ('public-file-version', 'public-file-form', '<FileUpload name="privateAttachment" />', ?)
      `).bind(now),
      env.DB.prepare(dedent`
        INSERT INTO form_response (id, event_id, form_id, form_version_id, speaker_id, session_id, status, submitted_at, created_at, updated_at)
        VALUES ('public-file-response', ?, 'public-file-form', 'public-file-version', ?, ?, 'SUBMITTED', ?, ?, ?)
      `).bind(ids.event, ids.speaker, ids.visible, now, now, now),
      env.DB.prepare(dedent`
        INSERT INTO file (id, event_id, kind, file_name, mime_type, size_bytes, storage_key, created_at)
        VALUES ('private-response-file', ?, 'DOCUMENT', 'private.pdf', 'application/pdf', 7, 'public/private', ?)
      `).bind(ids.event, now),
      env.DB.prepare(dedent`
        INSERT INTO file (id, event_id, kind, file_name, mime_type, size_bytes, storage_key, created_at)
        VALUES ('public-cover-file', ?, 'IMAGE', 'cover.png', 'image/png', 5, 'public/cover', ?)
      `).bind(ids.event, now),
      env.DB.prepare(dedent`
        INSERT INTO form_field_value (id, response_id, name, value, file_id)
        VALUES ('private-response-value', 'public-file-response', 'privateAttachment', 'private-response-file', 'private-response-file')
      `),
      env.DB.prepare('UPDATE event_session SET cover_image_file_id = ? WHERE id = ?').bind('public-cover-file', ids.visible),
    ])
    await env.FILES.put('public/private', 'private')
    await env.FILES.put('public/cover', 'cover')

    const privateResponse = await app.handle(new Request('http://localhost/files/private-response-file'))
    const coverResponse = await app.handle(new Request('http://localhost/files/public-cover-file'))

    expect(privateResponse.status).toBe(404)
    expect(coverResponse.status).toBe(200)
    expect(new TextDecoder().decode(await coverResponse.arrayBuffer())).toBe('cover')
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

  test('renders a title-only agenda block for a ten-minute session', async () => {
    const response = await createSpiceflowFetch(app)('/public/:eventSlug/agenda', {
      params: { eventSlug: 'public-program' },
    })
    if (!(response instanceof SpiceflowTestResponse)) throw new Error('expected public agenda page')
    const html = await response.text()
    expect(html).toContain('Ten minute briefing')
    expect(html).toContain('data-agenda-density="title-only"')
  })

  test('validates every automatic placement before writing the atomic batch', async () => {
    const db = getDb()
    const event = await db.query.event.findFirst({ where: { id: ids.event } })
    if (!event) throw new Error('fixture event missing')
    await env.DB.batch([
      env.DB.prepare(dedent`
        INSERT INTO event_session (id, event_id, kind, status, title, visibility, format_id, created_at, updated_at)
        VALUES ('atomic-auto-a', ?, 'CONTENT', 'ACCEPTED', 'Atomic A', 'PUBLIC', ?, ?, ?)
      `).bind(ids.event, ids.format, now, now),
      env.DB.prepare(dedent`
        INSERT INTO event_session (id, event_id, kind, status, title, visibility, format_id, created_at, updated_at)
        VALUES ('atomic-auto-b', ?, 'CONTENT', 'ACCEPTED', 'Atomic B', 'PUBLIC', ?, ?, ?)
      `).bind(ids.event, ids.format, now, now),
    ])

    await expect(applyAutoPlacementPlan({
      db,
      event,
      now: now + 3,
      placements: [
        { sessionId: 'atomic-auto-a', roomId: ids.room, dayKey: '2027-05-13', startMinute: 12 * 60, durationMinutes: 30 },
        { sessionId: 'missing-session', roomId: ids.room, dayKey: '2027-05-13', startMinute: 13 * 60, durationMinutes: 30 },
      ],
    })).rejects.toThrow('Automatic placement session not found')

    const untouched = await db.query.eventSession.findMany({
      where: { id: { in: ['atomic-auto-a', 'atomic-auto-b'] } },
      orderBy: { id: 'asc' },
    })
    expect(untouched.map((row) => ({ id: row.id, roomId: row.roomId, startsAt: row.startsAt }))).toEqual([
      { id: 'atomic-auto-a', roomId: null, startsAt: null },
      { id: 'atomic-auto-b', roomId: null, startsAt: null },
    ])

    const applied = await applyAutoPlacementPlan({
      db,
      event,
      now: now + 4,
      placements: [
        { sessionId: 'atomic-auto-a', roomId: ids.room, dayKey: '2027-05-13', startMinute: 12 * 60, durationMinutes: 30 },
        { sessionId: 'atomic-auto-b', roomId: ids.room, dayKey: '2027-05-13', startMinute: 13 * 60, durationMinutes: 30 },
      ],
    })
    expect(applied).toMatchObject({ applied: 2 })
    const written = await db.query.eventSession.findMany({
      where: { id: { in: ['atomic-auto-a', 'atomic-auto-b'] } },
      orderBy: { id: 'asc' },
    })
    expect(written.map((row) => ({ id: row.id, roomId: row.roomId, startsAt: row.startsAt }))).toEqual([
      { id: 'atomic-auto-a', roomId: ids.room, startsAt: Date.UTC(2027, 4, 13, 12) },
      { id: 'atomic-auto-b', roomId: ids.room, startsAt: Date.UTC(2027, 4, 13, 13) },
    ])
  })

  test('iframe routes accept safe options, reject unsafe values, and allow framing', async () => {
    const response = await createSpiceflowFetch(app)('/embed/:eventSlug/sessions', {
      params: { eventSlug: 'public-program' },
      query: { accent: '#123456', compact: '1' },
    })
    if (!(response instanceof SpiceflowTestResponse)) throw new Error('expected embed page')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe('frame-ancestors *')
    expect(response.headers.get('x-frame-options')).toBeNull()
    expect((await response.text())).toContain('Published talk')

    const invalid = await app.handle(new Request('http://localhost/embed/public-program/sessions?accent=javascript%3Aalert(1)'))
    expect(invalid.status).toBe(400)
  })

  test('offers live basic HTML, JSON, XML, iCal, and script outputs without stale caching', async () => {
    const paths = [
      '/public/public-program/widget.html?widget=sessions&fields=time,room',
      '/public/public-program/widget.json?widget=sessions',
      '/public/public-program/widget.xml?widget=sessions',
      '/public/public-program/schedule.ics',
      '/public/public-program/widget.js?widget=sessions',
    ]
    for (const path of paths) {
      const response = await app.handle(new Request(`http://localhost${path}`))
      expect({ path, status: response.status, cache: response.headers.get('cache-control') }).toEqual({
        path,
        status: 200,
        cache: 'no-store',
      })
      const body = await response.text()
      expect(body.length).toBeGreaterThan(20)
      if (!path.endsWith('widget.js?widget=sessions')) expect(body).toContain('Published talk')
    }
  })

  test('applies visible fields to every iframe widget type', async () => {
    for (const view of ['sessions', 'speakers', 'agenda', 'itinerary', 'gallery']) {
      const response = await app.handle(new Request(`http://localhost/embed/public-program/${view}?fields=track`))
      const html = await response.text()
      expect({ view, status: response.status }).toEqual({ view, status: 200 })
      expect(html).not.toContain('Principal Engineer')
      expect(html).not.toContain('Latticework Systems')
      expect(html).not.toContain('Program description')
    }
  })

  test('serves organizer edits on the next request without republishing or a stale window', async () => {
    const before = await app.handle(new Request('http://localhost/public/public-program/schedule.json'))
    expect(await before.text()).toContain('Published talk')

    await env.DB.prepare('UPDATE event_session SET title = ?, updated_at = ? WHERE id = ?')
      .bind('Published talk updated live', now + 10, ids.visible)
      .run()

    const after = await app.handle(new Request('http://localhost/public/public-program/schedule.json'))
    const body = await after.text()
    expect(after.headers.get('cache-control')).toBe('no-store')
    expect(body).toContain('Published talk updated live')
    expect(body).not.toContain('"title":"Published talk"')
  })
})
