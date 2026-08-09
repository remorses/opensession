// Pure tests for speaker roster import, filtering, participants, and communications.
import { describe, expect, test } from 'vitest'
import {
  applySpeakerMergeFields,
  filterSpeakers,
  parseSpeakerCsv,
  speakerCsvHeaders,
  planParticipantChange,
  prepareSpeakerImport,
} from './speaker-operations.ts'

const fixtureCsv = `name,email,title,company,bio
Priya Raman,priya.speaker@sbek-test.example.com,Principal Engineer,Latticework Systems,"Leads the build-tooling platform team at Latticework Systems."
Marcus Okafor,marcus.speaker@sbek-test.example.com,Staff Developer Advocate,Cloudreach Labs,"Focused on AI agents in production; writes Agents Weekly."
Dana Kowalski,dana.speaker@sbek-test.example.com,Engineering Manager,Substrate,"Runs the developer-experience org at Substrate; ex-CI lead at a fintech."
`

describe('speaker CSV import', () => {
  test('parses the real evaluation fixture and maps identity fields', () => {
    expect(parseSpeakerCsv(fixtureCsv)).toMatchInlineSnapshot(`
      [
        {
          "bio": "Leads the build-tooling platform team at Latticework Systems.",
          "companyName": "Latticework Systems",
          "email": "priya.speaker@sbek-test.example.com",
          "firstName": "Priya",
          "jobTitle": "Principal Engineer",
          "lastName": "Raman",
        },
        {
          "bio": "Focused on AI agents in production; writes Agents Weekly.",
          "companyName": "Cloudreach Labs",
          "email": "marcus.speaker@sbek-test.example.com",
          "firstName": "Marcus",
          "jobTitle": "Staff Developer Advocate",
          "lastName": "Okafor",
        },
        {
          "bio": "Runs the developer-experience org at Substrate; ex-CI lead at a fintech.",
          "companyName": "Substrate",
          "email": "dana.speaker@sbek-test.example.com",
          "firstName": "Dana",
          "jobTitle": "Engineering Manager",
          "lastName": "Kowalski",
        },
      ]
    `)
  })

  test('maps non-standard fixture headers before previewing rows', () => {
    const source = 'Full Name,Contact,Role,Employer\nPriya Raman,PRIYA@example.com,Principal Engineer,Latticework\n'
    expect(speakerCsvHeaders(source)).toEqual(['Full Name', 'Contact', 'Role', 'Employer'])
    expect(parseSpeakerCsv(source, {
      name: 'Full Name',
      email: 'Contact',
      jobTitle: 'Role',
      companyName: 'Employer',
    })).toEqual([{
      firstName: 'Priya',
      lastName: 'Raman',
      email: 'priya@example.com',
      jobTitle: 'Principal Engineer',
      companyName: 'Latticework',
      bio: null,
    }])
  })

  test('normalizes event-email duplicates and reports invalid rows', () => {
    const rows = parseSpeakerCsv(`${fixtureCsv}Broken,not-an-email,,,\n`)
    const result = prepareSpeakerImport(rows, [
      ' PRIYA.SPEAKER@sbek-test.example.com ',
      'marcus.speaker@sbek-test.example.com',
    ])
    expect(result).toMatchObject({ inserted: [expect.objectContaining({ firstName: 'Dana' })] })
    expect(result.skipped).toHaveLength(2)
    expect(result.errors).toEqual([{ row: 4, message: 'Invalid email address' }])
  })
})

describe('speaker roster and participants', () => {
  const speakers = [
    { id: 'a', firstName: 'Priya', lastName: 'Raman', email: 'p@example.com', jobTitle: 'Engineer', companyName: 'Latticework', status: 'CONFIRMED' as const },
    { id: 'b', firstName: 'Marcus', lastName: 'Okafor', email: 'm@example.com', jobTitle: null, companyName: 'Cloudreach', status: 'PENDING' as const },
  ]

  test('filters by case-insensitive text and explicit status', () => {
    expect(filterSpeakers(speakers, { search: 'LATTICE', status: 'CONFIRMED' }).map((row) => row.id)).toEqual(['a'])
    expect(filterSpeakers(speakers, { search: '', status: 'PENDING' }).map((row) => row.id)).toEqual(['b'])
  })

  test('sets role, order, and mutually exclusive confirmation timestamps', () => {
    expect(planParticipantChange({ role: 'MODERATOR', confirmationStatus: 'CONFIRMED', sortOrder: 2 }, 500)).toEqual({
      role: 'MODERATOR', confirmationStatus: 'CONFIRMED', sortOrder: 2, confirmedAt: 500, declinedAt: null,
    })
    expect(planParticipantChange({ role: 'SPEAKER', confirmationStatus: 'DECLINED', sortOrder: 0 }, 600)).toEqual({
      role: 'SPEAKER', confirmationStatus: 'DECLINED', sortOrder: 0, confirmedAt: null, declinedAt: 600,
    })
  })
})

describe('custom communication merge fields', () => {
  const recipient = {
    firstName: 'Priya', lastName: 'Raman', email: 'p@example.com',
    eventName: 'DevFlow Conf 2027', portalUrl: 'https://opensession.dev/portal/devflow',
    sessionTitles: ['Taming CI'],
  }

  test('resolves the explicit safe field set', () => {
    expect(applySpeakerMergeFields('Hi {{firstName}}, {{eventName}}: {{sessions}} {{portalUrl}}', recipient))
      .toBe('Hi Priya, DevFlow Conf 2027: Taming CI https://opensession.dev/portal/devflow')
  })

  test('rejects unknown fields instead of leaking arbitrary data', () => {
    expect(() => applySpeakerMergeFields('Token: {{password}}', recipient)).toThrow(/Unknown merge field: password/)
  })
})
