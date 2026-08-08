// Server-side CFP draft and submit workflow. All entry points receive an
// authenticated session from actions/loaders, then enforce event, form,
// response, speaker, participant, file, and pinned-version tenancy.
import * as orm from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import * as schema from 'db/schema'
import { ulid } from 'ulid'
import { z } from 'zod'
import { getDb, type Session } from '../db.ts'
import { collectFields, libraryOptions, type CollectResult, type FormSubmission } from '../forms/collect-fields.ts'
import { extractWellKnown } from '../forms/well-known-names.ts'
import { validateSubmission } from '../forms/validate.ts'
import {
  assertCfpResponseLimit,
  flattenSubmissionValues,
  getFileFieldNames,
  restoreSubmissionValues,
} from './cfp-submission.ts'
import { linkSpeakerIdentity, normalizeSpeakerEmail } from './speaker-link.ts'

const fieldValueSchema = z.union([
  z.string().max(100_000),
  z.array(z.string().max(100_000)).max(100),
])

export const cfpSubmissionSchema = z.object({
  values: z.record(z.string().min(1).max(200), fieldValueSchema),
  participants: z.array(z.record(z.string().min(1).max(200), fieldValueSchema)).max(10),
})

export type PublicCfpForm = {
  event: typeof schema.event.$inferSelect
  form: typeof schema.form.$inferSelect
  version: typeof schema.formVersion.$inferSelect
  tracks: Array<typeof schema.track.$inferSelect>
  formats: Array<typeof schema.format.$inferSelect>
}

export async function getPublicCfp(eventSlug: string, formSlug: string): Promise<PublicCfpForm | null> {
  const db = getDb()
  const event = await db.query.event.findFirst({
    where: { slug: eventSlug, status: 'ACTIVE' },
    with: {
      tracks: { orderBy: { sortOrder: 'asc', name: 'asc' } },
      formats: { orderBy: { sortOrder: 'asc', name: 'asc' } },
    },
  })
  if (!event) return null
  const form = await db.query.form.findFirst({
    where: { eventId: event.id, slug: formSlug, purpose: 'CFP', status: 'OPEN' },
  })
  if (!form || (form.closesAt != null && form.closesAt <= Date.now())) return null
  const version = await db.query.formVersion.findFirst({
    where: { formId: form.id },
    orderBy: { createdAt: 'desc', id: 'desc' },
  })
  if (!version) return null
  const { tracks, formats, ...eventRow } = event
  return { event: eventRow, form, version, tracks, formats }
}

function sessionProfile(session: Session) {
  const parts = session.user.name.trim().split(/\s+/).filter(Boolean)
  return { firstName: parts[0] ?? 'Speaker', lastName: parts.slice(1).join(' ') }
}

export async function getOrCreateCfpDraft(cfp: PublicCfpForm, session: Session) {
  const speaker = await linkSpeakerIdentity({
    eventId: cfp.event.id,
    session,
    profile: sessionProfile(session),
  })
  const db = getDb()
  let response = await db.query.formResponse.findFirst({
    where: { formId: cfp.form.id, speakerId: speaker.id, status: 'DRAFT' },
    with: {
      fieldValues: true,
      session: {
        with: {
          participants: {
            orderBy: { sortOrder: 'asc' },
            with: { speaker: true },
          },
        },
      },
      formVersion: true,
    },
  })

  if (!response) {
    const existing = await db.query.eventSession.findMany({
      where: { eventId: cfp.event.id, submitterSpeakerId: speaker.id, kind: 'CONTENT' },
      columns: { id: true },
    })
    assertCfpResponseLimit(existing.length)
    const sessionId = ulid()
    const responseId = ulid()
    try {
      await db.batch([
        db.insert(schema.eventSession).values({
          id: sessionId,
          eventId: cfp.event.id,
          submitterSpeakerId: speaker.id,
        }),
        db.insert(schema.formResponse).values({
          id: responseId,
          formId: cfp.form.id,
          formVersionId: cfp.version.id,
          speakerId: speaker.id,
          sessionId,
        }),
        db.insert(schema.sessionParticipant).values({
          eventId: cfp.event.id,
          sessionId,
          speakerId: speaker.id,
          sortOrder: 0,
        }),
      ] as const)
    } catch (cause) {
      const winner = await db.query.formResponse.findFirst({
        where: { formId: cfp.form.id, speakerId: speaker.id, status: 'DRAFT' },
      })
      if (!winner) throw cause
    }
    response = await db.query.formResponse.findFirst({
      where: { formId: cfp.form.id, speakerId: speaker.id, status: 'DRAFT' },
      with: {
        fieldValues: true,
        session: {
          with: {
            participants: {
              orderBy: { sortOrder: 'asc' },
              with: { speaker: true },
            },
          },
        },
        formVersion: true,
      },
    })
  }
  if (!response?.session || !response.formVersion) throw new Error('Could not create a CFP draft')
  const responseSession = response.session
  const responseVersion = response.formVersion

  const participantRows = responseSession.participants
  const restored = restoreSubmissionValues({
    rows: response.fieldValues,
    participantSpeakerIds: participantRows.map((row) => row.speakerId),
  })
  if (restored.participants.length === 0) restored.participants.push({})
  const primary = restored.participants[0]!
  primary['speaker.firstName'] ??= speaker.firstName
  primary['speaker.lastName'] ??= speaker.lastName
  primary['speaker.email'] ??= speaker.email

  return {
    responseId: response.id,
    sessionId: responseSession.id,
    pinnedMdxSource: responseVersion.mdxSource,
    values: restored.values,
    participants: restored.participants,
  }
}

async function loadOwnedDraft({ eventId, formId, responseId, session, submission }: {
  eventId: string
  formId: string
  responseId: string
  session: Session
  submission: FormSubmission
}) {
  const primary = submission.participants[0] ?? {}
  const speaker = await linkSpeakerIdentity({
    eventId,
    session,
    profile: {
      firstName: stringValue(primary['speaker.firstName']),
      lastName: stringValue(primary['speaker.lastName']),
    },
  })
  const db = getDb()
  const [event, form, response, tracks, formats] = await db.batch([
    db.query.event.findFirst({ where: { id: eventId, status: 'ACTIVE' } }),
    db.query.form.findFirst({ where: { id: formId, eventId, purpose: 'CFP', status: 'OPEN' } }),
    db.query.formResponse.findFirst({
      where: { id: responseId, formId, speakerId: speaker.id, status: 'DRAFT' },
      with: { formVersion: true, session: true },
    }),
    db.query.track.findMany({ where: { eventId }, orderBy: { sortOrder: 'asc', name: 'asc' } }),
    db.query.format.findMany({ where: { eventId }, orderBy: { sortOrder: 'asc', name: 'asc' } }),
  ] as const)
  if (!event || !form || !response?.formVersion || !response.session || response.session.eventId !== eventId) {
    throw new Error('CFP draft not found')
  }
  if (form.closesAt != null && form.closesAt <= Date.now()) throw new Error('This CFP is closed')
  return {
    db,
    event,
    form,
    response: { ...response, formVersion: response.formVersion, session: response.session },
    speaker,
    tracks,
    formats,
  }
}

function stringValue(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function collectDraftFields({ mdxSource, tracks, formats, submission }: {
  mdxSource: string
  tracks: Array<{ id: string; name: string }>
  formats: Array<{ id: string; name: string }>
  submission: FormSubmission
}): CollectResult {
  const collected = collectFields({
    mdxSource,
    scope: {
      values: submission.values,
      tracks: libraryOptions(tracks),
      formats: libraryOptions(formats),
    },
  })
  if (collected.errors.length > 0) throw new Error(collected.errors.map((error) => error.message).join('\n'))
  const names = new Set(collected.fields.map((field) => field.name))
  const participantNames = new Set(collected.participantFields.map((field) => field.name))
  const unknown = Object.keys(submission.values).find((name) => !names.has(name))
  const unknownParticipant = submission.participants.flatMap(Object.keys).find((name) => !participantNames.has(name))
  if (unknown) throw new Error(`Unknown field "${unknown}"`)
  if (unknownParticipant) throw new Error(`Unknown participant field "${unknownParticipant}"`)
  if (collected.participants && submission.participants.length > collected.participants.max) {
    throw new Error(`At most ${collected.participants.max} participants allowed`)
  }
  return collected
}

/** Resolve each submitted participant by email (primary = current user).
 *  Shared by CFP submit and portal PENDING edit so email changes replace
 *  the speaker identity instead of keeping the old row by position. */
export async function resolveParticipantSpeakers({ eventId, session, primarySpeakerId, submission }: {
  eventId: string
  session: Session
  primarySpeakerId: string
  submission: FormSubmission
}) {
  if (submission.participants.length === 0) throw new Error('At least one participant required')
  const primaryEmail = normalizeSpeakerEmail(stringValue(submission.participants[0]?.['speaker.email']))
  if (!primaryEmail || primaryEmail !== normalizeSpeakerEmail(session.user.email)) {
    throw new Error('The primary participant email must match your verified account email')
  }

  const db = getDb()
  const ids: string[] = []
  const emails = new Set<string>()
  for (const [index, values] of submission.participants.entries()) {
    const email = normalizeSpeakerEmail(stringValue(values['speaker.email']))
    if (!z.string().email().safeParse(email).success) throw new Error(`Participant ${index + 1} needs a valid email`)
    if (emails.has(email)) throw new Error(`Participant email "${email}" is listed more than once`)
    emails.add(email)
    if (index === 0) {
      ids.push(primarySpeakerId)
      continue
    }
    const existing = await db.query.speaker.findFirst({ where: { eventId, email } })
    if (existing) {
      ids.push(existing.id)
      continue
    }
    const id = ulid()
    try {
      await db.insert(schema.speaker).values({
        id,
        eventId,
        email,
        firstName: stringValue(values['speaker.firstName']) || 'Speaker',
        lastName: stringValue(values['speaker.lastName']),
      })
      ids.push(id)
    } catch (cause) {
      const winner = await db.query.speaker.findFirst({ where: { eventId, email } })
      if (!winner) throw cause
      ids.push(winner.id)
    }
  }
  return ids
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

async function persistResponse({ loaded, submission, collected, participantSpeakerIds, submitted }: {
  loaded: Awaited<ReturnType<typeof loadOwnedDraft>>
  submission: FormSubmission
  collected: CollectResult
  participantSpeakerIds: string[]
  submitted: boolean
}) {
  const fileFieldNames = getFileFieldNames(collected)
  const fieldRows = flattenSubmissionValues({
    responseId: loaded.response.id,
    submission,
    participantSpeakerIds,
    fileFieldNames,
  })
  await assertOwnedFiles({
    eventId: loaded.event.id,
    ownerSpeakerId: loaded.speaker.id,
    fileIds: fieldRows.flatMap((row) => row.fileId ? [row.fileId] : []),
  })
  const projected = extractWellKnown(submission)
  const now = Date.now()
  const queries: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    loaded.db.delete(schema.formFieldValue).where(orm.eq(schema.formFieldValue.responseId, loaded.response.id)),
    loaded.db.delete(schema.sessionParticipant).where(orm.eq(schema.sessionParticipant.sessionId, loaded.response.session!.id)),
    loaded.db.update(schema.eventSession)
      .set({
        title: projected.session.title || null,
        description: projected.session.description || null,
        coverImageFileId: projected.session.coverImageFileId || null,
        trackId: projected.session.trackId || null,
        formatId: projected.session.formatId || null,
        status: submitted ? 'PENDING' : 'DRAFT',
        submittedAt: submitted ? now : null,
        updatedAt: now,
      })
      .where(orm.eq(schema.eventSession.id, loaded.response.session!.id))
      .limit(1),
    loaded.db.update(schema.formResponse)
      .set({ status: submitted ? 'SUBMITTED' : 'DRAFT', submittedAt: submitted ? now : null, updatedAt: now })
      .where(orm.eq(schema.formResponse.id, loaded.response.id))
      .limit(1),
    ...participantSpeakerIds.map((speakerId, sortOrder) =>
      loaded.db.insert(schema.sessionParticipant).values({
        eventId: loaded.event.id,
        sessionId: loaded.response.session!.id,
        speakerId,
        sortOrder,
      }),
    ),
    ...fieldRows.map((row) => loaded.db.insert(schema.formFieldValue).values(row)),
  ]

  if (submitted) {
    participantSpeakerIds.forEach((speakerId, index) => {
      const profile = projected.speakers[index] ?? {}
      queries.push(
        loaded.db.update(schema.speaker)
          .set({
            email: normalizeSpeakerEmail(profile.email || stringValue(submission.participants[index]?.['speaker.email'])),
            firstName: profile.firstName || 'Speaker',
            lastName: profile.lastName || '',
            bio: profile.bio || null,
            jobTitle: profile.jobTitle || null,
            companyName: profile.companyName || null,
            pronouns: profile.pronouns || null,
            websiteUrl: profile.websiteUrl || null,
            linkedinUrl: profile.linkedinUrl || null,
            twitterUrl: profile.twitterUrl || null,
            headshotFileId: profile.headshotFileId || null,
            updatedAt: now,
          })
          .where(orm.eq(schema.speaker.id, speakerId))
          .limit(1),
      )
    })
  }
  await loaded.db.batch(queries)
  return {
    responseId: loaded.response.id,
    sessionId: loaded.response.session.id,
    title: projected.session.title || 'Untitled submission',
    status: submitted ? 'PENDING' as const : 'DRAFT' as const,
  }
}

export async function saveCfpDraft(input: {
  eventId: string
  formId: string
  responseId: string
  submission: FormSubmission
  session: Session
}) {
  const submission = cfpSubmissionSchema.parse(input.submission)
  const loaded = await loadOwnedDraft({ ...input, submission })
  const collected = collectDraftFields({
    mdxSource: loaded.response.formVersion!.mdxSource,
    tracks: loaded.tracks,
    formats: loaded.formats,
    submission,
  })
  const participantSpeakerIds = await resolveParticipantSpeakers({
    eventId: input.eventId,
    session: input.session,
    primarySpeakerId: loaded.speaker.id,
    submission,
  })
  return persistResponse({ loaded, submission, collected, participantSpeakerIds, submitted: false })
}

export async function submitCfpResponse(input: {
  eventId: string
  formId: string
  responseId: string
  submission: FormSubmission
  session: Session
}) {
  const submission = cfpSubmissionSchema.parse(input.submission)
  const loaded = await loadOwnedDraft({ ...input, submission })
  const collected = collectFields({
    mdxSource: loaded.response.formVersion!.mdxSource,
    scope: {
      values: submission.values,
      tracks: libraryOptions(loaded.tracks),
      formats: libraryOptions(loaded.formats),
    },
  })
  const validation = validateSubmission({ collected, ...submission })
  if (!validation.ok) throw new Error(validation.errors.map((error) => error.message).join('\n'))
  const participantSpeakerIds = await resolveParticipantSpeakers({
    eventId: input.eventId,
    session: input.session,
    primarySpeakerId: loaded.speaker.id,
    submission,
  })
  return persistResponse({ loaded, submission, collected, participantSpeakerIds, submitted: true })
}
