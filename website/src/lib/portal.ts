// Pure speaker-portal ownership, assignment filters, and completion rules.
// Server loaders/actions call these after loading speaker-scoped rows so
// authorization stays testable without DB mocks.

import type { SessionStatus } from './submissions.ts'
import { canTransition } from './submissions.ts'
import type { TaskAssignmentStatus, TaskSource, TaskTarget } from './tasks.ts'

export type PortalSessionRow = {
  id: string
  status: SessionStatus
  submitterSpeakerId: string | null
  participantSpeakerIds: string[]
}

export type PortalAssignmentRow = {
  id: string
  speakerId: string
  sessionId: string | null
  status: TaskAssignmentStatus
  target: TaskTarget
  source: TaskSource
  formId: string | null
}

export type PortalTasksTab = 'all' | 'mine' | 'submission'

export const PORTAL_TASKS_TABS: { value: PortalTasksTab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'My Tasks' },
  { value: 'submission', label: 'Submission Tasks' },
]

export function isSessionOwner(speakerId: string, session: PortalSessionRow): boolean {
  if (session.submitterSpeakerId === speakerId) return true
  return session.participantSpeakerIds.includes(speakerId)
}

export function canViewSession(speakerId: string, session: PortalSessionRow): boolean {
  return isSessionOwner(speakerId, session)
}

/** Speakers may edit their own PENDING submissions while the owning CFP is open. */
export function canEditSession(
  { speakerId, session, formIsOpen = true }: {
    speakerId: string
    session: PortalSessionRow
    formIsOpen?: boolean
  },
): boolean {
  return formIsOpen && isSessionOwner(speakerId, session) && session.status === 'PENDING'
}

/** Withdraw is a guarded transition to WITHDRAWN for owners. */
export function canWithdrawSession(speakerId: string, session: PortalSessionRow): boolean {
  return isSessionOwner(speakerId, session) && canTransition(session.status, 'WITHDRAWN')
}

export function filterPortalAssignments(
  assignments: PortalAssignmentRow[],
  tab: PortalTasksTab,
): PortalAssignmentRow[] {
  if (tab === 'all') return assignments
  if (tab === 'mine') return assignments.filter((row) => row.target === 'SPEAKER')
  return assignments.filter((row) => row.target === 'SUBMISSION')
}

export function parsePortalTasksTab(value: string | undefined): PortalTasksTab {
  if (value === 'mine' || value === 'submission' || value === 'all') return value
  return 'all'
}

/** MANUAL assignments complete from the portal button when still open. */
export function canCompleteManualAssignment(assignment: PortalAssignmentRow): boolean {
  if (assignment.source !== 'MANUAL') return false
  if (assignment.formId != null) return false
  return assignment.status === 'NOT_STARTED' || assignment.status === 'IN_PROGRESS'
}

/** FORM assignments can be submitted again so completed deliverables can receive
 * replacement versions without reopening the assignment. */
export function canSubmitFormAssignment(assignment: PortalAssignmentRow): boolean {
  if (assignment.source !== 'FORM') return false
  if (!assignment.formId) return false
  return true
}

export function assignmentOwnedBySpeaker(
  assignment: { speakerId: string },
  speakerId: string,
): boolean {
  return assignment.speakerId === speakerId
}

/** Prefer uploaded headshot file URL; else Google avatarUrl. */
export function speakerDisplayImage(speaker: {
  headshotFileId: string | null
  avatarUrl: string | null
}): string | null {
  if (speaker.headshotFileId) return `/files/${speaker.headshotFileId}`
  if (speaker.avatarUrl?.trim()) return speaker.avatarUrl.trim()
  return null
}

/** Pure split of Google display name into first/last for speaker rows. */
export function namesFromGoogleProfile(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const clean = (value: string) => value.trim().slice(0, 80)
  return {
    firstName: clean(parts[0] ?? 'Speaker'),
    lastName: clean(parts.slice(1).join(' ')),
  }
}

export function googleAvatarFromImage(image: string | null | undefined): string | null {
  const value = image?.trim()
  return value ? value.slice(0, 2000) : null
}

/** Fields to apply on create/claim: never overwrite a real headshot. */
export function speakerGooglePrefill(
  profile: { name: string; image: string | null },
  existing?: {
    firstName?: string | null
    lastName?: string | null
    headshotFileId?: string | null
    avatarUrl?: string | null
  } | null,
): {
  firstName?: string
  lastName?: string
  avatarUrl?: string | null
} {
  const names = namesFromGoogleProfile(profile.name)
  const patch: {
    firstName?: string
    lastName?: string
    avatarUrl?: string | null
  } = {}
  if (!existing?.firstName?.trim()) patch.firstName = names.firstName
  if (!existing?.lastName?.trim()) patch.lastName = names.lastName
  if (!existing?.headshotFileId) {
    const avatar = googleAvatarFromImage(profile.image)
    if (avatar && !existing?.avatarUrl?.trim()) patch.avatarUrl = avatar
  }
  return patch
}

export function countOpenAssignments(
  assignments: Array<{ status: TaskAssignmentStatus }>,
): number {
  return assignments.filter((row) => row.status !== 'COMPLETED').length
}
