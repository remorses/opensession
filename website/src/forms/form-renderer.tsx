// Client MDX form renderer ('use client').
//
// Parses mdxSource in the browser (mdxParse is browser-safe), owns the
// { values, participants } state, and renders the mdast with MdastToJsx on
// EVERY value change so scope expressions (`<Show when={values.x === 'y'}>`,
// `{values.title}`) re-evaluate live. Consumers: public CFP fill (task 4),
// admin live preview (task 3), portal forms (task 6).

'use client'

import * as React from 'react'
import { MdastToJsx, type MyRootContent, type SafeMdxError } from 'safe-mdx'
import { mdxParse } from 'safe-mdx/parse'
import { Button } from '../components/ui/button.tsx'
import {
  collectFields,
  FORM_EVALUATE_OPTIONS,
  type FieldOption,
  type FieldValue,
  type FormSubmission,
  type ValuesRecord,
  withSelectedOptionLabels,
} from './collect-fields.ts'
import { formComponents } from './components-map.tsx'
import { FormValuesContext, type FormValuesState } from './field-components.tsx'

export type FormRendererProps = {
  mdxSource: string
  /** Library option arrays exposed to MDX scope (`options={tracks}`). Extra
   *  keys are passed through to the scope untouched. */
  scope?: { tracks?: FieldOption[]; formats?: FieldOption[] } & Record<string, unknown>
  initialValues?: ValuesRecord
  initialParticipants?: ValuesRecord[]
  /** Fired after every value change with the full submission payload
   *  (drafts/autosave hook for task 4). */
  onChange?: (submission: FormSubmission) => void
  /** When provided, a submit button renders below the form. */
  onSubmit?: (submission: FormSubmission) => void | Promise<void>
  submitLabel?: string
  /** Uploads through POST /api/upload. Absent means uploads render disabled. */
  uploadFile?: (file: File, fieldName: string) => Promise<string>
}

export function FormRenderer({
  mdxSource,
  scope,
  initialValues,
  initialParticipants,
  onChange,
  onSubmit,
  submitLabel,
  uploadFile,
}: FormRendererProps) {
  const [values, setValues] = React.useState<ValuesRecord>(() => initialValues ?? {})
  const [participants, setParticipants] = React.useState<ValuesRecord[]>(() => {
    const initial = initialParticipants ?? []
    const collected = collectFields({
      mdxSource,
      scope: { ...scope, values: initialValues ?? {} },
    })
    return padTo(initial, collected.participants?.min ?? 0)
  })
  const [submitting, setSubmitting] = React.useState(false)

  // Keep onChange out of state updaters: fire it after commit when renderer
  // state changes, not when a projected visible submission gets a new identity.
  const lastNotified = React.useRef<{ values: ValuesRecord; participants: ValuesRecord[] } | null>(null)
  React.useEffect(() => {
    const previous = lastNotified.current
    if (!previous || previous.values !== values || previous.participants !== participants) {
      onChange?.(visibleSubmission({ mdxSource, scope, values, participants }))
    }
    lastNotified.current = { values, participants }
  }, [values, participants, mdxSource, scope, onChange])

  const state = React.useMemo<FormValuesState>(
    () => ({
      values,
      participants,
      uploadFile,
      setValue: (name, value) => setValues((prev) => ({ ...prev, [name]: value })),
      setParticipantValue: (index, name, value) =>
        setParticipants((prev) => {
          const next = padTo(prev, index + 1)
          next[index] = { ...next[index], [name]: value }
          return next
        }),
      addParticipant: () => setParticipants((prev) => [...prev, {}]),
      removeParticipant: (index) => setParticipants((prev) => prev.filter((_, i) => i !== index)),
    }),
    [values, participants, uploadFile],
  )

  const mdast = React.useMemo<{
    ast: MyRootContent | null
    parseError: string | null
  }>(() => {
    try {
      return { ast: mdxParse(mdxSource), parseError: null }
    } catch (error) {
      return { ast: null, parseError: error instanceof Error ? error.message : String(error) }
    }
  }, [mdxSource])

  let rendered: React.ReactNode = null
  let errors: SafeMdxError[] = []
  if (mdast.ast) {
    // A fresh visitor per render: scope carries the live values so every
    // attribute expression re-evaluates against the current state.
    const visitor = new MdastToJsx({
      markdown: mdxSource,
      mdast: mdast.ast,
      components: formComponents,
      scope: withSelectedOptionLabels({ ...scope, values }),
      evaluateOptions: FORM_EVALUATE_OPTIONS,
    })
    rendered = visitor.run()
    errors = visitor.errors
  }

  // NOTE (verified in browser): values of fields hidden by a <Show> toggle
  // stay in client state, and the server correctly rejects them as unknown
  // fields. The real submit flow (task 4) should prune values not present
  // in the client-collected visible field set before submitting, so users
  // who toggle a conditional off don't get a server error.
  const handleSubmit = async () => {
    if (!onSubmit) return
    setSubmitting(true)
    try {
      await onSubmit(visibleSubmission({ mdxSource, scope, values, participants }))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <FormValuesContext.Provider value={state}>
      <div className="flex flex-col gap-5">
        {mdast.parseError ? <FormErrors errors={[{ type: 'expression', message: mdast.parseError }]} /> : null}
        {errors.length > 0 ? <FormErrors errors={errors} /> : null}
        {rendered}
        {onSubmit ? (
          <Button className="self-start" loading={submitting} onClick={handleSubmit}>
            {submitLabel ?? 'Submit'}
          </Button>
        ) : null}
      </div>
    </FormValuesContext.Provider>
  )
}

function visibleSubmission({ mdxSource, scope, values, participants }: {
  mdxSource: string
  scope: FormRendererProps['scope']
  values: ValuesRecord
  participants: ValuesRecord[]
}): FormSubmission {
  const collected = collectFields({
    mdxSource,
    scope: { ...scope, values },
  })
  const names = new Set(collected.fields.map((field) => field.name))
  const participantNames = new Set(collected.participantFields.map((field) => field.name))
  return {
    values: Object.fromEntries(Object.entries(values).filter(([name]) => names.has(name))),
    participants: participants.map((record) =>
      Object.fromEntries(Object.entries(record).filter(([name]) => participantNames.has(name))),
    ),
  }
}

function padTo(prev: ValuesRecord[], count: number): ValuesRecord[] {
  const next = [...prev]
  while (next.length < count) next.push({})
  return next
}

/** Dev-visible list of safe-mdx errors (bad expressions, missing
 *  components) with line numbers — shown to admins editing the MDX, and a
 *  submit-blocking signal server-side. */
function FormErrors({ errors }: { errors: SafeMdxError[] }) {
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm flex flex-col gap-1">
      <span className="font-medium">Form definition problems</span>
      {errors.map((error, i) => (
        <span key={i} className="text-muted-foreground">
          {error.line ? `Line ${error.line}: ` : ''}
          {error.message}
        </span>
      ))}
    </div>
  )
}

export type { FieldValue, FormSubmission, ValuesRecord }
