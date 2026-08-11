// Workerd integration tests for API-key auth, tenant isolation, core CRUD,
// and the generated OpenAPI contract on real Miniflare D1.
import { env } from 'cloudflare:workers'
import dedent from 'string-dedent'
import { beforeAll, describe, expect, test } from 'vitest'
import { app } from '../src/app.tsx'
import { apiApp } from '../src/api.ts'

const now = Date.UTC(2027, 5, 3, 12)
const secret = 'osk_test_open_session_api_key'
const ids = {
  user: 'api-user',
  org: 'api-org',
  event: 'api-event',
  otherEvent: 'api-other-event',
  key: 'api-key',
  track: 'api-track',
  format: 'api-format',
  room: 'api-room',
  speaker: 'api-speaker',
  session: 'api-session',
}

async function hashSecret(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function apiRequest(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost/api/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      ...init?.headers,
    },
  }))
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(dedent`
      INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES (?, 'API Owner', 'api-owner@example.test', 1, ?, ?)
    `).bind(ids.user, now, now),
    env.DB.prepare(dedent`
      INSERT INTO org (org_id, owner_user_id, kind, name, created_at, updated_at)
      VALUES (?, ?, 'team', 'API Org', ?, ?)
    `).bind(ids.org, ids.user, now, now),
    env.DB.prepare(dedent`
      INSERT INTO event (id, org_id, name, slug, status, timezone, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, 'API Conference', 'api-conference', 'ACTIVE', 'UTC', ?, ?, ?, ?)
    `).bind(ids.event, ids.org, now, now + 86_400_000, now, now),
    env.DB.prepare(dedent`
      INSERT INTO event (id, org_id, name, slug, status, timezone, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, 'Other Conference', 'other-conference', 'ACTIVE', 'UTC', ?, ?, ?, ?)
    `).bind(ids.otherEvent, ids.org, now, now + 86_400_000, now, now),
    env.DB.prepare(dedent`
      INSERT INTO api_key (
        id, org_id, event_id, name, key_hash, key_prefix,
        created_by_user_id, created_at
      ) VALUES (?, ?, ?, 'Integration key', ?, 'osk_test', ?, ?)
    `).bind(ids.key, ids.org, ids.event, await hashSecret(secret), ids.user, now),
    ...[
      'read:events',
      'write:events',
      'read:sessions',
      'write:sessions',
      'read:speakers',
      'write:speakers',
      'read:metadata',
      'write:metadata',
      'read:reviews',
    ].map((scope) => env.DB.prepare(
      'INSERT INTO api_key_scope (api_key_id, scope) VALUES (?, ?)',
    ).bind(ids.key, scope)),
  ])
})

describe('OpenSession API', () => {
  test('publishes an OpenAPI contract without requiring a key', async () => {
    const response = await apiApp.handle(new Request('http://localhost/api/v1/openapi.json'))
    const body = await response.json<any>()

    expect({
      status: response.status,
      title: body.info.title,
      security: body.security,
      paths: Object.keys(body.paths).sort(),
    }).toMatchInlineSnapshot(`
      {
        "paths": [
          "/api/v1/events",
          "/api/v1/events/{eventId}",
          "/api/v1/events/{eventId}/formats",
          "/api/v1/events/{eventId}/formats/{formatId}",
          "/api/v1/events/{eventId}/reviews",
          "/api/v1/events/{eventId}/reviews/{reviewId}",
          "/api/v1/events/{eventId}/rooms",
          "/api/v1/events/{eventId}/rooms/{roomId}",
          "/api/v1/events/{eventId}/schedule",
          "/api/v1/events/{eventId}/schedule/publish",
          "/api/v1/events/{eventId}/schedule/unpublish",
          "/api/v1/events/{eventId}/sessions",
          "/api/v1/events/{eventId}/sessions/{sessionId}",
          "/api/v1/events/{eventId}/sessions/{sessionId}/schedule",
          "/api/v1/events/{eventId}/speakers",
          "/api/v1/events/{eventId}/speakers/{speakerId}",
          "/api/v1/events/{eventId}/tracks",
          "/api/v1/events/{eventId}/tracks/{trackId}",
          "/api/v1/openapi.json",
        ],
        "security": [
          {
            "apiKey": [],
          },
        ],
        "status": 200,
        "title": "OpenSession API",
      }
    `)
  })

  test('rejects missing credentials and hides another event', async () => {
    const missing = await app.handle(new Request('http://localhost/api/v1/events'))
    const foreign = await apiRequest(`/events/${ids.otherEvent}`)

    expect({
      missing: { status: missing.status, body: await missing.json() },
      foreign: { status: foreign.status, body: await foreign.json() },
    }).toMatchInlineSnapshot(`
      {
        "foreign": {
          "body": {
            "code": "not_found",
            "message": "Event not found",
          },
          "status": 404,
        },
        "missing": {
          "body": {
            "code": "unauthorized",
            "message": "Send an API key with the Authorization Bearer header",
          },
          "status": 401,
        },
      }
    `)
  })

  test('creates metadata, a speaker, and a session in the key event', async () => {
    const track = await apiRequest(`/events/${ids.event}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ name: 'AI Engineering', color: '#334455', sortOrder: 1 }),
    })
    const format = await apiRequest(`/events/${ids.event}/formats`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Talk', defaultDurationMinutes: 30, sortOrder: 1 }),
    })
    const room = await apiRequest(`/events/${ids.event}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Main Stage', sortOrder: 1 }),
    })
    const speaker = await apiRequest(`/events/${ids.event}/speakers`, {
      method: 'POST',
      body: JSON.stringify({
        email: 'speaker-api@example.test',
        firstName: 'Priya',
        lastName: 'Raman',
        jobTitle: 'Principal Engineer',
      }),
    })
    const session = await apiRequest(`/events/${ids.event}/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'CONTENT',
        title: 'Building reliable agents',
        description: 'A practical systems talk.',
        visibility: 'PRIVATE',
      }),
    })

    const trackBody = await track.json<any>()
    const formatBody = await format.json<any>()
    const roomBody = await room.json<any>()
    const speakerBody = await speaker.json<any>()
    const sessionBody = await session.json<any>()
    expect({
      track: { status: track.status, name: trackBody.name, color: trackBody.color },
      format: { status: format.status, name: formatBody.name, duration: formatBody.defaultDurationMinutes },
      room: { status: room.status, name: roomBody.name },
      speaker: { status: speaker.status, email: speakerBody.email, jobTitle: speakerBody.jobTitle },
      session: { status: session.status, title: sessionBody.title, lifecycle: sessionBody.status, kind: sessionBody.kind },
    }).toMatchInlineSnapshot(`
      {
        "format": {
          "duration": 30,
          "name": "Talk",
          "status": 201,
        },
        "room": {
          "name": "Main Stage",
          "status": 201,
        },
        "session": {
          "kind": "CONTENT",
          "lifecycle": "PENDING",
          "status": 201,
          "title": "Building reliable agents",
        },
        "speaker": {
          "email": "speaker-api@example.test",
          "jobTitle": "Principal Engineer",
          "status": 201,
        },
        "track": {
          "color": "#334455",
          "name": "AI Engineering",
          "status": 201,
        },
      }
    `)
  })

  test('lists only resources owned by the key event', async () => {
    const events = await apiRequest('/events')
    const tracks = await apiRequest(`/events/${ids.event}/tracks`)
    const speakers = await apiRequest(`/events/${ids.event}/speakers`)
    const sessions = await apiRequest(`/events/${ids.event}/sessions`)

    expect({
      events: (await events.json<any>()).data.map((row: any) => row.id),
      tracks: (await tracks.json<any>()).data.map((row: any) => row.name),
      speakers: (await speakers.json<any>()).data.map((row: any) => row.email),
      sessions: (await sessions.json<any>()).data.map((row: any) => row.title),
    }).toMatchInlineSnapshot(`
      {
        "events": [
          "api-event",
        ],
        "sessions": [
          "Building reliable agents",
        ],
        "speakers": [
          "speaker-api@example.test",
        ],
        "tracks": [
          "AI Engineering",
        ],
      }
    `)
  })

  test('revoked keys stop working immediately', async () => {
    await env.DB.prepare('UPDATE api_key SET revoked_at = ? WHERE id = ?')
      .bind(now + 1, ids.key)
      .run()

    const response = await apiRequest('/events')
    expect({ status: response.status, body: await response.json() }).toMatchInlineSnapshot(`
      {
        "body": {
          "code": "unauthorized",
          "message": "API key is invalid, expired, or revoked",
        },
        "status": 401,
      }
    `)
  })
})
