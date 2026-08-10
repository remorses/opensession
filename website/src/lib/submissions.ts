// Pure session status transitions, queue helpers, status-tab filters, and
// CSV export for the Abstracts admin flow.
// notifiedAt is stamped by notifyQueue only after the current decision email
// reaches SENT. Starting a redecision clears the obsolete delivery timestamp.

export type SessionStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'ACCEPT_QUEUE'
  | 'ACCEPTED'
  | 'DECLINE_QUEUE'
  | 'DECLINED'
  | 'WITHDRAWN'

/** Query-param tabs on /abstracts — maps to one or more DB statuses. */
export type AbstractsStatusTab =
  | 'all'
  | 'pending'
  | 'accept-queue'
  | 'accepted'
  | 'decline-queue'
  | 'declined'
  | 'withdrawn'
  | 'drafts'

export const ABSTRACTS_STATUS_TABS: {
  value: AbstractsStatusTab
  label: string
  statuses: SessionStatus[] | null
}[] = [
  { value: 'all', label: 'All', statuses: null },
  { value: 'pending', label: 'Pending', statuses: ['PENDING'] },
  { value: 'accept-queue', label: 'Accept Queue', statuses: ['ACCEPT_QUEUE'] },
  { value: 'accepted', label: 'Accepted', statuses: ['ACCEPTED'] },
  { value: 'decline-queue', label: 'Decline Queue', statuses: ['DECLINE_QUEUE'] },
  { value: 'declined', label: 'Declined', statuses: ['DECLINED'] },
  { value: 'withdrawn', label: 'Withdrawn', statuses: ['WITHDRAWN'] },
  { value: 'drafts', label: 'Drafts', statuses: ['DRAFT'] },
]

/** Legal directed edges of Session.status (database-schema-plan state machine). */
const TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  DRAFT: ['PENDING', 'WITHDRAWN'],
  PENDING: ['ACCEPT_QUEUE', 'DECLINE_QUEUE', 'WITHDRAWN'],
  ACCEPT_QUEUE: ['ACCEPTED', 'PENDING', 'DECLINE_QUEUE', 'WITHDRAWN'],
  DECLINE_QUEUE: ['DECLINED', 'PENDING', 'ACCEPT_QUEUE', 'WITHDRAWN'],
  ACCEPTED: ['DECLINE_QUEUE'],
  DECLINED: ['ACCEPT_QUEUE'],
  WITHDRAWN: [],
}

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  if (from === to) return false
  return TRANSITIONS[from].includes(to)
}

export type TransitionableSession = {
  status: SessionStatus
  title: string | null
  submittedAt: number | null
  decidedAt: number | null
  withdrawnAt: number | null
  notifiedAt?: number | null
}

export type SessionTransitionPatch = {
  status: SessionStatus
  /** Set when the row had no title and we backfill for the DB CHECK. */
  title?: string
  submittedAt: number | null
  decidedAt: number | null
  withdrawnAt: number | null
  /** Cleared only when a finalized outcome enters the opposite decision queue. */
  notifiedAt?: null
  updatedAt: number
}

/** Placeholder when a submitted row lost its projected title (legacy data or
 *  form without a well-known `title` field). Keeps the DB CHECK happy. */
export const UNTITLED_SESSION_TITLE = 'Untitled'

/** Apply a guarded status transition. Final outcomes can enter the opposite
 *  queue for redecision; that clears timestamps for the obsolete outcome. */
export function applyTransition(
  session: TransitionableSession,
  to: SessionStatus,
  now: number,
): SessionTransitionPatch {
  if (!canTransition(session.status, to)) {
    throw new Error(`Cannot move session from ${session.status} to ${to}`)
  }

  // Non-DRAFT rows need a non-empty title (DB CHECK). Older/broken rows may
  // already be PENDING with a null title — backfill instead of blocking the
  // accept-queue buttons with a cryptic throw.
  const existingTitle = session.title?.trim() ?? ''
  const needsTitle = to !== 'DRAFT' && !existingTitle

  const reconsidering = session.status === 'ACCEPTED' || session.status === 'DECLINED'
  return {
    status: to,
    ...(needsTitle ? { title: UNTITLED_SESSION_TITLE } : {}),
    submittedAt:
      to === 'PENDING' && session.submittedAt == null
        ? now
        : session.submittedAt,
    decidedAt: reconsidering
      ? null
      : to === 'ACCEPTED' || to === 'DECLINED'
        ? now
        : session.decidedAt,
    withdrawnAt:
      to === 'WITHDRAWN' && session.withdrawnAt == null
        ? now
        : session.withdrawnAt,
    ...(reconsidering ? { notifiedAt: null } : {}),
    updatedAt: now,
  }
}

/** Bulk move with all-or-nothing validation. Silent partial updates leave a
 *  selected list in an unknowable state, so every invalid row is reported. */
export function planBulkStatusUpdate(
  sessions: Array<TransitionableSession & { id: string }>,
  to: SessionStatus,
  now: number,
): Array<{ id: string } & SessionTransitionPatch> {
  const invalid = sessions.filter((session) => !canTransition(session.status, to))
  if (invalid.length > 0) {
    throw new Error(`${invalid.length} selected session${invalid.length === 1 ? '' : 's'} cannot move to ${to}`)
  }
  const out: Array<{ id: string } & SessionTransitionPatch> = []
  for (const session of sessions) {
    out.push({ id: session.id, ...applyTransition(session, to, now) })
  }
  return out
}

/** Finalise an accept or decline queue: ACCEPT_QUEUE→ACCEPTED or
 *  DECLINE_QUEUE→DECLINED. Returns only sessions that could move. */
export function planNotifyQueue(
  sessions: Array<TransitionableSession & { id: string }>,
  queue: 'accept' | 'decline',
  now: number,
): Array<{ id: string; from: SessionStatus } & SessionTransitionPatch> {
  const fromStatus: SessionStatus = queue === 'accept' ? 'ACCEPT_QUEUE' : 'DECLINE_QUEUE'
  const toStatus: SessionStatus = queue === 'accept' ? 'ACCEPTED' : 'DECLINED'
  const out: Array<{ id: string; from: SessionStatus } & SessionTransitionPatch> = []
  for (const session of sessions) {
    if (session.status !== fromStatus) continue
    out.push({
      id: session.id,
      from: session.status,
      ...applyTransition(session, toStatus, now),
    })
  }
  return out
}

export function parseAbstractsStatusTab(value: string | null | undefined): AbstractsStatusTab {
  const found = ABSTRACTS_STATUS_TABS.find((row) => row.value === value)
  return found?.value ?? 'all'
}

export function statusesForTab(tab: AbstractsStatusTab): SessionStatus[] | null {
  const found = ABSTRACTS_STATUS_TABS.find((row) => row.value === tab)
  return found?.statuses ?? null
}

export function filterSessionsByTab<T extends { status: SessionStatus }>(
  sessions: T[],
  tab: AbstractsStatusTab,
): T[] {
  const statuses = statusesForTab(tab)
  if (!statuses) return sessions
  return sessions.filter((row) => statuses.includes(row.status))
}

export function countSessionsByTab(
  sessions: Array<{ status: SessionStatus }>,
): Record<AbstractsStatusTab, number> {
  const counts = Object.fromEntries(
    ABSTRACTS_STATUS_TABS.map((tab) => [tab.value, 0]),
  ) as Record<AbstractsStatusTab, number>
  counts.all = sessions.length
  for (const session of sessions) {
    for (const tab of ABSTRACTS_STATUS_TABS) {
      if (tab.statuses?.includes(session.status)) counts[tab.value] += 1
    }
  }
  return counts
}

/** Case-insensitive substring match across title + speaker names + track/format. */
export function sessionMatchesQuery(
  session: {
    title: string | null
    trackName?: string | null
    formatName?: string | null
    speakerNames?: string[]
  },
  q: string,
): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const haystacks = [
    session.title ?? '',
    session.trackName ?? '',
    session.formatName ?? '',
    ...(session.speakerNames ?? []),
  ]
  return haystacks.some((part) => part.toLowerCase().includes(needle))
}

/** Stable CSV cell escape (RFC 4180-ish). */
export function csvEscape(value: string | number | null | undefined): string {
  if (value == null) return ''
  const text = String(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function abstractsToCsv(
  rows: Array<{
    status: SessionStatus
    title: string | null
    trackName: string | null
    formatName: string | null
    speakerNames: string[]
    formName: string | null
    avgRating: number | null
    yes: number
    maybe: number
    no: number
    notifiedAt: number | null
    submittedAt: number | null
  }>,
): string {
  const header = [
    'status',
    'title',
    'track',
    'format',
    'speakers',
    'form',
    'avg_rating',
    'yes',
    'maybe',
    'no',
    'notified_at',
    'submitted_at',
  ].join(',')
  const lines = rows.map((row) =>
    [
      csvEscape(row.status),
      csvEscape(row.title),
      csvEscape(row.trackName),
      csvEscape(row.formatName),
      csvEscape(row.speakerNames.join('; ')),
      csvEscape(row.formName),
      csvEscape(row.avgRating == null ? '' : row.avgRating.toFixed(2)),
      csvEscape(row.yes),
      csvEscape(row.maybe),
      csvEscape(row.no),
      csvEscape(row.notifiedAt),
      csvEscape(row.submittedAt),
    ].join(','),
  )
  return [header, ...lines].join('\n') + '\n'
}
