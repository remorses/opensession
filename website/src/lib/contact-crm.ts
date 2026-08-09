// Pure organization CRM rules for CSV import, explicit segments, duplicate
// merges, the fixed sourcing pipeline, and derived dashboard metrics.
import type { SpeakerCsvRow } from './speaker-operations.ts'
export {
  parseSpeakerCsv as parseContactCsv,
  prepareSpeakerImport as prepareContactImport,
} from './speaker-operations.ts'

export const CONTACT_STAGES = [
  'RESEARCHING',
  'IDENTIFIED',
  'CONTACTED',
  'INTERESTED',
  'CONFIRMED',
  'DECLINED',
] as const

export type ContactStage = (typeof CONTACT_STAGES)[number]
export type ContactCsvRow = SpeakerCsvRow

export type ContactFilter = {
  search: string
  company: string
  title: string
  tagId: string
}

export function filterContacts<T extends {
  firstName: string
  lastName: string
  email: string
  companyName: string | null
  jobTitle: string | null
  tagIds: string[]
}>(contacts: T[], filter: ContactFilter): T[] {
  const search = filter.search.trim().toLowerCase()
  const company = filter.company.trim().toLowerCase()
  const title = filter.title.trim().toLowerCase()
  return contacts.filter((contact) => {
    if (company && !contact.companyName?.toLowerCase().includes(company)) return false
    if (title && !contact.jobTitle?.toLowerCase().includes(title)) return false
    if (filter.tagId && !contact.tagIds.includes(filter.tagId)) return false
    if (!search) return true
    return [contact.firstName, contact.lastName, contact.email, contact.companyName, contact.jobTitle]
      .some((value) => value?.toLowerCase().includes(search))
  })
}

type MergeProfile = {
  bio: string | null
  jobTitle: string | null
  companyName: string | null
}

export function planContactMerge(input: {
  primaryId: string
  duplicateId: string
  primaryTagIds: string[]
  duplicateTagIds: string[]
  primary: MergeProfile
  duplicate: MergeProfile
}) {
  if (input.primaryId === input.duplicateId) throw new Error('Choose two different contacts')
  return {
    contactPatch: {
      bio: input.primary.bio || input.duplicate.bio,
      jobTitle: input.primary.jobTitle || input.duplicate.jobTitle,
      companyName: input.primary.companyName || input.duplicate.companyName,
    },
    tagIds: [...new Set([...input.primaryTagIds, ...input.duplicateTagIds])].sort(),
    speakerContactId: input.primaryId,
    activityContactId: input.primaryId,
    emailContactId: input.primaryId,
    deleteContactId: input.duplicateId,
  }
}

export function contactMetrics(
  contacts: Array<{
    companyName: string | null
    eventIds: string[]
    stage: ContactStage | null
  }>,
  eventCount: number,
) {
  const companies = new Map<string, number>()
  for (const contact of contacts) {
    const company = contact.companyName?.trim()
    if (company) companies.set(company, (companies.get(company) ?? 0) + 1)
  }
  return {
    totalContacts: contacts.length,
    events: eventCount,
    returningSpeakers: contacts.filter((contact) => new Set(contact.eventIds).size > 1).length,
    inPipeline: contacts.filter((contact) => contact.stage && contact.stage !== 'DECLINED').length,
    topCompanies: [...companies.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 5),
  }
}

export function sameNameDuplicateGroups<T extends {
  id: string
  firstName: string
  lastName: string
}>(contacts: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const contact of contacts) {
    const key = `${contact.firstName.trim()} ${contact.lastName.trim()}`.toLowerCase()
    const group = groups.get(key)
    if (group) group.push(contact)
    else groups.set(key, [contact])
  }
  for (const [key, group] of groups) {
    if (group.length < 2) groups.delete(key)
  }
  return groups
}

export function stageLabel(stage: ContactStage): string {
  return stage[0] + stage.slice(1).toLowerCase()
}
