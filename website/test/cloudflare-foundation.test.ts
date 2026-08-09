// Workerd smoke tests for the real anonymous app, D1 migrations, and R2 binding.
import { env } from 'cloudflare:workers'
import dedent from 'string-dedent'
import { beforeAll, describe, expect, test } from 'vitest'
import { app } from '../src/app.tsx'

const fixture = {
  userId: 'workerd-fixture-user',
  orgId: 'workerd-fixture-org',
  eventId: 'workerd-fixture-event',
  eventSlug: 'workerd-fixture-event',
  formId: 'workerd-fixture-form',
  formSlug: 'call-for-speakers',
  versionId: 'workerd-fixture-version',
  objectKey: 'workerd-fixture-object',
}

beforeAll(async () => {
  const now = Date.UTC(2026, 7, 9)
  await env.DB.batch([
    env.DB.prepare(dedent`
      INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(fixture.userId, 'Fixture Organizer', 'fixture@example.test', 1, now, now),
    env.DB.prepare(dedent`
      INSERT INTO org (org_id, owner_user_id, kind, name, created_at, updated_at)
      VALUES (?, ?, 'personal', ?, ?, ?)
    `).bind(fixture.orgId, fixture.userId, 'Fixture Org', now, now),
    env.DB.prepare(dedent`
      INSERT INTO event (
        id, org_id, name, slug, status, timezone, starts_at, ends_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'ACTIVE', 'UTC', ?, ?, ?, ?)
    `).bind(
      fixture.eventId,
      fixture.orgId,
      'Integration Summit',
      fixture.eventSlug,
      now,
      now + 86_400_000,
      now,
      now,
    ),
    env.DB.prepare(dedent`
      INSERT INTO form (id, event_id, purpose, target, name, slug, status, created_at, updated_at)
      VALUES (?, ?, 'CFP', 'SUBMISSION', ?, ?, 'OPEN', ?, ?)
    `).bind(fixture.formId, fixture.eventId, 'Call for Speakers', fixture.formSlug, now, now),
    env.DB.prepare(dedent`
      INSERT INTO form_version (id, form_id, mdx_source, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(
      fixture.versionId,
      fixture.formId,
      '# Tell us about your session\n\n<Step title="Session"><TextField name="title" required /></Step>',
      now,
    ),
  ])
})

describe('Cloudflare integration foundation', () => {
  test('every discovered nested D1 migration was applied', async () => {
    const applied = await env.DB.prepare(
      'SELECT name FROM d1_migrations ORDER BY name',
    ).all<{ name: string }>()

    expect(applied.results.map(({ name }) => name)).toEqual(
      env.TEST_MIGRATIONS.map(({ name }) => name).sort(),
    )
    expect(applied.results.length).toBeGreaterThan(1)
    expect(applied.results.every(({ name }) => name.includes('/'))).toBe(true)
  })

  test('the anonymous CFP loader and page render D1 fixture data', async () => {
    const response = await app.handle(new Request(
      `http://localhost/submit/${fixture.eventSlug}/${fixture.formSlug}`,
    ))
    const html = await response.text()

    expect({
      status: response.status,
      html,
    }).toMatchObject({
      status: 200,
      html: expect.stringContaining('Integration Summit'),
    })
    expect(html).toContain('Call for Speakers')
    expect(html).toContain('Tell us about your session')
  })

  test('the Miniflare R2 binding stores and returns bytes and metadata', async () => {
    await env.FILES.put(fixture.objectKey, 'workerd-r2-body', {
      httpMetadata: { contentType: 'text/plain' },
    })
    const object = await env.FILES.get(fixture.objectKey)

    expect({
      body: await object?.text(),
      contentType: object?.httpMetadata?.contentType,
    }).toEqual({ body: 'workerd-r2-body', contentType: 'text/plain' })
  })
})
