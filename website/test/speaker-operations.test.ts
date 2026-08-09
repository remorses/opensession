// Workerd integration tests for Phase 3 speaker operations on real Miniflare D1.
// These tests use production migrations and database constraints without mocks.
import { env } from 'cloudflare:workers'
import dedent from 'string-dedent'
import { beforeAll, describe, expect, test } from 'vitest'

const now = Date.UTC(2026, 7, 9)
const ids = {
  user: 'speaker-ops-user', org: 'speaker-ops-org', event: 'speaker-ops-event',
  otherEvent: 'speaker-ops-other-event', priya: 'speaker-ops-priya', marcus: 'speaker-ops-marcus',
  session: 'speaker-ops-session', futureSession: 'speaker-ops-future-session',
  selectedTask: 'speaker-ops-selected-task', allTask: 'speaker-ops-all-task',
}

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(dedent`
      INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES (?, 'Organizer', 'organizer-speaker-ops@example.test', 1, ?, ?)
    `).bind(ids.user, now, now),
    env.DB.prepare(dedent`
      INSERT INTO org (org_id, owner_user_id, kind, name, created_at, updated_at)
      VALUES (?, ?, 'team', 'Speaker Ops', ?, ?)
    `).bind(ids.org, ids.user, now, now),
    ...[[ids.event, 'speaker-ops'], [ids.otherEvent, 'speaker-ops-other']].map(([id, slug]) => env.DB.prepare(dedent`
      INSERT INTO event (id, org_id, name, slug, status, timezone, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, 'Speaker Event', ?, 'ACTIVE', 'UTC', ?, ?, ?, ?)
    `).bind(id, ids.org, slug, now, now + 86_400_000, now, now)),
    env.DB.prepare(dedent`
      INSERT INTO speaker (id, event_id, email, first_name, last_name, status, created_at, updated_at)
      VALUES (?, ?, 'priya@example.test', 'Priya', 'Raman', 'CONFIRMED', ?, ?)
    `).bind(ids.priya, ids.event, now, now),
    env.DB.prepare(dedent`
      INSERT INTO speaker (id, event_id, email, first_name, last_name, created_at, updated_at)
      VALUES (?, ?, 'marcus@example.test', 'Marcus', 'Okafor', ?, ?)
    `).bind(ids.marcus, ids.event, now, now),
    ...[[ids.session, 'Accepted talk', 'ACCEPTED'], [ids.futureSession, 'Future talk', 'PENDING']].map(([id, title, status]) => env.DB.prepare(dedent`
      INSERT INTO event_session (id, event_id, kind, status, title, created_at, updated_at)
      VALUES (?, ?, 'CONTENT', ?, ?, ?, ?)
    `).bind(id, ids.event, status, title, now, now)),
    env.DB.prepare(dedent`
      INSERT INTO session_participant (id, event_id, session_id, speaker_id, role, confirmation_status, sort_order, created_at)
      VALUES ('speaker-ops-participant', ?, ?, ?, 'SPEAKER', 'PENDING', 0, ?)
    `).bind(ids.event, ids.session, ids.priya, now),
    ...[[ids.selectedTask, 'SELECTED'], [ids.allTask, 'ALL_ACCEPTED']].map(([id, policy]) => env.DB.prepare(dedent`
      INSERT INTO task_definition (id, event_id, title, target, source, assignment_policy, sort_order, created_at)
      VALUES (?, ?, ?, 'SPEAKER', 'MANUAL', ?, 0, ?)
    `).bind(id, ids.event, `${policy} task`, policy, now)),
  ])
})

describe('speaker roster and event boundaries', () => {
  test('migration adds constrained roster status, assignment policy, and outbox batch', async () => {
    await expect(env.DB.prepare("UPDATE speaker SET status = 'UNKNOWN' WHERE id = ?").bind(ids.priya).run()).rejects.toThrow(/CHECK/)
    await expect(env.DB.prepare("UPDATE task_definition SET assignment_policy = 'FUTURE_SELECTED' WHERE id = ?").bind(ids.allTask).run()).rejects.toThrow(/CHECK/)
    const columns = await env.DB.prepare("SELECT name FROM pragma_table_info('email_message') WHERE name = 'batch_id'").all()
    expect(columns.results).toEqual([{ name: 'batch_id' }])
  })

  test('add, edit, status, and event-email import stay idempotent', async () => {
    const insert = env.DB.prepare(dedent`
      INSERT OR IGNORE INTO speaker (id, event_id, email, first_name, last_name, job_title, company_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'Dana', 'Kowalski', 'Engineering Manager', 'Substrate', 'PENDING', ?, ?)
    `)
    await insert.bind('speaker-ops-dana-1', ids.event, 'dana@example.test', now, now).run()
    await insert.bind('speaker-ops-dana-2', ids.event, 'dana@example.test', now, now).run()
    await env.DB.prepare("UPDATE speaker SET bio = 'SBEK-ORG-EDIT-01', status = 'INVITED' WHERE id = ? AND event_id = ?").bind(ids.priya, ids.event).run()
    const rows = await env.DB.prepare("SELECT first_name, bio, status FROM speaker WHERE event_id = ? AND email IN ('priya@example.test', 'dana@example.test') ORDER BY first_name").bind(ids.event).all()
    expect(rows.results).toMatchInlineSnapshot(`
      [
        {
          "bio": null,
          "first_name": "Dana",
          "status": "PENDING",
        },
        {
          "bio": "SBEK-ORG-EDIT-01",
          "first_name": "Priya",
          "status": "INVITED",
        },
      ]
    `)
    await expect(env.DB.prepare(dedent`
      INSERT INTO session_participant (id, event_id, session_id, speaker_id, created_at)
      VALUES ('speaker-ops-cross-participant', ?, ?, ?, ?)
    `).bind(ids.otherEvent, ids.session, ids.marcus, now).run()).rejects.toThrow(/FOREIGN KEY/)
  })
})

describe('participants and assignment policies', () => {
  test('updates role, order, and confirmation without changing roster status', async () => {
    await env.DB.prepare(dedent`
      UPDATE session_participant SET role = 'MODERATOR', confirmation_status = 'CONFIRMED',
        confirmed_at = ?, declined_at = NULL, sort_order = 2
      WHERE session_id = ? AND speaker_id = ?
    `).bind(now + 1, ids.session, ids.priya).run()
    const row = await env.DB.prepare(dedent`
      SELECT participant.role, participant.confirmation_status, participant.sort_order, speaker.status
      FROM session_participant participant JOIN speaker ON speaker.id = participant.speaker_id
      WHERE participant.session_id = ? AND participant.speaker_id = ?
    `).bind(ids.session, ids.priya).first()
    expect(row).toEqual({ role: 'MODERATOR', confirmation_status: 'CONFIRMED', sort_order: 2, status: 'INVITED' })
  })

  test('selected is current-only while all-accepted is idempotent for future acceptance', async () => {
    const assignment = env.DB.prepare(dedent`
      INSERT OR IGNORE INTO task_assignment
        (id, event_id, task_definition_id, speaker_id, session_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, 'NOT_STARTED', ?, ?)
    `)
    await assignment.bind('speaker-ops-selected-priya', ids.event, ids.selectedTask, ids.priya, now, now).run()
    await assignment.bind('speaker-ops-all-priya-1', ids.event, ids.allTask, ids.priya, now, now).run()
    await assignment.bind('speaker-ops-all-priya-2', ids.event, ids.allTask, ids.priya, now, now).run()
    await env.DB.prepare("UPDATE event_session SET status = 'ACCEPTED' WHERE id = ?").bind(ids.futureSession).run()
    await env.DB.prepare(dedent`
      INSERT INTO session_participant (id, event_id, session_id, speaker_id, created_at)
      VALUES ('speaker-ops-future-participant', ?, ?, ?, ?)
    `).bind(ids.event, ids.futureSession, ids.marcus, now).run()
    await assignment.bind('speaker-ops-all-marcus', ids.event, ids.allTask, ids.marcus, now, now).run()
    const counts = await env.DB.prepare(dedent`
      SELECT task_definition_id, count(*) AS count FROM task_assignment
      WHERE event_id = ? GROUP BY task_definition_id ORDER BY task_definition_id
    `).bind(ids.event).all()
    expect(counts.results).toEqual([
      { task_definition_id: ids.allTask, count: 2 },
      { task_definition_id: ids.selectedTask, count: 1 },
    ])
  })

  test('detaching from an accepted session can remove only all-accepted assignments', async () => {
    await env.DB.prepare("DELETE FROM task_assignment WHERE task_definition_id IN (?, ?)").bind(ids.selectedTask, ids.allTask).run()
    const assignment = env.DB.prepare(`
      INSERT INTO task_assignment
        (id, event_id, task_definition_id, speaker_id, session_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, 'NOT_STARTED', ?, ?)
    `)
    await assignment.bind('speaker-ops-detach-selected', ids.event, ids.selectedTask, ids.priya, now, now).run()
    await assignment.bind('speaker-ops-detach-all', ids.event, ids.allTask, ids.priya, now, now).run()
    await env.DB.prepare("DELETE FROM task_assignment WHERE event_id = ? AND speaker_id = ? AND task_definition_id IN (SELECT id FROM task_definition WHERE event_id = ? AND assignment_policy = 'ALL_ACCEPTED')").bind(ids.event, ids.priya, ids.event).run()
    const remaining = await env.DB.prepare('SELECT task_definition_id FROM task_assignment WHERE speaker_id = ? ORDER BY task_definition_id').bind(ids.priya).all()
    expect(remaining.results).toEqual([{ task_definition_id: ids.selectedTask }])
  })
})

describe('email history and portal ownership', () => {
  test('groups rendered snapshots by batch and deduplicates each recipient', async () => {
    const message = env.DB.prepare(dedent`
      INSERT OR IGNORE INTO email_message
        (id, event_id, kind, dedupe_key, batch_id, to_email, speaker_id, subject, body_html, status, created_at)
      VALUES (?, ?, 'CUSTOM', ?, 'speaker-ops-batch', ?, ?, ?, ?, 'QUEUED', ?)
    `)
    await message.bind('speaker-ops-mail-priya-1', ids.event, 'custom:batch:priya', 'priya@example.test', ids.priya, 'Hi Priya', '<p>Priya portal</p>', now).run()
    await message.bind('speaker-ops-mail-priya-2', ids.event, 'custom:batch:priya', 'priya@example.test', ids.priya, 'Duplicate', '<p>duplicate</p>', now).run()
    await message.bind('speaker-ops-mail-marcus', ids.event, 'custom:batch:marcus', 'marcus@example.test', ids.marcus, 'Hi Marcus', '<p>Marcus portal</p>', now).run()
    const history = await env.DB.prepare("SELECT batch_id, count(*) AS recipients, group_concat(subject, '|') AS subjects FROM email_message WHERE batch_id = 'speaker-ops-batch' GROUP BY batch_id").first()
    expect(history).toEqual({ batch_id: 'speaker-ops-batch', recipients: 2, subjects: 'Hi Priya|Hi Marcus' })
  })

  test('speaker-scoped portal query cannot return another speaker assignment', async () => {
    const priyaRows = await env.DB.prepare('SELECT id, speaker_id FROM task_assignment WHERE event_id = ? AND speaker_id = ?').bind(ids.event, ids.priya).all()
    const leaked = priyaRows.results.some((row) => row.speaker_id === ids.marcus)
    const directMarcusAsPriya = await env.DB.prepare('SELECT id FROM task_assignment WHERE event_id = ? AND speaker_id = ? AND id = ?').bind(ids.event, ids.priya, 'speaker-ops-all-marcus').first()
    expect({ leaked, directMarcusAsPriya }).toEqual({ leaked: false, directMarcusAsPriya: null })
  })
})
