// Stateful Workerd acceptance test for the core customer handoff:
// organizer setup → public CFP → decision → agenda → public program.
import { env } from 'cloudflare:workers'
import * as orm from 'drizzle-orm'
import * as schema from 'db/schema'
import { createSpiceflowFetch } from 'spiceflow/client'
import { runAction, SpiceflowTestResponse } from 'spiceflow/testing'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  completeManualTaskAssignment,
  createEvent,
  createOrg,
  createRoom,
  resetPublicCfpDraft,
  saveFormVersion,
  saveOrganizerSpeakerProfile,
  savePortalProfile,
  savePortalSubmission,
  savePublicCfpDraft,
  scheduleSession,
  setProgramPublication,
  setSessionVisibility,
  startPublicCfpSubmission,
  submitPublicCfp,
  updateEvent,
  updateFormSettings,
  updateSessionStatus,
} from '../src/actions.tsx'
import { app } from '../src/app.tsx'
import { getDb } from '../src/db.ts'

const profileValuesSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]))
const organizerDetailSchema = z.object({
  speaker: z.object({
    bio: z.string().nullable(),
    headshotFileId: z.string().nullable(),
  }).optional(),
  profileForm: z.object({
    customFields: z.array(z.object({
      name: z.string(),
      value: z.union([z.string(), z.array(z.string())]),
    })),
  }).nullable(),
})
const abstractParticipantsSchema = z.object({
  participants: z.array(z.object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    jobTitle: z.string().nullable(),
    companyName: z.string().nullable(),
  })),
})
const reviewerAssignmentsSchema = z.object({
  assignments: z.array(z.object({
    session: z.object({ participants: z.array(z.unknown()) }),
  })),
})

async function signUp(name: string, email: string) {
  const password = 'workflow-test-password'
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
  if (!setCookie) throw new Error('sign-up did not set a session cookie')
  return setCookie.split(';', 1)[0]!
}

async function runWithCookie<T>(cookie: string, action: () => Promise<T>) {
  return runAction(action, {
    request: new Request('http://localhost/action', {
      method: 'POST',
      headers: { cookie },
    }),
  })
}

async function runRedirect<T>(cookie: string, action: () => Promise<T>) {
  const result = await runWithCookie(cookie, action).catch((error) => error)
  if (!(result instanceof Response)) throw result
  expect(result.status).toBe(307)
  return result
}

describe('core customer workflow', () => {
  test('a submitted talk reaches the published agenda without data re-entry', async () => {
    const organizerCookie = await signUp('Workflow Organizer', 'organizer-workflow@example.test')
    await runRedirect(organizerCookie, () => createOrg({ name: 'Workflow Events' }))

    const db = getDb()
    const org = await db.query.org.findFirst({ where: { name: 'Workflow Events' } })
    if (!org) throw new Error('organizer action did not create the organization')

    await runRedirect(organizerCookie, () => createEvent({
      orgId: org.orgId,
      name: 'Customer Workflow Summit',
      slug: 'customer-workflow-summit',
      timezone: 'UTC',
      startsAt: '2027-05-13',
      endsAt: '2027-05-14',
    }))

    const event = await db.query.event.findFirst({ where: { slug: 'customer-workflow-summit' } })
    if (!event) throw new Error('organizer action did not create the event')
    await runWithCookie(organizerCookie, () => updateEvent({
      orgId: org.orgId,
      eventId: event.id,
      name: event.name,
      slug: event.slug,
      status: 'ACTIVE',
      websiteUrl: '',
      location: '',
      timezone: event.timezone,
      startsAt: '2027-05-13',
      endsAt: '2027-05-14',
      description: '',
      contactEmail: 'organizer-workflow@example.test',
    }))
    const form = await db.query.form.findFirst({ where: { eventId: event.id, purpose: 'CFP' } })
    if (!form) throw new Error('event did not create its CFP form')
    await runWithCookie(organizerCookie, () => updateFormSettings({
      orgId: org.orgId,
      eventId: event.id,
      formId: form.id,
      name: 'Call for speakers',
      slug: 'cfp',
      status: 'OPEN',
      closesAt: null,
    }))

    const publicFetch = createSpiceflowFetch(app)
    const openCfp = await publicFetch('/submit/:eventSlug/:formSlug', {
      params: { eventSlug: event.slug, formSlug: form.slug },
    })
    if (!(openCfp instanceof SpiceflowTestResponse)) throw new Error('expected public CFP page')
    expect(await openCfp.text()).toContain('Call for speakers')

    const speakerCookie = await signUp('Ada Speaker', 'ada-workflow@example.test')
    await runRedirect(speakerCookie, () => startPublicCfpSubmission({
      eventSlug: event.slug,
      formSlug: form.slug,
    }))
    const response = await db.query.formResponse.findFirst({
      where: { formId: form.id, status: 'DRAFT' },
      with: { session: true },
    })
    if (!response?.session) throw new Error('speaker action did not create a draft')
    let sessionId = response.session.id
    let responseId = response.id
    const track = await db.query.track.findFirst({ where: { eventId: event.id } })
    const format = await db.query.format.findFirst({ where: { eventId: event.id } })
    if (!track || !format) throw new Error('event library is incomplete')

    const submission = {
      values: {
        title: 'Durable workflows without data re-entry',
        description: 'A practical guide to carrying customer data through every event workflow.',
        track: track.id,
        format: format.id,
      },
      participants: [{
        'speaker.firstName': 'Ada',
        'speaker.lastName': 'Speaker',
        'speaker.email': 'ada-workflow@example.test',
        'speaker.bio': 'Builds reliable event systems.',
      }],
    }
    await runWithCookie(speakerCookie, () => savePublicCfpDraft({
      eventId: event.id,
      formId: form.id,
      responseId,
      submission,
    }))
    const originalVersion = await db.query.formVersion.findFirst({
      where: { formId: form.id },
      orderBy: { createdAt: 'desc', id: 'desc' },
    })
    if (!originalVersion) throw new Error('CFP version is missing')
    const latestVersion = await runWithCookie(organizerCookie, () => saveFormVersion({
      orgId: org.orgId,
      eventId: event.id,
      formId: form.id,
      mdxSource: `${originalVersion.mdxSource}\n\n<Info>The latest form version is active.</Info>`,
    }))
    const speakerFetch = createSpiceflowFetch(app, { headers: { cookie: speakerCookie } })
    const staleDraftPage = await speakerFetch('/submit/:eventSlug/:formSlug', {
      params: { eventSlug: event.slug, formSlug: form.slug },
    })
    if (!(staleDraftPage instanceof SpiceflowTestResponse)) throw new Error('expected stale draft page')
    expect(staleDraftPage.loaderData.draft).toMatchObject({ hasSavedData: true, isLatestVersion: false })
    expect(await staleDraftPage.text()).toContain('The CFP form changed since you saved this draft')

    const resetDraft = await runWithCookie(speakerCookie, () => resetPublicCfpDraft({
      eventSlug: event.slug,
      formSlug: form.slug,
    }))
    expect({
      isLatestVersion: resetDraft.isLatestVersion,
      pinnedVersionId: resetDraft.pinnedVersionId,
    }).toEqual({
      isLatestVersion: true,
      pinnedVersionId: latestVersion.versionId,
    })
    expect(await db.query.eventSession.findFirst({ where: { id: sessionId } })).toBeUndefined()
    sessionId = resetDraft.sessionId
    responseId = resetDraft.responseId

    await runWithCookie(speakerCookie, () => submitPublicCfp({
      eventId: event.id,
      formId: form.id,
      responseId,
      submission,
    }))

    const submitted = await db.query.eventSession.findFirst({
      where: { id: sessionId },
      with: { participants: { with: { speaker: true } } },
    })
    expect({
      status: submitted?.status,
      title: submitted?.title,
      speaker: submitted?.participants[0]?.speaker?.email,
    }).toEqual({
      status: 'PENDING',
      title: submission.values.title,
      speaker: 'ada-workflow@example.test',
    })
    if (!submitted) throw new Error('submitted session is missing')

    const editablePortal = await speakerFetch('/portal/:eventSlug/submissions/:sessionId', {
      params: { eventSlug: event.slug, sessionId },
    })
    if (!(editablePortal instanceof SpiceflowTestResponse)) throw new Error('expected portal submission page')
    expect(await editablePortal.text()).toContain('Edit')

    await runWithCookie(organizerCookie, () => updateFormSettings({
      orgId: org.orgId,
      eventId: event.id,
      formId: form.id,
      name: form.name,
      slug: form.slug,
      status: 'OPEN',
      closesAt: Date.now() - 1_000,
    }))
    const lockedPortal = await speakerFetch('/portal/:eventSlug/submissions/:sessionId', {
      params: { eventSlug: event.slug, sessionId },
    })
    if (!(lockedPortal instanceof SpiceflowTestResponse)) throw new Error('expected locked portal submission page')
    expect(await lockedPortal.text()).toContain('Editing is closed. This form closed at its deadline.')
    await expect(runWithCookie(speakerCookie, () => savePortalSubmission({
      eventId: event.id,
      sessionId,
      submission,
      submit: true,
    }))).rejects.toThrow('Editing is closed. This form closed at its deadline.')
    const closedCfp = await publicFetch('/submit/:eventSlug/:formSlug', {
      params: { eventSlug: event.slug, formSlug: form.slug },
    })
    if (!(closedCfp instanceof SpiceflowTestResponse)) throw new Error('expected closed CFP page')
    expect(await closedCfp.text()).toContain('closed at its deadline')
    await runWithCookie(organizerCookie, () => updateFormSettings({
      orgId: org.orgId,
      eventId: event.id,
      formId: form.id,
      name: form.name,
      slug: form.slug,
      status: 'OPEN',
      closesAt: null,
    }))

    await expect(runWithCookie(speakerCookie, () => updateSessionStatus({
      orgId: org.orgId,
      eventId: event.id,
      sessionId,
      status: 'ACCEPTED',
    }))).rejects.toBeDefined()
    await runWithCookie(organizerCookie, () => updateSessionStatus({
      orgId: org.orgId,
      eventId: event.id,
      sessionId,
      status: 'ACCEPT_QUEUE',
    }))
    await runWithCookie(organizerCookie, () => updateSessionStatus({
      orgId: org.orgId,
      eventId: event.id,
      sessionId,
      status: 'ACCEPTED',
    }))
    await db.update(schema.eventSession)
      .set({ notifiedAt: Date.now() })
      .where(orm.eq(schema.eventSession.id, sessionId))
      .limit(1)
    await runWithCookie(organizerCookie, () => updateSessionStatus({
      orgId: org.orgId,
      eventId: event.id,
      sessionId,
      status: 'DECLINE_QUEUE',
    }))
    const reconsidered = await db.query.eventSession.findFirst({ where: { id: sessionId } })
    expect({
      status: reconsidered?.status,
      decidedAt: reconsidered?.decidedAt,
      notifiedAt: reconsidered?.notifiedAt,
    }).toEqual({ status: 'DECLINE_QUEUE', decidedAt: null, notifiedAt: null })
    await runWithCookie(organizerCookie, () => updateSessionStatus({
      orgId: org.orgId,
      eventId: event.id,
      sessionId,
      status: 'ACCEPT_QUEUE',
    }))
    await runWithCookie(organizerCookie, () => updateSessionStatus({
      orgId: org.orgId,
      eventId: event.id,
      sessionId,
      status: 'ACCEPTED',
    }))

    const ada = submitted.participants[0]?.speaker
    if (!ada) throw new Error('submitted speaker is missing')
    const profileForm = await db.query.form.findFirst({
      where: { eventId: event.id, purpose: 'PORTAL', target: 'SPEAKER' },
    })
    if (!profileForm) throw new Error('event did not create a speaker profile form')
    await env.FILES.put(`${event.id}/workflow-headshot/headshot.png`, 'image-bytes', {
      httpMetadata: { contentType: 'image/png' },
    })
    await db.insert(schema.file).values({
      id: 'workflow-headshot',
      eventId: event.id,
      kind: 'HEADSHOT',
      fileName: 'headshot.png',
      mimeType: 'image/png',
      sizeBytes: 11,
      storageKey: `${event.id}/workflow-headshot/headshot.png`,
      uploadedBySpeakerId: ada.id,
    })
    await runWithCookie(speakerCookie, () => savePortalProfile({
      eventId: event.id,
      formId: profileForm.id,
      submission: {
        values: {
          'speaker.firstName': 'Ada',
          'speaker.lastName': 'Speaker',
          'speaker.bio': 'Builds reliable event systems. SBEK-PORTAL-BIO-01',
          'speaker.jobTitle': 'Staff Engineer',
          'speaker.companyName': 'Reliable Systems',
          'speaker.headshot': 'workflow-headshot',
          'speaker.travelLogistics': 'Arrival May 11, aisle seat; dietary: Vegetarian',
        },
        participants: [],
      },
    }))
    await db.insert(schema.speaker).values({
      id: 'workflow-other-speaker',
      eventId: event.id,
      firstName: 'Marcus',
      lastName: 'Okafor',
      email: 'marcus-private@example.test',
    })
    await db.insert(schema.taskDefinition).values({
      id: 'workflow-other-task',
      eventId: event.id,
      title: 'Marcus only private task',
      target: 'SPEAKER',
      source: 'MANUAL',
      assignmentPolicy: 'SELECTED',
    })
    await db.insert(schema.taskAssignment).values({
      id: 'workflow-other-assignment',
      eventId: event.id,
      taskDefinitionId: 'workflow-other-task',
      speakerId: 'workflow-other-speaker',
    })

    const profilePage = await speakerFetch('/portal/:eventSlug/profile', {
      params: { eventSlug: event.slug },
    })
    if (!(profilePage instanceof SpiceflowTestResponse)) throw new Error('expected profile page')
    expect(await profilePage.text()).toContain('/files/workflow-headshot')
    const profileValues = profileValuesSchema.parse(profilePage.loaderData.initialValues)
    expect(profileValues['speaker.travelLogistics'])
      .toBe('Arrival May 11, aisle seat; dietary: Vegetarian')
    const portalHome = await speakerFetch('/portal/:eventSlug', {
      params: { eventSlug: event.slug },
    })
    if (!(portalHome instanceof SpiceflowTestResponse)) throw new Error('expected portal home')
    const portalHtml = await portalHome.text()
    expect(portalHtml).not.toContain('Marcus')
    expect(portalHtml).not.toContain('Marcus only private task')
    const otherTask = await speakerFetch('/portal/:eventSlug/tasks/:assignmentId', {
      params: { eventSlug: event.slug, assignmentId: 'workflow-other-assignment' },
    })
    if (!(otherTask instanceof SpiceflowTestResponse)) throw new Error('expected scoped task page')
    expect(otherTask.loaderData.assignment).toBeNull()
    expect(await otherTask.text()).toContain('This assignment is missing or not yours.')
    await expect(runWithCookie(speakerCookie, () => completeManualTaskAssignment({
      eventId: event.id,
      assignmentId: 'workflow-other-assignment',
    }))).rejects.toThrow('This task cannot be completed')

    const organizerFetch = createSpiceflowFetch(app, { headers: { cookie: organizerCookie } })
    const abstractDetail = await organizerFetch('/org/:orgId/e/:eventId/abstracts/:sessionId', {
      params: { orgId: org.orgId, eventId: event.id, sessionId },
    })
    if (!(abstractDetail instanceof SpiceflowTestResponse)) throw new Error('expected organizer abstract detail page')
    const abstractData = abstractParticipantsSchema.parse(abstractDetail.loaderData)
    expect(abstractData.participants[0]).toMatchObject({
      firstName: 'Ada',
      lastName: 'Speaker',
      email: 'ada-workflow@example.test',
      jobTitle: 'Staff Engineer',
      companyName: 'Reliable Systems',
    })
    const reviewerCookie = await signUp('Blind Reviewer', 'blind-reviewer-workflow@example.test')
    const reviewer = await db.query.user.findFirst({ where: { email: 'blind-reviewer-workflow@example.test' } })
    if (!reviewer) throw new Error('reviewer account is missing')
    await db.batch([
      db.insert(schema.form).values({
        id: 'workflow-blind-round',
        eventId: event.id,
        purpose: 'EVALUATION',
        target: 'SUBMISSION',
        name: 'Blind review',
        slug: 'blind-review',
        status: 'OPEN',
        blind: true,
      }),
      db.insert(schema.formVersion).values({
        id: 'workflow-blind-round-version',
        formId: 'workflow-blind-round',
        mdxSource: '<Number name="rating" min={1} max={5} />',
      }),
      db.insert(schema.evaluationReviewer).values({
        id: 'workflow-blind-reviewer',
        eventId: event.id,
        formId: 'workflow-blind-round',
        userId: reviewer.id,
      }),
      db.insert(schema.review).values({
        id: 'workflow-blind-review',
        eventId: event.id,
        formId: 'workflow-blind-round',
        sessionId,
        reviewerId: reviewer.id,
      }),
    ] as const)
    const reviewerFetch = createSpiceflowFetch(app, { headers: { cookie: reviewerCookie } })
    const blindRound = await reviewerFetch('/review/:formId', {
      params: { formId: 'workflow-blind-round' },
    })
    if (!(blindRound instanceof SpiceflowTestResponse)) throw new Error('expected blind reviewer page')
    const blindData = reviewerAssignmentsSchema.parse(blindRound.loaderData)
    expect(blindData.assignments[0]?.session.participants).toEqual([])
    expect(JSON.stringify(blindData.assignments))
      .not.toMatch(/Ada Speaker|ada-workflow@example\.test|Staff Engineer|Reliable Systems/)

    const organizerSpeaker = await organizerFetch('/org/:orgId/e/:eventId/speakers/:speakerId', {
      params: { orgId: org.orgId, eventId: event.id, speakerId: ada.id },
    })
    if (!(organizerSpeaker instanceof SpiceflowTestResponse)) throw new Error('expected organizer speaker page')
    const organizerDetail = organizerDetailSchema.parse(organizerSpeaker.loaderData)
    expect({
      bio: organizerDetail.speaker?.bio,
      headshotFileId: organizerDetail.speaker?.headshotFileId,
      customFields: organizerDetail.profileForm?.customFields,
    }).toMatchObject({
      bio: expect.stringContaining('SBEK-PORTAL-BIO-01'),
      headshotFileId: 'workflow-headshot',
      customFields: [{
        name: 'speaker.travelLogistics',
        value: 'Arrival May 11, aisle seat; dietary: Vegetarian',
      }],
    })
    await runWithCookie(organizerCookie, () => saveOrganizerSpeakerProfile({
      orgId: org.orgId,
      eventId: event.id,
      speakerId: ada.id,
      formId: profileForm.id,
      submission: {
        values: {
          'speaker.firstName': 'Ada',
          'speaker.lastName': 'Speaker',
          'speaker.bio': 'Builds reliable event systems. SBEK-PORTAL-BIO-01',
          'speaker.headshot': 'workflow-headshot',
          'speaker.travelLogistics': 'Arrival May 12 by train; dietary: Vegetarian',
        },
        participants: [],
      },
    }))
    const updatedOrganizerSpeaker = await organizerFetch('/org/:orgId/e/:eventId/speakers/:speakerId', {
      params: { orgId: org.orgId, eventId: event.id, speakerId: ada.id },
    })
    if (!(updatedOrganizerSpeaker instanceof SpiceflowTestResponse)) throw new Error('expected updated organizer speaker page')
    const updatedDetail = organizerDetailSchema.parse(updatedOrganizerSpeaker.loaderData)
    expect(updatedDetail.profileForm?.customFields).toContainEqual({
      name: 'speaker.travelLogistics',
      value: 'Arrival May 12 by train; dietary: Vegetarian',
    })
    await runWithCookie(organizerCookie, () => createRoom({
      orgId: org.orgId,
      eventId: event.id,
      name: 'Main stage',
    }))
    const room = await db.query.room.findFirst({ where: { eventId: event.id, name: 'Main stage' } })
    if (!room) throw new Error('organizer action did not create the room')
    await runWithCookie(organizerCookie, () => scheduleSession({
      orgId: org.orgId,
      eventId: event.id,
      sessionId,
      roomId: room.id,
      dayKey: '2027-05-13',
      startMinute: 10 * 60,
      durationMinutes: 30,
    }))
    await runWithCookie(organizerCookie, () => setSessionVisibility({
      orgId: org.orgId,
      eventId: event.id,
      sessionId,
      visibility: 'PUBLIC',
    }))
    await runWithCookie(organizerCookie, () => setProgramPublication({
      orgId: org.orgId,
      eventId: event.id,
      published: true,
    }))

    const agenda = await publicFetch('/public/:eventSlug/agenda', {
      params: { eventSlug: event.slug },
    })
    if (!(agenda instanceof SpiceflowTestResponse)) throw new Error('expected public agenda page')
    const html = await agenda.text()
    expect(html).toContain(submission.values.title)
    expect(html).toContain('Main stage')

    const sessions = await publicFetch('/public/:eventSlug/sessions', {
      params: { eventSlug: event.slug },
    })
    if (!(sessions instanceof SpiceflowTestResponse)) throw new Error('expected public sessions page')
    expect(await sessions.text()).toContain('Ada Speaker')

    const emails = await db.query.emailMessage.findMany({ where: { eventId: event.id } })
    expect(emails.length).toBeGreaterThan(0)
    expect(emails.every((email) => email.status === 'QUEUED' && email.attemptCount === 0)).toBe(true)
  })
})
