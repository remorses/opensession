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
