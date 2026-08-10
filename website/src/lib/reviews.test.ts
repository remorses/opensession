// Pure tests for evaluation invitations, blind projections, scorecards, and results.
import { describe, expect, test } from 'vitest'
import { collectFields } from '../forms/collect-fields.ts'
import {
  aggregateEvaluationResults,
  coverageBySession,
  evaluationResultsToCsv,
  invitationAcceptanceDecision,
  progressByReviewer,
  projectAssignedSession,
  reviewState,
  sortEvaluationResults,
  type Assignment,
} from './reviews.ts'

const scorecard = `
  <Number name="originality" label="Originality" min={1} max={5} weight={2} required />
  <Number name="relevance" label="Relevance" min={1} max={5} weight={1} required />
  <Select name="recommendation" label="Recommendation" options={['Accept', 'Maybe', 'Reject']} required />
  <RichText name="comments" label="Comments" maxLength={5000} />
`

describe('reviewer invitations', () => {
  test('requires a live invite and the verified invited email', () => {
    expect([
      invitationAcceptanceDecision({ now: 10, expiresAt: 11, invitedEmail: 'Sam@Example.com', userEmail: 'sam@example.com', emailVerified: true }),
      invitationAcceptanceDecision({ now: 12, expiresAt: 11, invitedEmail: 'sam@example.com', userEmail: 'sam@example.com', emailVerified: true }),
      invitationAcceptanceDecision({ now: 10, expiresAt: 11, invitedEmail: 'sam@example.com', userEmail: 'other@example.com', emailVerified: true }),
      invitationAcceptanceDecision({ now: 10, expiresAt: 11, invitedEmail: 'sam@example.com', userEmail: 'sam@example.com', emailVerified: false }),
    ]).toMatchInlineSnapshot(`
      [
        {
          "ok": true,
        },
        {
          "message": "Invitation not found or expired",
          "ok": false,
        },
        {
          "message": "Sign in with the invited email address",
          "ok": false,
        },
        {
          "message": "Verify the invited email address before accepting",
          "ok": false,
        },
      ]
    `)
  })
})

describe('scorecard metadata and values', () => {
  test('collects number, select, and text criteria with weights', () => {
    expect(collectFields({ mdxSource: scorecard, scope: { values: {} } }).fields)
      .toMatchInlineSnapshot(`
        [
          {
            "max": 5,
            "min": 1,
            "name": "originality",
            "participantScope": false,
            "required": true,
            "type": "number",
            "weight": 2,
          },
          {
            "max": 5,
            "min": 1,
            "name": "relevance",
            "participantScope": false,
            "required": true,
            "type": "number",
            "weight": 1,
          },
          {
            "multiple": undefined,
            "name": "recommendation",
            "options": [
              {
                "label": "Accept",
                "value": "Accept",
              },
              {
                "label": "Maybe",
                "value": "Maybe",
              },
              {
                "label": "Reject",
                "value": "Reject",
              },
            ],
            "participantScope": false,
            "required": true,
            "type": "select",
          },
          {
            "maxLength": 5000,
            "name": "comments",
            "participantScope": false,
            "required": false,
            "type": "richtext",
          },
        ]
      `)
  })
})

describe('blind assignment projection', () => {
  const row = {
    id: 'session-1', title: 'Build systems', description: 'Fast builds',
    trackName: 'Platform', formatName: 'Talk',
    participants: [{ firstName: 'Priya', lastName: 'Raman', email: 'priya@example.com', companyName: 'Latticework', headshotFileId: 'file-1' }],
    fieldValues: [
      { name: 'audience', value: 'Advanced' },
      { name: 'speaker.company', value: 'Latticework' },
      { name: 'contactEmail', value: 'private@example.com' },
      { name: 'authorBio', value: 'Priya writes build tools' },
      { name: 'presenterAffiliation', value: 'Latticework Systems' },
      { name: 'dietary', value: 'Vegetarian', subjectSpeakerId: 'speaker-1' },
    ],
  }

  test('removes every identity-bearing value before serialization', () => {
    expect(projectAssignedSession(row, true)).toMatchInlineSnapshot(`
      {
        "description": "Fast builds",
        "fieldValues": [
          {
            "name": "audience",
            "value": "Advanced",
          },
        ],
        "formatName": "Talk",
        "id": "session-1",
        "participants": [],
        "title": "Build systems",
        "trackName": "Platform",
      }
    `)
    expect(JSON.stringify(projectAssignedSession(row, true))).not.toMatch(/Priya|Raman|Latticework|private@example|Vegetarian/)
  })
})

describe('derived state, progress, coverage, results, sorting, and CSV', () => {
  const assignments: Assignment[] = [
    { id: 'r1', sessionId: 's1', reviewerId: 'u1', recusedAt: null, response: { status: 'SUBMITTED' as const, values: { originality: '4', relevance: '2', recommendation: 'Accept', comments: 'Strong' } }, reviewer: { name: 'Sam', email: 'sam@example.com' } },
    { id: 'r2', sessionId: 's2', reviewerId: 'u1', recusedAt: null, response: { status: 'DRAFT' as const, values: { originality: '5' } }, reviewer: { name: 'Sam', email: 'sam@example.com' } },
    { id: 'r3', sessionId: 's2', reviewerId: 'u2', recusedAt: 20, response: null, reviewer: { name: 'Ada', email: 'ada@example.com' } },
  ]

  test('derives assignment state and progress without lifecycle columns', () => {
    expect([
      reviewState({ recusedAt: null, responseStatus: null }),
      reviewState({ recusedAt: null, responseStatus: 'DRAFT' }),
      reviewState({ recusedAt: null, responseStatus: 'SUBMITTED' }),
      reviewState({ recusedAt: 1, responseStatus: null }),
      progressByReviewer(assignments),
      coverageBySession([{ id: 's1', title: 'Alpha' }, { id: 's2', title: 'Beta' }], assignments),
    ]).toMatchInlineSnapshot(`
      [
        "ASSIGNED",
        "IN_PROGRESS",
        "COMPLETED",
        "RECUSED",
        [
          {
            "assigned": 2,
            "completed": 1,
            "email": "sam@example.com",
            "inProgress": 1,
            "name": "Sam",
            "recused": 0,
            "reviewerId": "u1",
          },
          {
            "assigned": 1,
            "completed": 0,
            "email": "ada@example.com",
            "inProgress": 0,
            "name": "Ada",
            "recused": 1,
            "reviewerId": "u2",
          },
        ],
        [
          {
            "assigned": 1,
            "completed": 1,
            "sessionId": "s1",
            "title": "Alpha",
          },
          {
            "assigned": 2,
            "completed": 0,
            "sessionId": "s2",
            "title": "Beta",
          },
        ],
      ]
    `)
  })

  test('uses numeric weights, sorts both directions, and exports typed answers', () => {
    const fields = collectFields({ mdxSource: scorecard, scope: { values: {} } }).fields
    const results = aggregateEvaluationResults({
      sessions: [{ id: 's1', title: 'Taming CI' }, { id: 's2', title: 'AI Pair Programmer' }],
      fields,
      assignments: [
        assignments[0]!,
        { ...assignments[1]!, response: { status: 'SUBMITTED' as const, values: { originality: '5', relevance: '5', recommendation: 'Accept', comments: 'Excellent' } } },
      ],
    })
    expect({
      results,
      desc: sortEvaluationResults(results, 'desc').map((row) => row.title),
      asc: sortEvaluationResults(results, 'asc').map((row) => row.title),
      csv: evaluationResultsToCsv(results, fields),
    }).toMatchInlineSnapshot(`
      {
        "asc": [
          "Taming CI",
          "AI Pair Programmer",
        ],
        "csv": "session_id,title,status,aggregate,completed,in_progress,recused,assigned,originality,relevance,recommendation,comments
      s1,Taming CI,COMPLETED,3.3333,1,0,0,1,4,2,Accept,Strong
      s2,AI Pair Programmer,COMPLETED,5.0000,1,0,0,1,5,5,Accept,Excellent
      ",
        "desc": [
          "AI Pair Programmer",
          "Taming CI",
        ],
        "results": [
          {
            "aggregate": 3.3333333333333335,
            "answers": {
              "comments": "Strong",
              "originality": "4",
              "recommendation": "Accept",
              "relevance": "2",
            },
            "assigned": 1,
            "completed": 1,
            "inProgress": 0,
            "recused": 0,
            "sessionId": "s1",
            "status": "COMPLETED",
            "title": "Taming CI",
          },
          {
            "aggregate": 5,
            "answers": {
              "comments": "Excellent",
              "originality": "5",
              "recommendation": "Accept",
              "relevance": "5",
            },
            "assigned": 1,
            "completed": 1,
            "inProgress": 0,
            "recused": 0,
            "sessionId": "s2",
            "status": "COMPLETED",
            "title": "AI Pair Programmer",
          },
        ],
      }
    `)
  })
})
