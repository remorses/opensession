// Pure speaker roster, CSV import, participant, and communication rules.
// Effectful organizer actions use these functions after auth and tenancy checks.

export type SpeakerStatus = 'PENDING' | 'INVITED' | 'CONFIRMED' | 'DECLINED'

export type SpeakerCsvRow = {
  firstName: string
  lastName: string
  email: string
  jobTitle: string | null
  companyName: string | null
  bio: string | null
}

export type SpeakerCsvField = 'name' | 'firstName' | 'lastName' | 'email' | 'jobTitle' | 'companyName' | 'bio'

function parseCsvRecords(source: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      record.push(field)
      field = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      record.push(field)
      if (record.some((value) => value.trim())) records.push(record)
      record = []
      field = ''
    } else {
      field += char
    }
  }
  if (field || record.length > 0) {
    record.push(field)
    if (record.some((value) => value.trim())) records.push(record)
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field')
  return records
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') }
}

export function speakerCsvHeaders(source: string): string[] {
  return (parseCsvRecords(source)[0] ?? []).map((header) => header.trim())
}

export function parseSpeakerCsv(
  source: string,
  mapping: Partial<Record<SpeakerCsvField, string>> = {},
): SpeakerCsvRow[] {
  const [header = [], ...records] = parseCsvRecords(source)
  const indexes = new Map(header.map((value, index) => [value.trim().toLowerCase(), index]))
  const value = (record: string[], key: keyof typeof mapping, fallback: string) =>
    record[indexes.get((mapping[key] ?? fallback).toLowerCase()) ?? -1]?.trim() ?? ''
  return records.map((record) => {
    const wholeName = splitName(value(record, 'name', 'name'))
    return {
      firstName: value(record, 'firstName', 'first_name') || wholeName.firstName,
      lastName: value(record, 'lastName', 'last_name') || wholeName.lastName,
      email: normalizeSpeakerEmail(value(record, 'email', 'email')),
      jobTitle: value(record, 'jobTitle', 'title') || null,
      companyName: value(record, 'companyName', 'company') || null,
      bio: value(record, 'bio', 'bio') || null,
    }
  })
}

export function normalizeSpeakerEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function prepareSpeakerImport(rows: SpeakerCsvRow[], existingEmails: string[]) {
  const seen = new Set(existingEmails.map(normalizeSpeakerEmail))
  const inserted: SpeakerCsvRow[] = []
  const skipped: SpeakerCsvRow[] = []
  const errors: Array<{ row: number; message: string }> = []
  rows.forEach((row, index) => {
    if (!/^\S+@\S+\.\S+$/.test(row.email)) {
      errors.push({ row: index + 1, message: 'Invalid email address' })
      return
    }
    if (!row.firstName || !row.lastName) {
      errors.push({ row: index + 1, message: 'Name must include first and last name' })
      return
    }
    if (seen.has(row.email)) {
      skipped.push(row)
      return
    }
    seen.add(row.email)
    inserted.push(row)
  })
  return { inserted, skipped, errors }
}

export function filterSpeakers<T extends {
  firstName: string
  lastName: string
  email: string
  jobTitle: string | null
  companyName: string | null
  status: SpeakerStatus
}>(rows: T[], filter: { search: string; status?: SpeakerStatus | 'ALL' }): T[] {
  const search = filter.search.trim().toLowerCase()
  return rows.filter((row) => {
    if (filter.status && filter.status !== 'ALL' && row.status !== filter.status) return false
    if (!search) return true
    return [row.firstName, row.lastName, row.email, row.jobTitle, row.companyName]
      .some((value) => value?.toLowerCase().includes(search))
  })
}

export function planParticipantChange(input: {
  role: 'SPEAKER' | 'MODERATOR'
  confirmationStatus: 'PENDING' | 'CONFIRMED' | 'DECLINED'
  sortOrder: number
}, now: number) {
  return {
    ...input,
    confirmedAt: input.confirmationStatus === 'CONFIRMED' ? now : null,
    declinedAt: input.confirmationStatus === 'DECLINED' ? now : null,
  }
}

type MergeSpeaker = {
  id: string
  userId: string | null
  contactId: string | null
  status: SpeakerStatus
  bio: string | null
  jobTitle: string | null
  companyName: string | null
  pronouns: string | null
  websiteUrl: string | null
  linkedinUrl: string | null
  twitterUrl: string | null
  headshotFileId: string | null
  avatarUrl: string | null
}

type MergeParticipant = {
  id: string
  speakerId: string
  sessionId: string
  role: 'SPEAKER' | 'MODERATOR'
  confirmationStatus: 'PENDING' | 'CONFIRMED' | 'DECLINED'
  confirmedAt: number | null
  declinedAt: number | null
  sortOrder: number
}

type MergeAssignment = {
  id: string
  speakerId: string
  taskDefinitionId: string
  sessionId: string | null
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'
  dueAt: number | null
  completedAt: number | null
  responseIds: string[]
  fileIds: string[]
  commentIds: string[]
}

const speakerStatusRank: Record<SpeakerStatus, number> = {
  PENDING: 0,
  INVITED: 1,
  DECLINED: 2,
  CONFIRMED: 3,
}
const assignmentStatusRank = { NOT_STARTED: 0, IN_PROGRESS: 1, COMPLETED: 2 } as const

function richerValue<T>(survivor: T | null, duplicate: T | null): T | null {
  return survivor ?? duplicate
}

function taskKey(row: MergeAssignment): string {
  return `${row.taskDefinitionId}\u0000${row.sessionId ?? ''}`
}

export function planSpeakerMerge(input: {
  survivor: MergeSpeaker
  duplicate: MergeSpeaker
  participants: MergeParticipant[]
  assignments: MergeAssignment[]
  draftResponses: Array<{ id: string; formId: string; speakerId: string }>
  subjectValues: Array<{
    id: string
    responseId: string
    name: string
    value: string
    speakerId: string
  }>
}) {
  const { survivor, duplicate } = input
  if (survivor.id === duplicate.id) throw new Error('A speaker cannot be merged into itself')
  if (survivor.userId && duplicate.userId && survivor.userId !== duplicate.userId) {
    throw new Error('Cannot merge speakers linked to different user accounts')
  }
  const draftForms = new Set(input.draftResponses.filter((row) => row.speakerId === survivor.id).map((row) => row.formId))
  const duplicateDraft = input.draftResponses.find((row) => row.speakerId === duplicate.id && draftForms.has(row.formId))
  if (duplicateDraft) throw new Error(`Cannot merge speakers: both have an active draft for form "${duplicateDraft.formId}"`)

  const survivorParticipants = new Map(input.participants
    .filter((row) => row.speakerId === survivor.id)
    .map((row) => [row.sessionId, row]))
  const reassignParticipantIds: string[] = []
  const participantCollisions = input.participants
    .filter((row) => row.speakerId === duplicate.id)
    .flatMap((duplicateRow) => {
      const survivorRow = survivorParticipants.get(duplicateRow.sessionId)
      if (!survivorRow) {
        reassignParticipantIds.push(duplicateRow.id)
        return []
      }
      if (survivorRow.role !== duplicateRow.role) {
        throw new Error(`Cannot merge session "${duplicateRow.sessionId}": the speakers have different participant roles`)
      }
      const decisions = [survivorRow.confirmationStatus, duplicateRow.confirmationStatus]
        .filter((status) => status !== 'PENDING')
      if (new Set(decisions).size > 1) {
        throw new Error(`Cannot merge session "${duplicateRow.sessionId}": confirmation states conflict`)
      }
      const confirmationStatus = decisions[0] ?? 'PENDING'
      return [{
        survivorParticipantId: survivorRow.id,
        deleteParticipantId: duplicateRow.id,
        patch: {
          role: survivorRow.role,
          confirmationStatus,
          confirmedAt: confirmationStatus === 'CONFIRMED'
            ? richerValue(survivorRow.confirmedAt, duplicateRow.confirmedAt)
            : null,
          declinedAt: confirmationStatus === 'DECLINED'
            ? richerValue(survivorRow.declinedAt, duplicateRow.declinedAt)
            : null,
          sortOrder: Math.min(survivorRow.sortOrder, duplicateRow.sortOrder),
        },
      }]
    })

  const survivorAssignments = new Map(input.assignments
    .filter((row) => row.speakerId === survivor.id)
    .map((row) => [taskKey(row), row]))
  const reassignAssignmentIds: string[] = []
  const assignmentCollisions = input.assignments
    .filter((row) => row.speakerId === duplicate.id)
    .flatMap((duplicateRow) => {
      const survivorRow = survivorAssignments.get(taskKey(duplicateRow))
      if (!survivorRow) {
        reassignAssignmentIds.push(duplicateRow.id)
        return []
      }
      if (survivorRow.responseIds.length && duplicateRow.responseIds.length) {
        throw new Error(`Cannot merge task "${duplicateRow.taskDefinitionId}": both assignments have form responses`)
      }
      if (survivorRow.dueAt != null && duplicateRow.dueAt != null && survivorRow.dueAt !== duplicateRow.dueAt) {
        throw new Error(`Cannot merge task "${duplicateRow.taskDefinitionId}": due-date overrides conflict`)
      }
      if (survivorRow.completedAt != null && duplicateRow.completedAt != null && survivorRow.completedAt !== duplicateRow.completedAt) {
        throw new Error(`Cannot merge task "${duplicateRow.taskDefinitionId}": completion timestamps conflict`)
      }
      const status = assignmentStatusRank[survivorRow.status] >= assignmentStatusRank[duplicateRow.status]
        ? survivorRow.status
        : duplicateRow.status
      return [{
        survivorAssignmentId: survivorRow.id,
        deleteAssignmentId: duplicateRow.id,
        moveResponseIds: duplicateRow.responseIds,
        moveFileIds: duplicateRow.fileIds,
        moveCommentIds: duplicateRow.commentIds,
        patch: {
          status,
          dueAt: richerValue(survivorRow.dueAt, duplicateRow.dueAt),
          completedAt: status === 'COMPLETED'
            ? richerValue(survivorRow.completedAt, duplicateRow.completedAt)
            : null,
        },
      }]
    })

  const survivorSubjectKeys = new Set(input.subjectValues
    .filter((row) => row.speakerId === survivor.id)
    .map((row) => `${row.responseId}\u0000${row.name}\u0000${row.value}`))
  const deleteSubjectValueIds = input.subjectValues
    .filter((row) => row.speakerId === duplicate.id)
    .filter((row) => survivorSubjectKeys.has(`${row.responseId}\u0000${row.name}\u0000${row.value}`))
    .map((row) => row.id)

  const status = speakerStatusRank[survivor.status] >= speakerStatusRank[duplicate.status]
    ? survivor.status
    : duplicate.status
  return {
    profilePatch: {
      userId: richerValue(survivor.userId, duplicate.userId),
      contactId: richerValue(survivor.contactId, duplicate.contactId),
      status,
      bio: richerValue(survivor.bio, duplicate.bio),
      jobTitle: richerValue(survivor.jobTitle, duplicate.jobTitle),
      companyName: richerValue(survivor.companyName, duplicate.companyName),
      pronouns: richerValue(survivor.pronouns, duplicate.pronouns),
      websiteUrl: richerValue(survivor.websiteUrl, duplicate.websiteUrl),
      linkedinUrl: richerValue(survivor.linkedinUrl, duplicate.linkedinUrl),
      twitterUrl: richerValue(survivor.twitterUrl, duplicate.twitterUrl),
      headshotFileId: richerValue(survivor.headshotFileId, duplicate.headshotFileId),
      avatarUrl: richerValue(survivor.avatarUrl, duplicate.avatarUrl),
    },
    reassignParticipantIds,
    participantCollisions,
    reassignAssignmentIds,
    assignmentCollisions,
    deleteSubjectValueIds,
  }
}

export type SpeakerMergeRecipient = {
  firstName: string
  lastName: string
  email: string
  eventName: string
  portalUrl: string
  sessionTitles: string[]
}

const mergeFields = ['firstName', 'lastName', 'email', 'eventName', 'portalUrl', 'sessions'] as const
export const SPEAKER_MERGE_FIELDS = mergeFields.map((name) => `{{${name}}}`)

export function applySpeakerMergeFields(template: string, recipient: SpeakerMergeRecipient): string {
  const values: Record<(typeof mergeFields)[number], string> = {
    firstName: recipient.firstName,
    lastName: recipient.lastName,
    email: recipient.email,
    eventName: recipient.eventName,
    portalUrl: recipient.portalUrl,
    sessions: recipient.sessionTitles.join(', '),
  }
  return template.replace(/{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g, (_match, field: string) => {
    if (!mergeFields.includes(field as (typeof mergeFields)[number])) {
      throw new Error(`Unknown merge field: ${field}`)
    }
    return values[field as (typeof mergeFields)[number]]
  })
}
