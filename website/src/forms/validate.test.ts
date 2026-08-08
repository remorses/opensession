// Pure unit tests for submission validation: required/maxLength/options/
// unknown-name/participant cases, driven through the real collector so the
// server-side conditional logic is exercised end to end.
import { describe, expect, test } from 'vitest'
import dedent from 'string-dedent'
import { collectFields, type ValuesRecord } from './collect-fields.ts'
import { validateSubmission } from './validate.ts'
import { extractWellKnown } from './well-known-names.ts'

const MDX = dedent`
  <TextField name="title" required maxLength={10} />
  <Select name="track" options={tracks} required />
  <Select name="topics" options={['ai', 'infra', 'web']} multiple />
  <Checkbox name="needsAV" />

  <Show when={values.needsAV === 'true'}>
    <TextField name="avDetails" required maxLength={20} />
  </Show>

  <Participants min={1} max={2}>
    <TextField name="speaker.firstName" required />
    <TextField name="speaker.email" required maxLength={50} />
  </Participants>
`

const tracks = [
  { value: 'trk_1', label: 'AI' },
  { value: 'trk_2', label: 'Infra' },
]

function run(values: ValuesRecord, participants: ValuesRecord[] = [{ 'speaker.firstName': 'Ada', 'speaker.email': 'ada@example.com' }]) {
  const collected = collectFields({ mdxSource: MDX, scope: { values, tracks, formats: [] } })
  return validateSubmission({ collected, values, participants })
}

const valid: ValuesRecord = { title: 'Short', track: 'trk_1', topics: ['ai', 'web'], needsAV: 'false' }

describe('validateSubmission', () => {
  test('valid submission passes and returns the visible fields', () => {
    const result = run(valid)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.fields.map((f) => f.name)).toEqual(['title', 'track', 'topics', 'needsAV'])
      expect(result.participantFields.map((f) => f.name)).toEqual(['speaker.firstName', 'speaker.email'])
    }
  })

  test('missing required fields are rejected', () => {
    const result = run({ track: 'trk_1' })
    expect(result).toMatchInlineSnapshot(`
      {
        "errors": [
          {
            "message": ""title" is required",
            "name": "title",
          },
        ],
        "ok": false,
      }
    `)
  })

  test('conditionally visible required field is enforced only when visible', () => {
    // needsAV true → avDetails becomes visible and required.
    const withAV = run({ ...valid, needsAV: 'true' })
    expect(withAV.ok).toBe(false)
    if (!withAV.ok) expect(withAV.errors.map((e) => e.message)).toEqual(['"avDetails" is required'])

    // needsAV false → submitting avDetails is a tampered hidden field.
    const tampered = run({ ...valid, avDetails: 'projector' })
    expect(tampered.ok).toBe(false)
    if (!tampered.ok) expect(tampered.errors.map((e) => e.message)).toEqual(['Unknown field "avDetails"'])
  })

  test('maxLength is enforced', () => {
    const result = run({ ...valid, title: 'This title is way too long' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.message)).toEqual(['"title" must be at most 10 characters'])
  })

  test('option membership: library ids and inline options', () => {
    const badTrack = run({ ...valid, track: 'trk_999' })
    expect(badTrack.ok).toBe(false)
    if (!badTrack.ok) expect(badTrack.errors.map((e) => e.message)).toEqual(['"track" has an invalid option "trk_999"'])

    const badTopic = run({ ...valid, topics: ['ai', 'blockchain'] })
    expect(badTopic.ok).toBe(false)
    if (!badTopic.ok) expect(badTopic.errors.map((e) => e.message)).toEqual(['"topics" has an invalid option "blockchain"'])
  })

  test('array values are rejected for single-value fields', () => {
    const result = run({ ...valid, title: ['a', 'b'] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.message)).toEqual(['"title" must be a single value'])
  })

  test('participant count and per-participant required fields', () => {
    const none = run(valid, [])
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.errors.map((e) => e.message)).toEqual(['At least 1 participant required'])

    const tooMany = run(valid, [
      { 'speaker.firstName': 'A', 'speaker.email': 'a@x.com' },
      { 'speaker.firstName': 'B', 'speaker.email': 'b@x.com' },
      { 'speaker.firstName': 'C', 'speaker.email': 'c@x.com' },
    ])
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.errors.map((e) => e.message)).toEqual(['At most 2 participants allowed'])

    const missing = run(valid, [{ 'speaker.firstName': 'Ada' }, { 'speaker.email': 'b@x.com' }])
    expect(missing).toMatchInlineSnapshot(`
      {
        "errors": [
          {
            "message": ""speaker.email" (participant 1) is required",
            "name": "speaker.email",
          },
          {
            "message": ""speaker.firstName" (participant 2) is required",
            "name": "speaker.firstName",
          },
        ],
        "ok": false,
      }
    `)
  })

  test('unknown participant field names are rejected', () => {
    const result = run(valid, [{ 'speaker.firstName': 'Ada', 'speaker.email': 'a@x.com', 'speaker.hacked': 'x' }])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.map((e) => e.message)).toEqual(['Unknown participant field "speaker.hacked" (participant 1)'])
    }
  })

  test('form definition errors block validation', () => {
    const collected = collectFields({ mdxSource: '<Bogus />', scope: { values: {} } })
    const result = validateSubmission({ collected, values: {}, participants: [] })
    expect(result).toMatchInlineSnapshot(`
      {
        "errors": [
          {
            "message": "Form definition error (line 1): Unsupported jsx component Bogus",
          },
        ],
        "ok": false,
      }
    `)
  })
})

describe('extractWellKnown', () => {
  test('splits a submission into typed columns and custom values', () => {
    const result = extractWellKnown({
      values: {
        title: 'My talk',
        description: 'Abstract',
        track: 'trk_1',
        format: 'fmt_2',
        topics: ['ai', 'web'],
        needsAV: 'true',
      },
      participants: [
        {
          'speaker.firstName': 'Ada',
          'speaker.lastName': 'Lovelace',
          'speaker.email': 'ada@example.com',
          'speaker.headshot': 'file_123',
          'speaker.tshirtSize': 'M',
        },
      ],
    })
    expect(result).toMatchInlineSnapshot(`
      {
        "customValues": [
          {
            "name": "topics",
            "participantIndex": null,
            "value": "ai",
          },
          {
            "name": "topics",
            "participantIndex": null,
            "value": "web",
          },
          {
            "name": "needsAV",
            "participantIndex": null,
            "value": "true",
          },
          {
            "name": "speaker.tshirtSize",
            "participantIndex": 0,
            "value": "M",
          },
        ],
        "session": {
          "description": "Abstract",
          "formatId": "fmt_2",
          "title": "My talk",
          "trackId": "trk_1",
        },
        "speakers": [
          {
            "email": "ada@example.com",
            "firstName": "Ada",
            "headshotFileId": "file_123",
            "lastName": "Lovelace",
          },
        ],
      }
    `)
  })
})
