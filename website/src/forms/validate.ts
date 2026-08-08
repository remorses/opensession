// Server-side validation of a submitted { values, participants } payload
// against the fields collected from the form's MDX (pure, no DB, no throw
// for validation failures — a typed result is returned instead).
//
// The collector already applied the conditional logic with the SUBMITTED
// values in scope, so `collected` is exactly the set of fields the user
// saw. Anything submitted outside that set is rejected (tamper-proofing:
// a hidden required field cannot be skipped, an invisible field cannot be
// smuggled in).

import type { CollectedField, CollectResult, FieldValue, ValuesRecord } from './collect-fields.ts'

export type ValidationIssue = {
  /** Field name when the issue is field-scoped; omitted for form-level issues. */
  name?: string
  message: string
}

export type ValidateResult =
  | { ok: true; fields: CollectedField[]; participantFields: CollectedField[] }
  | { ok: false; errors: ValidationIssue[] }

export function validateSubmission({
  collected,
  values,
  participants,
}: {
  collected: CollectResult
  values: ValuesRecord
  participants: ValuesRecord[]
}): ValidateResult {
  const errors: ValidationIssue[] = []

  // A broken form definition never validates: surface safe-mdx errors
  // (bad expressions, unknown components) with their line numbers.
  for (const err of collected.errors) {
    errors.push({ message: err.line ? `Form definition error (line ${err.line}): ${err.message}` : `Form definition error: ${err.message}` })
  }
  if (errors.length > 0) return { ok: false, errors }

  // Participant count against the <Participants min max> block.
  if (!collected.participants) {
    if (participants.length > 0) {
      errors.push({ message: 'This form has no participants section, but participant values were submitted' })
    }
  } else {
    const { min, max } = collected.participants
    if (participants.length < min) {
      errors.push({ message: `At least ${min} participant${min === 1 ? '' : 's'} required` })
    }
    if (participants.length > max) {
      errors.push({ message: `At most ${max} participant${max === 1 ? '' : 's'} allowed` })
    }
  }

  const topLevel = new Map(collected.fields.map((f) => [f.name, f]))
  const perParticipant = new Map(collected.participantFields.map((f) => [f.name, f]))

  // Unknown names → reject (values the visible form could not have produced).
  for (const name of Object.keys(values)) {
    if (!topLevel.has(name)) errors.push({ name, message: `Unknown field "${name}"` })
  }
  participants.forEach((record, index) => {
    for (const name of Object.keys(record)) {
      if (!perParticipant.has(name)) {
        errors.push({ name, message: `Unknown participant field "${name}" (participant ${index + 1})` })
      }
    }
  })

  // Per-field checks: required, shape, maxLength, option membership.
  for (const field of collected.fields) {
    checkField(field, values[field.name], null, errors)
  }
  participants.forEach((record, index) => {
    for (const field of collected.participantFields) {
      checkField(field, record[field.name], index, errors)
    }
  })

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, fields: collected.fields, participantFields: collected.participantFields }
}

function isEmpty(value: FieldValue | undefined): boolean {
  if (value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  return value.length === 0
}

function checkField(
  field: CollectedField,
  value: FieldValue | undefined,
  participantIndex: number | null,
  errors: ValidationIssue[],
) {
  const where = participantIndex == null ? '' : ` (participant ${participantIndex + 1})`
  const label = `"${field.name}"${where}`

  if (value === undefined || isEmpty(value)) {
    // Required checkbox means "must be checked": 'false' and absent both fail.
    if (field.required) errors.push({ name: field.name, message: `${label} is required` })
    return
  }
  const present = value

  // Shape: only multi-selects submit arrays.
  if (Array.isArray(present) && !(field.type === 'select' && field.multiple)) {
    errors.push({ name: field.name, message: `${label} must be a single value` })
    return
  }
  const entries = Array.isArray(present) ? present : [present]
  if (entries.some((entry) => typeof entry !== 'string')) {
    errors.push({ name: field.name, message: `${label} must contain strings` })
    return
  }

  if (field.maxLength != null) {
    for (const entry of entries) {
      if (entry.length > field.maxLength) {
        errors.push({ name: field.name, message: `${label} must be at most ${field.maxLength} characters` })
        break
      }
    }
  }

  if (field.type === 'checkbox') {
    if (present !== 'true' && present !== 'false') {
      errors.push({ name: field.name, message: `${label} must be "true" or "false"` })
    } else if (field.required && present !== 'true') {
      errors.push({ name: field.name, message: `${label} must be checked` })
    }
    return
  }

  if ((field.type === 'select' || field.type === 'radio') && field.options && field.options.length > 0) {
    const allowed = new Set(field.options.map((option) => option.value))
    for (const entry of entries) {
      if (!allowed.has(entry)) {
        errors.push({ name: field.name, message: `${label} has an invalid option "${entry}"` })
      }
    }
  }
}
