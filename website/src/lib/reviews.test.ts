// Pure tests for review normalization and evaluation progress helpers.
import { describe, expect, test } from 'vitest'
import {
  coverageBySession,
  isReviewableStatus,
  normalizeReviewInput,
  progressByReviewer,
  sessionsToReview,
} from './reviews.ts'

describe('normalizeReviewInput', () => {
  test('accepts yes/maybe/no with optional rating and trimmed comment', () => {
    expect(
      normalizeReviewInput({ vote: 'YES', rating: 4, comment: '  solid  ' }),
    ).toEqual({ vote: 'YES', rating: 4, comment: 'solid' })
    expect(normalizeReviewInput({ vote: 'NO' })).toEqual({
      vote: 'NO',
      rating: null,
      comment: null,
    })
  })

  test('rejects out-of-range ratings', () => {
    expect(() => normalizeReviewInput({ vote: 'YES', rating: 0 })).toThrow(/1 to 5/)
    expect(() => normalizeReviewInput({ vote: 'YES', rating: 6 })).toThrow(/1 to 5/)
    expect(() => normalizeReviewInput({ vote: 'YES', rating: 3.5 })).toThrow(/1 to 5/)
  })
})

describe('to-review filters', () => {
  test('only pending-ish unreviewed sessions appear', () => {
    expect(isReviewableStatus('PENDING')).toBe(true)
    expect(isReviewableStatus('ACCEPTED')).toBe(false)
    const sessions = [
      { id: '1', status: 'PENDING' },
      { id: '2', status: 'ACCEPT_QUEUE' },
      { id: '3', status: 'ACCEPTED' },
      { id: '4', status: 'PENDING' },
    ]
    expect(sessionsToReview(sessions, new Set(['1']))).toEqual([
      { id: '2', status: 'ACCEPT_QUEUE' },
      { id: '4', status: 'PENDING' },
    ])
  })
})

describe('progress helpers', () => {
  test('aggregates per reviewer and per session coverage', () => {
    expect(
      progressByReviewer([
        { reviewerId: 'u1', vote: 'YES', reviewer: { name: 'Ada', email: 'a@x.com' } },
        { reviewerId: 'u1', vote: 'NO', reviewer: { name: 'Ada', email: 'a@x.com' } },
        { reviewerId: 'u2', vote: 'MAYBE', reviewer: { name: 'Grace', email: 'g@x.com' } },
      ]),
    ).toMatchInlineSnapshot(`
      [
        {
          "email": "a@x.com",
          "maybe": 0,
          "name": "Ada",
          "no": 1,
          "reviewerId": "u1",
          "total": 2,
          "yes": 1,
        },
        {
          "email": "g@x.com",
          "maybe": 1,
          "name": "Grace",
          "no": 0,
          "reviewerId": "u2",
          "total": 1,
          "yes": 0,
        },
      ]
    `)

    expect(
      coverageBySession(
        [
          { id: 's1', title: 'Alpha', status: 'PENDING' },
          { id: 's2', title: 'Beta', status: 'ACCEPTED' },
          { id: 's3', title: 'Draft', status: 'DRAFT' },
        ],
        [{ sessionId: 's1' }, { sessionId: 's1' }],
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "reviewCount": 0,
          "sessionId": "s2",
          "status": "ACCEPTED",
          "title": "Beta",
        },
        {
          "reviewCount": 2,
          "sessionId": "s1",
          "status": "PENDING",
          "title": "Alpha",
        },
      ]
    `)
  })
})
