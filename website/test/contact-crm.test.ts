// Workerd integration tests for the Phase 6 CRM migration, tenant boundaries,
// merge integrity, event handoff, activities, segments, and outbox contact links.
import { env } from 'cloudflare:workers'
import dedent from 'string-dedent'
import { beforeAll, describe, expect, test } from 'vitest'
import { app } from '../src/app.tsx'

const now = Date.UTC(2026, 7, 9)
const ids = {
  user: 'crm-user', otherUser: 'crm-other-user', org: 'crm-org', otherOrg: 'crm-other-org',
  event: 'crm-event', otherEvent: 'crm-other-event', primary: 'crm-priya', duplicate: 'crm-priya-alt',
  otherContact: 'crm-other-contact', speaker: 'crm-speaker', tag: 'crm-ai-tag', activity: 'crm-note',
}

beforeAll(async () => {
  await env.DB.batch([
    ...[[ids.user, 'Organizer', 'crm-organizer@example.test'], [ids.otherUser, 'Other', 'crm-other@example.test']].map(([id, name, email]) => env.DB.prepare(dedent`
      INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).bind(id, name, email, now, now)),
    ...[[ids.org, ids.user, 'CRM Org'], [ids.otherOrg, ids.otherUser, 'Other Org']].map(([id, owner, name]) => env.DB.prepare(dedent`
      INSERT INTO org (org_id, owner_user_id, kind, name, created_at, updated_at)
      VALUES (?, ?, 'team', ?, ?, ?)
    `).bind(id, owner, name, now, now)),
    ...[[ids.event, ids.org, 'DevFlow Conf 2027', 'crm-devflow'], [ids.otherEvent, ids.otherOrg, 'Other Event', 'crm-other']].map(([id, orgId, name, slug]) => env.DB.prepare(dedent`
      INSERT INTO event (id, org_id, name, slug, status, timezone, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', 'UTC', ?, ?, ?, ?)
    `).bind(id, orgId, name, slug, now, now + 86_400_000, now, now)),
    env.DB.prepare(dedent`
      INSERT INTO org_contact (id, org_id, email, first_name, last_name, company_name, bio, created_at, updated_at)
      VALUES (?, ?, 'priya@example.test', 'Priya', 'Raman', 'Latticework', 'Primary bio', ?, ?)
    `).bind(ids.primary, ids.org, now, now),
    env.DB.prepare(dedent`
      INSERT INTO org_contact (id, org_id, email, first_name, last_name, job_title, created_at, updated_at)
      VALUES (?, ?, 'priya.alt@example.test', 'Priya', 'Raman', 'Principal Engineer', ?, ?)
    `).bind(ids.duplicate, ids.org, now, now),
    env.DB.prepare(dedent`
      INSERT INTO org_contact (id, org_id, email, first_name, last_name, created_at, updated_at)
      VALUES (?, ?, 'other@example.test', 'Other', 'Contact', ?, ?)
    `).bind(ids.otherContact, ids.otherOrg, now, now),
    env.DB.prepare(dedent`
      INSERT INTO speaker (id, event_id, contact_id, email, first_name, last_name, created_at, updated_at)
      VALUES (?, ?, ?, 'priya.alt@example.test', 'Priya', 'Raman', ?, ?)
    `).bind(ids.speaker, ids.event, ids.duplicate, now, now),
    env.DB.prepare("INSERT INTO contact_tag (id, org_id, name, created_at) VALUES (?, ?, 'AI', ?)").bind(ids.tag, ids.org, now),
    env.DB.prepare('INSERT INTO contact_tag_link (id, org_id, contact_id, tag_id, created_at) VALUES (?, ?, ?, ?, ?)').bind('crm-tag-link', ids.org, ids.duplicate, ids.tag, now),
    env.DB.prepare(dedent`
      INSERT INTO contact_activity (id, org_id, contact_id, actor_user_id, kind, body, created_at)
      VALUES (?, ?, ?, ?, 'NOTE', 'Met at DevFlow 2026 - strong on CI topics; shortlist for keynote.', ?)
    `).bind(ids.activity, ids.org, ids.duplicate, ids.user, now),
    env.DB.prepare(dedent`
      INSERT INTO email_message (id, event_id, kind, dedupe_key, to_email, contact_id, subject, body_html, status, created_at)
      VALUES ('crm-email', ?, 'CUSTOM', 'crm:outreach', 'priya.alt@example.test', ?, 'Speak at DevFlow Conf 2027?', '<p>Hi Priya</p>', 'QUEUED', ?)
    `).bind(ids.event, ids.duplicate, now),
  ])
})

describe('CRM schema and authorization', () => {
  test('creates only the five CRM tables and nullable existing-table links', async () => {
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('org_contact', 'contact_tag', 'contact_tag_link', 'contact_segment', 'contact_activity') ORDER BY name").all()
    const speakerColumn = await env.DB.prepare("SELECT name FROM pragma_table_info('speaker') WHERE name = 'contact_id'").all()
    const emailColumn = await env.DB.prepare("SELECT name FROM pragma_table_info('email_message') WHERE name = 'contact_id'").all()
    expect({ tables: tables.results, speakerColumn: speakerColumn.results, emailColumn: emailColumn.results }).toMatchInlineSnapshot(`
      {
        "emailColumn": [
          {
            "name": "contact_id",
          },
        ],
        "speakerColumn": [
          {
            "name": "contact_id",
          },
        ],
        "tables": [
          {
            "name": "contact_activity",
          },
          {
            "name": "contact_segment",
          },
          {
            "name": "contact_tag",
          },
          {
            "name": "contact_tag_link",
          },
          {
            "name": "org_contact",
          },
        ],
      }
    `)
  })

  test('redirects an unauthenticated CRM page request before loading org data', async () => {
    const response = await app.handle(new Request(`http://localhost/org/${ids.org}/crm`))
    expect({ status: response.status, location: response.headers.get('location') }).toEqual({ status: 307, location: '/login' })
  })

  test('deduplicates normalized organization email and rejects every cross-org link', async () => {
    await expect(env.DB.prepare(dedent`
      INSERT INTO org_contact (id, org_id, email, first_name, last_name, created_at, updated_at)
      VALUES ('crm-duplicate-email', ?, 'priya@example.test', 'P', 'R', ?, ?)
    `).bind(ids.org, now, now).run()).rejects.toThrow(/UNIQUE/)
    await expect(env.DB.prepare(dedent`
      INSERT INTO contact_tag_link (id, org_id, contact_id, tag_id, created_at)
      VALUES ('crm-cross-tag', ?, ?, ?, ?)
    `).bind(ids.otherOrg, ids.otherContact, ids.tag, now).run()).rejects.toThrow(/FOREIGN KEY/)
    await expect(env.DB.prepare(dedent`
      INSERT INTO speaker (id, event_id, contact_id, email, first_name, last_name, created_at, updated_at)
      VALUES ('crm-cross-speaker', ?, ?, 'cross@example.test', 'Cross', 'Tenant', ?, ?)
    `).bind(ids.event, ids.otherContact, now, now).run()).rejects.toThrow(/organization mismatch/)
    await expect(env.DB.prepare(dedent`
      INSERT INTO email_message (id, event_id, contact_id, kind, dedupe_key, to_email, subject, body_html, status, created_at)
      VALUES ('crm-cross-email', ?, ?, 'CUSTOM', 'crm:cross-email', 'cross@example.test', 'Cross', '<p>Cross</p>', 'QUEUED', ?)
    `).bind(ids.event, ids.otherContact, now).run()).rejects.toThrow(/organization mismatch/)
  })
})

describe('CRM persistence and handoffs', () => {
  test('stores explicit dynamic segment criteria and constrained pipeline history', async () => {
    await env.DB.batch([
      env.DB.prepare(dedent`
        INSERT INTO contact_segment (id, org_id, name, company_name, tag_id, created_at, updated_at)
        VALUES ('crm-segment', ?, 'AI Experts', 'Latticework', ?, ?, ?)
      `).bind(ids.org, ids.tag, now, now),
      env.DB.prepare("UPDATE org_contact SET stage = 'INTERESTED', score = 85, rationale = 'Strong platform record' WHERE id = ?").bind(ids.primary),
      env.DB.prepare(dedent`
        INSERT INTO contact_activity (id, org_id, contact_id, actor_user_id, kind, from_stage, to_stage, created_at)
        VALUES ('crm-transition', ?, ?, ?, 'STAGE_TRANSITION', 'CONTACTED', 'INTERESTED', ?)
      `).bind(ids.org, ids.primary, ids.user, now + 1),
    ])
    await expect(env.DB.prepare("UPDATE org_contact SET stage = 'WON' WHERE id = ?").bind(ids.primary).run()).rejects.toThrow(/CHECK/)
    const segment = await env.DB.prepare('SELECT name, company_name, job_title, tag_id FROM contact_segment WHERE id = ?').bind('crm-segment').first()
    const history = await env.DB.prepare('SELECT kind, from_stage, to_stage FROM contact_activity WHERE id = ?').bind('crm-transition').first()
    expect({ segment, history }).toEqual({
      segment: { name: 'AI Experts', company_name: 'Latticework', job_title: null, tag_id: ids.tag },
      history: { kind: 'STAGE_TRANSITION', from_stage: 'CONTACTED', to_stage: 'INTERESTED' },
    })
  })

  test('reuses contact profile in an event speaker row without re-entry', async () => {
    const contact = await env.DB.prepare('SELECT * FROM org_contact WHERE id = ?').bind(ids.primary).first<any>()
    await env.DB.prepare(dedent`
      INSERT INTO speaker (id, event_id, contact_id, email, first_name, last_name, job_title, company_name, bio, created_at, updated_at)
      VALUES ('crm-event-speaker', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(ids.event, ids.primary, contact.email, contact.first_name, contact.last_name, contact.job_title, contact.company_name, contact.bio, now, now).run()
    const speaker = await env.DB.prepare("SELECT email, first_name, last_name, company_name, bio FROM speaker WHERE id = 'crm-event-speaker'").first()
    expect(speaker).toEqual({ email: 'priya@example.test', first_name: 'Priya', last_name: 'Raman', company_name: 'Latticework', bio: 'Primary bio' })
  })

  test('merge reassigns speaker, tags, activity, and email history before deletion', async () => {
    await env.DB.batch([
      env.DB.prepare('UPDATE speaker SET contact_id = ? WHERE contact_id = ?').bind(ids.primary, ids.duplicate),
      env.DB.prepare('UPDATE email_message SET contact_id = ? WHERE contact_id = ?').bind(ids.primary, ids.duplicate),
      env.DB.prepare('UPDATE contact_activity SET contact_id = ?, org_id = ? WHERE contact_id = ?').bind(ids.primary, ids.org, ids.duplicate),
      env.DB.prepare('DELETE FROM contact_tag_link WHERE contact_id = ?').bind(ids.duplicate),
      env.DB.prepare('INSERT OR IGNORE INTO contact_tag_link (id, org_id, contact_id, tag_id, created_at) VALUES (?, ?, ?, ?, ?)').bind('crm-primary-tag', ids.org, ids.primary, ids.tag, now),
      env.DB.prepare('DELETE FROM org_contact WHERE id = ?').bind(ids.duplicate),
    ])
    const links = await env.DB.batch([
      env.DB.prepare('SELECT contact_id FROM speaker WHERE id = ?').bind(ids.speaker),
      env.DB.prepare("SELECT contact_id FROM email_message WHERE id = 'crm-email'"),
      env.DB.prepare('SELECT contact_id FROM contact_activity WHERE id = ?').bind(ids.activity),
      env.DB.prepare('SELECT contact_id, tag_id FROM contact_tag_link WHERE contact_id = ?').bind(ids.primary),
      env.DB.prepare('SELECT id FROM org_contact WHERE id = ?').bind(ids.duplicate),
    ])
    expect(links.map((result) => result.results)).toEqual([
      [{ contact_id: ids.primary }],
      [{ contact_id: ids.primary }],
      [{ contact_id: ids.primary }],
      [{ contact_id: ids.primary, tag_id: ids.tag }],
      [],
    ])
  })
})
