// Workerd integration tests for the Phase 2 evaluation migration and D1
// boundaries. Authenticated Google UI remains covered by Playwriter.
import { env } from 'cloudflare:workers'
import dedent from 'string-dedent'
import { beforeAll, describe, expect, test } from 'vitest'

const now = Date.UTC(2026, 7, 9)
const ids = {
  organizer: 'eval-organizer', reviewer: 'eval-reviewer', other: 'eval-other',
  org: 'eval-org', event: 'eval-event', otherEvent: 'eval-other-event',
  round: 'eval-round', otherRound: 'eval-other-round', version: 'eval-version',
  session: 'eval-session', unassigned: 'eval-unassigned', speaker: 'eval-speaker',
  membership: 'eval-membership', review: 'eval-review', recusedReview: 'eval-recused-review',
}

beforeAll(async () => {
  await env.DB.batch([
    ...[[ids.organizer, 'Organizer', 'organizer@example.test'], [ids.reviewer, 'Sam Reviewer', 'sam@example.test'], [ids.other, 'Other Reviewer', 'other@example.test']].map(([id, name, email]) => env.DB.prepare(dedent`
      INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).bind(id, name, email, now, now)),
    env.DB.prepare(dedent`
      INSERT INTO org (org_id, owner_user_id, kind, name, created_at, updated_at)
      VALUES (?, ?, 'team', 'Evaluation Org', ?, ?)
    `).bind(ids.org, ids.organizer, now, now),
    env.DB.prepare(dedent`
      INSERT INTO event (id, org_id, name, slug, status, timezone, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, 'Evaluation Event', 'evaluation-event', 'ACTIVE', 'UTC', ?, ?, ?, ?)
    `).bind(ids.event, ids.org, now, now + 86_400_000, now, now),
    env.DB.prepare(dedent`
      INSERT INTO event (id, org_id, name, slug, status, timezone, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, 'Other Event', 'other-evaluation-event', 'ACTIVE', 'UTC', ?, ?, ?, ?)
    `).bind(ids.otherEvent, ids.org, now, now + 86_400_000, now, now),
    env.DB.prepare(dedent`
      INSERT INTO form (id, event_id, purpose, target, name, slug, status, blind, created_at, updated_at)
      VALUES (?, ?, 'EVALUATION', 'SUBMISSION', 'Initial Review', 'initial-review', 'OPEN', 1, ?, ?)
    `).bind(ids.round, ids.event, now, now),
    env.DB.prepare(dedent`
      INSERT INTO form (id, event_id, purpose, target, name, slug, status, created_at, updated_at)
      VALUES (?, ?, 'EVALUATION', 'SUBMISSION', 'Other Review', 'other-review', 'OPEN', ?, ?)
    `).bind(ids.otherRound, ids.otherEvent, now, now),
    env.DB.prepare(dedent`
      INSERT INTO form_version (id, form_id, mdx_source, created_at)
      VALUES (?, ?, '<Number name="rating" min={1} max={5} /><RichText name="comments" />', ?)
    `).bind(ids.version, ids.round, now),
    env.DB.prepare(dedent`
      INSERT INTO speaker (id, event_id, email, first_name, last_name, company_name, created_at, updated_at)
      VALUES (?, ?, 'priya@example.test', 'Priya', 'Raman', 'Latticework', ?, ?)
    `).bind(ids.speaker, ids.event, now, now),
    ...[ids.session, ids.unassigned].map((id, index) => env.DB.prepare(dedent`
      INSERT INTO event_session (id, event_id, kind, status, title, description, created_at, updated_at)
      VALUES (?, ?, 'CONTENT', 'PENDING', ?, 'Abstract', ?, ?)
    `).bind(id, ids.event, index === 0 ? 'Assigned talk' : 'Unassigned talk', now, now)),
    env.DB.prepare(dedent`
      INSERT INTO evaluation_reviewer (id, event_id, form_id, user_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(ids.membership, ids.event, ids.round, ids.reviewer, now),
    env.DB.prepare(dedent`
      INSERT INTO review (id, event_id, form_id, session_id, reviewer_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(ids.review, ids.event, ids.round, ids.session, ids.reviewer, now, now),
  ])
})

describe('evaluation D1 boundaries', () => {
  test('keeps existing shareable org invitations and idempotent membership inserts', async () => {
    await env.DB.prepare(dedent`
      INSERT INTO org_invitation (invitation_id, org_id, purpose, role, created_by, expires_at, created_at)
      VALUES ('org-invite', ?, 'ORG_MEMBER', 'member', ?, ?, ?)
    `).bind(ids.org, ids.organizer, now + 1000, now).run()
    await env.DB.prepare("INSERT OR IGNORE INTO org_member (member_id, org_id, user_id, role, created_at) VALUES ('member-1', ?, ?, 'member', ?)").bind(ids.org, ids.other, now).run()
    await env.DB.prepare("INSERT OR IGNORE INTO org_member (member_id, org_id, user_id, role, created_at) VALUES ('member-2', ?, ?, 'member', ?)").bind(ids.org, ids.other, now).run()
    const rows = await env.DB.prepare('SELECT purpose, invited_email, form_id FROM org_invitation WHERE invitation_id = ?').bind('org-invite').all()
    const members = await env.DB.prepare('SELECT count(*) AS count FROM org_member WHERE org_id = ? AND user_id = ?').bind(ids.org, ids.other).first<{ count: number }>()
    expect({ invitation: rows.results, memberCount: members?.count }).toMatchInlineSnapshot(`
      {
        "invitation": [
          {
            "form_id": null,
            "invited_email": null,
            "purpose": "ORG_MEMBER",
          },
        ],
        "memberCount": 1,
      }
    `)
  })

  test('rejects reviewer pools and assignments that cross events', async () => {
    await expect(env.DB.prepare(dedent`
      INSERT INTO evaluation_reviewer (id, event_id, form_id, user_id, created_at)
      VALUES ('cross-pool', ?, ?, ?, ?)
    `).bind(ids.otherEvent, ids.round, ids.other, now).run()).rejects.toThrow(/FOREIGN KEY/)
    await expect(env.DB.prepare(dedent`
      INSERT INTO review (id, event_id, form_id, session_id, reviewer_id, created_at, updated_at)
      VALUES ('cross-review', ?, ?, ?, ?, ?, ?)
    `).bind(ids.otherEvent, ids.round, ids.session, ids.other, now, now).run()).rejects.toThrow(/FOREIGN KEY/)
  })

  test('scoped assignment lookup denies an unassigned direct id', async () => {
    const assigned = await env.DB.prepare('SELECT id FROM review WHERE form_id = ? AND reviewer_id = ? AND session_id = ?').bind(ids.round, ids.reviewer, ids.session).first()
    const denied = await env.DB.prepare('SELECT id FROM review WHERE form_id = ? AND reviewer_id = ? AND session_id = ?').bind(ids.round, ids.reviewer, ids.unassigned).first()
    expect({ assigned: Boolean(assigned), unassigned: denied }).toEqual({ assigned: true, unassigned: null })
  })

  test('stores draft and submitted scorecard values through the response owner path', async () => {
    await env.DB.batch([
      env.DB.prepare(dedent`
        INSERT INTO form_response (id, event_id, form_id, form_version_id, review_id, session_id, status, created_at, updated_at)
        VALUES ('eval-response', ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
      `).bind(ids.event, ids.round, ids.version, ids.review, ids.session, now, now),
      env.DB.prepare("INSERT INTO form_field_value (id, response_id, name, value) VALUES ('eval-rating', 'eval-response', 'rating', '4')"),
      env.DB.prepare("INSERT INTO form_field_value (id, response_id, name, value) VALUES ('eval-comment', 'eval-response', 'comments', 'Strong practical content')"),
    ])
    await env.DB.prepare("UPDATE form_response SET status = 'SUBMITTED', submitted_at = ? WHERE id = 'eval-response'").bind(now + 1).run()
    const response = await env.DB.prepare(dedent`
      SELECT response.status, value.name, value.value
      FROM form_response response JOIN form_field_value value ON value.response_id = response.id
      WHERE response.id = 'eval-response' ORDER BY value.name
    `).all()
    expect(response.results).toMatchInlineSnapshot(`
      [
        {
          "name": "comments",
          "status": "SUBMITTED",
          "value": "Strong practical content",
        },
        {
          "name": "rating",
          "status": "SUBMITTED",
          "value": "4",
        },
      ]
    `)
  })

  test('enforces exactly one response owner and deduplicates reviewer email history', async () => {
    await expect(env.DB.prepare(dedent`
      INSERT INTO form_response (id, event_id, form_id, form_version_id, speaker_id, review_id, session_id, status, created_at, updated_at)
      VALUES ('bad-owner', ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
    `).bind(ids.event, ids.round, ids.version, ids.speaker, ids.review, ids.session, now, now).run()).rejects.toThrow(/CHECK/)
    const message = env.DB.prepare(dedent`
      INSERT OR IGNORE INTO email_message (id, event_id, kind, dedupe_key, to_email, subject, body_html, status, created_at)
      VALUES (?, ?, 'REVIEW_REMINDER', 'reminder:review:round:user:2026-08-09', 'sam@example.test', 'Reminder', '<p>Review</p>', 'QUEUED', ?)
    `)
    await message.bind('review-mail-1', ids.event, now).run()
    await message.bind('review-mail-2', ids.event, now).run()
    const count = await env.DB.prepare("SELECT count(*) AS count FROM email_message WHERE kind = 'REVIEW_REMINDER'").first<{ count: number }>()
    expect(count?.count).toBe(1)
  })

  test('stores recusal reason while response state remains derived', async () => {
    await env.DB.prepare(dedent`
      INSERT INTO review (id, event_id, form_id, session_id, reviewer_id, recused_at, recusal_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'Conflict with author', ?, ?)
    `).bind(ids.recusedReview, ids.event, ids.round, ids.unassigned, ids.reviewer, now, now, now).run()
    const row = await env.DB.prepare('SELECT recused_at, recusal_reason FROM review WHERE id = ?').bind(ids.recusedReview).first()
    expect(row).toEqual({ recused_at: now, recusal_reason: 'Conflict with author' })
  })
})
