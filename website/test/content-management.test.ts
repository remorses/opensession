// Workerd integration tests for Phase 4 using real Miniflare D1 and R2 bindings.
import { env } from 'cloudflare:workers'
import * as schema from 'db/schema'
import { unzipSync } from 'fflate'
import { runAction } from 'spiceflow/testing'
import dedent from 'string-dedent'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  createTaskDefinition,
  restoreSessionRevision,
  saveSessionContent,
  setSessionVisibility,
  submitPortalFormTask,
} from '../src/actions.tsx'
import { app, loadFilesWorkspace, loadZipFiles, streamZip } from '../src/app.tsx'
import {
  isPublicContentEligible,
  latestTaskFileVersions,
  type TaskFileVersion,
} from '../src/lib/content-management.ts'
import { getDb } from '../src/db.ts'
import { assertTaskSlotFiles } from '../src/lib/portal-server.ts'

const now = Date.UTC(2026, 7, 9)
const ids = {
  organizer: 'content-organizer', speakerUser: 'content-speaker-user', otherUser: 'content-other-user',
  org: 'content-org', event: 'content-event', otherEvent: 'content-other-event',
  speaker: 'content-speaker', session: 'content-session', form: 'content-form', version: 'content-version',
  task: 'content-task', assignment: 'content-assignment', file1: 'content-file-1', file2: 'content-file-2',
}

let speakerCookie = ''
let organizerCookie = ''
let replacementSpeakerId = ''
let actionOrganizerId = ''

async function signUp(name: string, email: string) {
  const password = 'content-workflow-password'
  const response = await app.handle(new Request('http://localhost/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  }))
  expect(response.status).toBe(200)
  await env.DB.prepare('UPDATE user SET email_verified = 1 WHERE email = ?').bind(email).run()
  const signIn = await app.handle(new Request('http://localhost/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }))
  expect(signIn.status).toBe(200)
  const setCookie = signIn.headers.get('set-cookie')
  if (!setCookie) throw new Error('sign-in did not set a session cookie')
  const user = await env.DB.prepare('SELECT id FROM user WHERE email = ?').bind(email).first<{ id: string }>()
  if (!user) throw new Error('sign-up did not create a user')
  return { cookie: setCookie.split(';', 1)[0]!, userId: user.id }
}

function runWithCookie<T>(cookie: string, action: () => Promise<T>) {
  return runAction(action, {
    request: new Request('http://localhost/action', { method: 'POST', headers: { cookie } }),
  })
}

beforeAll(async () => {
  const speakerAuth = await signUp('Replacement Speaker', 'replacement-content@example.test')
  const organizerAuth = await signUp('Content Action Organizer', 'action-organizer-content@example.test')
  speakerCookie = speakerAuth.cookie
  organizerCookie = organizerAuth.cookie
  actionOrganizerId = organizerAuth.userId
  replacementSpeakerId = 'content-replacement-speaker'
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
    env.DB.prepare(dedent`
      INSERT INTO org_member (member_id, org_id, user_id, role, created_at)
      VALUES ('content-action-member', ?, ?, 'admin', ?)
    `).bind(ids.org, actionOrganizerId, now),
    env.DB.prepare(dedent`
      INSERT INTO speaker (id, event_id, user_id, email, first_name, last_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'replacement-content@example.test', 'Replacement', 'Speaker', 'CONFIRMED', ?, ?)
    `).bind(replacementSpeakerId, ids.event, speakerAuth.userId, now, now),
    env.DB.prepare(dedent`
      INSERT INTO task_assignment (id, event_id, task_definition_id, speaker_id, session_id, status, completed_at, created_at, updated_at)
      VALUES ('content-replacement-assignment', ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)
    `).bind(ids.event, ids.task, replacementSpeakerId, ids.session, now - 100, now - 200, now - 100),
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
  test('creates a direct file request and assignments through the real action', async () => {
    const result = await runWithCookie(organizerCookie, () => createTaskDefinition({
      orgId: ids.org,
      eventId: ids.event,
      title: 'Upload Final Headshot (print quality)',
      instructionsHtml: 'Use a high-resolution portrait.',
      target: 'SPEAKER',
      source: 'FORM',
      dueAt: Date.UTC(2027, 3, 14, 23, 59, 59),
      assignmentPolicy: 'SELECTED',
      speakerIds: [replacementSpeakerId],
      sessionIds: [],
      fileRequest: { accept: '.avif,.gif,.jpeg,.jpg,.png,.webp' },
    }))

    const row = await env.DB.prepare(dedent`
      SELECT task.id AS taskId, task.source, task.target, task.assignment_policy AS assignmentPolicy,
        task.form_id AS formId, form.purpose, form.status AS formStatus, form.target AS formTarget,
        version.mdx_source AS mdxSource, assignment.speaker_id AS speakerId,
        assignment.session_id AS sessionId, assignment.status, assignment.due_at AS dueAt
      FROM task_definition task
      JOIN form ON form.id = task.form_id
      JOIN form_version version ON version.form_id = form.id
      JOIN task_assignment assignment ON assignment.task_definition_id = task.id
      WHERE task.id = ?
    `).bind(result.taskDefinitionId).first<{ mdxSource: string } & Record<string, unknown>>()
    expect(row).toMatchObject({
      source: 'FORM', target: 'SPEAKER', assignmentPolicy: 'SELECTED', purpose: 'PORTAL',
      formStatus: 'OPEN', formTarget: 'SPEAKER', speakerId: replacementSpeakerId, sessionId: null,
      status: 'NOT_STARTED', dueAt: Date.UTC(2027, 3, 14, 23, 59, 59),
    })
    expect(row?.mdxSource).toContain('<FileUpload name="deliverable"')

    const body = new FormData()
    body.set('file', new File(['image'], 'headshot.png', { type: 'image/png' }))
    body.set('eventId', ids.event)
    body.set('kind', 'HEADSHOT')
    body.set('taskAssignmentId', String((await env.DB.prepare('SELECT id FROM task_assignment WHERE task_definition_id = ?').bind(result.taskDefinitionId).first<{ id: string }>())!.id))
    body.set('fieldName', 'deliverable')
    const upload = await app.handle(new Request('http://localhost/api/upload', {
      method: 'POST', headers: { cookie: speakerCookie }, body,
    }))
    expect(upload.status).toBe(200)

    const otherEventRows = await env.DB.prepare('SELECT count(*) AS count FROM task_definition WHERE event_id = ? AND title = ?')
      .bind(ids.otherEvent, 'Upload Final Headshot (print quality)').first()
    expect(otherEventRows).toEqual({ count: 0 })
  })

  test('allows a completed form task to receive and submit a replacement without reopening it', async () => {
    const upload = async (bodyText: string) => {
      const body = new FormData()
      body.set('file', new File([bodyText], 'slides.pdf', { type: 'application/pdf' }))
      body.set('eventId', ids.event)
      body.set('kind', 'SLIDES')
      body.set('taskAssignmentId', 'content-replacement-assignment')
      body.set('fieldName', 'slides')
      const response = await app.handle(new Request('http://localhost/api/upload', {
        method: 'POST',
        headers: { cookie: speakerCookie },
        body,
      }))
      expect(response.status).toBe(200)
      return response.json<{ fileId: string; versions: Array<{ id: string }> }>()
    }

    const first = await upload('replacement one')
    const second = await upload('replacement two')
    expect(second.versions.map((file) => file.id)).toEqual([second.fileId, first.fileId])

    const beforeSubmit = await env.DB.prepare(dedent`
      SELECT status, completed_at AS completedAt
      FROM task_assignment WHERE id = 'content-replacement-assignment'
    `).first()
    expect(beforeSubmit).toEqual({ status: 'COMPLETED', completedAt: now - 100 })

    await runWithCookie(speakerCookie, () => submitPortalFormTask({
      eventId: ids.event,
      assignmentId: 'content-replacement-assignment',
      submission: { values: { slides: second.fileId }, participants: [] },
    }))
    const afterSubmit = await env.DB.prepare(dedent`
      SELECT status, completed_at AS completedAt
      FROM task_assignment WHERE id = 'content-replacement-assignment'
    `).first()
    expect(afterSubmit).toEqual(beforeSubmit)

    const files = await getDb().query.file.findMany({
      where: { taskAssignmentId: 'content-replacement-assignment', fieldName: 'slides' },
      orderBy: { createdAt: 'desc', id: 'desc' },
    })
    expect(latestTaskFileVersions(files)[0]).toMatchObject({
      currentFileId: second.fileId,
      versions: [{ id: second.fileId }, { id: first.fileId }],
    })

    const selected = new Set([
      `${ids.assignment}:slides`,
      'content-replacement-assignment:slides',
    ])
    const archive = streamZip(await loadZipFiles({ db: getDb(), eventId: ids.event, selectedSlots: selected }))
    const [bytes] = await Promise.all([
      new Response(archive.readable).arrayBuffer(),
      archive.done,
    ])
    expect(Object.fromEntries(
      Object.entries(unzipSync(new Uint8Array(bytes)))
        .map(([path, value]) => [path, new TextDecoder().decode(value)]),
    )).toEqual({
      'Taming CI/Priya Raman/slides/slides.pdf': 'version two',
      'Taming CI/Replacement Speaker/slides/slides.pdf': 'replacement two',
    })
  })

  test('keeps both R2 versions downloadable and identifies the latest', async () => {
    const rows = await env.DB.prepare(dedent`
      SELECT id, task_assignment_id AS taskAssignmentId, field_name AS fieldName,
        file_name AS fileName, created_at AS createdAt
      FROM file WHERE event_id = ? AND task_assignment_id = ? ORDER BY created_at
    `).bind(ids.event, ids.assignment).all<TaskFileVersion>()
    expect(latestTaskFileVersions(rows.results)[0]?.currentFileId).toBe(ids.file2)
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

  test('rejects speaker uploads without a form-owned file slot', async () => {
    const body = new FormData()
    body.set('file', new File(['payload'], 'payload.pdf', { type: 'application/pdf' }))
    body.set('eventId', ids.event)
    body.set('kind', 'DOCUMENT')

    const response = await app.handle(new Request('http://localhost/api/upload', {
      method: 'POST',
      headers: { cookie: speakerCookie },
      body,
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_upload_slot' })
  })

  test('rejects task uploads for fields outside the assigned form', async () => {
    const body = new FormData()
    body.set('file', new File(['payload'], 'payload.pdf', { type: 'application/pdf' }))
    body.set('eventId', ids.event)
    body.set('kind', 'DOCUMENT')
    body.set('taskAssignmentId', 'content-replacement-assignment')
    body.set('fieldName', 'identity-document')

    const response = await app.handle(new Request('http://localhost/api/upload', {
      method: 'POST',
      headers: { cookie: speakerCookie },
      body,
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_upload_slot' })
  })

  test('accepts a speaker upload for a file field in the assigned form', async () => {
    const body = new FormData()
    body.set('file', new File(['payload'], 'slides.pdf', { type: 'application/pdf' }))
    body.set('eventId', ids.event)
    body.set('kind', 'SLIDES')
    body.set('taskAssignmentId', 'content-replacement-assignment')
    body.set('fieldName', 'slides')

    const response = await app.handle(new Request('http://localhost/api/upload', {
      method: 'POST',
      headers: { cookie: speakerCookie },
      body,
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ fileName: 'slides.pdf' })
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
    expect(workspace.fileSlots.find((slot) => slot.slotKey === `${ids.assignment}:slides`)).toMatchObject({
      slotKey: `${ids.assignment}:slides`,
      versions: [
        { id: ids.file2, current: true },
        { id: ids.file1, current: false },
      ],
      comments: [
        { authorName: 'Priya Raman' },
        { authorName: 'Jordan Alvarez' },
      ],
    })
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
  test('saves two attributed revisions and restores the first through organizer actions', async () => {
    const first = await runWithCookie(organizerCookie, () => saveSessionContent({
      orgId: ids.org,
      eventId: ids.event,
      sessionId: ids.session,
      title: 'UPDATED: Taming CI',
      description: 'This session now includes a live demo of remote build caching.',
      trackId: null,
      formatId: null,
      coverImageFileId: null,
    }))
    await runWithCookie(organizerCookie, () => saveSessionContent({
      orgId: ids.org,
      eventId: ids.event,
      sessionId: ids.session,
      title: 'UPDATED: Taming CI',
      description: 'This session now includes a live demo of remote build caching. Attendees should bring a laptop.',
      trackId: null,
      formatId: null,
      coverImageFileId: null,
    }))
    await runWithCookie(organizerCookie, () => restoreSessionRevision({
      orgId: ids.org,
      eventId: ids.event,
      sessionId: ids.session,
      revisionId: first.revisionId,
    }))

    expect(await env.DB.prepare('SELECT title, description FROM event_session WHERE id = ?').bind(ids.session).first())
      .toEqual({
        title: 'UPDATED: Taming CI',
        description: 'This session now includes a live demo of remote build caching.',
      })
    const revisions = await getDb().query.sessionRevision.findMany({
      where: { eventId: ids.event, sessionId: ids.session },
      orderBy: { createdAt: 'asc', id: 'asc' },
    })
    expect(revisions).toHaveLength(3)
    expect(revisions.every((revision) => revision.editorUserId === actionOrganizerId)).toBe(true)
    expect(revisions[2]?.restoredFromRevisionId).toBe(first.revisionId)
  })

  test('organizer approval exposes only the approved session on the anonymous program', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO room (id, event_id, name, sort_order) VALUES ('content-room', ?, 'Main Stage', 0)").bind(ids.event),
      env.DB.prepare(dedent`
        INSERT INTO event_session (id, event_id, kind, status, title, visibility, room_id, starts_at, ends_at, created_at, updated_at)
        VALUES ('content-private-session', ?, 'CONTENT', 'ACCEPTED', 'Unapproved session', 'PRIVATE', 'content-room', ?, ?, ?, ?)
      `).bind(ids.event, now + 3_600_000, now + 5_400_000, now, now),
      env.DB.prepare('UPDATE event SET program_published_at = ? WHERE id = ?').bind(now, ids.event),
      env.DB.prepare("UPDATE event_session SET room_id = 'content-room', starts_at = ?, ends_at = ? WHERE id = ?")
        .bind(now, now + 1_800_000, ids.session),
    ])
    const before = await env.DB.prepare('SELECT status, visibility FROM event_session WHERE id = ?').bind(ids.session).first<any>()
    await runWithCookie(organizerCookie, () => setSessionVisibility({
      orgId: ids.org,
      eventId: ids.event,
      sessionId: ids.session,
      visibility: 'PUBLIC',
    }))
    const after = await env.DB.prepare('SELECT status, visibility FROM event_session WHERE id = ?').bind(ids.session).first<any>()
    expect([isPublicContentEligible(before), isPublicContentEligible(after)]).toEqual([false, true])

    const response = await app.handle(new Request('http://localhost/public/content-event/schedule.json'))
    expect(response.status).toBe(200)
    const program = await response.json<{ sessions: Array<{ id: string }> }>()
    expect(program.sessions.map((session) => session.id)).toEqual([ids.session])
  })
})
