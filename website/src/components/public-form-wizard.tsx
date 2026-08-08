// Multistep public/portal form wizard ('use client').
// Google-Forms-like centered layout with numbered step tabs:
// Welcome → Account → MDX <Step>s → Review. Shared values state across
// steps; Next validates the current content step only; final Submit runs
// the full validation pipeline in the parent onSubmit handler.

'use client'

import * as React from 'react'
import { CheckCircle2Icon, ChevronLeftIcon, ChevronRightIcon, SaveIcon } from 'lucide-react'
import { ErrorBoundary } from 'spiceflow/react'
import type { FieldOption, FormSubmission, ValuesRecord } from '../forms/collect-fields.ts'
import { collectFields } from '../forms/collect-fields.ts'
import {
  buildWizardTabs,
  extractFormSteps,
  validateContentStep,
  type WizardTab,
} from '../forms/form-steps.ts'
import { FormRenderer } from '../forms/form-renderer.tsx'
import { cn } from '../lib/utils.ts'
import { SignInButton } from './login-button.tsx'
import { Button } from './ui/button.tsx'
import { Badge } from './ui/primitives.tsx'

export type PublicFormWizardProps = {
  mdxSource: string
  scope?: { tracks?: FieldOption[]; formats?: FieldOption[] } & Record<string, unknown>
  initialValues?: ValuesRecord
  initialParticipants?: ValuesRecord[]
  /** When set, draft autosave/save and content steps are enabled. */
  authenticated: boolean
  accountEmail?: string | null
  accountName?: string | null
  signInHref: string
  uploadFile?: (file: File, fieldName: string) => Promise<string>
  onChange?: (submission: FormSubmission) => void
  onSaveDraft?: (submission: FormSubmission) => void | Promise<void>
  onSubmit: (submission: FormSubmission) => void | Promise<void>
  submitLabel?: string
  /** Hide Welcome when empty and jump past Account when already signed in is not desired —
   *  Account still shows so the user confirms the Google identity. */
  saving?: boolean
  savedAt?: number | null
  error?: string | null
  header?: React.ReactNode
}

export function PublicFormWizard({
  mdxSource,
  scope,
  initialValues,
  initialParticipants,
  authenticated,
  accountEmail,
  accountName,
  signInHref,
  uploadFile,
  onChange,
  onSaveDraft,
  onSubmit,
  submitLabel = 'Submit',
  saving,
  savedAt,
  error,
  header,
}: PublicFormWizardProps) {
  const extracted = React.useMemo(() => extractFormSteps(mdxSource), [mdxSource])
  const tabs = React.useMemo(() => buildWizardTabs(extracted.contentSteps), [extracted.contentSteps])
  const [tabIndex, setTabIndex] = React.useState(0)
  const [values, setValues] = React.useState<ValuesRecord>(() => initialValues ?? {})
  const [participants, setParticipants] = React.useState<ValuesRecord[]>(() => initialParticipants ?? [])
  const [stepError, setStepError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const submission = React.useMemo<FormSubmission>(
    () => visibleSubmission({ mdxSource, scope, values, participants }),
    [mdxSource, scope, values, participants],
  )

  React.useEffect(() => {
    onChange?.(submission)
  }, [submission, onChange])

  const active = tabs[tabIndex] ?? tabs[0]!
  const numberedLabel = (tab: WizardTab, index: number) => `${index + 1} ${tab.label}`

  const goNext = async () => {
    setStepError(null)
    if (active.kind === 'account' && !authenticated) {
      setStepError('Sign in with Google to continue')
      return
    }
    if (active.kind === 'content') {
      const step = extracted.contentSteps[active.stepIndex]
      if (!step) return
      const result = validateContentStep({
        stepMdx: step.mdxSource,
        scope: scope ?? {},
        submission,
      })
      if (!result.ok) {
        setStepError(result.errors.map((item) => item.message).join('\n'))
        return
      }
    }
    if (tabIndex < tabs.length - 1) setTabIndex(tabIndex + 1)
  }

  const goBack = () => {
    setStepError(null)
    if (tabIndex > 0) setTabIndex(tabIndex - 1)
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    setStepError(null)
    try {
      await onSubmit(submission)
    } catch (cause) {
      setStepError(cause instanceof Error ? cause.message : 'Could not submit')
    } finally {
      setSubmitting(false)
    }
  }

  const handleSave = async () => {
    if (!onSaveDraft) return
    try {
      await onSaveDraft(submission)
    } catch (cause) {
      setStepError(cause instanceof Error ? cause.message : 'Could not save draft')
    }
  }

  // Shared FormRenderer state lives outside the step body so values persist.
  // We re-mount only the visible MDX slice via key={active.key}.
  const contentMdx =
    active.kind === 'welcome' ? extracted.welcomeMdx
      : active.kind === 'content' ? (extracted.contentSteps[active.stepIndex]?.mdxSource ?? '')
        : active.kind === 'review' ? ''
          : ''

  return (
    <div className="flex flex-col gap-8">
      {header}

      {extracted.errors.length > 0 ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-muted-foreground">
          {extracted.errors.join('\n')}
        </div>
      ) : null}

      <nav className="flex flex-wrap items-center gap-1 border-b border-border" aria-label="Form steps">
        {tabs.map((tab, index) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => {
              // Allow free navigation backward; forward still goes through Next validation.
              if (index <= tabIndex || authenticated || tab.kind === 'welcome' || tab.kind === 'account') {
                setStepError(null)
                setTabIndex(index)
              }
            }}
            className={cn(
              'relative -mb-px flex items-center gap-1.5 px-2.5 py-2 text-sm transition-colors',
              index === tabIndex
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {numberedLabel(tab, index)}
            {index === tabIndex ? (
              <span className="absolute inset-x-2.5 bottom-0 h-0.5 bg-foreground" />
            ) : null}
          </button>
        ))}
      </nav>

      <ErrorBoundary
        below
        fallback={<ErrorBoundary.ErrorMessage className="whitespace-pre-wrap text-sm text-destructive" />}
      >
        <div className="flex min-h-64 flex-col gap-6">
          {active.kind === 'welcome' ? (
            contentMdx.trim() ? (
              <FormRenderer
                key="welcome"
                mdxSource={contentMdx}
                scope={scope}
                initialValues={values}
                initialParticipants={participants}
              />
            ) : (
              <div className="flex flex-col gap-2 text-balance">
                <h2 className="text-xl font-semibold tracking-tight">Welcome</h2>
                <p className="text-sm text-muted-foreground">
                  Continue to sign in and fill out the form.
                </p>
              </div>
            )
          ) : null}

          {active.kind === 'account' ? (
            <AccountStep
              authenticated={authenticated}
              email={accountEmail}
              name={accountName}
              signInHref={signInHref}
            />
          ) : null}

          {active.kind === 'content' ? (
            authenticated ? (
              <WizardStepFields
                key={active.key}
                mdxSource={contentMdx}
                scope={scope}
                values={values}
                participants={participants}
                setValues={setValues}
                setParticipants={setParticipants}
                uploadFile={uploadFile}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Sign in on the Account step to continue.</p>
            )
          ) : null}

          {active.kind === 'review' ? (
            <ReviewStep mdxSource={mdxSource} scope={scope} submission={submission} />
          ) : null}
        </div>
      </ErrorBoundary>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
        {tabIndex > 0 ? (
          <Button variant="outline" onClick={goBack}>
            <ChevronLeftIcon data-icon="inline-start" />
            Back
          </Button>
        ) : null}

        {active.kind !== 'review' ? (
          <Button onClick={goNext} disabled={active.kind === 'content' && !authenticated}>
            Next
            <ChevronRightIcon data-icon="inline-end" />
          </Button>
        ) : (
          <Button loading={submitting} onClick={handleSubmit} disabled={!authenticated}>
            {submitLabel}
          </Button>
        )}

        {authenticated && onSaveDraft && active.kind !== 'welcome' && active.kind !== 'account' ? (
          <Button variant="outline" loading={saving} onClick={handleSave}>
            <SaveIcon data-icon="inline-start" />
            Save draft
          </Button>
        ) : null}

        {savedAt ? <span className="text-xs text-muted-foreground">Draft saved</span> : null}
        {(stepError || error) ? (
          <p className="basis-full whitespace-pre-wrap text-sm text-destructive">{stepError || error}</p>
        ) : null}
      </div>
    </div>
  )
}

function AccountStep({
  authenticated,
  email,
  name,
  signInHref,
}: {
  authenticated: boolean
  email?: string | null
  name?: string | null
  signInHref: string
}) {
  if (!authenticated) {
    return (
      <section className="flex flex-col gap-5 py-4">
        <div className="flex flex-col gap-2 text-balance">
          <h2 className="text-xl font-semibold tracking-tight">Sign in to continue</h2>
          <p className="text-sm text-muted-foreground">
            Use Google so your verified email links this form to your speaker portal.
          </p>
        </div>
        <div className="w-full max-w-sm">
          <SignInButton href={signInHref}>Continue with Google</SignInButton>
        </div>
      </section>
    )
  }
  return (
    <section className="flex flex-col gap-4 py-4">
      <div className="flex flex-col gap-2 text-balance">
        <h2 className="text-xl font-semibold tracking-tight">Account</h2>
        <p className="text-sm text-muted-foreground">You are signed in. Continue to fill out the form.</p>
      </div>
      <div className="flex flex-col gap-1 border-y border-border py-4 text-sm">
        {name ? <span className="font-medium">{name}</span> : null}
        <span className="text-muted-foreground">{email}</span>
        <Badge variant="success" className="mt-2 w-fit px-1.5">Google</Badge>
      </div>
    </section>
  )
}

function ReviewStep({
  mdxSource,
  scope,
  submission,
}: {
  mdxSource: string
  scope: PublicFormWizardProps['scope']
  submission: FormSubmission
}) {
  const collected = React.useMemo(
    () => collectFields({ mdxSource, scope: { ...scope, values: submission.values } }),
    [mdxSource, scope, submission.values],
  )
  const entries = [
    ...collected.fields.map((field) => ({
      label: field.name,
      value: formatValue(submission.values[field.name]),
    })),
    ...submission.participants.flatMap((record, index) =>
      collected.participantFields.map((field) => ({
        label: `${field.name} (speaker ${index + 1})`,
        value: formatValue(record[field.name]),
      })),
    ),
  ]
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 text-balance">
        <h2 className="text-xl font-semibold tracking-tight">Review</h2>
        <p className="text-sm text-muted-foreground">
          Check your answers, then submit. You can go back to edit any step.
        </p>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No answers yet.</p>
      ) : (
        <dl className="flex flex-col divide-y divide-border border-y border-border">
          {entries.map((entry) => (
            <div key={entry.label} className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-6">
              <dt className="w-48 shrink-0 text-sm font-medium text-muted-foreground">{entry.label}</dt>
              <dd className="min-w-0 flex-1 whitespace-pre-wrap text-sm">{entry.value || '—'}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

/** Isolates FormRenderer state updates into the parent values/participants. */
function WizardStepFields({
  mdxSource,
  scope,
  values,
  participants,
  setValues,
  setParticipants,
  uploadFile,
}: {
  mdxSource: string
  scope: PublicFormWizardProps['scope']
  values: ValuesRecord
  participants: ValuesRecord[]
  setValues: React.Dispatch<React.SetStateAction<ValuesRecord>>
  setParticipants: React.Dispatch<React.SetStateAction<ValuesRecord[]>>
  uploadFile?: (file: File, fieldName: string) => Promise<string>
}) {
  return (
    <FormRenderer
      mdxSource={mdxSource}
      scope={scope}
      initialValues={values}
      initialParticipants={participants}
      uploadFile={uploadFile}
      onChange={(next) => {
        // Merge step slice back into full submission so other steps keep their values.
        setValues((prev) => ({ ...prev, ...next.values }))
        setParticipants((prev) => {
          if (next.participants.length === 0) return prev
          // Never pad to the old length — removing a participant must drop
          // their record from the submission payload.
          return next.participants.map((record, index) => ({
            ...(prev[index] ?? {}),
            ...record,
          }))
        })
      }}
    />
  )
}

function visibleSubmission({
  mdxSource,
  scope,
  values,
  participants,
}: {
  mdxSource: string
  scope: PublicFormWizardProps['scope']
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

function formatValue(value: string | string[] | undefined): string {
  if (value == null) return ''
  if (Array.isArray(value)) return value.join(', ')
  return value
}

export function SubmittedSuccess({
  title,
  referenceId,
  footer,
}: {
  title: string
  referenceId?: string
  footer?: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-5 py-8 text-center text-balance">
      <CheckCircle2Icon className="mx-auto size-10 text-success" />
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold">Submission received</h2>
        <p className="text-muted-foreground">Thanks — your response was saved.</p>
      </div>
      <div className="mx-auto flex max-w-md flex-col gap-2 border-y border-border py-4 text-left text-sm">
        <span className="font-medium">{title}</span>
        {referenceId ? (
          <span className="font-mono text-xs text-muted-foreground">Reference: {referenceId}</span>
        ) : null}
      </div>
      {footer}
    </section>
  )
}
