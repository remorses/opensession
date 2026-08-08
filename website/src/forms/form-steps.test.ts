// Pure tests for MDX <Step> extraction and per-step validation.
import { describe, expect, test } from 'vitest'
import dedent from 'string-dedent'
import {
  buildWizardTabs,
  extractFormSteps,
  validateContentStep,
} from './form-steps.ts'
import { starterCfpTemplate, starterSpeakerProfileTemplate } from './starter-template.ts'

describe('extractFormSteps', () => {
  test('splits welcome copy and ordered content steps', () => {
    const mdx = dedent`
      # Hello

      Welcome body.

      <Step title="One">
      <TextField name="title" required />
      </Step>

      <Step title="Two">
      <TextField name="notes" />
      </Step>
    `
    const result = extractFormSteps(mdx)
    expect(result.errors).toEqual([])
    expect(result.welcomeMdx).toContain('Welcome body')
    expect(result.contentSteps.map((step) => step.title)).toEqual(['One', 'Two'])
    expect(result.contentSteps[0]!.mdxSource).toContain('name="title"')
    expect(result.contentSteps[1]!.mdxSource).toContain('name="notes"')
  })

  test('zero Steps treats the whole form as one content step', () => {
    const mdx = dedent`
      # Plain

      <TextField name="title" required />
    `
    const result = extractFormSteps(mdx)
    expect(result.errors).toEqual([])
    expect(result.welcomeMdx).toBe('')
    expect(result.contentSteps).toHaveLength(1)
    expect(result.contentSteps[0]!.title).toBe('Submission')
    expect(result.contentSteps[0]!.mdxSource).toContain('name="title"')
  })

  test('starter CFP template has Submission and Speakers steps', () => {
    const result = extractFormSteps(starterCfpTemplate)
    expect(result.errors).toEqual([])
    expect(result.welcomeMdx).toContain('Call for speakers')
    expect(result.contentSteps.map((step) => step.title)).toEqual(['Submission', 'Speakers'])
  })

  test('starter speaker profile has Profile and Socials steps', () => {
    const result = extractFormSteps(starterSpeakerProfileTemplate)
    expect(result.errors).toEqual([])
    expect(result.contentSteps.map((step) => step.title)).toEqual(['Profile', 'Socials'])
  })
})

describe('buildWizardTabs', () => {
  test('prefixes Welcome, Account, content steps, Review', () => {
    expect(buildWizardTabs([{ title: 'Submission', mdxSource: 'x' }, { title: 'Speakers', mdxSource: 'y' }]).map((tab) => tab.label)).toEqual([
      'Welcome',
      'Account',
      'Submission',
      'Speakers',
      'Review',
    ])
  })
})

describe('validateContentStep', () => {
  test('only validates fields inside the current step', () => {
    const step = dedent`
      <TextField name="title" required maxLength={80} />
    `
    const missing = validateContentStep({
      stepMdx: step,
      scope: {},
      submission: { values: {}, participants: [] },
    })
    expect(missing.ok).toBe(false)

    const ok = validateContentStep({
      stepMdx: step,
      scope: {},
      submission: { values: { title: 'Hello' }, participants: [] },
    })
    expect(ok.ok).toBe(true)

    // Values for other steps are ignored for this step's validation.
    const withExtra = validateContentStep({
      stepMdx: step,
      scope: {},
      submission: { values: { title: 'Hello', other: 'x' }, participants: [] },
    })
    expect(withExtra.ok).toBe(true)
  })
})
