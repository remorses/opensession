// Reserved field `name`s → typed columns (pure, no DB).
//
// The MDX form engine stores every submitted value as FormFieldValue KV
// rows, but a handful of well-known names are ALSO copied to typed entity
// columns on submit: session fields to eventSession, `speaker.*` fields to
// the Speaker rows created per participant. Everything else stays custom.
// The submit action (task 4) calls extractWellKnown() to split a validated
// submission into those three buckets.

import type { FormSubmission } from './collect-fields.ts'

/** Top-level names → eventSession columns. `track`/`format` values are the
 *  library row ids (Select options come from libraryOptions), stored in the
 *  FK-checked trackId/formatId columns. */
export const sessionWellKnown = {
  title: 'title',
  description: 'description',
  track: 'trackId',
  format: 'formatId',
} as const

/** Participant-scoped names → speaker columns. `speaker.headshot` holds the
 *  uploaded File row id (FileUpload stores fileId strings). */
export const speakerWellKnown = {
  'speaker.firstName': 'firstName',
  'speaker.lastName': 'lastName',
  'speaker.email': 'email',
  'speaker.bio': 'bio',
  'speaker.jobTitle': 'jobTitle',
  'speaker.companyName': 'companyName',
  'speaker.pronouns': 'pronouns',
  'speaker.websiteUrl': 'websiteUrl',
  'speaker.linkedinUrl': 'linkedinUrl',
  'speaker.twitterUrl': 'twitterUrl',
  'speaker.headshot': 'headshotFileId',
} as const

export type SessionColumn = (typeof sessionWellKnown)[keyof typeof sessionWellKnown]
export type SpeakerColumn = (typeof speakerWellKnown)[keyof typeof speakerWellKnown]

export type ExtractedWellKnown = {
  session: Partial<Record<SessionColumn, string>>
  /** One entry per submitted participant, same order. */
  speakers: Array<Partial<Record<SpeakerColumn, string>>>
  /** Non-well-known values, flattened one row per value (multi-selects
   *  produce one row per selected entry — matches formFieldValue rows).
   *  participantIndex is null for top-level values. */
  customValues: Array<{ name: string; value: string; participantIndex: number | null }>
}

export function extractWellKnown({ values, participants }: FormSubmission): ExtractedWellKnown {
  const result: ExtractedWellKnown = { session: {}, speakers: [], customValues: [] }

  for (const [name, value] of Object.entries(values)) {
    const column = (sessionWellKnown as Record<string, SessionColumn>)[name]
    // Well-known session fields are single-valued; arrays (multi-selects)
    // can never map to a typed column, so they fall through to custom.
    if (column && typeof value === 'string') {
      result.session[column] = value
      continue
    }
    pushCustom(result, name, value, null)
  }

  participants.forEach((record, index) => {
    const speaker: Partial<Record<SpeakerColumn, string>> = {}
    for (const [name, value] of Object.entries(record)) {
      const column = (speakerWellKnown as Record<string, SpeakerColumn>)[name]
      if (column && typeof value === 'string') {
        speaker[column] = value
        continue
      }
      pushCustom(result, name, value, index)
    }
    result.speakers.push(speaker)
  })

  return result
}

function pushCustom(
  result: ExtractedWellKnown,
  name: string,
  value: string | string[],
  participantIndex: number | null,
) {
  const entries = Array.isArray(value) ? value : [value]
  for (const entry of entries) {
    if (entry === '') continue
    result.customValues.push({ name, value: entry, participantIndex })
  }
}
