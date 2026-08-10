// Standalone public CFP client page. Multistep wizard (Welcome → Account →
// MDX Steps → Review), draft save, authenticated R2 uploads, and final
// submit — without the organizer dashboard shell.
'use client'

import * as React from 'react'
import { Link, router } from 'spiceflow/react'
import { resetPublicCfpDraft, savePublicCfpDraft, startPublicCfpSubmission, submitPublicCfp } from '../actions.tsx'
import type { FieldOption, FormSubmission, ValuesRecord } from '../forms/collect-fields.ts'
import { formatDateRange, formatDateTimeUTC } from '../lib/utils.ts'
import { OpenSessionLogo } from './auth-page.tsx'
import { PublicFormWizard } from './public-form-wizard.tsx'
import { Button } from './ui/button.tsx'
import { toastActionError } from './ui/toast.tsx'

type DraftData = {
  responseId: string
  sessionId: string
  pinnedVersionId: string
  currentVersionId: string
  isLatestVersion: boolean
  hasSavedData: boolean
  pinnedMdxSource: string
  values: ValuesRecord
  participants: ValuesRecord[]
}

export function PublicCfpPage({
  event,
  form,
  scope,
  mdxSource,
  draft,
  signInHref,
  capReached,
  accountEmail,
  accountName,
}: {
  event: { id: string; slug: string; name: string; startsAt: number; endsAt: number; timezone: string; location: string | null }
  form: { id: string; slug: string; name: string; closesAt: number | null }
  scope: { tracks: FieldOption[]; formats: FieldOption[] }
  mdxSource: string
  draft: DraftData | null
  signInHref: string
  capReached: boolean
  accountEmail?: string | null
  accountName?: string | null
}) {
  const [replacementDraft, setReplacementDraft] = React.useState<DraftData | null>(null)
  const [draftChoice, setDraftChoice] = React.useState<'prompt' | 'edit' | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [starting, setStarting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const activeDraft = replacementDraft ?? draft
  const showDraftPrompt = draftChoice == null
    ? Boolean(activeDraft?.hasSavedData || activeDraft?.isLatestVersion === false)
    : draftChoice === 'prompt'

  const uploadFile = async (file: File, fieldName: string) => {
    const body = new FormData()
    body.set('file', file)
    body.set('eventId', event.id)
    body.set('formResponseId', activeDraft?.responseId ?? '')
    body.set('fieldName', fieldName)
    body.set(
      'kind',
      fieldName.includes('headshot') ? 'HEADSHOT'
        : fieldName.includes('slides') ? 'SLIDES'
          : file.type.startsWith('image/') ? 'IMAGE'
            : 'DOCUMENT',
    )
    const response = await fetch('/api/upload', { method: 'POST', body })
    const result: { fileId?: string; error?: string; message?: string } = await response.json()
    if (!response.ok || !result.fileId) throw new Error(result.message ?? result.error ?? 'Upload failed')
    return result.fileId
  }

  const save = async (submission: FormSubmission) => {
    if (!activeDraft) return
    setSaving(true)
    setError(null)
    try {
      await savePublicCfpDraft({
        eventId: event.id,
        formId: form.id,
        responseId: activeDraft.responseId,
        submission,
      })
    } catch (cause) {
      setError(toastActionError(cause, 'Could not save the draft'))
    } finally {
      setSaving(false)
    }
  }

  const submit = async (submission: FormSubmission) => {
    if (!activeDraft) throw new Error('Sign in to submit')
    setError(null)
    try {
      await submitPublicCfp({
        eventId: event.id,
        formId: form.id,
        responseId: activeDraft.responseId,
        submission,
      })
    } catch (cause) {
      setError(toastActionError(cause, 'Could not submit'))
      throw cause
    }
  }

  const header = (
    <header className="flex flex-col gap-6 border-b border-border pb-6">
      <div className="flex items-center gap-4">
        <OpenSessionLogo imageClassName="h-8" />
        <Link
          href={router.href('/portal/:eventSlug', { eventSlug: event.slug })}
          className="text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
        >
          Speaker portal
        </Link>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-muted-foreground">{form.name}</span>
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{event.name}</h1>
        <p className="text-sm text-muted-foreground">
          {formatDateRange({ startMs: event.startsAt, endMs: event.endsAt, timezone: event.timezone })}
          {event.location ? ` · ${event.location}` : ''}
        </p>
        {form.closesAt ? <p className="text-sm text-muted-foreground">Closes {formatDateTimeUTC(form.closesAt)}</p> : null}
      </div>
    </header>
  )

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
        {capReached ? (
          <>
            {header}
            <section className="flex flex-col gap-3 py-8 text-center text-balance">
              <h2 className="text-xl font-semibold">Submission limit reached</h2>
              <p className="text-sm text-muted-foreground">You already have three submissions for this event.</p>
              <Link href={router.href('/portal/:eventSlug/submissions', { eventSlug: event.slug })} className="text-sm underline underline-offset-4">
                View your submissions
              </Link>
            </section>
          </>
        ) : activeDraft && showDraftPrompt ? (
          <>
            {header}
            <section className="flex flex-col gap-5 py-6">
              <div className="flex flex-col gap-2 text-balance">
                <h2 className="text-xl font-semibold">
                  {activeDraft.isLatestVersion ? 'Resume your saved draft' : 'The CFP form changed since you saved this draft'}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {activeDraft.isLatestVersion
                    ? 'Your saved answers are ready. Resume them or discard the draft and start over.'
                    : 'Resume with the form version you started, or discard it and start against the latest form version.'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setDraftChoice('edit')}>Resume saved draft</Button>
                <Button
                  variant="outline"
                  loading={starting}
                  onClick={async () => {
                    setStarting(true)
                    try {
                      const next = await resetPublicCfpDraft({ eventSlug: event.slug, formSlug: form.slug })
                      setReplacementDraft(next)
                      setDraftChoice('edit')
                    } catch (cause) {
                      toastActionError(cause, 'Could not discard the draft')
                    } finally {
                      setStarting(false)
                    }
                  }}
                >
                  {activeDraft.isLatestVersion ? 'Discard and start over' : 'Discard and use latest form'}
                </Button>
              </div>
            </section>
          </>
        ) : !activeDraft && accountEmail ? (
          <>
            {header}
            <section className="flex flex-col items-center gap-4 py-8 text-center text-balance">
              <div className="flex flex-col gap-2">
                <h2 className="text-xl font-semibold">Start another submission</h2>
                <p className="text-sm text-muted-foreground">
                  Your previous responses are in the speaker portal. Start a new draft only when you are ready.
                </p>
              </div>
              <Button
                loading={starting}
                onClick={async () => {
                  setStarting(true)
                  try {
                    await startPublicCfpSubmission({ eventSlug: event.slug, formSlug: form.slug })
                  } catch (cause) {
                    toastActionError(cause, 'Could not start a submission')
                  } finally {
                    setStarting(false)
                  }
                }}
              >
                Start submission
              </Button>
            </section>
          </>
        ) : (
          <PublicFormWizard
            header={(
              <>
                {header}
                {activeDraft?.hasSavedData ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
                    <span>You resumed a saved draft.</span>
                    <Button variant="ghost" size="sm" onClick={() => setDraftChoice('prompt')}>Reset saved data</Button>
                  </div>
                ) : null}
              </>
            )}
            mdxSource={activeDraft?.pinnedMdxSource ?? mdxSource}
            scope={scope}
            initialValues={activeDraft?.values}
            initialParticipants={activeDraft?.participants}
            authenticated={Boolean(activeDraft)}
            accountEmail={accountEmail}
            accountName={accountName}
            signInHref={signInHref}
            uploadFile={activeDraft ? uploadFile : undefined}
            onSaveDraft={activeDraft ? save : undefined}
            onSubmit={submit}
            submitLabel="Submit session"
            saving={saving}
            error={error}
          />
        )}
      </div>
    </main>
  )
}
