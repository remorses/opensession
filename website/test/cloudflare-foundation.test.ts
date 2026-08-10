// Workerd smoke tests for the real anonymous app, D1 migrations, and R2 binding.
import { env } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import * as schema from 'db/schema'
import { createSpiceflowFetch } from 'spiceflow/client'
import { SpiceflowTestResponse } from 'spiceflow/testing'
import dedent from 'string-dedent'
import { beforeAll, describe, expect, test } from 'vitest'
import worker, { app } from '../src/app.tsx'
import { getDb } from '../src/db.ts'
import { runCron } from '../src/lib/emails/cron.ts'
import { enqueueAndSend, isPlaceholderEmail } from '../src/lib/emails/send.ts'

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
  test('the Holocron homepage has one document shell and progress bar', async () => {
    const response = await createSpiceflowFetch(app)('/')
    if (!(response instanceof SpiceflowTestResponse)) throw new Error('expected homepage')
    const html = await response.text()

    expect(html.match(/<html/g)).toHaveLength(1)
    expect(html.match(/spiceflow-progress-fade-in/g)).toHaveLength(1)
  })

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
    const response = await createSpiceflowFetch(app)(
      '/submit/:eventSlug/:formSlug',
      { params: { eventSlug: fixture.eventSlug, formSlug: fixture.formSlug } },
    )
    if (!(response instanceof SpiceflowTestResponse)) throw new Error('expected CFP page')
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
    expect(html.match(/spiceflow-progress-fade-in/g)).toHaveLength(1)
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

  test('queues email without contacting the delivery service', async () => {
    const result = await enqueueAndSend({
      db: getDb(),
      eventId: fixture.eventId,
      toEmail: 'speaker@example.test',
      dedupeKey: 'workerd:no-delivery',
      replyTo: 'organizer@example.test',
      now: Date.UTC(2026, 7, 9),
      payload: {
        kind: 'SUBMISSION_CONFIRMATION',
        context: {
          eventName: 'Integration Summit',
          eventSlug: fixture.eventSlug,
          appUrl: 'http://localhost',
          timezone: 'UTC',
          recipientName: 'Speaker',
        },
        data: {
          sessionId: 'workerd-session',
          sessionTitle: 'A queued talk',
        },
      },
    })
    const row = await env.DB.prepare(dedent`
      SELECT status, attempt_count AS attemptCount, last_attempt_at AS lastAttemptAt
      FROM email_message WHERE dedupe_key = 'workerd:no-delivery'
    `).first()

    expect({ result, row }).toEqual({
      result: { inserted: true, sent: false },
      row: { status: 'QUEUED', attemptCount: 0, lastAttemptAt: null },
    })
  })

  test('does not queue placeholder email recipients', async () => {
    expect([
      'speaker@example.com',
      'speaker@sbek-test.example.com',
      'speaker@real-example.com',
    ].map(isPlaceholderEmail)).toEqual([true, true, false])

    const result = await enqueueAndSend({
      db: getDb(),
      eventId: fixture.eventId,
      toEmail: 'speaker@sbek-test.example.com',
      dedupeKey: 'workerd:placeholder-email',
      replyTo: 'organizer@example.test',
      now: Date.UTC(2026, 7, 9),
      payload: {
        kind: 'SUBMISSION_CONFIRMATION',
        context: {
          eventName: 'Integration Summit',
          eventSlug: fixture.eventSlug,
          appUrl: 'http://localhost',
          timezone: 'UTC',
          recipientName: 'Speaker',
        },
        data: {
          sessionId: 'workerd-placeholder-session',
          sessionTitle: 'A placeholder talk',
        },
      },
    })
    const row = await env.DB.prepare(
      "SELECT id FROM email_message WHERE dedupe_key = 'workerd:placeholder-email'",
    ).first()

    expect({ result, row }).toEqual({
      result: { inserted: false, sent: false },
      row: null,
    })
  })

  test('cron queues one task reminder outbox snapshot for an incomplete assignment', async () => {
    const now = Date.UTC(2026, 7, 10, 12)
    const dueAt = now + 24 * 60 * 60 * 1000
    const db = getDb()
    await db.insert(schema.speaker).values({
      id: 'workerd-reminder-speaker',
      eventId: fixture.eventId,
      firstName: 'Priya',
      lastName: 'Raman',
      email: 'priya-reminder@example.test',
    })
    await db.insert(schema.taskDefinition).values({
      id: 'workerd-reminder-task',
      eventId: fixture.eventId,
      title: 'Sign speaker release form',
      target: 'SPEAKER',
      source: 'MANUAL',
      assignmentPolicy: 'SELECTED',
      dueAt,
    })
    await db.insert(schema.taskAssignment).values({
      id: 'workerd-reminder-assignment',
      eventId: fixture.eventId,
      taskDefinitionId: 'workerd-reminder-task',
      speakerId: 'workerd-reminder-speaker',
      dueAt,
    })

    const ctx = createExecutionContext()
    await worker.scheduled(
      { scheduledTime: now, cron: '*/5 * * * *', noRetry() {} },
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    const second = await runCron({ now })
    const reminders = await db.query.emailMessage.findMany({
      where: { speakerId: 'workerd-reminder-speaker', kind: 'TASK_REMINDER' },
    })

    expect({
      second: second.taskRemindersQueued,
      reminders: reminders.map((row) => ({
        status: row.status,
        subject: row.subject,
        text: row.bodyText,
        to: row.toEmail,
      })),
    }).toMatchInlineSnapshot(`
      {
        "reminders": [
          {
            "status": "QUEUED",
            "subject": "Reminder: Sign speaker release form",
            "text": "Hey Priya,

      "Sign speaker release form" is still open in your Integration Summit speaker portal. It is due in 1 day.

      It takes a couple of minutes:
      https://opensession.dev/portal/workerd-fixture-event/tasks/workerd-reminder-assignment

      If anything looks off, just reply to this email.
      Integration Summit",
            "to": "priya-reminder@example.test",
          },
        ],
        "second": 0,
      }
    `)
  })
})
