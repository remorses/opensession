// Pure CFP submission helpers. This module owns response caps, field-value
// flattening/restoration, pinned-version validation, and file access decisions.
import { collectFields, type FormScope, type FormSubmission, type ValuesRecord } from '../forms/collect-fields.ts'
import { validateSubmission, type ValidateResult } from '../forms/validate.ts'

export const MAX_CFP_RESPONSES = 3
export const MAX_FIELD_VALUE_ROWS = 500

export function assertCfpResponseLimit(existingResponseCount: number) {
  if (existingResponseCount >= MAX_CFP_RESPONSES) {
    throw new Error(`You can submit at most ${MAX_CFP_RESPONSES} sessions to this event`)
  }
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
