// Pure tests for organization contact import, segments, merge planning, pipeline, and metrics.
import { describe, expect, test } from 'vitest'
import {
  CONTACT_STAGES,
  contactMetrics,
  filterContacts,
  parseContactCsv,
  planContactMerge,
  prepareContactImport,
} from './contact-crm.ts'

const fixtureCsv = `name,email,title,company,bio
Priya Raman,priya.speaker@sbek-test.example.com,Principal Engineer,Latticework Systems,"Leads the build-tooling platform team at Latticework Systems."
Marcus Okafor,marcus.speaker@sbek-test.example.com,Staff Developer Advocate,Cloudreach Labs,"Focused on AI agents in production; writes Agents Weekly."
Dana Kowalski,dana.speaker@sbek-test.example.com,Engineering Manager,Substrate,"Runs the developer-experience org at Substrate; ex-CI lead at a fintech."
`

describe('organization contact import', () => {
  test('parses and normalizes the evaluation fixture', () => {
    expect(parseContactCsv(fixtureCsv)).toMatchInlineSnapshot(`
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

  test('deduplicates by normalized organization email and reports bad rows', () => {
    const rows = parseContactCsv(`${fixtureCsv}Broken,not-an-email,,,
`)
    expect(prepareContactImport(rows, [' PRIYA.SPEAKER@sbek-test.example.com '])).toMatchInlineSnapshot(`
      {
        "errors": [
          {
            "message": "Invalid email address",
            "row": 4,
          },
        ],
        "inserted": [
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
        ],
        "skipped": [
          {
            "bio": "Leads the build-tooling platform team at Latticework Systems.",
            "companyName": "Latticework Systems",
            "email": "priya.speaker@sbek-test.example.com",
            "firstName": "Priya",
            "jobTitle": "Principal Engineer",
            "lastName": "Raman",
          },
        ],
      }
    `)
  })
})

describe('directory, segments, and merge', () => {
  const contacts = [
    { id: 'priya', firstName: 'Priya', lastName: 'Raman', email: 'p@example.test', companyName: 'Latticework', jobTitle: 'Principal Engineer', tagIds: ['ai'], eventIds: ['a', 'b'], stage: 'INTERESTED' as const },
    { id: 'marcus', firstName: 'Marcus', lastName: 'Okafor', email: 'm@example.test', companyName: 'Cloudreach', jobTitle: 'Advocate', tagIds: ['ai', 'platform'], eventIds: ['b'], stage: 'CONTACTED' as const },
    { id: 'dana', firstName: 'Dana', lastName: 'Kowalski', email: 'd@example.test', companyName: 'Substrate', jobTitle: 'Manager', tagIds: [], eventIds: [], stage: null },
  ]

  test('applies search and explicit segment criteria with AND semantics', () => {
    expect(filterContacts(contacts, { search: 'marc', company: 'cloud', title: 'adv', tagId: 'ai' }).map((row) => row.id)).toEqual(['marcus'])
    expect(filterContacts(contacts, { search: '', company: '', title: '', tagId: 'ai' }).map((row) => row.id)).toEqual(['priya', 'marcus'])
  })

  test('plans every dependent reassignment before deleting a duplicate', () => {
    expect(planContactMerge({
      primaryId: 'priya', duplicateId: 'priya-alt',
      primaryTagIds: ['ai'], duplicateTagIds: ['keynote', 'ai'],
      primary: { bio: 'Long bio', jobTitle: null, companyName: 'Latticework' },
      duplicate: { bio: null, jobTitle: 'Principal Engineer', companyName: 'Other' },
    })).toMatchInlineSnapshot(`
      {
        "activityContactId": "priya",
        "contactPatch": {
          "bio": "Long bio",
          "companyName": "Latticework",
          "jobTitle": "Principal Engineer",
        },
        "deleteContactId": "priya-alt",
        "emailContactId": "priya",
        "speakerContactId": "priya",
        "tagIds": [
          "ai",
          "keynote",
        ],
      }
    `)
  })
})

describe('fixed pipeline and derived metrics', () => {
  test('keeps one fixed open-to-terminal stage sequence', () => {
    expect(CONTACT_STAGES).toEqual(['RESEARCHING', 'IDENTIFIED', 'CONTACTED', 'INTERESTED', 'CONFIRMED', 'DECLINED'])
  })

  test('derives totals, returning speakers, pipeline counts, and top companies', () => {
    expect(contactMetrics([
      { companyName: 'Latticework', eventIds: ['a', 'b'], stage: 'CONFIRMED' },
      { companyName: 'Latticework', eventIds: ['a'], stage: 'INTERESTED' },
      { companyName: 'Cloudreach', eventIds: [], stage: null },
    ], 3)).toMatchInlineSnapshot(`
      {
        "events": 3,
        "inPipeline": 2,
        "returningSpeakers": 1,
        "topCompanies": [
          {
            "count": 2,
            "name": "Latticework",
          },
          {
            "count": 1,
            "name": "Cloudreach",
          },
        ],
        "totalContacts": 3,
      }
    `)
  })
})
