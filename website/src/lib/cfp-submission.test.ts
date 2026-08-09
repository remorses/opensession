// Pure tests for CFP submission persistence, access decisions, response caps,
// and validation against the immutable FormVersion pinned to a response.
import { describe, expect, test } from 'vitest'
import dedent from 'string-dedent'
import { extractWellKnown } from '../forms/well-known-names.ts'
import {
  assertCfpResponseLimit,
  canAccessFile,
  flattenSubmissionValues,
  isResumableCfpDraft,
  shouldCreateCfpDraft,
  validatePinnedSubmission,
} from './cfp-submission.ts'

describe('assertCfpResponseLimit', () => {
  test('allows the first three responses and rejects a fourth', () => {
    expect(() => assertCfpResponseLimit(2)).not.toThrow()
    expect(() => assertCfpResponseLimit(3)).toThrowError(
      'You can submit at most 3 sessions to this event',
    )
  })
})

describe('shouldCreateCfpDraft', () => {
  test('creates the first draft automatically but requires intent after a submission', () => {
    expect(shouldCreateCfpDraft({ existingResponseCount: 0, explicitlyRequested: false })).toBe(true)
    expect(shouldCreateCfpDraft({ existingResponseCount: 1, explicitlyRequested: false })).toBe(false)
    expect(shouldCreateCfpDraft({ existingResponseCount: 1, explicitlyRequested: true })).toBe(true)
  })
})

describe('isResumableCfpDraft', () => {
  test('does not reopen a withdrawn session through its draft response', () => {
    expect(isResumableCfpDraft({ responseStatus: 'DRAFT', sessionStatus: 'DRAFT' })).toBe(true)
    expect(isResumableCfpDraft({ responseStatus: 'DRAFT', sessionStatus: 'WITHDRAWN' })).toBe(false)
    expect(isResumableCfpDraft({ responseStatus: 'SUBMITTED', sessionStatus: 'PENDING' })).toBe(false)
  })
})

describe('flattenSubmissionValues', () => {
  test('preserves typed and custom answers, arrays, file ids, and participant owners', () => {
    const rows = flattenSubmissionValues({
      responseId: 'response-1',
      submission: {
        values: {
          title: 'A durable CFP',
          topics: ['workers', 'sqlite'],
          slides: 'file-slides',
        },
        participants: [
          {
            'speaker.firstName': 'Ada',
            'speaker.headshot': 'file-headshot',
          },
          {
            'speaker.firstName': 'Grace',
          },
        ],
      },
      participantSpeakerIds: ['speaker-ada', 'speaker-grace'],
      fileFieldNames: new Set(['slides', 'speaker.headshot']),
    })

    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "fileId": null,
          "name": "title",
          "responseId": "response-1",
          "subjectSpeakerId": null,
          "value": "A durable CFP",
        },
        {
          "fileId": null,
          "name": "topics",
          "responseId": "response-1",
          "subjectSpeakerId": null,
          "value": "workers",
        },
        {
          "fileId": null,
          "name": "topics",
          "responseId": "response-1",
          "subjectSpeakerId": null,
          "value": "sqlite",
        },
        {
          "fileId": "file-slides",
          "name": "slides",
          "responseId": "response-1",
          "subjectSpeakerId": null,
          "value": "file-slides",
        },
        {
          "fileId": null,
          "name": "speaker.firstName",
          "responseId": "response-1",
          "subjectSpeakerId": "speaker-ada",
          "value": "Ada",
        },
        {
          "fileId": "file-headshot",
          "name": "speaker.headshot",
          "responseId": "response-1",
          "subjectSpeakerId": "speaker-ada",
          "value": "file-headshot",
        },
        {
          "fileId": null,
          "name": "speaker.firstName",
          "responseId": "response-1",
          "subjectSpeakerId": "speaker-grace",
          "value": "Grace",
        },
      ]
    `)
  })
})

describe('extractWellKnown', () => {
  test('projects the public session file fields', () => {
    expect(extractWellKnown({
      values: { coverImage: 'file-cover' },
      participants: [],
    }).session).toMatchInlineSnapshot(`
      {
        "coverImageFileId": "file-cover",
      }
    `)
  })
})

describe('canAccessFile', () => {
  test('allows members, owners, and public references only', () => {
    expect(canAccessFile({ isOrgMember: true })).toBe(true)
    expect(canAccessFile({ isOwningSpeaker: true })).toBe(true)
    expect(canAccessFile({ hasPublicSessionReference: true })).toBe(true)
    expect(canAccessFile({ isPublicSpeakerHeadshot: true })).toBe(true)
    expect(canAccessFile({})).toBe(false)
  })
})

describe('validatePinnedSubmission', () => {
  test('keeps using the response version after the live form gets a new version', () => {
    const OLD_MDX = dedent`
      <TextField name="title" required />
    `
    const NEW_MDX = dedent`
      <TextField name="renamedTitle" required />
    `
    const submission = { values: { title: 'Pinned title' }, participants: [] }

    const currentResult = validatePinnedSubmission({
      pinnedMdxSource: NEW_MDX,
      scope: { tracks: [], formats: [] },
      submission,
    })
    expect(currentResult.ok).toBe(false)

    const result = validatePinnedSubmission({
      pinnedMdxSource: OLD_MDX,
      scope: { tracks: [], formats: [] },
      submission,
    })

    expect(result).toMatchInlineSnapshot(`
      {
        "fields": [
          {
            "name": "title",
            "participantScope": false,
            "required": true,
            "type": "text",
          },
        ],
        "ok": true,
        "participantFields": [],
      }
    `)
  })
})
