// Standalone public CFP client page. Multistep wizard (Welcome → Account →
// MDX Steps → Review), draft save, authenticated R2 uploads, and final
// submit — without the organizer dashboard shell.
'use client'

import * as React from 'react'
import { Link } from 'spiceflow/react'
import { savePublicCfpDraft, submitPublicCfp } from '../actions.tsx'
import type { FieldOption, FormSubmission, ValuesRecord } from '../forms/collect-fields.ts'
import { formatDateRangeUTC, formatDateTimeUTC } from '../lib/utils.ts'
import { OpenSessionLogo } from './auth-page.tsx'
import { PublicFormWizard, SubmittedSuccess } from './public-form-wizard.tsx'
import { Button } from './ui/button.tsx'
import { Toaster, toastActionError } from './ui/toast.tsx'
import { Badge } from './ui/primitives.tsx'

type DraftData = {
  responseId: string
  sessionId: string
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
  event: { id: string; slug: string; name: string; startsAt: number; endsAt: number; location: string | null }
  form: { id: string; slug: string; name: string; closesAt: number | null }
  scope: { tracks: FieldOption[]; formats: FieldOption[] }
  mdxSource: string
  draft: DraftData | null
  signInHref: string
  capReached: boolean
  accountEmail?: string | null
  accountName?: string | null
}) {
  const [lastSubmission, setLastSubmission] = React.useState<FormSubmission | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [savedAt, setSavedAt] = React.useState<number | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [submitted, setSubmitted] = React.useState<{
    sessionId: string
    title: string
    status: 'PENDING'
  } | null>(null)

  const uploadFile = async (file: File, fieldName: string) => {
    const body = new FormData()
    body.set('file', file)
    body.set('eventId', event.id)
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

  const save = async (submission = lastSubmission) => {
    if (!draft || !submission) return
    setSaving(true)
    setError(null)
    try {
      await savePublicCfpDraft({
        eventId: event.id,
        formId: form.id,
        responseId: draft.responseId,
        submission,
      })
      setSavedAt(Date.now())
    } catch (cause) {
      setError(toastActionError(cause, 'Could not save the draft'))
    } finally {
      setSaving(false)
    }
  }

  const submit = async (submission: FormSubmission) => {
    if (!draft) throw new Error('Sign in to submit')
    setError(null)
    try {
      const result = await submitPublicCfp({
        eventId: event.id,
        formId: form.id,
        responseId: draft.responseId,
        submission,
      })
      setSubmitted({ sessionId: result.sessionId, title: result.title, status: 'PENDING' })
    } catch (cause) {
      setError(toastActionError(cause, 'Could not submit'))
      throw cause
    }
  }

  const header = (
    <header className="flex flex-col gap-6 border-b border-border pb-6">
      <OpenSessionLogo imageClassName="h-8" />
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-muted-foreground">{form.name}</span>
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{event.name}</h1>
        <p className="text-sm text-muted-foreground">
          {formatDateRangeUTC(event.startsAt, event.endsAt)}
          {event.location ? ` · ${event.location}` : ''}
        </p>
        {form.closesAt ? <p className="text-sm text-muted-foreground">Closes {formatDateTimeUTC(form.closesAt)}</p> : null}
      </div>
    </header>
  )

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6 sm:py-12">
      <Toaster />
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
        {submitted ? (
          <>
            {header}
            <SubmittedSuccess
              title={submitted.title}
              referenceId={submitted.sessionId}
              footer={(
                <div className="flex flex-col items-center gap-3">
                  <Badge variant="warning" className="w-fit px-1.5">Pending</Badge>
                  <Button
                    variant="outline"
                    render={<Link href={`/portal/${event.slug}`} />}
                  >
                    View speaker portal
                  </Button>
                </div>
              )}
            />
          </>
        ) : capReached ? (
          <>
            {header}
            <section className="flex flex-col gap-3 py-8 text-center text-balance">
              <h2 className="text-xl font-semibold">Submission limit reached</h2>
              <p className="text-sm text-muted-foreground">You already have three submissions for this event.</p>
              <Link href={`/portal/${event.slug}`} className="text-sm underline underline-offset-4">
                View your submissions
              </Link>
            </section>
          </>
        ) : (
          <PublicFormWizard
            header={header}
            mdxSource={draft?.pinnedMdxSource ?? mdxSource}
            scope={scope}
            initialValues={draft?.values}
            initialParticipants={draft?.participants}
            authenticated={Boolean(draft)}
            accountEmail={accountEmail}
            accountName={accountName}
            signInHref={signInHref}
            uploadFile={draft ? uploadFile : undefined}
            onChange={setLastSubmission}
            onSaveDraft={draft ? save : undefined}
            onSubmit={submit}
            submitLabel="Submit session"
            saving={saving}
            savedAt={savedAt}
            error={error}
          />
        )}
      </div>
    </main>
  )
}
