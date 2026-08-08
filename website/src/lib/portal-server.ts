// Server-side speaker portal workflows: load owned data, edit PENDING
// submissions, withdraw, profile form, and task completion. Every entry
// point receives an authenticated session and enforces speaker ownership.

import * as orm from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import * as schema from 'db/schema'
import { ulid } from 'ulid'
import { getDb, lookupOrgMember, type Session } from '../db.ts'
import { collectFields, libraryOptions, type FormSubmission } from '../forms/collect-fields.ts'
import { extractWellKnown } from '../forms/well-known-names.ts'
import { validateSubmission } from '../forms/validate.ts'
import {
  flattenSubmissionValues,
  getFileFieldNames,
  restoreSubmissionValues,
} from './cfp-submission.ts'
import { cfpSubmissionSchema, resolveParticipantSpeakers } from './cfp-server.ts'
import {
  assignmentOwnedBySpeaker,
  canCompleteManualAssignment,
  canEditSession,
  canSubmitFormAssignment,
  canViewSession,
  canWithdrawSession,
  type PortalAssignmentRow,
  type PortalSessionRow,
} from './portal.ts'
import { linkSpeakerIdentity } from './speaker-link.ts'
import { applyTransition, type SessionStatus } from './submissions.ts'

export type PortalEventContext = {
  event: typeof schema.event.$inferSelect
  /** Null when this user has no speaker row yet (must submit CFP or be
   *  invited as co-speaker first — portal does not invent speakers). */
  speaker: typeof schema.speaker.$inferSelect | null
  adminOrgPath: string | null
  userEmail: string
  userName: string
}

export async function loadPortalContext(
  eventSlug: string,
  session: Session,
): Promise<PortalEventContext | null> {
  const db = getDb()
  const event = await db.query.event.findFirst({ where: { slug: eventSlug } })
  if (!event) return null
  // Claim existing speaker by verified email only — never create on portal
  // visit (that would let any signed-in user attach to any event + upload).
  const speaker = await linkSpeakerIdentity({
    eventId: event.id,
    session,
  })
  const member = await lookupOrgMember(session.userId, event.orgId)
  return {
    event,
    speaker,
    adminOrgPath: member ? `/org/${event.orgId}/e/${event.id}` : null,
    userEmail: session.user.email,
    userName: session.user.name,
  }
}

function toPortalSessionRow(session: {
  id: string
  status: SessionStatus
  submitterSpeakerId: string | null
  participants: Array<{ speakerId: string }>
}): PortalSessionRow {
  return {
    id: session.id,
    status: session.status,
    submitterSpeakerId: session.submitterSpeakerId,
    participantSpeakerIds: session.participants.map((row) => row.speakerId),
  }
}

export async function listPortalSessions(eventId: string, speakerId: string) {
  const db = getDb()
  const withSession = {
    participants: {
      orderBy: { sortOrder: 'asc' as const },
      with: { speaker: true },
    },
    track: true,
    format: true,
  }
  const [asSubmitter, participations] = await db.batch([
    db.query.eventSession.findMany({
      where: { eventId, kind: 'CONTENT', submitterSpeakerId: speakerId },
      with: withSession,
      orderBy: { createdAt: 'desc' },
    }),
    db.query.sessionParticipant.findMany({
      where: { eventId, speakerId },
      with: {
        session: { with: withSession },
      },
    }),
  ] as const)
  const byId = new Map<string, (typeof asSubmitter)[number]>()
  for (const row of asSubmitter) byId.set(row.id, row)
  for (const row of participations) {
    const session = row.session
    if (!session || session.kind !== 'CONTENT' || session.eventId !== eventId) continue
    byId.set(session.id, session)
  }
  return [...byId.values()]
    .filter((row) => canViewSession(speakerId, toPortalSessionRow(row)))
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function getPortalSession(eventId: string, speakerId: string, sessionId: string) {
  const db = getDb()
  const row = await db.query.eventSession.findFirst({
    where: { id: sessionId, eventId, kind: 'CONTENT' },
    with: {
      participants: {
        orderBy: { sortOrder: 'asc' },
        with: { speaker: true },
      },
      track: true,
      format: true,
      formResponses: {
        with: { formVersion: true, form: true, fieldValues: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  })
  if (!row) return null
  const portalRow = toPortalSessionRow(row)
  if (!canViewSession(speakerId, portalRow)) return null
  return {
    session: row,
    portalRow,
    canEdit: canEditSession(speakerId, portalRow),
    canWithdraw: canWithdrawSession(speakerId, portalRow),
  }
}

export async function listPortalAssignments(eventId: string, speakerId: string) {
  const db = getDb()
  const rows = await db.query.taskAssignment.findMany({
    where: { eventId, speakerId },
    with: {
      taskDefinition: true,
      session: true,
    },
    orderBy: { createdAt: 'asc' },
  })
  return rows.flatMap((row) => {
    const def = row.taskDefinition
    if (!def) return []
    return [{
      ...row,
      taskDefinition: def,
      portal: {
        id: row.id,
        speakerId: row.speakerId,
        sessionId: row.sessionId,
        status: row.status,
        target: def.target,
        source: def.source,
        formId: def.formId,
      } satisfies PortalAssignmentRow,
    }]
  })
}

export async function getPortalAssignment(eventId: string, speakerId: string, assignmentId: string) {
  const db = getDb()
  const row = await db.query.taskAssignment.findFirst({
    where: { id: assignmentId, eventId, speakerId },
    with: {
      taskDefinition: {
        with: {
          form: true,
        },
      },
      session: true,
    },
  })
  if (!row || !assignmentOwnedBySpeaker(row, speakerId) || !row.taskDefinition) return null
  const taskDefinition = row.taskDefinition
  let formVersion: typeof schema.formVersion.$inferSelect | null = null
  if (taskDefinition.formId) {
    formVersion = await db.query.formVersion.findFirst({
      where: { formId: taskDefinition.formId },
      orderBy: { createdAt: 'desc', id: 'desc' },
    }) ?? null
  }
  return {
    assignment: { ...row, taskDefinition },
    portal: {
      id: row.id,
      speakerId: row.speakerId,
      sessionId: row.sessionId,
      status: row.status,
      target: taskDefinition.target,
      source: taskDefinition.source,
      formId: taskDefinition.formId,
    } satisfies PortalAssignmentRow,
    formVersion,
  }
}

export async function getPortalProfileForm(eventId: string) {
  const db = getDb()
  const bySlug = await db.query.form.findFirst({
    where: { eventId, purpose: 'PORTAL', target: 'SPEAKER', slug: 'speaker-profile' },
  })
  if (bySlug) return bySlug
  return db.query.form.findFirst({
    where: { eventId, purpose: 'PORTAL', target: 'SPEAKER', status: 'OPEN' },
    orderBy: { createdAt: 'asc' },
  })
}

async function assertOwnedFiles({ eventId, ownerSpeakerId, fileIds }: {
  eventId: string
  ownerSpeakerId: string
  fileIds: string[]
}) {
  const unique = [...new Set(fileIds)]
  if (unique.length === 0) return
  const db = getDb()
  const rows = await db.query.file.findMany({ where: { id: { in: unique }, eventId } })
  if (rows.length !== unique.length || rows.some((file) => file.uploadedBySpeakerId !== ownerSpeakerId)) {
    throw new Error('A submitted file is missing or does not belong to this speaker')
  }
}

export async function withdrawPortalSubmission({
  eventId,
  sessionId,
  session,
}: {
  eventId: string
  sessionId: string
  session: Session
}) {
  const ctx = await loadPortalContextByEventId(eventId, session)
  const loaded = await getPortalSession(eventId, ctx.speaker.id, sessionId)
  if (!loaded?.canWithdraw) throw new Error('You cannot withdraw this submission')
  const now = Date.now()
  const patch = applyTransition(
    {
      status: loaded.session.status,
      title: loaded.session.title,
      submittedAt: loaded.session.submittedAt,
      decidedAt: loaded.session.decidedAt,
      withdrawnAt: loaded.session.withdrawnAt,
    },
    'WITHDRAWN',
    now,
  )
  const db = getDb()
  const updateSession = db
    .update(schema.eventSession)
    .set(patch)
    .where(orm.eq(schema.eventSession.id, sessionId))
    .limit(1)
  const draftResponse = loaded.session.formResponses.find((response) => response.status === 'DRAFT')
  if (draftResponse) {
    await db.batch([
      db.delete(schema.formResponse)
        .where(orm.eq(schema.formResponse.id, draftResponse.id))
        .limit(1),
      updateSession,
    ] as const)
  } else {
    await updateSession
  }
  return { sessionId, status: 'WITHDRAWN' as const }
}

export async function savePortalSubmission({
  eventId,
  sessionId,
  submission: raw,
  session,
  submit,
}: {
  eventId: string
  sessionId: string
  submission: FormSubmission
  session: Session
  submit: boolean
}) {
  const submission = cfpSubmissionSchema.parse(raw)
  const ctx = await loadPortalContextByEventId(eventId, session)
  const loaded = await getPortalSession(eventId, ctx.speaker.id, sessionId)
  if (!loaded?.canEdit) throw new Error('You cannot edit this submission')

  const cfpResponse = loaded.session.formResponses.find((row) => row.form?.purpose === 'CFP')
    ?? loaded.session.formResponses[0]
  if (!cfpResponse?.formVersion) throw new Error('No editable form response for this submission')

  const db = getDb()
  const [tracks, formats] = await db.batch([
    db.query.track.findMany({ where: { eventId }, orderBy: { sortOrder: 'asc', name: 'asc' } }),
    db.query.format.findMany({ where: { eventId }, orderBy: { sortOrder: 'asc', name: 'asc' } }),
  ] as const)

  const collected = collectFields({
    mdxSource: cfpResponse.formVersion.mdxSource,
    scope: {
      values: submission.values,
      tracks: libraryOptions(tracks),
      formats: libraryOptions(formats),
    },
  })
  if (submit) {
    const validation = validateSubmission({ collected, ...submission })
    if (!validation.ok) throw new Error(validation.errors.map((error) => error.message).join('\n'))
  } else if (collected.errors.length > 0) {
    throw new Error(collected.errors.map((error) => error.message).join('\n'))
  }

  const participantSpeakerIds = await resolveParticipantSpeakers({
    eventId,
    session,
    primarySpeakerId: ctx.speaker.id,
    submission,
  })

  const fileFieldNames = getFileFieldNames(collected)
  const fieldRows = flattenSubmissionValues({
    responseId: cfpResponse.id,
    submission,
    participantSpeakerIds,
    fileFieldNames,
  })
  await assertOwnedFiles({
    eventId,
    ownerSpeakerId: ctx.speaker.id,
    fileIds: fieldRows.flatMap((row) => (row.fileId ? [row.fileId] : [])),
  })
  const projected = extractWellKnown(submission)
  const now = Date.now()
  const queries: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    db.delete(schema.formFieldValue).where(orm.eq(schema.formFieldValue.responseId, cfpResponse.id)),
    db.delete(schema.sessionParticipant).where(orm.eq(schema.sessionParticipant.sessionId, sessionId)),
    db.update(schema.eventSession)
      .set({
        title: projected.session.title || loaded.session.title,
        description: projected.session.description || null,
        coverImageFileId: projected.session.coverImageFileId || null,
        trackId: projected.session.trackId || null,
        formatId: projected.session.formatId || null,
        updatedAt: now,
      })
      .where(orm.eq(schema.eventSession.id, sessionId))
      .limit(1),
    ...participantSpeakerIds.map((speakerId, sortOrder) =>
      db.insert(schema.sessionParticipant).values({
        eventId,
        sessionId,
        speakerId,
        sortOrder,
      }),
    ),
    ...fieldRows.map((row) => db.insert(schema.formFieldValue).values(row)),
  ]
  await db.batch(queries)
  return { sessionId, status: loaded.session.status }
}

export async function savePortalProfile({
  eventId,
  formId,
  submission: raw,
  session,
}: {
  eventId: string
  formId: string
  submission: FormSubmission
  session: Session
}) {
  const submission = cfpSubmissionSchema.parse(raw)
  const ctx = await loadPortalContextByEventId(eventId, session)
  const db = getDb()
  const form = await db.query.form.findFirst({
    where: { id: formId, eventId, purpose: 'PORTAL', target: 'SPEAKER', status: 'OPEN' },
  })
  if (!form) throw new Error('Profile form not found')
  const version = await db.query.formVersion.findFirst({
    where: { formId: form.id },
    orderBy: { createdAt: 'desc', id: 'desc' },
  })
  if (!version) throw new Error('Profile form has no version')

  const collected = collectFields({
    mdxSource: version.mdxSource,
    scope: { values: submission.values },
  })
  const validation = validateSubmission({ collected, ...submission })
  if (!validation.ok) throw new Error(validation.errors.map((error) => error.message).join('\n'))

  const projected = extractWellKnown(submission)
  const profile = projected.speakers[0] ?? {}
  const fileFieldNames = getFileFieldNames(collected)
  const responseId = ulid()
  const fieldRows = flattenSubmissionValues({
    responseId,
    submission: {
      values: submission.values,
      participants: submission.participants.length > 0 ? submission.participants : [],
    },
    participantSpeakerIds: submission.participants.map(() => ctx.speaker.id),
    fileFieldNames,
  }).map((row) =>
    row.name.startsWith('speaker.')
      ? { ...row, subjectSpeakerId: ctx.speaker.id }
      : row,
  )
  // Top-level speaker.* values need subjectSpeakerId even without participants.
  for (const row of fieldRows) {
    if (row.name.startsWith('speaker.') && !row.subjectSpeakerId) {
      row.subjectSpeakerId = ctx.speaker.id
    }
  }
  await assertOwnedFiles({
    eventId,
    ownerSpeakerId: ctx.speaker.id,
    fileIds: fieldRows.flatMap((row) => (row.fileId ? [row.fileId] : [])),
  })

  const now = Date.now()
  const openAssignments = await db.query.taskAssignment.findMany({
    where: {
      eventId,
      speakerId: ctx.speaker.id,
      status: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
    },
    with: { taskDefinition: true },
  })
  const openProfileTask = openAssignments.find(
    (row) =>
      row.sessionId == null
      && row.taskDefinition?.target === 'SPEAKER'
      && row.taskDefinition?.formId === form.id,
  )

  const queries: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    db.insert(schema.formResponse).values({
      id: responseId,
      formId: form.id,
      formVersionId: version.id,
      speakerId: ctx.speaker.id,
      sessionId: null,
      taskAssignmentId: openProfileTask?.id ?? null,
      status: 'SUBMITTED',
      submittedAt: now,
    }),
    db.update(schema.speaker)
      .set({
        firstName: profile.firstName || ctx.speaker.firstName,
        lastName: profile.lastName || ctx.speaker.lastName,
        bio: profile.bio ?? ctx.speaker.bio,
        jobTitle: profile.jobTitle ?? ctx.speaker.jobTitle,
        companyName: profile.companyName ?? ctx.speaker.companyName,
        pronouns: profile.pronouns ?? ctx.speaker.pronouns,
        websiteUrl: profile.websiteUrl ?? ctx.speaker.websiteUrl,
        linkedinUrl: profile.linkedinUrl ?? ctx.speaker.linkedinUrl,
        twitterUrl: profile.twitterUrl ?? ctx.speaker.twitterUrl,
        headshotFileId: profile.headshotFileId || ctx.speaker.headshotFileId,
        updatedAt: now,
      })
      .where(orm.eq(schema.speaker.id, ctx.speaker.id))
      .limit(1),
    ...fieldRows.map((row) => db.insert(schema.formFieldValue).values(row)),
  ]
  if (openProfileTask) {
    queries.push(
      db.update(schema.taskAssignment)
        .set({ status: 'COMPLETED', completedAt: now, updatedAt: now })
        .where(orm.eq(schema.taskAssignment.id, openProfileTask.id))
        .limit(1),
    )
  }
  await db.batch(queries)
  return { responseId, speakerId: ctx.speaker.id }
}

export async function completeManualTaskAssignment({
  eventId,
  assignmentId,
  session,
}: {
  eventId: string
  assignmentId: string
  session: Session
}) {
  const ctx = await loadPortalContextByEventId(eventId, session)
  const loaded = await getPortalAssignment(eventId, ctx.speaker.id, assignmentId)
  if (!loaded || !canCompleteManualAssignment(loaded.portal)) {
    throw new Error('This task cannot be completed')
  }
  const now = Date.now()
  const db = getDb()
  await db
    .update(schema.taskAssignment)
    .set({ status: 'COMPLETED', completedAt: now, updatedAt: now })
    .where(orm.eq(schema.taskAssignment.id, assignmentId))
    .limit(1)
  return { assignmentId, status: 'COMPLETED' as const }
}

export async function submitPortalFormTask({
  eventId,
  assignmentId,
  submission: raw,
  session,
}: {
  eventId: string
  assignmentId: string
  submission: FormSubmission
  session: Session
}) {
  const submission = cfpSubmissionSchema.parse(raw)
  const ctx = await loadPortalContextByEventId(eventId, session)
  const loaded = await getPortalAssignment(eventId, ctx.speaker.id, assignmentId)
  if (!loaded) throw new Error('This form task cannot be submitted')
  const taskDefinition = loaded.assignment.taskDefinition
  if (!canSubmitFormAssignment(loaded.portal) || !loaded.formVersion || !taskDefinition?.form) {
    throw new Error('This form task cannot be submitted')
  }
  const form = taskDefinition.form
  if (form.status !== 'OPEN' || form.purpose !== 'PORTAL') {
    throw new Error('This portal form is not open')
  }
  if (form.target === 'SUBMISSION' && !loaded.assignment.sessionId) {
    throw new Error('This task is missing its session')
  }

  const db = getDb()
  const [tracks, formats] = await db.batch([
    db.query.track.findMany({ where: { eventId }, orderBy: { sortOrder: 'asc', name: 'asc' } }),
    db.query.format.findMany({ where: { eventId }, orderBy: { sortOrder: 'asc', name: 'asc' } }),
  ] as const)
  const collected = collectFields({
    mdxSource: loaded.formVersion.mdxSource,
    scope: {
      values: submission.values,
      tracks: libraryOptions(tracks),
      formats: libraryOptions(formats),
    },
  })
  const validation = validateSubmission({ collected, ...submission })
  if (!validation.ok) throw new Error(validation.errors.map((error) => error.message).join('\n'))

  const responseId = ulid()
  const participantSpeakerIds =
    submission.participants.length > 0 ? submission.participants.map(() => ctx.speaker.id) : []
  const fileFieldNames = getFileFieldNames(collected)
  const fieldRows = flattenSubmissionValues({
    responseId,
    submission,
    participantSpeakerIds,
    fileFieldNames,
  }).map((row) =>
    row.name.startsWith('speaker.') ? { ...row, subjectSpeakerId: row.subjectSpeakerId ?? ctx.speaker.id } : row,
  )
  await assertOwnedFiles({
    eventId,
    ownerSpeakerId: ctx.speaker.id,
    fileIds: fieldRows.flatMap((row) => (row.fileId ? [row.fileId] : [])),
  })

  const now = Date.now()
  const projected = extractWellKnown(submission)
  const queries: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    db.insert(schema.formResponse).values({
      id: responseId,
      formId: form.id,
      formVersionId: loaded.formVersion.id,
      speakerId: ctx.speaker.id,
      sessionId: loaded.assignment.sessionId,
      taskAssignmentId: assignmentId,
      status: 'SUBMITTED',
      submittedAt: now,
    }),
    db.update(schema.taskAssignment)
      .set({ status: 'COMPLETED', completedAt: now, updatedAt: now })
      .where(orm.eq(schema.taskAssignment.id, assignmentId))
      .limit(1),
    ...fieldRows.map((row) => db.insert(schema.formFieldValue).values(row)),
  ]

  if (form.target === 'SPEAKER') {
    const profile = projected.speakers[0] ?? {}
    queries.push(
      db.update(schema.speaker)
        .set({
          firstName: profile.firstName || ctx.speaker.firstName,
          lastName: profile.lastName || ctx.speaker.lastName,
          bio: profile.bio ?? ctx.speaker.bio,
          jobTitle: profile.jobTitle ?? ctx.speaker.jobTitle,
          companyName: profile.companyName ?? ctx.speaker.companyName,
          pronouns: profile.pronouns ?? ctx.speaker.pronouns,
          websiteUrl: profile.websiteUrl ?? ctx.speaker.websiteUrl,
          linkedinUrl: profile.linkedinUrl ?? ctx.speaker.linkedinUrl,
          twitterUrl: profile.twitterUrl ?? ctx.speaker.twitterUrl,
          headshotFileId: profile.headshotFileId || ctx.speaker.headshotFileId,
          updatedAt: now,
        })
        .where(orm.eq(schema.speaker.id, ctx.speaker.id))
        .limit(1),
    )
  }

  await db.batch(queries)
  return { responseId, assignmentId, status: 'COMPLETED' as const }
}

async function loadPortalContextByEventId(eventId: string, session: Session) {
  const db = getDb()
  const event = await db.query.event.findFirst({ where: { id: eventId } })
  if (!event) throw new Error('Event not found')
  const speaker = await linkSpeakerIdentity({ eventId, session })
  if (!speaker) {
    throw new Error('No speaker profile for this event. Submit a CFP or accept a co-speaker invite first.')
  }
  return { event, speaker }
}

export function draftValuesFromSpeaker(speaker: typeof schema.speaker.$inferSelect): FormSubmission {
  return {
    values: {
      'speaker.firstName': speaker.firstName,
      'speaker.lastName': speaker.lastName,
      'speaker.email': speaker.email,
      ...(speaker.bio ? { 'speaker.bio': speaker.bio } : {}),
      ...(speaker.jobTitle ? { 'speaker.jobTitle': speaker.jobTitle } : {}),
      ...(speaker.companyName ? { 'speaker.companyName': speaker.companyName } : {}),
      ...(speaker.pronouns ? { 'speaker.pronouns': speaker.pronouns } : {}),
      ...(speaker.websiteUrl ? { 'speaker.websiteUrl': speaker.websiteUrl } : {}),
      ...(speaker.linkedinUrl ? { 'speaker.linkedinUrl': speaker.linkedinUrl } : {}),
      ...(speaker.twitterUrl ? { 'speaker.twitterUrl': speaker.twitterUrl } : {}),
      ...(speaker.headshotFileId ? { 'speaker.headshot': speaker.headshotFileId } : {}),
    },
    participants: [],
  }
}

export function restoreCfpEditDraft(loaded: NonNullable<Awaited<ReturnType<typeof getPortalSession>>>): {
  mdxSource: string
  values: FormSubmission['values']
  participants: FormSubmission['participants']
  formId: string
  responseId: string
} | null {
  const cfpResponse = loaded.session.formResponses.find((row) => row.form?.purpose === 'CFP')
    ?? loaded.session.formResponses[0]
  if (!cfpResponse?.formVersion) return null
  const restored = restoreSubmissionValues({
    rows: cfpResponse.fieldValues,
    participantSpeakerIds: loaded.session.participants.map((row) => row.speakerId),
  })
  if (restored.participants.length === 0) restored.participants.push({})
  return {
    mdxSource: cfpResponse.formVersion.mdxSource,
    values: restored.values,
    participants: restored.participants,
    formId: cfpResponse.formId,
    responseId: cfpResponse.id,
  }
}
