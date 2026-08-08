// Pure unit tests for the MDX field collector: visibility under <Show>
// conditionals, participants expansion, error surfacing.
import { describe, expect, test } from 'vitest'
import dedent from 'string-dedent'
import { collectFields, libraryOptions, normalizeOptions } from './collect-fields.ts'

const scopeWith = (values: Record<string, string | string[]>) => ({
  values,
  tracks: [
    { value: 'trk_1', label: 'AI' },
    { value: 'trk_2', label: 'Infra' },
  ],
  formats: [
    { value: 'fmt_1', label: 'Talk' },
    { value: 'fmt_2', label: 'Workshop' },
  ],
})

describe('collectFields', () => {
  test('collects plain fields with props', () => {
    const MDX = dedent`
      # Hello

      <TextField name="title" label="Title" required maxLength={80} />
      <RichText name="description" maxLength={5000} />
      <Select name="track" options={tracks} required />
      <Checkbox name="needsAV" label="Needs A/V" />
      <Radio name="level" options={['beginner', 'advanced']} required />
      <FileUpload name="headshot" accept="image/*" />
    `
    const result = collectFields({ mdxSource: MDX, scope: scopeWith({}) })
    expect(result.errors).toEqual([])
    expect(result.participants).toBeNull()
    expect(result.fields).toMatchInlineSnapshot(`
      [
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
          "required": false,
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
            {
              "label": "Infra",
              "value": "trk_2",
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
        {
          "maxLength": undefined,
          "multiple": undefined,
          "name": "level",
          "options": [
            {
              "label": "beginner",
              "value": "beginner",
            },
            {
              "label": "advanced",
              "value": "advanced",
            },
          ],
          "participantScope": false,
          "required": true,
          "type": "radio",
        },
        {
          "maxLength": undefined,
          "multiple": undefined,
          "name": "headshot",
          "options": undefined,
          "participantScope": false,
          "required": false,
          "type": "file",
        },
      ]
    `)
  })

  test('Show excludes fields when the condition is false', () => {
    const MDX = dedent`
      <Checkbox name="needsAV" />

      <Show when={values.needsAV === 'true'}>
        <TextField name="avDetails" required />
      </Show>
    `
    const hidden = collectFields({ mdxSource: MDX, scope: scopeWith({}) })
    expect(hidden.fields.map((f) => f.name)).toEqual(['needsAV'])

    const visible = collectFields({ mdxSource: MDX, scope: scopeWith({ needsAV: 'true' }) })
    expect(visible.fields.map((f) => f.name)).toEqual(['needsAV', 'avDetails'])
  })

  test('fields nested in sections and markdown containers are found', () => {
    const MDX = dedent`
      <Section title="Your session">

      Some intro copy.

      <TextField name="title" required />

      </Section>
    `
    const result = collectFields({ mdxSource: MDX, scope: scopeWith({}) })
    expect(result.errors).toEqual([])
    expect(result.fields.map((f) => f.name)).toEqual(['title'])
  })

  test('participants block flags child fields as participant-scoped', () => {
    const MDX = dedent`
      <Participants min={1} max={3}>
        <TextField name="speaker.firstName" required />
        <RichText name="speaker.bio" maxLength={5000} />
      </Participants>
    `
    const result = collectFields({ mdxSource: MDX, scope: scopeWith({}) })
    expect(result.errors).toEqual([])
    expect(result.participants).toEqual({ min: 1, max: 3 })
    expect(result.participantFields).toMatchInlineSnapshot(`
      [
        {
          "maxLength": undefined,
          "multiple": undefined,
          "name": "speaker.firstName",
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
      ]
    `)
  })

  test('surfaces safe-mdx errors: unknown component and bad expression', () => {
    // NOTE: eval-estree-expression silently returns undefined for method
    // calls on undefined values ({values.x.map(...)} does NOT error); only
    // missing top-level identifiers produce expression errors.
    const MDX = dedent`
      <Bogus name="x" />

      {missingVar.foo}

      <TextField name="title" />
    `
    const result = collectFields({ mdxSource: MDX, scope: scopeWith({}) })
    expect(result.fields.map((f) => f.name)).toEqual(['title'])
    expect(result.errors).toMatchInlineSnapshot(`
      [
        {
          "line": 1,
          "message": "Unsupported jsx component Bogus",
          "type": "missing-component",
        },
        {
          "line": 3,
          "message": "Failed to evaluate expression: missingVar.foo. missingVar is not defined. Available variables: values, tracks, formats",
          "type": "expression",
        },
      ]
    `)
  })

  test('collector-level errors: missing name, duplicate names, nested participants', () => {
    const MDX = dedent`
      <TextField label="No name" />
      <TextField name="title" />
      <TextField name="title" />

      <Participants>
        <Participants>
          <TextField name="speaker.email" />
        </Participants>
      </Participants>
    `
    const result = collectFields({ mdxSource: MDX, scope: scopeWith({}) })
    expect(result.errors.map((e) => e.message)).toMatchInlineSnapshot(`
      [
        "A text field is missing its name prop",
        "Duplicate field name "title"",
        "<Participants> cannot be nested inside <Participants>",
      ]
    `)
  })

  test('multiple Participants blocks are rejected', () => {
    const MDX = dedent`
      <Participants min={1} max={2}>
        <TextField name="speaker.firstName" />
      </Participants>

      <Participants min={1} max={2}>
        <TextField name="speaker.lastName" />
      </Participants>
    `
    const result = collectFields({ mdxSource: MDX, scope: scopeWith({}) })
    expect(result.errors.map((e) => e.message)).toEqual(['Only one <Participants> block is allowed per form'])
    expect(result.participants).toEqual({ min: 1, max: 2 })
  })
})

describe('option helpers', () => {
  test('normalizeOptions accepts strings and {value,label}', () => {
    expect(normalizeOptions(['a', { value: 'b', label: 'B' }, { value: 'c' }, 42, null])).toEqual([
      { value: 'a', label: 'a' },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'c' },
    ])
  })

  test('libraryOptions maps rows to id/name options', () => {
    expect(libraryOptions([{ id: 'trk_1', name: 'AI' }])).toEqual([{ value: 'trk_1', label: 'AI' }])
  })
})
