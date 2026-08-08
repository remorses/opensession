// Pure MDX step extraction for multistep public/portal form wizards.
//
// Leading markdown and non-Step JSX before the first <Step> is the Welcome
// body. Each <Step title="..."> becomes one content step. Zero <Step>
// blocks means the whole source is a single content step (compat).
// Framework-owned Account and Review steps are added by the wizard UI.

import { mdxParse } from 'safe-mdx/parse'
import type { CollectResult, FormScope, FormSubmission } from './collect-fields.ts'
import { collectFields } from './collect-fields.ts'
import { validateSubmission, type ValidateResult } from './validate.ts'

export type ContentStep = {
  title: string
  /** Inner MDX of the <Step> (or the full source when there are no Steps). */
  mdxSource: string
}

export type ExtractedFormSteps = {
  welcomeMdx: string
  contentSteps: ContentStep[]
  errors: string[]
}

type Positioned = {
  type?: string
  name?: string | null
  attributes?: Array<{
    type?: string
    name?: string
    value?: string | { type?: string; value?: string } | null
  }>
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
  children?: Positioned[]
}

function attrTitle(node: Positioned): string {
  const attr = node.attributes?.find((item) => item.name === 'title')
  if (!attr) return 'Step'
  if (typeof attr.value === 'string' && attr.value.trim()) return attr.value.trim()
  if (attr.value && typeof attr.value === 'object' && typeof attr.value.value === 'string') {
    const raw = attr.value.value.trim()
    // Strip simple string literals from expressions: {"Hello"}
    const match = raw.match(/^['"`]([\s\S]*)['"`]$/)
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return 'Step'
}

function sliceSource(source: string, start: number, end: number): string {
  return source.slice(start, end).replace(/^\n+/, '').replace(/\n+$/, '')
}

/** Split form MDX into welcome copy + ordered content steps. */
export function extractFormSteps(mdxSource: string): ExtractedFormSteps {
  let root: Positioned
  try {
    root = mdxParse(mdxSource) as Positioned
  } catch (error) {
    return {
      welcomeMdx: '',
      contentSteps: [],
      errors: [`Failed to parse MDX: ${error instanceof Error ? error.message : String(error)}`],
    }
  }

  const children = Array.isArray(root.children) ? root.children : []
  const stepNodes = children.filter((node) => node.type === 'mdxJsxFlowElement' && node.name === 'Step')
  const errors: string[] = []

  if (stepNodes.length === 0) {
    const body = mdxSource.trim()
    return {
      welcomeMdx: '',
      contentSteps: body
        ? [{ title: 'Submission', mdxSource: body }]
        : [],
      errors,
    }
  }

  const firstStepStart = stepNodes[0]?.position?.start?.offset
  const welcomeMdx =
    typeof firstStepStart === 'number' ? sliceSource(mdxSource, 0, firstStepStart) : ''

  const contentSteps: ContentStep[] = []
  for (const [index, node] of stepNodes.entries()) {
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (typeof start !== 'number' || typeof end !== 'number') {
      errors.push(`Step ${index + 1} is missing source positions`)
      continue
    }
    // Prefer inner children span so nested fields render without the Step wrapper.
    const kids = Array.isArray(node.children) ? node.children : []
    let innerStart = start
    let innerEnd = end
    if (kids.length > 0) {
      const first = kids[0]?.position?.start?.offset
      const last = kids[kids.length - 1]?.position?.end?.offset
      if (typeof first === 'number' && typeof last === 'number') {
        innerStart = first
        innerEnd = last
      }
    } else {
      // Empty step: leave empty body.
      const openEnd = mdxSource.indexOf('>', start)
      innerStart = openEnd >= 0 ? openEnd + 1 : start
      const close = mdxSource.lastIndexOf('</Step>', end)
      innerEnd = close >= 0 ? close : end
    }
    contentSteps.push({
      title: attrTitle(node) || `Step ${index + 1}`,
      mdxSource: sliceSource(mdxSource, innerStart, innerEnd),
    })
  }

  return { welcomeMdx, contentSteps, errors }
}

/** Wizard tabs the user walks: Welcome, Account, each MDX Step, Review. */
export type WizardTab =
  | { key: 'welcome'; kind: 'welcome'; label: string }
  | { key: 'account'; kind: 'account'; label: string }
  | { key: `content:${number}`; kind: 'content'; label: string; stepIndex: number }
  | { key: 'review'; kind: 'review'; label: string }

export function buildWizardTabs(contentSteps: ContentStep[]): WizardTab[] {
  const tabs: WizardTab[] = [
    { key: 'welcome', kind: 'welcome', label: 'Welcome' },
    { key: 'account', kind: 'account', label: 'Account' },
  ]
  contentSteps.forEach((step, stepIndex) => {
    tabs.push({
      key: `content:${stepIndex}`,
      kind: 'content',
      label: step.title,
      stepIndex,
    })
  })
  tabs.push({ key: 'review', kind: 'review', label: 'Review' })
  return tabs
}

/** Validate only the fields that live inside one content step's MDX. */
export function validateContentStep({
  stepMdx,
  scope,
  submission,
}: {
  stepMdx: string
  scope: Omit<FormScope, 'values'>
  submission: FormSubmission
}): ValidateResult {
  const collected = collectFields({
    mdxSource: stepMdx,
    scope: { ...scope, values: submission.values },
  })
  // Only check fields that belong to this step; ignore values from other steps.
  const names = new Set(collected.fields.map((field) => field.name))
  const participantNames = new Set(collected.participantFields.map((field) => field.name))
  const scoped: FormSubmission = {
    values: Object.fromEntries(Object.entries(submission.values).filter(([name]) => names.has(name))),
    participants: submission.participants.map((record) =>
      Object.fromEntries(Object.entries(record).filter(([name]) => participantNames.has(name))),
    ),
  }
  // If this step has no Participants block, do not require participant rows.
  if (!collected.participants) {
    scoped.participants = []
  }
  return validateSubmission({ collected, ...scoped })
}

export function collectAllFields(mdxSource: string, scope: FormScope): CollectResult {
  return collectFields({ mdxSource, scope })
}
