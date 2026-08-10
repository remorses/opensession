// Pure evaluation helpers: reviewer invitation decisions, blind projections,
// derived assignment state, weighted results, progress, sorting, and CSV.
import type { CollectedField, ValuesRecord } from '../forms/collect-fields.ts'

export type ReviewVote = 'YES' | 'MAYBE' | 'NO'

/** Compatibility aggregate for imported quick-review rows shown in abstract lists. */
export function aggregateReviewStats(
  reviews: Array<{ vote?: ReviewVote | null; rating?: number | null }>,
) {
  let yes = 0
  let maybe = 0
  let no = 0
  let ratingSum = 0
  let ratingCount = 0
  for (const review of reviews) {
    if (review.vote === 'YES') yes += 1
    if (review.vote === 'MAYBE') maybe += 1
    if (review.vote === 'NO') no += 1
    if (review.rating != null) {
      ratingSum += review.rating
      ratingCount += 1
    }
  }
  return {
    total: reviews.length,
    yes,
    maybe,
    no,
    avgRating: ratingCount === 0 ? null : ratingSum / ratingCount,
  }
}

export type ReviewState = 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'RECUSED'

export function invitationAcceptanceDecision(input: {
  now: number
  expiresAt: number
  invitedEmail: string
  userEmail: string
  emailVerified: boolean
}): { ok: true } | { ok: false; message: string } {
  if (input.expiresAt < input.now) return { ok: false, message: 'Invitation not found or expired' }
  if (!input.emailVerified) return { ok: false, message: 'Verify the invited email address before accepting' }
  if (input.invitedEmail.trim().toLowerCase() !== input.userEmail.trim().toLowerCase()) {
    return { ok: false, message: 'Sign in with the invited email address' }
  }
  return { ok: true }
}

export function reviewState(input: {
  recusedAt: number | null
  responseStatus: 'DRAFT' | 'SUBMITTED' | null
}): ReviewState {
  if (input.recusedAt != null) return 'RECUSED'
  if (input.responseStatus === 'SUBMITTED') return 'COMPLETED'
  if (input.responseStatus === 'DRAFT') return 'IN_PROGRESS'
  return 'ASSIGNED'
}

const IDENTITY_FIELD = /speaker\.|author|presenter|participant|name|email|company|employer|affiliation|organization|bio|job|pronoun|headshot|avatar|photo|linkedin|twitter/i

type AssignedSession = {
  id: string
  title: string | null
  description: string | null
  trackName: string | null
  formatName: string | null
  participants: unknown[]
  fieldValues: Array<{ name: string; value: string; subjectSpeakerId?: string | null }>
}

/** This function is the last boundary before reviewer loader serialization. */
export function projectAssignedSession<T extends AssignedSession>(row: T, blind: boolean) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    trackName: row.trackName,
    formatName: row.formatName,
    participants: blind ? [] : row.participants,
    fieldValues: blind
      ? row.fieldValues.filter((field) => field.subjectSpeakerId == null && !IDENTITY_FIELD.test(field.name))
      : row.fieldValues,
  }
}

export type Assignment = {
  id?: string
  sessionId: string
  reviewerId: string
  recusedAt: number | null
  response: { status: 'DRAFT' | 'SUBMITTED'; values: ValuesRecord } | null
  reviewer?: { name: string | null; email: string | null } | null
}

export function progressByReviewer(assignments: Assignment[]) {
  const rows = new Map<string, {
    reviewerId: string
    name: string
    email: string
    assigned: number
    completed: number
    inProgress: number
    recused: number
  }>()
  for (const assignment of assignments) {
    const row = rows.get(assignment.reviewerId) ?? {
      reviewerId: assignment.reviewerId,
      name: assignment.reviewer?.name?.trim() || 'Reviewer',
      email: assignment.reviewer?.email ?? '',
      assigned: 0,
      completed: 0,
      inProgress: 0,
      recused: 0,
    }
    row.assigned += 1
    const state = reviewState({
      recusedAt: assignment.recusedAt,
      responseStatus: assignment.response?.status ?? null,
    })
    if (state === 'COMPLETED') row.completed += 1
    if (state === 'IN_PROGRESS') row.inProgress += 1
    if (state === 'RECUSED') row.recused += 1
    rows.set(assignment.reviewerId, row)
  }
  return [...rows.values()].sort((a, b) => b.assigned - a.assigned || a.name.localeCompare(b.name))
}

export function coverageBySession(
  sessions: Array<{ id: string; title: string | null }>,
  assignments: Assignment[],
) {
  return sessions.map((session) => {
    const rows = assignments.filter((assignment) => assignment.sessionId === session.id)
    return {
      sessionId: session.id,
      title: session.title?.trim() || 'Untitled',
      assigned: rows.length,
      completed: rows.filter((assignment) => reviewState({
        recusedAt: assignment.recusedAt,
        responseStatus: assignment.response?.status ?? null,
      }) === 'COMPLETED').length,
    }
  })
}

export type EvaluationResult = {
  sessionId: string
  title: string
  aggregate: number | null
  completed: number
  assigned: number
  inProgress: number
  recused: number
  status: 'UNASSIGNED' | 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'RECUSED'
  answers: Record<string, string>
}

export function aggregateEvaluationResults(input: {
  sessions: Array<{ id: string; title: string | null }>
  fields: CollectedField[]
  assignments: Assignment[]
}): EvaluationResult[] {
  const numericFields = input.fields.filter((field) => field.type === 'number')
  return input.sessions.map((session) => {
    const assigned = input.assignments.filter((assignment) => assignment.sessionId === session.id)
    const completed = assigned.filter((assignment) => assignment.response?.status === 'SUBMITTED' && assignment.recusedAt == null)
    const inProgress = assigned.filter((assignment) => assignment.response?.status === 'DRAFT' && assignment.recusedAt == null).length
    const recused = assigned.filter((assignment) => assignment.recusedAt != null).length
    let weightedSum = 0
    let totalWeight = 0
    for (const assignment of completed) {
      for (const field of numericFields) {
        const value = Number(assignment.response!.values[field.name])
        if (!Number.isFinite(value)) continue
        const weight = field.weight ?? 1
        weightedSum += value * weight
        totalWeight += weight
      }
    }
    const answers: Record<string, string> = {}
    for (const field of input.fields) {
      const values = completed.flatMap((assignment) => {
        const value = assignment.response!.values[field.name]
        return value == null ? [] : [Array.isArray(value) ? value.join('; ') : value]
      })
      if (values.length > 0) answers[field.name] = values.join(' | ')
    }
    return {
      sessionId: session.id,
      title: session.title?.trim() || 'Untitled',
      aggregate: totalWeight > 0 ? weightedSum / totalWeight : null,
      completed: completed.length,
      assigned: assigned.length,
      inProgress,
      recused,
      status: assigned.length === 0
        ? 'UNASSIGNED'
        : completed.length === assigned.length
          ? 'COMPLETED'
          : recused === assigned.length
            ? 'RECUSED'
            : completed.length > 0 || inProgress > 0 || recused > 0
              ? 'IN_PROGRESS'
              : 'PENDING',
      answers,
    }
  })
}

export function sortEvaluationResults(rows: EvaluationResult[], direction: 'asc' | 'desc') {
  const factor = direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    if (a.aggregate == null && b.aggregate == null) return a.title.localeCompare(b.title)
    if (a.aggregate == null) return 1
    if (b.aggregate == null) return -1
    return (a.aggregate - b.aggregate) * factor || a.title.localeCompare(b.title)
  })
}

function csv(value: string | number | null): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function evaluationResultsToCsv(rows: EvaluationResult[], fields: CollectedField[]): string {
  const header = ['session_id', 'title', 'status', 'aggregate', 'completed', 'in_progress', 'recused', 'assigned', ...fields.map((field) => field.name)]
  const body = rows.map((row) => [
    row.sessionId,
    row.title,
    row.status,
    row.aggregate == null ? '' : row.aggregate.toFixed(4),
    row.completed,
    row.inProgress,
    row.recused,
    row.assigned,
    ...fields.map((field) => row.answers[field.name] ?? ''),
  ].map(csv).join(','))
  return [header.join(','), ...body].join('\n') + '\n'
}
