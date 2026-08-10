// Locks the starter templates' field contract: collect-fields on the
// starter MDX snapshots the full field list, so accidental template edits
// that change names/required/limits fail loudly.
import { describe, expect, test } from 'vitest'
import { collectFields } from './collect-fields.ts'
import { buildFormCustomizationPrompt, chatgptPromptUrl } from './form-customization-prompt.ts'
import { extractFormSteps } from './form-steps.ts'
import {
  starterCfpTemplate,
  starterPortalTemplate,
  starterSpeakerProfileTemplate,
} from './starter-template.ts'

const scope = {
  values: {},
  tracks: [{ value: 'trk_1', label: 'AI' }],
  formats: [{ value: 'fmt_1', label: 'Talk' }],
}

describe('starterCfpTemplate', () => {
  test('collects the full field contract with no errors', () => {
    const result = collectFields({ mdxSource: starterCfpTemplate, scope })
    expect(result.errors).toEqual([])
    expect(result).toMatchInlineSnapshot(`
      {
        "errors": [],
        "fields": [
          {
            "maxLength": 80,
            "name": "title",
            "participantScope": false,
            "required": true,
            "type": "text",
          },
          {
            "maxLength": 5000,
            "name": "description",
            "participantScope": false,
            "required": true,
            "type": "richtext",
          },
          {
            "multiple": undefined,
            "name": "track",
            "options": [
              {
                "label": "AI",
                "value": "trk_1",
              },
            ],
            "participantScope": false,
            "required": true,
            "type": "select",
          },
          {
            "multiple": undefined,
            "name": "format",
            "options": [
              {
                "label": "Talk",
                "value": "fmt_1",
              },
            ],
            "participantScope": false,
            "required": true,
            "type": "select",
          },
          {
            "name": "needsAV",
            "participantScope": false,
            "required": false,
            "type": "checkbox",
          },
        ],
        "participantFields": [
          {
            "maxLength": 80,
            "name": "speaker.firstName",
            "participantScope": true,
            "required": true,
            "type": "text",
          },
          {
            "maxLength": 80,
            "name": "speaker.lastName",
            "participantScope": true,
            "required": true,
            "type": "text",
          },
          {
            "maxLength": 200,
            "name": "speaker.email",
            "participantScope": true,
            "required": true,
            "type": "text",
          },
          {
            "maxLength": 5000,
            "name": "speaker.bio",
            "participantScope": true,
            "required": false,
            "type": "richtext",
          },
          {
            "name": "speaker.headshot",
            "participantScope": true,
            "required": false,
            "type": "file",
          },
        ],
        "participants": {
          "max": 3,
          "min": 1,
        },
      }
    `)
  })

  test('the conditional A/V field appears when needsAV is true', () => {
    const result = collectFields({ mdxSource: starterCfpTemplate, scope: { ...scope, values: { needsAV: 'true' } } })
    expect(result.fields.map((f) => f.name)).toContain('avDetails')
  })

  test('uses multistep Steps for Submission and Speakers', () => {
    const steps = extractFormSteps(starterCfpTemplate)
    expect(steps.errors).toEqual([])
    expect(steps.contentSteps.map((step) => step.title)).toEqual(['Submission', 'Speakers'])
  })
})

describe('starterPortalTemplate', () => {
  test('collects the portal field contract with no errors', () => {
    const result = collectFields({ mdxSource: starterPortalTemplate, scope: { values: {} } })
    expect(result.errors).toEqual([])
    expect(result).toMatchInlineSnapshot(`
      {
        "errors": [],
        "fields": [
          {
            "name": "slides",
            "participantScope": false,
            "required": true,
            "type": "file",
          },
          {
            "maxLength": 500,
            "name": "slidesNotes",
            "participantScope": false,
            "required": false,
            "type": "text",
          },
        ],
        "participantFields": [],
        "participants": null,
      }
    `)
  })
})

describe('starterSpeakerProfileTemplate', () => {
  test('collects speaker.* well-known fields with no errors', () => {
    const result = collectFields({ mdxSource: starterSpeakerProfileTemplate, scope: { values: {} } })
    expect(result.errors).toEqual([])
    expect(result.fields.map((field) => field.name)).toEqual([
      'speaker.firstName',
      'speaker.lastName',
      'speaker.pronouns',
      'speaker.jobTitle',
      'speaker.companyName',
      'speaker.bio',
      'speaker.headshot',
      'speaker.websiteUrl',
      'speaker.linkedinUrl',
      'speaker.twitterUrl',
      'speaker.travelLogistics',
    ])
    expect(result.participants).toBeNull()
  })
})

test('builds a complete ChatGPT customization prompt from the live field registry', () => {
  const prompt = buildFormCustomizationPrompt({
    formName: 'Call for Papers',
    useCase: 'collecting conference talk proposals',
    fieldNames: ['title', 'track', 'speaker.email'],
    mdxSource: '# Submit\n\n<TextField name="title" label="Talk title" />',
  })

  expect(prompt).toContain('Always return the full, valid MDX form')
  expect(prompt).toContain('How do you want to customize this form?')
  expect(prompt).toContain('`title` → `eventSession.title`')
  expect(prompt).toContain('`speaker.email` → `speaker.email`')
  expect(prompt).toContain('```mdx\n# Submit\n\n<TextField name="title" label="Talk title" />\n```')
})

test('builds a ChatGPT URL that pre-fills the prompt via the hash form', () => {
  const prompt = buildFormCustomizationPrompt({
    formName: 'Call for Papers',
    useCase: 'collecting conference talk proposals',
    fieldNames: ['title'],
    mdxSource: '<TextField name="title" label="Talk title" />',
  })
  const url = chatgptPromptUrl(prompt)
  expect(url.startsWith('https://chatgpt.com/#?q=')).toBe(true)
  expect(decodeURIComponent(url.slice('https://chatgpt.com/#?q='.length))).toBe(prompt)
  // Hash form keeps the long authoring guide off the request line.
  expect(url.includes('?q=')).toBe(true)
  expect(new URL(url).search).toBe('')
})
