// Locks the starter templates' field contract: collect-fields on the
// starter MDX snapshots the full field list, so accidental template edits
// that change names/required/limits fail loudly.
import { describe, expect, test } from 'vitest'
import { collectFields } from './collect-fields.ts'
import { starterCfpTemplate, starterPortalTemplate } from './starter-template.ts'

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
            "multiple": undefined,
            "name": "title",
            "options": undefined,
            "participantScope": false,
            "required": true,
            "type": "text",
          },
          {
            "maxLength": 5000,
            "multiple": undefined,
            "name": "description",
            "options": undefined,
            "participantScope": false,
            "required": true,
            "type": "richtext",
          },
          {
            "maxLength": undefined,
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
            "maxLength": undefined,
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
            "maxLength": undefined,
            "multiple": undefined,
            "name": "needsAV",
            "options": undefined,
            "participantScope": false,
            "required": false,
            "type": "checkbox",
          },
        ],
        "participantFields": [
          {
            "maxLength": 80,
            "multiple": undefined,
            "name": "speaker.firstName",
            "options": undefined,
            "participantScope": true,
            "required": true,
            "type": "text",
          },
          {
            "maxLength": 80,
            "multiple": undefined,
            "name": "speaker.lastName",
            "options": undefined,
            "participantScope": true,
            "required": true,
            "type": "text",
          },
          {
            "maxLength": 200,
            "multiple": undefined,
            "name": "speaker.email",
            "options": undefined,
            "participantScope": true,
            "required": true,
            "type": "text",
          },
          {
            "maxLength": 5000,
            "multiple": undefined,
            "name": "speaker.bio",
            "options": undefined,
            "participantScope": true,
            "required": false,
            "type": "richtext",
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
            "maxLength": undefined,
            "multiple": undefined,
            "name": "slides",
            "options": undefined,
            "participantScope": false,
            "required": true,
            "type": "file",
          },
          {
            "maxLength": 500,
            "multiple": undefined,
            "name": "slidesNotes",
            "options": undefined,
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
