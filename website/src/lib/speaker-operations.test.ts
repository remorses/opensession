// Pure tests for speaker roster import, filtering, participants, and communications.
import { describe, expect, test } from 'vitest'
import {
  applySpeakerMergeFields,
  filterSpeakers,
  parseSpeakerCsv,
  planSpeakerMerge,
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

describe('speaker merge planning', () => {
  const survivor = {
    id: 'speaker-a', firstName: 'Priya', lastName: 'Raman', email: 'priya@example.com',
    status: 'CONFIRMED' as const, bio: 'Primary bio', jobTitle: null, companyName: 'Latticework',
    pronouns: null, websiteUrl: null, linkedinUrl: null, twitterUrl: null,
    headshotFileId: null, avatarUrl: null, userId: 'user-a', contactId: null,
  }
  const duplicate = {
    ...survivor, id: 'speaker-b', email: 'priya.old@example.com', status: 'INVITED' as const,
    bio: 'Duplicate bio', jobTitle: 'Principal Engineer', companyName: null,
    websiteUrl: 'https://priya.example.com', userId: null,
  }

  test('fills blank survivor fields and resolves participant and task collisions', () => {
    expect(planSpeakerMerge({
      survivor,
      duplicate,
      participants: [
        { id: 'participant-a', speakerId: survivor.id, sessionId: 'session-a', role: 'SPEAKER', confirmationStatus: 'PENDING', confirmedAt: null, declinedAt: null, sortOrder: 2 },
        { id: 'participant-b', speakerId: duplicate.id, sessionId: 'session-a', role: 'SPEAKER', confirmationStatus: 'CONFIRMED', confirmedAt: 200, declinedAt: null, sortOrder: 0 },
        { id: 'participant-c', speakerId: duplicate.id, sessionId: 'session-b', role: 'MODERATOR', confirmationStatus: 'PENDING', confirmedAt: null, declinedAt: null, sortOrder: 1 },
      ],
      assignments: [
        { id: 'assignment-a', speakerId: survivor.id, taskDefinitionId: 'task-a', sessionId: null, status: 'IN_PROGRESS', dueAt: null, completedAt: null, responseIds: [], fileIds: ['file-a'], commentIds: [] },
        { id: 'assignment-b', speakerId: duplicate.id, taskDefinitionId: 'task-a', sessionId: null, status: 'COMPLETED', dueAt: 400, completedAt: 300, responseIds: ['response-b'], fileIds: ['file-b'], commentIds: ['comment-b'] },
      ],
      draftResponses: [],
      subjectValues: [],
    })).toMatchInlineSnapshot(`
      {
        "assignmentCollisions": [
          {
            "deleteAssignmentId": "assignment-b",
            "moveCommentIds": [
              "comment-b",
            ],
            "moveFileIds": [
              "file-b",
            ],
            "moveResponseIds": [
              "response-b",
            ],
            "patch": {
              "completedAt": 300,
              "dueAt": 400,
              "status": "COMPLETED",
            },
            "survivorAssignmentId": "assignment-a",
          },
        ],
        "deleteSubjectValueIds": [],
        "participantCollisions": [
          {
            "deleteParticipantId": "participant-b",
            "patch": {
              "confirmationStatus": "CONFIRMED",
              "confirmedAt": 200,
              "declinedAt": null,
              "role": "SPEAKER",
              "sortOrder": 0,
            },
            "survivorParticipantId": "participant-a",
          },
        ],
        "profilePatch": {
          "avatarUrl": null,
          "bio": "Primary bio",
          "companyName": "Latticework",
          "contactId": null,
          "headshotFileId": null,
          "jobTitle": "Principal Engineer",
          "linkedinUrl": null,
          "pronouns": null,
          "status": "CONFIRMED",
          "twitterUrl": null,
          "userId": "user-a",
          "websiteUrl": "https://priya.example.com",
        },
        "reassignAssignmentIds": [],
        "reassignParticipantIds": [
          "participant-c",
        ],
      }
    `)
  })

  test('rejects ownership and dependent collisions that cannot be represented safely', () => {
    expect(() => planSpeakerMerge({
      survivor,
      duplicate: { ...duplicate, userId: 'user-b' },
      participants: [], assignments: [], draftResponses: [], subjectValues: [],
    })).toThrowErrorMatchingInlineSnapshot(`[Error: Cannot merge speakers linked to different user accounts]`)

    expect(() => planSpeakerMerge({
      survivor, duplicate, participants: [],
      assignments: [
        { id: 'a', speakerId: survivor.id, taskDefinitionId: 'task', sessionId: null, status: 'COMPLETED', dueAt: null, completedAt: 1, responseIds: ['response-a'], fileIds: [], commentIds: [] },
        { id: 'b', speakerId: duplicate.id, taskDefinitionId: 'task', sessionId: null, status: 'COMPLETED', dueAt: null, completedAt: 2, responseIds: ['response-b'], fileIds: [], commentIds: [] },
      ],
      draftResponses: [], subjectValues: [],
    })).toThrowErrorMatchingInlineSnapshot(`[Error: Cannot merge task "task": both assignments have form responses]`)
  })

  test('removes only redundant subject values and rejects active draft collisions', () => {
    expect(planSpeakerMerge({
      survivor, duplicate, participants: [], assignments: [], draftResponses: [],
      subjectValues: [
        { id: 'value-a', responseId: 'response-a', name: 'speaker.bio', value: 'same', speakerId: survivor.id },
        { id: 'value-b', responseId: 'response-a', name: 'speaker.bio', value: 'same', speakerId: duplicate.id },
      ],
    }).deleteSubjectValueIds).toEqual(['value-b'])

    expect(() => planSpeakerMerge({
      survivor, duplicate, participants: [], assignments: [], subjectValues: [],
      draftResponses: [
        { id: 'draft-a', formId: 'profile', speakerId: survivor.id },
        { id: 'draft-b', formId: 'profile', speakerId: duplicate.id },
      ],
    })).toThrowErrorMatchingInlineSnapshot(`[Error: Cannot merge speakers: both have an active draft for form "profile"]`)
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
