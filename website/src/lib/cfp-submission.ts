// Pure CFP submission helpers. This module owns response caps, field-value
// flattening/restoration, pinned-version validation, file access decisions,
// and form open/close schedule rules (null opensAt/closesAt = no bound).
import { collectFields, type FormScope, type FormSubmission, type ValuesRecord } from '../forms/collect-fields.ts'
import { validateSubmission, type ValidateResult } from '../forms/validate.ts'

export const MAX_CFP_RESPONSES = 3
export const MAX_FIELD_VALUE_ROWS = 500

export function assertCfpResponseLimit(existingResponseCount: number) {
  if (existingResponseCount >= MAX_CFP_RESPONSES) {
    throw new Error(`You can submit at most ${MAX_CFP_RESPONSES} sessions to this event`)
  }
}

export function shouldCreateCfpDraft({ existingResponseCount, explicitlyRequested }: {
  existingResponseCount: number
  explicitlyRequested: boolean
}) {
  return existingResponseCount === 0 || explicitlyRequested
}

export function isResumableCfpDraft({ responseStatus, sessionStatus }: {
  responseStatus: 'DRAFT' | 'SUBMITTED'
  sessionStatus: string
}) {
  return responseStatus === 'DRAFT' && sessionStatus === 'DRAFT'
}

export type StoredFieldValue = {
  responseId: string
  name: string
  value: string
  fileId: string | null
  subjectSpeakerId: string | null
}

export function flattenSubmissionValues({
  responseId,
  submission,
  participantSpeakerIds,
  fileFieldNames,
}: {
  responseId: string
  submission: FormSubmission
  participantSpeakerIds: string[]
  fileFieldNames: ReadonlySet<string>
}): StoredFieldValue[] {
  if (submission.participants.length !== participantSpeakerIds.length) {
    throw new Error('Participant identities do not match the submitted participant values')
  }

  const rows: StoredFieldValue[] = []
  const append = (record: ValuesRecord, subjectSpeakerId: string | null) => {
    for (const [name, value] of Object.entries(record)) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (entry === '') continue
        rows.push({
          responseId,
          name,
          value: entry,
          fileId: fileFieldNames.has(name) ? entry : null,
          subjectSpeakerId,
        })
      }
    }
  }

  append(submission.values, null)
  submission.participants.forEach((record, index) => {
    append(record, participantSpeakerIds[index]!)
  })

  if (rows.length > MAX_FIELD_VALUE_ROWS) {
    throw new Error(`A form response can contain at most ${MAX_FIELD_VALUE_ROWS} values`)
  }
  return rows
}

export function restoreSubmissionValues({
  rows,
  participantSpeakerIds,
}: {
  rows: Array<{ name: string; value: string; subjectSpeakerId: string | null }>
  participantSpeakerIds: string[]
}): FormSubmission {
  const values: ValuesRecord = {}
  const participants = participantSpeakerIds.map<ValuesRecord>(() => ({}))
  const participantIndexes = new Map(participantSpeakerIds.map((id, index) => [id, index]))

  for (const row of rows) {
    const record = row.subjectSpeakerId == null
      ? values
      : participants[participantIndexes.get(row.subjectSpeakerId) ?? -1]
    if (!record) continue
    const current = record[row.name]
    record[row.name] = current == null
      ? row.value
      : Array.isArray(current)
        ? [...current, row.value]
        : [current, row.value]
  }
  return { values, participants }
}

export function validatePinnedSubmission({
  pinnedMdxSource,
  scope,
  submission,
}: {
  pinnedMdxSource: string
  scope: Omit<FormScope, 'values'>
  submission: FormSubmission
}): ValidateResult {
  const collected = collectFields({
    mdxSource: pinnedMdxSource,
    scope: { ...scope, values: submission.values },
  })
  return validateSubmission({ collected, ...submission })
}

export function getFileFieldNames(result: {
  fields: Array<{ name: string; type: string }>
  participantFields: Array<{ name: string; type: string }>
}): Set<string> {
  return new Set(
    [...result.fields, ...result.participantFields]
      .filter((field) => field.type === 'file')
      .map((field) => field.name),
  )
}

export function canAccessFile({
  isOrgMember = false,
  isOwningSpeaker = false,
  hasPublicSessionReference = false,
  isPublicSpeakerHeadshot = false,
}: {
  isOrgMember?: boolean
  isOwningSpeaker?: boolean
  hasPublicSessionReference?: boolean
  isPublicSpeakerHeadshot?: boolean
}): boolean {
  return isOrgMember || isOwningSpeaker || hasPublicSessionReference || isPublicSpeakerHeadshot
}

/** Status + optional schedule window for any form (CFP, portal, evaluation). */
export type FormScheduleInput = {
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'ARCHIVED'
  opensAt: number | null
  closesAt: number | null
}

/**
 * Why a form is not accepting input right now.
 * null opensAt / closesAt means no bound on that side — treat as open.
 */
export type FormScheduleBlock =
  | 'status_draft'
  | 'status_closed'
  | 'status_archived'
  | 'not_yet_open'
  | 'past_deadline'

/** Returns null when the form is open for submissions/reviews. */
export function formScheduleBlock(
  form: FormScheduleInput,
  now = Date.now(),
): FormScheduleBlock | null {
  if (form.status === 'DRAFT') return 'status_draft'
  if (form.status === 'CLOSED') return 'status_closed'
  if (form.status === 'ARCHIVED') return 'status_archived'
  if (form.status !== 'OPEN') return 'status_closed'
  // Omit opensAt → open immediately. Omit closesAt → never auto-close.
  if (form.opensAt != null && now < form.opensAt) return 'not_yet_open'
  if (form.closesAt != null && now >= form.closesAt) return 'past_deadline'
  return null
}

export function isFormScheduleOpen(form: FormScheduleInput, now = Date.now()): boolean {
  return formScheduleBlock(form, now) == null
}

export function formScheduleBlockMessage(block: FormScheduleBlock): string {
  switch (block) {
    case 'status_draft':
      return 'This form is still a draft.'
    case 'status_closed':
      return 'This form is closed.'
    case 'status_archived':
      return 'This form is archived.'
    case 'not_yet_open':
      return 'This form is not open yet.'
    case 'past_deadline':
      return 'This form closed at its deadline.'
  }
}
