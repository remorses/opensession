// Server-side field collector for MDX forms (pure, no DB, no 'use client').
//
// Given a form's MDX source and the SAME scope the client rendered with
// ({ values, tracks, formats }), walk the mdast with MdastToJsx and collect
// the field specs the user actually SAW: fields hidden behind a false
// `<Show when={...}>` are excluded, exactly like on the client.
//
// THE COLLECTOR TRICK: MdastToJsx accepts a custom `createElement`. Ours
// INVOKES function components immediately (React.createElement would only
// create an element object) and each field component returns a plain marker
// object instead of JSX. Because children are evaluated bottom-up, a field
// cannot push into a shared array eagerly — a field under a false `<Show>`
// would still record itself. Instead every component RETURNS markers and
// containers return their children, so `run()` yields a marker tree that
// only contains the visible branches; we then flatten it. `<Participants>`
// returns a marker wrapping its child fields, which flags them as
// participant-scoped.
//
// LIMITATION (documented deviation from plan §6): safe-mdx cannot evaluate
// JSX inside expressions (`{cond && <TextField/>}` fails with "visitor
// JSXElement is not supported"), so conditional logic uses the
// `<Show when={expr}>` component. Expressions inside ATTRIBUTES evaluate
// fine. This also means conditionals can only read the top-level `values`
// scope — per-participant conditionals are not supported (the client
// renderer has the same limitation, so client and server always agree),
// and participant child fields are collected once and applied to every
// submitted participant during validation.

import { MdastToJsx, type EvaluateOptions, type MyRootContent, type SafeMdxError } from 'safe-mdx'
import { mdxParse } from 'safe-mdx/parse'

// ── Shared submission types (the public data contract) ──────────────
//
// Submitted shape: plain `values` for top-level fields plus `participants`,
// one record per participant entry, keyed by the `speaker.*` field names.

export type FieldValue = string | string[]
export type ValuesRecord = Record<string, FieldValue>
export type FormSubmission = { values: ValuesRecord; participants: ValuesRecord[] }

export type FieldOption = { value: string; label: string }

export type FieldType = 'text' | 'richtext' | 'number' | 'select' | 'checkbox' | 'radio' | 'file'

export type CollectedField = {
  name: string
  type: FieldType
  required: boolean
  maxLength?: number
  /** Number only: accepted range and weighted aggregate metadata. */
  min?: number
  max?: number
  weight?: number
  /** Select only: multiple values allowed (submitted as string[]). */
  multiple?: boolean
  /** Select/Radio: allowed option values (normalized). */
  options?: FieldOption[]
  /** True when the field lives inside <Participants> (speaker.* names). */
  participantScope: boolean
}

export type CollectResult = {
  /** Visible top-level fields (participantScope false). */
  fields: CollectedField[]
  /** Visible fields inside <Participants> (participantScope true). */
  participantFields: CollectedField[]
  /** min/max from the <Participants> block, or null when the form has none. */
  participants: { min: number; max: number } | null
  /** safe-mdx errors (bad expressions, unknown components) + collector errors. */
  errors: SafeMdxError[]
}

export type FormScope = {
  values: ValuesRecord
  tracks?: FieldOption[]
  formats?: FieldOption[]
  selected?: { track?: string; format?: string }
} & Record<string, unknown>

/** A non-empty safe-mdx scope enables calls by default. Form expressions only
 * need plain data access, so keep calls disabled on both client and server. */
export const FORM_EVALUATE_OPTIONS = { functions: false } satisfies EvaluateOptions

// ── Option helpers (shared with the client field components) ────────

/** Options come either inline (array of strings or {value,label}) or from
 *  the scope arrays (tracks/formats). Normalize to {value,label}. */
export function normalizeOptions(input: unknown): FieldOption[] {
  if (!Array.isArray(input)) return []
  const out: FieldOption[] = []
  for (const item of input) {
    if (typeof item === 'string') {
      out.push({ value: item, label: item })
    } else if (item && typeof item === 'object' && typeof (item as any).value === 'string') {
      const value = (item as any).value as string
      const label = typeof (item as any).label === 'string' ? ((item as any).label as string) : value
      out.push({ value, label })
    }
  }
  return out
}

/** Map library rows (tracks/formats) to select options: value = row id,
 *  label = row name. Used by both the client scope and server validation
 *  so option membership checks run against real library ids. */
export function libraryOptions(rows: Array<{ id: string; name: string }>): FieldOption[] {
  return rows.map((row) => ({ value: row.id, label: row.name }))
}

/** Format stored option ids for display without changing the submitted values. */
export function formatOptionValue(
  value: FieldValue | undefined,
  options?: FieldOption[],
): string {
  if (value == null) return ''
  const labels = new Map(options?.map((option) => [option.value, option.label]))
  const display = (item: string) => labels.get(item) ?? item
  return Array.isArray(value) ? value.map(display).join(', ') : display(value)
}

/** Add readable labels for dynamic library choices while values keep their FK ids. */
export function withSelectedOptionLabels(scope: FormScope): FormScope {
  const labelFor = (name: 'track' | 'format', options: FieldOption[] | undefined) => {
    const value = scope.values[name]
    if (typeof value !== 'string') return undefined
    return options?.find((option) => option.value === value)?.label
  }
  return {
    ...scope,
    selected: {
      track: labelFor('track', scope.tracks),
      format: labelFor('format', scope.formats),
    },
  }
}

// ── Marker tree ─────────────────────────────────────────────────────

type FieldMarker = { kind: 'field'; spec: Omit<CollectedField, 'participantScope'> }
type ChildrenMarker = { kind: 'children'; children: unknown[] }
type ParticipantsMarker = { kind: 'participants'; min: number; max: number; children: unknown[] }
type Marker = FieldMarker | ChildrenMarker | ParticipantsMarker

const DEFAULT_PARTICIPANTS_MIN = 1
const DEFAULT_PARTICIPANTS_MAX = 10

function toChildren(value: unknown): unknown[] {
  return (Array.isArray(value) ? value : [value]).flat(Infinity as 20).filter((x) => x != null && x !== false)
}

function fieldCollector(type: FieldType) {
  return (props: Record<string, unknown>): FieldMarker => ({
    kind: 'field',
    spec: {
      name: typeof props.name === 'string' ? props.name : '',
      type,
      required: Boolean(props.required),
      ...(typeof props.maxLength === 'number' && props.maxLength > 0 ? { maxLength: props.maxLength } : {}),
      ...(type === 'number' && typeof props.min === 'number' ? { min: props.min } : {}),
      ...(type === 'number' && typeof props.max === 'number' ? { max: props.max } : {}),
      ...(type === 'number' && typeof props.weight === 'number' && props.weight > 0 ? { weight: props.weight } : {}),
      ...(type === 'select' ? { multiple: Boolean(props.multiple) || undefined } : {}),
      ...(type === 'select' || type === 'radio' ? { options: normalizeOptions(props.options) } : {}),
    },
  })
}

function toPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/** Collector components: same names as the render map, but each returns a
 *  marker instead of JSX. Containers pass their children through so nested
 *  fields survive; `Show` drops children when `when` is falsy. */
const collectorComponents: Record<string, (props: any) => Marker | null> = {
  TextField: fieldCollector('text'),
  RichText: fieldCollector('richtext'),
  Number: fieldCollector('number'),
  Select: fieldCollector('select'),
  Checkbox: fieldCollector('checkbox'),
  Radio: fieldCollector('radio'),
  FileUpload: fieldCollector('file'),
  Participants: (props) => ({
    kind: 'participants',
    min: toPositiveInt(props.min, DEFAULT_PARTICIPANTS_MIN),
    max: toPositiveInt(props.max, DEFAULT_PARTICIPANTS_MAX),
    children: toChildren(props.children),
  }),
  Show: (props) => (props.when ? { kind: 'children', children: toChildren(props.children) } : null),
  Section: (props) => ({ kind: 'children', children: toChildren(props.children) }),
  // Multistep wizard marker — children are still part of the full form field set.
  Step: (props) => ({ kind: 'children', children: toChildren(props.children) }),
  Info: () => null,
}

// ── Collector ───────────────────────────────────────────────────────

export function collectFields({ mdxSource, scope }: { mdxSource: string; scope: FormScope }): CollectResult {
  const result: CollectResult = { fields: [], participantFields: [], participants: null, errors: [] }

  let mdast: MyRootContent
  try {
    mdast = mdxParse(mdxSource)
  } catch (error) {
    result.errors.push({
      type: 'expression',
      message: `Failed to parse MDX: ${error instanceof Error ? error.message : String(error)}`,
    })
    return result
  }

  const visitor = new MdastToJsx({
    markdown: mdxSource,
    mdast,
    components: collectorComponents as any,
    scope: withSelectedOptionLabels(scope),
    evaluateOptions: FORM_EVALUATE_OPTIONS,
    // Invoke function components directly; host tags (p, h1, div, ...)
    // become pass-through children wrappers so markers inside markdown
    // containers still reach the flattener.
    createElement: ((type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
      const kids = toChildren(children)
      if (typeof type === 'function') {
        return (type as (p: Record<string, unknown>) => unknown)({ ...(props ?? {}), children: kids })
      }
      return { kind: 'children', children: kids } satisfies ChildrenMarker
    }) as any,
  })

  const tree = visitor.run()
  result.errors.push(...visitor.errors)

  const seenNames = { plain: new Set<string>(), participant: new Set<string>() }

  const walk = (node: unknown, inParticipants: boolean) => {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inParticipants)
      return
    }
    const marker = node as Partial<Marker>
    if (marker.kind === 'field') {
      const spec = (marker as FieldMarker).spec
      if (!spec.name) {
        result.errors.push({ type: 'validation', message: `A ${spec.type} field is missing its name prop` })
        return
      }
      const seen = inParticipants ? seenNames.participant : seenNames.plain
      if (seen.has(spec.name)) {
        result.errors.push({ type: 'validation', message: `Duplicate field name "${spec.name}"` })
        return
      }
      seen.add(spec.name)
      const field: CollectedField = { ...spec, participantScope: inParticipants }
      if (inParticipants) result.participantFields.push(field)
      else result.fields.push(field)
      return
    }
    if (marker.kind === 'participants') {
      const p = marker as ParticipantsMarker
      if (inParticipants) {
        result.errors.push({ type: 'validation', message: '<Participants> cannot be nested inside <Participants>' })
        return
      }
      if (result.participants) {
        result.errors.push({ type: 'validation', message: 'Only one <Participants> block is allowed per form' })
        return
      }
      if (p.max < p.min) {
        result.errors.push({ type: 'validation', message: `<Participants> max (${p.max}) is smaller than min (${p.min})` })
        return
      }
      result.participants = { min: p.min, max: p.max }
      walk(p.children, true)
      return
    }
    if (marker.kind === 'children') {
      walk((marker as ChildrenMarker).children, inParticipants)
    }
  }

  walk(tree, false)
  return result
}

export function getFileUploadAccept(mdxSource: string, fieldName: string): string | null | undefined {
  type MdxJsxElement = Extract<MyRootContent, { type: 'mdxJsxFlowElement' | 'mdxJsxTextElement' }>

  const isMdxJsxElement = (node: MyRootContent): node is MdxJsxElement =>
    node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement'

  const visit = (node: MyRootContent): string | null | undefined => {
    if (isMdxJsxElement(node) && node.name === 'FileUpload') {
      const matches = node.attributes.some((attribute) =>
        attribute.type === 'mdxJsxAttribute'
        && attribute.name === 'name'
        && attribute.value === fieldName,
      )
      if (matches) {
        const accept = node.attributes.find((attribute) =>
          attribute.type === 'mdxJsxAttribute' && attribute.name === 'accept'
        )
        return accept?.type === 'mdxJsxAttribute' && typeof accept.value === 'string'
          ? accept.value
          : null
      }
    }
    switch (node.type) {
      case 'blockquote':
      case 'delete':
      case 'emphasis':
      case 'footnoteDefinition':
      case 'heading':
      case 'link':
      case 'linkReference':
      case 'list':
      case 'listItem':
      case 'mdxJsxFlowElement':
      case 'mdxJsxTextElement':
      case 'paragraph':
      case 'root':
      case 'strong':
      case 'table':
      case 'tableCell':
      case 'tableRow':
        for (const child of node.children) {
          const accept = visit(child)
          if (accept !== undefined) return accept
        }
        return undefined
      default:
        return undefined
    }
  }

  try {
    return visit(mdxParse(mdxSource))
  } catch {
    return undefined
  }
}

export function hasFileUploadField(mdxSource: string, fieldName: string): boolean {
  return getFileUploadAccept(mdxSource, fieldName) !== undefined
}
