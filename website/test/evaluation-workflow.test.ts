// Stateful Workerd acceptance test for CFP collection through blinded evaluation.
// It uses real BetterAuth sessions, D1, routes, server actions, and the email outbox.
import { env } from 'cloudflare:workers'
import * as schema from 'db/schema'
import dedent from 'string-dedent'
import { createSpiceflowFetch } from 'spiceflow/client'
import { runAction, SpiceflowTestResponse } from 'spiceflow/testing'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  acceptInvite,
  assignEvaluationReviews,
  createEvent,
  createForm,
  createOrg,
  createTrack,
  inviteEvaluationReviewer,
  recuseEvaluationReview,
  remindEvaluationReviewers,
  saveEvaluationReview,
  saveFormVersion,
  savePublicCfpDraft,
  startPublicCfpSubmission,
  submitPublicCfp,
  updateEvent,
  updateFormSettings,
  updateSessionStatus,
} from '../src/actions.tsx'
import { app } from '../src/app.tsx'
import { getDb } from '../src/db.ts'

const password = 'workflow-test-password'

async function signUp(name: string, email: string) {
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
  const cookie = signIn.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error(`No session cookie for ${email}`)
  return cookie
}

function runWithCookie<T>(cookie: string, action: () => Promise<T>) {
  return runAction(action, {
    request: new Request('http://localhost/action', { method: 'POST', headers: { cookie } }),
  })
}

async function runRedirect<T>(cookie: string, action: () => Promise<T>) {
  const result = await runWithCookie(cookie, action).catch((error) => error)
  if (!(result instanceof Response)) throw result
  expect(result.status).toBe(307)
  return result
}

function requirePage(value: Error | Response, message: string): SpiceflowTestResponse {
  if (!(value instanceof SpiceflowTestResponse)) throw new Error(message)
  return value
}

const reviewerQueueSchema = z.object({
  round: z.object({
    id: z.string(), name: z.string(), status: z.string(), opensAt: z.number().nullable(),
    closesAt: z.number().nullable(), blind: z.boolean(),
  }),
  assignments: z.array(z.object({ id: z.string(), session: z.object({ title: z.string().nullable() }) })),
  progress: z.object({ assigned: z.number(), completed: z.number(), recused: z.number() }),
})
const evaluationPageSchema = z.object({
  rounds: z.array(z.object({
    id: z.string(),
    fields: z.array(z.object({ name: z.string(), type: z.string(), weight: z.number().optional() })),
    reviewers: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })),
    progress: z.array(z.object({
      reviewerId: z.string(), name: z.string(), email: z.string(), assigned: z.number(),
      completed: z.number(), inProgress: z.number(), recused: z.number(),
    })),
    results: z.array(z.object({
      title: z.string(), aggregate: z.number().nullable(), status: z.string(),
    })),
  })),
  sessions: z.array(z.unknown()),
})

describe('CFP through evaluation workflow', () => {
  test('preserves submissions through scoped, blinded, weighted review and acceptance', async () => {
    const organizerCookie = await signUp('Jordan Organizer', 'task8-organizer@example.test')
    const speakerCookie = await signUp('Priya Speaker', 'task8-speaker@example.test')
    const reviewerCookie = await signUp('Sam Reviewer', 'task8-reviewer@example.test')
    const outsiderCookie = await signUp('Other User', 'task8-outsider@example.test')

    await runRedirect(organizerCookie, () => createOrg({ name: 'Task 8 Events' }))
    const db = getDb()
    const org = await db.query.org.findFirst({ where: { name: 'Task 8 Events' } })
    if (!org) throw new Error('Organization was not created')
    await runRedirect(organizerCookie, () => createEvent({
      orgId: org.orgId,
      name: 'DevFlow Conf 2027',
      slug: 'task-8-devflow-2027',
      timezone: 'UTC',
      startsAt: '2027-05-12',
      endsAt: '2027-05-14',
    }))
    await runRedirect(organizerCookie, () => createEvent({
      orgId: org.orgId,
      name: 'Forward Summit 2028',
      slug: 'task-8-forward-2028',
      timezone: 'UTC',
      startsAt: '2028-05-12',
      endsAt: '2028-05-14',
    }))
    const event = await db.query.event.findFirst({ where: { slug: 'task-8-devflow-2027' } })
    const otherEvent = await db.query.event.findFirst({ where: { slug: 'task-8-forward-2028' } })
    if (!event || !otherEvent) throw new Error('Events were not created')
    await runWithCookie(organizerCookie, () => updateEvent({
      orgId: org.orgId,
      eventId: event.id,
      name: event.name,
      slug: event.slug,
      status: 'ACTIVE',
      websiteUrl: '',
      location: 'Moscone West, San Francisco',
      timezone: 'UTC',
      startsAt: '2027-05-12',
      endsAt: '2027-05-14',
      description: 'Developer workflow conference',
      contactEmail: 'task8-organizer@example.test',
    }))
    await runWithCookie(organizerCookie, () => createTrack({
      orgId: org.orgId, eventId: event.id, name: 'Platform & Infra', color: '#6366f1',
    }))
    await runWithCookie(organizerCookie, () => createTrack({
      orgId: org.orgId, eventId: event.id, name: 'AI Engineering', color: '#059669',
    }))
    await runWithCookie(organizerCookie, () => createTrack({
      orgId: org.orgId, eventId: event.id, name: 'Developer Experience', color: '#d97706',
    }))
    const tracks = await db.query.track.findMany({ where: { eventId: event.id } })
    const platformTrack = tracks.find((row) => row.name === 'Platform & Infra')
    const aiTrack = tracks.find((row) => row.name === 'AI Engineering')
    const docsTrack = tracks.find((row) => row.name === 'Developer Experience')
    const format = await db.query.format.findFirst({ where: { eventId: event.id } })
    const cfp = await db.query.form.findFirst({ where: { eventId: event.id, purpose: 'CFP' } })
    if (!platformTrack || !aiTrack || !docsTrack || !format || !cfp) throw new Error('Event library is incomplete')

    const cfpMdx = dedent`
      # DevFlow Conf 2027 CFP

      <Step title="Submission">
        <TextField name="title" label="Session title" required />
        <RichText name="description" label="Abstract" required />
        <Select name="track" label="Track" options={tracks} required />
        <Select name="format" label="Format" options={formats} required />
        <TextField name="keyTakeaway" label="Key takeaway" required />
        <Select name="audienceLevel" label="Audience level" options={['Beginner', 'Intermediate', 'Advanced']} required />
        <Show when={values.audienceLevel === 'Advanced'}>
          <RichText name="verificationPlan" label="Verification plan" required />
        </Show>
      </Step>

      <Step title="Speakers">
        <Participants min={1} max={3}>
          <TextField name="speaker.firstName" label="First name" required />
          <TextField name="speaker.lastName" label="Last name" required />
          <TextField name="speaker.email" label="Email" required />
          <TextField name="speaker.companyName" label="Company" />
          <RichText name="speaker.bio" label="Bio" />
        </Participants>
      </Step>
    `
    const savedCfp = await runWithCookie(organizerCookie, () => saveFormVersion({
      orgId: org.orgId, eventId: event.id, formId: cfp.id, mdxSource: cfpMdx,
    }))
    await runWithCookie(organizerCookie, () => updateFormSettings({
      orgId: org.orgId,
      eventId: event.id,
      formId: cfp.id,
      name: 'DevFlow CFP',
      slug: 'cfp',
      status: 'OPEN',
      opensAt: null,
      closesAt: Date.now() + 86_400_000,
    }))

    const proposalInputs = [
      {
        title: 'Taming 40-Minute CI', trackId: platformTrack.id, level: 'Intermediate',
        description: 'Content-addressed caching and remote execution for monorepos.',
        extra: {}, coSpeaker: true,
      },
      {
        title: 'Your AI Pair Programmer Is Lying to You', trackId: aiTrack.id, level: 'Advanced',
        description: 'Verification patterns for generated code at scale.',
        extra: { verificationPlan: 'Property tests, mutation coverage, and CI gates.' }, coSpeaker: false,
      },
      {
        title: 'Docs That Answer Back', trackId: docsTrack.id, level: 'Beginner',
        description: 'Retrieval-grounded documentation with citations.',
        extra: {}, coSpeaker: false,
      },
    ] as const
    const sessionIds: string[] = []
    for (const [index, proposal] of proposalInputs.entries()) {
      await runRedirect(speakerCookie, () => startPublicCfpSubmission({ eventSlug: event.slug, formSlug: 'cfp' }))
      const draft = await db.query.formResponse.findFirst({
        where: { formId: cfp.id, status: 'DRAFT' },
        with: { session: true },
        orderBy: { createdAt: 'desc', id: 'desc' },
      })
      if (!draft?.session) throw new Error('CFP draft was not created')
      const submission = {
        values: {
          title: proposal.title,
          description: proposal.description,
          track: proposal.trackId,
          format: format.id,
          keyTakeaway: `Takeaway ${index + 1}`,
          audienceLevel: proposal.level,
          ...proposal.extra,
        },
        participants: [
          {
            'speaker.firstName': 'Priya',
            'speaker.lastName': 'Speaker',
            'speaker.email': 'task8-speaker@example.test',
            'speaker.companyName': 'Latticework Systems',
            'speaker.bio': 'Build tooling engineer.',
          },
          ...(proposal.coSpeaker ? [{
            'speaker.firstName': 'Marcus',
            'speaker.lastName': 'Okafor',
            'speaker.email': 'task8-cospeaker@example.test',
            'speaker.companyName': 'Cloudreach Labs',
            'speaker.bio': 'Developer advocate.',
          }] : []),
        ],
      }
      if (index === 0) {
        await runRedirect(speakerCookie, () => savePublicCfpDraft({
          eventId: event.id, formId: cfp.id, responseId: draft.id, submission,
        }))
        const resumed = requirePage(await createSpiceflowFetch(app, { headers: { cookie: speakerCookie } })(
          '/submit/:eventSlug/:formSlug',
          { params: { eventSlug: event.slug, formSlug: 'cfp' } },
        ), 'Expected resumed CFP page')
        expect(resumed.loaderData.draft).toMatchObject({
          responseId: draft.id,
          sessionId: draft.session.id,
          pinnedVersionId: savedCfp.versionId,
          isLatestVersion: true,
          hasSavedData: true,
          values: { title: proposal.title, keyTakeaway: 'Takeaway 1' },
        })
      }
      await runRedirect(speakerCookie, () => submitPublicCfp({
        eventId: event.id, formId: cfp.id, responseId: draft.id, submission,
      }))
      sessionIds.push(draft.session.id)
    }

    await expect(runWithCookie(speakerCookie, () => startPublicCfpSubmission({
      eventSlug: event.slug, formSlug: 'cfp',
    }))).rejects.toThrow('You can submit at most 3 sessions to this event')
    await runWithCookie(organizerCookie, () => updateFormSettings({
      orgId: org.orgId, eventId: event.id, formId: cfp.id, name: 'DevFlow CFP', slug: 'cfp',
      status: 'OPEN', opensAt: null, closesAt: Date.now() - 1_000,
    }))
    await expect(runWithCookie(speakerCookie, () => startPublicCfpSubmission({
      eventSlug: event.slug, formSlug: 'cfp',
    }))).rejects.toThrow('This CFP is not open')

    const initialRound = await runWithCookie(organizerCookie, () => createForm({
      orgId: org.orgId,
      eventId: event.id,
      name: 'Initial Review',
      purpose: 'EVALUATION',
      opensAt: Date.now() - 60_000,
      closesAt: Date.now() + 86_400_000,
      blind: true,
    }))
    const finalRound = await runWithCookie(organizerCookie, () => createForm({
      orgId: org.orgId,
      eventId: event.id,
      name: 'Final Review',
      purpose: 'EVALUATION',
      opensAt: Date.now() + 2 * 86_400_000,
      closesAt: Date.now() + 3 * 86_400_000,
      blind: false,
    }))
    const scorecard = dedent`
      # Initial scorecard

      <Number name="originality" label="Originality" min={1} max={5} weight={2} required />
      <Number name="relevance" label="Relevance" min={1} max={5} weight={1} required />
      <Select name="recommendation" label="Recommendation" options={['Accept', 'Maybe', 'Reject']} required />
      <RichText name="comments" label="Comments" required />
    `
    const finalScorecard = dedent`
      # Final scorecard

      <Number name="finalScore" label="Final score" min={1} max={10} required />
      <RichText name="comments" label="Comments" required />
    `
    const initialVersion = await runWithCookie(organizerCookie, () => saveFormVersion({
      orgId: org.orgId, eventId: event.id, formId: initialRound.id, mdxSource: scorecard,
    }))
    await runWithCookie(organizerCookie, () => saveFormVersion({
      orgId: org.orgId, eventId: event.id, formId: finalRound.id, mdxSource: finalScorecard,
    }))

    const invitation = await runWithCookie(organizerCookie, () => inviteEvaluationReviewer({
      orgId: org.orgId,
      eventId: event.id,
      formId: initialRound.id,
      email: 'task8-reviewer@example.test',
    }))
    await expect(runWithCookie(outsiderCookie, () => acceptInvite({ invitationId: invitation.invitationId })))
      .rejects.toThrow('Sign in with the invited email address')
    const acceptedInvite = await runWithCookie(reviewerCookie, () => acceptInvite({ invitationId: invitation.invitationId })).catch((error) => error)
    expect(acceptedInvite).toBeInstanceOf(Response)
    expect((acceptedInvite as Response).headers.get('location')).toBe(`/review/${initialRound.id}`)
    const reviewer = await db.query.user.findFirst({ where: { email: 'task8-reviewer@example.test' } })
    if (!reviewer) throw new Error('Reviewer user is missing')

    const platformAssignment = await runWithCookie(organizerCookie, () => assignEvaluationReviews({
      orgId: org.orgId,
      eventId: event.id,
      formId: initialRound.id,
      reviewerId: reviewer.id,
      sessionIds,
      trackId: platformTrack.id,
      limit: 1,
    }))
    const remainingAssignments = await runWithCookie(organizerCookie, () => assignEvaluationReviews({
      orgId: org.orgId,
      eventId: event.id,
      formId: initialRound.id,
      reviewerId: reviewer.id,
      sessionIds: sessionIds.slice(1),
      limit: 2,
    }))
    expect({ platformAssignment, remainingAssignments }).toEqual({
      platformAssignment: { assigned: 1 },
      remainingAssignments: { assigned: 2 },
    })
    expect(await runWithCookie(organizerCookie, () => remindEvaluationReviewers({
      orgId: org.orgId, eventId: event.id, formId: initialRound.id, reviewerIds: [reviewer.id],
    }))).toEqual({ reminded: 1, pendingCount: 3 })

    const reviewerFetch = createSpiceflowFetch(app, { headers: { cookie: reviewerCookie } })
    const reviewerQueue = requirePage(await reviewerFetch('/review/:formId', {
      params: { formId: initialRound.id },
    }), 'Expected reviewer queue')
    const reviewerData = reviewerQueueSchema.parse(reviewerQueue.loaderData)
    expect({ round: reviewerData.round, progress: reviewerData.progress }).toMatchInlineSnapshot(`
      {
        "progress": {
          "assigned": 3,
          "completed": 0,
          "recused": 0,
        },
        "round": {
          "blind": true,
          "closesAt": ${reviewerData.round.closesAt},
          "id": "${initialRound.id}",
          "name": "Initial Review",
          "opensAt": ${reviewerData.round.opensAt},
          "status": "OPEN",
        },
      }
    `)
    expect(reviewerData.assignments.map((row) => row.session.title)).toEqual(proposalInputs.map((row) => row.title))
    expect(JSON.stringify(reviewerData.assignments)).not.toMatch(/Priya|Marcus|Latticework|Cloudreach|task8-speaker/)
    const [ciReview, aiReview, docsReview] = reviewerData.assignments
    if (!ciReview || !aiReview || !docsReview) throw new Error('Expected three assignments')

    await runWithCookie(reviewerCookie, () => saveEvaluationReview({
      reviewId: ciReview.id,
      submit: false,
      submission: { values: { originality: '4' }, participants: [] },
    }))
    await runWithCookie(reviewerCookie, () => saveEvaluationReview({
      reviewId: ciReview.id,
      submit: true,
      submission: {
        values: {
          originality: '4', relevance: '2', recommendation: 'Accept',
          comments: 'Strong practical content and a clear narrative arc.',
        },
        participants: [],
      },
    }))
    await runWithCookie(reviewerCookie, () => saveEvaluationReview({
      reviewId: aiReview.id,
      submit: true,
      submission: {
        values: {
          originality: '5', relevance: '5', recommendation: 'Accept',
          comments: 'Excellent fit for the AI Engineering track.',
        },
        participants: [],
      },
    }))
    await runWithCookie(reviewerCookie, () => recuseEvaluationReview({
      reviewId: docsReview.id, reason: 'Prior collaboration with the author',
    }))
    await expect(runWithCookie(outsiderCookie, () => saveEvaluationReview({
      reviewId: ciReview.id,
      submit: true,
      submission: { values: {}, participants: [] },
    }))).rejects.toThrow('Review assignment not found')

    const duplicateReminder = await runWithCookie(organizerCookie, () => remindEvaluationReviewers({
      orgId: org.orgId, eventId: event.id, formId: initialRound.id, reviewerIds: [reviewer.id],
    })).catch((error) => error)
    expect(duplicateReminder).toBeInstanceOf(Error)
    expect((duplicateReminder as Error).message).toBe('The selected reviewers have no outstanding reviews')

    const organizerFetch = createSpiceflowFetch(app, { headers: { cookie: organizerCookie } })
    const evaluationPage = requirePage(await organizerFetch('/org/:orgId/e/:eventId/evaluation', {
      params: { orgId: org.orgId, eventId: event.id },
    }), 'Expected organizer evaluation page')
    const evaluationData = evaluationPageSchema.parse(evaluationPage.loaderData)
    const initial = evaluationData.rounds.find((round) => round.id === initialRound.id)
    const final = evaluationData.rounds.find((round) => round.id === finalRound.id)
    if (!initial || !final) throw new Error('Evaluation rounds are missing')
    expect({
      initialFields: initial.fields.map((field) => ({ name: field.name, type: field.type, weight: field.weight })),
      initialProgress: initial.progress,
      initialResults: initial.results.map((row) => ({ title: row.title, aggregate: row.aggregate, status: row.status })),
      finalFields: final.fields.map((field) => field.name),
      finalReviewers: final.reviewers,
    }).toMatchInlineSnapshot(`
      {
        "finalFields": [
          "finalScore",
          "comments",
        ],
        "finalReviewers": [],
        "initialFields": [
          {
            "name": "originality",
            "type": "number",
            "weight": 2,
          },
          {
            "name": "relevance",
            "type": "number",
            "weight": 1,
          },
          {
            "name": "recommendation",
            "type": "select",
            "weight": undefined,
          },
          {
            "name": "comments",
            "type": "richtext",
            "weight": undefined,
          },
        ],
        "initialProgress": [
          {
            "assigned": 3,
            "completed": 2,
            "email": "task8-reviewer@example.test",
            "inProgress": 0,
            "name": "Sam Reviewer",
            "recused": 1,
            "reviewerId": "${reviewer.id}",
          },
        ],
        "initialResults": [
          {
            "aggregate": null,
            "status": "RECUSED",
            "title": "Docs That Answer Back",
          },
          {
            "aggregate": 5,
            "status": "COMPLETED",
            "title": "Your AI Pair Programmer Is Lying to You",
          },
          {
            "aggregate": 3.3333333333333335,
            "status": "COMPLETED",
            "title": "Taming 40-Minute CI",
          },
        ],
      }
    `)
    expect(initialVersion.versionId).not.toBe(initial.id)

    const csvResponse = await app.handle(new Request(
      `http://localhost/org/${org.orgId}/e/${event.id}/evaluation/${initialRound.id}/results.csv`,
      { headers: { cookie: organizerCookie } },
    ))
    expect(csvResponse.status).toBe(200)
    expect(await csvResponse.text()).toMatchInlineSnapshot(`
      "session_id,title,status,aggregate,completed,in_progress,recused,assigned,originality,relevance,recommendation,comments
      ${sessionIds[0]},Taming 40-Minute CI,COMPLETED,3.3333,1,0,0,1,4,2,Accept,Strong practical content and a clear narrative arc.
      ${sessionIds[1]},Your AI Pair Programmer Is Lying to You,COMPLETED,5.0000,1,0,0,1,5,5,Accept,Excellent fit for the AI Engineering track.
      ${sessionIds[2]},Docs That Answer Back,RECUSED,,0,0,1,1,,,,
      "
    `)

    const outbox = await db.query.emailMessage.findMany({ where: { eventId: event.id } })
    expect(outbox.map((row) => ({ kind: row.kind, status: row.status, to: row.toEmail })).sort((a, b) => a.kind.localeCompare(b.kind)))
      .toMatchInlineSnapshot(`
        [
          {
            "kind": "REVIEW_REMINDER",
            "status": "QUEUED",
            "to": "task8-reviewer@example.test",
          },
          {
            "kind": "REVIEWER_INVITE",
            "status": "QUEUED",
            "to": "task8-reviewer@example.test",
          },
          {
            "kind": "SUBMISSION_CONFIRMATION",
            "status": "QUEUED",
            "to": "task8-speaker@example.test",
          },
          {
            "kind": "SUBMISSION_CONFIRMATION",
            "status": "QUEUED",
            "to": "task8-speaker@example.test",
          },
          {
            "kind": "SUBMISSION_CONFIRMATION",
            "status": "QUEUED",
            "to": "task8-speaker@example.test",
          },
        ]
      `)

    const outsiderReview = await createSpiceflowFetch(app, { headers: { cookie: outsiderCookie } })(
      '/review/:formId', { params: { formId: initialRound.id } },
    )
    expect(outsiderReview).toMatchObject({ status: 404 })
    const speakerAdmin = await createSpiceflowFetch(app, { headers: { cookie: speakerCookie } })(
      '/org/:orgId/e/:eventId/evaluation', { params: { orgId: org.orgId, eventId: event.id } },
    )
    expect(speakerAdmin).toMatchObject({ status: 307 })
    const otherEventEvaluation = requirePage(await organizerFetch('/org/:orgId/e/:eventId/evaluation', {
      params: { orgId: org.orgId, eventId: otherEvent.id },
    }), 'Expected second event evaluation page')
    expect(otherEventEvaluation.loaderData).toMatchObject({ rounds: [], sessions: [] })

    await runWithCookie(organizerCookie, () => updateSessionStatus({
      orgId: org.orgId, eventId: event.id, sessionId: sessionIds[0]!, status: 'ACCEPT_QUEUE',
    }))
    await runWithCookie(organizerCookie, () => updateSessionStatus({
      orgId: org.orgId, eventId: event.id, sessionId: sessionIds[0]!, status: 'ACCEPTED',
    }))
    const accepted = await db.query.eventSession.findFirst({
      where: { id: sessionIds[0], eventId: event.id },
      with: { track: true, participants: { with: { speaker: true }, orderBy: { sortOrder: 'asc' } } },
    })
    expect({
      id: accepted?.id,
      title: accepted?.title,
      status: accepted?.status,
      track: accepted?.track?.name,
      speakers: accepted?.participants.map((row) => `${row.speaker?.firstName} ${row.speaker?.lastName}`),
    }).toEqual({
      id: sessionIds[0],
      title: 'Taming 40-Minute CI',
      status: 'ACCEPTED',
      track: 'Platform & Infra',
      speakers: ['Priya Speaker', 'Marcus Okafor'],
    })
  })
})
