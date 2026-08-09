// Workerd integration tests for Phase 4 using real Miniflare D1 and R2 bindings.
import { env } from 'cloudflare:workers'
import { unzipSync } from 'fflate'
import dedent from 'string-dedent'
import { beforeAll, describe, expect, test } from 'vitest'
import { loadFilesWorkspace, loadZipFiles, streamZip } from '../src/app.tsx'
import { isPublicContentEligible, latestTaskFileVersions } from '../src/lib/content-management.ts'
import { getDb } from '../src/db.ts'
import { assertTaskSlotFiles } from '../src/lib/portal-server.ts'

const now = Date.UTC(2026, 7, 9)
const ids = {
  organizer: 'content-organizer', speakerUser: 'content-speaker-user', otherUser: 'content-other-user',
  org: 'content-org', event: 'content-event', otherEvent: 'content-other-event',
  speaker: 'content-speaker', session: 'content-session', form: 'content-form', version: 'content-version',
  task: 'content-task', assignment: 'content-assignment', file1: 'content-file-1', file2: 'content-file-2',
}

beforeAll(async () => {
  await env.DB.batch([
    ...[
      [ids.organizer, 'Jordan Alvarez', 'jordan-content@example.test'],
      [ids.speakerUser, 'Priya Raman', 'priya-content@example.test'],
      [ids.otherUser, 'Outside User', 'outside-content@example.test'],
    ].map(([id, name, email]) => env.DB.prepare(dedent`
      INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).bind(id, name, email, now, now)),
    env.DB.prepare(dedent`
      INSERT INTO org (org_id, owner_user_id, kind, name, created_at, updated_at)
      VALUES (?, ?, 'team', 'Content Org', ?, ?)
    `).bind(ids.org, ids.organizer, now, now),
    env.DB.prepare(dedent`
      INSERT INTO org_member (member_id, org_id, user_id, role, created_at)
      VALUES ('content-member', ?, ?, 'admin', ?)
    `).bind(ids.org, ids.organizer, now),
    ...[[ids.event, 'content-event'], [ids.otherEvent, 'content-other-event']].map(([id, slug]) => env.DB.prepare(dedent`
      INSERT INTO event (id, org_id, name, slug, status, timezone, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, 'Content Event', ?, 'ACTIVE', 'UTC', ?, ?, ?, ?)
    `).bind(id, ids.org, slug, now, now + 86_400_000, now, now)),
    env.DB.prepare(dedent`
      INSERT INTO speaker (id, event_id, user_id, email, first_name, last_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'priya-content@example.test', 'Priya', 'Raman', 'CONFIRMED', ?, ?)
    `).bind(ids.speaker, ids.event, ids.speakerUser, now, now),
    env.DB.prepare(dedent`
      INSERT INTO event_session (id, event_id, kind, status, title, description, visibility, created_at, updated_at)
      VALUES (?, ?, 'CONTENT', 'ACCEPTED', 'Taming CI', 'Original abstract', 'PRIVATE', ?, ?)
    `).bind(ids.session, ids.event, now, now),
    env.DB.prepare(dedent`
      INSERT INTO session_participant (id, event_id, session_id, speaker_id, created_at)
      VALUES ('content-participant', ?, ?, ?, ?)
    `).bind(ids.event, ids.session, ids.speaker, now),
    env.DB.prepare(dedent`
      INSERT INTO form (id, event_id, purpose, target, name, slug, status, created_at, updated_at)
      VALUES (?, ?, 'PORTAL', 'SUBMISSION', 'Materials', 'materials-content', 'OPEN', ?, ?)
    `).bind(ids.form, ids.event, now, now),
    env.DB.prepare(dedent`
      INSERT INTO form_version (id, form_id, mdx_source, created_at)
      VALUES (?, ?, '<FileUpload name="slides" />', ?)
    `).bind(ids.version, ids.form, now),
    env.DB.prepare(dedent`
      INSERT INTO task_definition (id, event_id, title, target, source, assignment_policy, form_id, created_at)
      VALUES (?, ?, 'Upload Session Presentation', 'SUBMISSION', 'FORM', 'SELECTED', ?, ?)
    `).bind(ids.task, ids.event, ids.form, now),
    env.DB.prepare(dedent`
      INSERT INTO task_assignment (id, event_id, task_definition_id, speaker_id, session_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'IN_PROGRESS', ?, ?)
    `).bind(ids.assignment, ids.event, ids.task, ids.speaker, ids.session, now, now),
  ])
  await env.FILES.put('content/v1', 'version one')
  await env.FILES.put('content/v2', 'version two')
  await env.DB.batch([
    env.DB.prepare(dedent`
      INSERT INTO file (id, event_id, kind, file_name, mime_type, size_bytes, storage_key, uploaded_by_speaker_id, task_assignment_id, field_name, created_at)
      VALUES (?, ?, 'SLIDES', 'slides.pdf', 'application/pdf', 11, 'content/v1', ?, ?, 'slides', ?)
    `).bind(ids.file1, ids.event, ids.speaker, ids.assignment, now),
    env.DB.prepare(dedent`
      INSERT INTO file (id, event_id, kind, file_name, mime_type, size_bytes, storage_key, uploaded_by_speaker_id, task_assignment_id, field_name, created_at)
      VALUES (?, ?, 'SLIDES', 'slides.pdf', 'application/pdf', 11, 'content/v2', ?, ?, 'slides', ?)
    `).bind(ids.file2, ids.event, ids.speaker, ids.assignment, now + 1),
    env.DB.prepare(dedent`
      INSERT INTO task_comment (id, task_assignment_id, field_name, author_user_id, body, created_at)
      VALUES ('content-comment-speaker', ?, 'slides', ?, 'Draft deck - final version coming Friday.', ?)
    `).bind(ids.assignment, ids.speakerUser, now),
    env.DB.prepare(dedent`
      INSERT INTO task_comment (id, task_assignment_id, field_name, author_user_id, body, created_at)
      VALUES ('content-comment-organizer', ?, 'slides', ?, 'Thanks - please confirm the final version by Tuesday.', ?)
    `).bind(ids.assignment, ids.organizer, now + 1),
  ])
})

describe('immutable file slots and role-safe threads', () => {
  test('keeps both R2 versions downloadable and identifies the latest', async () => {
    const rows = await env.DB.prepare(dedent`
      SELECT id, task_assignment_id AS taskAssignmentId, field_name AS fieldName,
        file_name AS fileName, created_at AS createdAt
      FROM file WHERE event_id = ? ORDER BY created_at
    `).bind(ids.event).all()
    expect(latestTaskFileVersions(rows.results as any)[0]?.currentFileId).toBe(ids.file2)
    expect(await (await env.FILES.get('content/v1'))?.text()).toBe('version one')
    expect(await (await env.FILES.get('content/v2'))?.text()).toBe('version two')
  })

  test('returns the same thread to the owning speaker and organizer but not an outsider', async () => {
    const readThread = async (userId: string) => env.DB.prepare(dedent`
      SELECT comment.body, author.name AS authorName
      FROM task_comment comment
      JOIN task_assignment assignment ON assignment.id = comment.task_assignment_id
      JOIN speaker ON speaker.id = assignment.speaker_id
      JOIN event ON event.id = assignment.event_id
      JOIN user author ON author.id = comment.author_user_id
      LEFT JOIN org_member member ON member.org_id = event.org_id AND member.user_id = ?
      WHERE comment.task_assignment_id = ? AND comment.field_name = 'slides'
        AND (speaker.user_id = ? OR member.user_id IS NOT NULL)
      ORDER BY comment.created_at
    `).bind(userId, ids.assignment, userId).all()
    expect((await readThread(ids.speakerUser)).results).toHaveLength(2)
    expect((await readThread(ids.organizer)).results).toHaveLength(2)
    expect((await readThread(ids.otherUser)).results).toEqual([])
  })

  test('rejects a file slot that crosses event boundaries', async () => {
    await expect(env.DB.prepare(dedent`
      INSERT INTO file (id, event_id, kind, file_name, mime_type, size_bytes, storage_key, task_assignment_id, field_name, created_at)
      VALUES ('content-cross-file', ?, 'SLIDES', 'cross.pdf', 'application/pdf', 1, 'content/cross', ?, 'slides', ?)
    `).bind(ids.otherEvent, ids.assignment, now).run()).rejects.toThrow(/task assignment event mismatch/)
  })

  test('accepts only the version uploaded through the submitted assignment and field', async () => {
    const db = getDb()
    await expect(assertTaskSlotFiles({
      db,
      eventId: ids.event,
      assignmentId: ids.assignment,
      fieldRows: [{ name: 'slides', fileId: ids.file2 }],
    })).resolves.toBeUndefined()
    await expect(assertTaskSlotFiles({
      db,
      eventId: ids.event,
      assignmentId: ids.assignment,
      fieldRows: [{ name: 'speaker.headshot', fileId: ids.file2 }],
    })).rejects.toThrow(/Upload speaker.headshot through this task/)
  })

  test('loads tenant-safe Files rows and streams only current selected versions into ZIP', async () => {
    const db = getDb()
    const workspace = await loadFilesWorkspace(db, ids.event)
    expect(workspace.fileSlots).toMatchObject([{
      slotKey: `${ids.assignment}:slides`,
      versions: [
        { id: ids.file2, current: true },
        { id: ids.file1, current: false },
      ],
      comments: [
        { authorName: 'Priya Raman' },
        { authorName: 'Jordan Alvarez' },
      ],
    }])
    expect((await loadFilesWorkspace(db, ids.otherEvent)).fileSlots).toEqual([])

    const selected = new Set([`${ids.assignment}:slides`])
    const files = await loadZipFiles({ db, eventId: ids.event, selectedSlots: selected })
    expect(files).toHaveLength(1)
    expect((await loadZipFiles({ db, eventId: ids.otherEvent, selectedSlots: selected }))).toEqual([])

    const archive = streamZip(files)
    const [bytes] = await Promise.all([
      new Response(archive.readable).arrayBuffer(),
      archive.done,
    ])
    const entries = unzipSync(new Uint8Array(bytes))
    expect(Object.fromEntries(
      Object.entries(entries).map(([path, value]) => [path, new TextDecoder().decode(value)]),
    )).toEqual({
      'Taming CI/Priya Raman/slides/slides.pdf': 'version two',
    })
  })
})

describe('session revisions and approval', () => {
  test('restores a typed snapshot and records the restore source', async () => {
    await env.DB.prepare(dedent`
      INSERT INTO session_revision (id, event_id, session_id, title, description, editor_user_id, created_at)
      VALUES ('content-revision-1', ?, ?, 'UPDATED: Taming CI', 'First edit', ?, ?)
    `).bind(ids.event, ids.session, ids.organizer, now + 2).run()
    await env.DB.prepare("UPDATE event_session SET title = 'Second edit', description = 'Second edit' WHERE id = ?").bind(ids.session).run()
    const revision = await env.DB.prepare("SELECT * FROM session_revision WHERE id = 'content-revision-1'").first<any>()
    await env.DB.batch([
      env.DB.prepare('UPDATE event_session SET title = ?, description = ?, updated_at = ? WHERE id = ? AND event_id = ?')
        .bind(revision.title, revision.description, now + 3, ids.session, ids.event),
      env.DB.prepare(dedent`
        INSERT INTO session_revision (id, event_id, session_id, title, description, editor_user_id, restored_from_revision_id, created_at)
        VALUES ('content-revision-restored', ?, ?, ?, ?, ?, ?, ?)
      `).bind(ids.event, ids.session, revision.title, revision.description, ids.organizer, revision.id, now + 3),
    ])
    expect(await env.DB.prepare('SELECT title, description FROM event_session WHERE id = ?').bind(ids.session).first())
      .toEqual({ title: 'UPDATED: Taming CI', description: 'First edit' })
    expect(await env.DB.prepare(dedent`
      SELECT restored_from_revision_id AS restoredFromRevisionId
      FROM session_revision WHERE id = 'content-revision-restored'
    `).first()).toEqual({ restoredFromRevisionId: 'content-revision-1' })
  })

  test('visibility is the public approval gate', async () => {
    const before = await env.DB.prepare('SELECT status, visibility FROM event_session WHERE id = ?').bind(ids.session).first<any>()
    await env.DB.prepare("UPDATE event_session SET visibility = 'PUBLIC' WHERE id = ?").bind(ids.session).run()
    const after = await env.DB.prepare('SELECT status, visibility FROM event_session WHERE id = ?').bind(ids.session).first<any>()
    expect([isPublicContentEligible(before), isPublicContentEligible(after)]).toEqual([false, true])
  })
})
