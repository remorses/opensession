// Pure review helpers: vote/rating validation and upsert payload shape.
// Uniqueness is (sessionId, reviewerId) — enforced by the DB unique index;
// callers upsert with onConflictDoUpdate on that pair.

export type ReviewVote = 'YES' | 'MAYBE' | 'NO'

export type ReviewInput = {
  vote: ReviewVote
  rating: number | null
  comment: string | null
}

export function normalizeReviewInput(input: {
  vote: ReviewVote
  rating?: number | null
  comment?: string | null
}): ReviewInput {
  const rating = input.rating == null || Number.isNaN(input.rating) ? null : input.rating
  if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    throw new Error('Rating must be an integer from 1 to 5')
  }
  const comment = input.comment?.trim() ? input.comment.trim() : null
  if (comment && comment.length > 5000) {
    throw new Error('Comment must be at most 5000 characters')
  }
  return { vote: input.vote, rating, comment }
}

/** Sessions eligible for the Evaluation "To Review" tab: still in the
 *  decision pipeline and not yet reviewed by the caller. */
export function isReviewableStatus(status: string): boolean {
  return status === 'PENDING' || status === 'ACCEPT_QUEUE' || status === 'DECLINE_QUEUE'
}

export function sessionsToReview<T extends { id: string; status: string }>(
  sessions: T[],
  reviewedSessionIds: ReadonlySet<string>,
): T[] {
  return sessions.filter(
    (session) => isReviewableStatus(session.status) && !reviewedSessionIds.has(session.id),
  )
}

export type ReviewerProgress = {
  reviewerId: string
  name: string
  email: string
  total: number
  yes: number
  maybe: number
  no: number
}

export function progressByReviewer(
  reviews: Array<{
    reviewerId: string
    vote: ReviewVote
    reviewer?: { name: string | null; email: string | null } | null
  }>,
): ReviewerProgress[] {
  const map = new Map<string, ReviewerProgress>()
  for (const review of reviews) {
    let row = map.get(review.reviewerId)
    if (!row) {
      row = {
        reviewerId: review.reviewerId,
        name: review.reviewer?.name?.trim() || 'Unknown',
        email: review.reviewer?.email ?? '',
        total: 0,
        yes: 0,
        maybe: 0,
        no: 0,
      }
      map.set(review.reviewerId, row)
    }
    row.total += 1
    if (review.vote === 'YES') row.yes += 1
    else if (review.vote === 'MAYBE') row.maybe += 1
    else row.no += 1
  }
  return [...map.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

export type SessionCoverage = {
  sessionId: string
  title: string
  status: string
  reviewCount: number
}

export function coverageBySession(
  sessions: Array<{ id: string; title: string | null; status: string }>,
  reviews: Array<{ sessionId: string }>,
): SessionCoverage[] {
  const counts = new Map<string, number>()
  for (const review of reviews) {
    counts.set(review.sessionId, (counts.get(review.sessionId) ?? 0) + 1)
  }
  return sessions
    .filter((session) => isReviewableStatus(session.status) || session.status === 'ACCEPTED' || session.status === 'DECLINED')
    .map((session) => ({
      sessionId: session.id,
      title: session.title?.trim() || 'Untitled',
      status: session.status,
      reviewCount: counts.get(session.id) ?? 0,
    }))
    .sort((a, b) => a.reviewCount - b.reviewCount || a.title.localeCompare(b.title))
}
