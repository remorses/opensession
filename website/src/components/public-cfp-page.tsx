// Standalone public CFP client page. It renders the pinned MDX draft,
// explicit draft saving, authenticated R2 uploads, final submission state,
// and a Google sign-in gate without the organizer dashboard shell.
'use client'

import * as React from 'react'
import { CheckCircle2Icon, SaveIcon } from 'lucide-react'
import { ErrorBoundary, Link, router } from 'spiceflow/react'
import { savePublicCfpDraft, submitPublicCfp } from '../actions.tsx'
import type { FieldOption, FormSubmission, ValuesRecord } from '../forms/collect-fields.ts'
import { FormRenderer } from '../forms/form-renderer.tsx'
import { formatDateRangeUTC, formatDateTimeUTC } from '../lib/utils.ts'
import { OpenSessionLogo } from './auth-page.tsx'
import { SignInButton } from './login-button.tsx'
import { Button } from './ui/button.tsx'
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
}: {
  event: { id: string; slug: string; name: string; startsAt: number; endsAt: number; location: string | null }
  form: { id: string; slug: string; name: string; closesAt: number | null }
  scope: { tracks: FieldOption[]; formats: FieldOption[] }
  mdxSource: string
  draft: DraftData | null
  signInHref: string
  capReached: boolean
}) {
  const [lastSubmission, setLastSubmission] = React.useState<FormSubmission | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [savedAt, setSavedAt] = React.useState<number | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
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
      setError(cause instanceof Error ? cause.message : 'Could not save the draft')
    } finally {
      setSaving(false)
    }
  }

  const submit = async (submission: FormSubmission) => {
    if (!draft) return
    setSubmitting(true)
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
      setError(cause instanceof Error ? cause.message : 'Could not submit this session')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
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

        {submitted ? (
          <section className="flex flex-col gap-5 py-8 text-center text-balance">
            <CheckCircle2Icon className="mx-auto size-10 text-success" />
            <div className="flex flex-col gap-2">
              <h2 className="text-2xl font-semibold">Submission received</h2>
              <p className="text-muted-foreground">The program team will review your session.</p>
            </div>
            <div className="mx-auto flex max-w-md flex-col gap-2 border-y border-border py-4 text-left text-sm">
              <span className="font-medium">{submitted.title}</span>
              <span className="font-mono text-xs text-muted-foreground">Reference: {submitted.sessionId}</span>
              <Badge variant="warning" className="w-fit px-1.5">Pending</Badge>
            </div>
            <Button
              variant="outline"
              className="mx-auto"
              render={<Link href={router.href('/portal/:eventSlug', { eventSlug: event.slug })} />}
            >
              View speaker portal
            </Button>
          </section>
        ) : capReached ? (
          <section className="flex flex-col gap-3 py-8 text-center text-balance">
            <h2 className="text-xl font-semibold">Submission limit reached</h2>
            <p className="text-sm text-muted-foreground">You already have three submissions for this event.</p>
            <Link href={router.href('/portal/:eventSlug', { eventSlug: event.slug })} className="text-sm underline underline-offset-4">
              View your submissions
            </Link>
          </section>
        ) : !draft ? (
          <section className="flex flex-col gap-5 py-8">
            <div inert className="pointer-events-none max-h-80 overflow-hidden border-b border-border pb-6 opacity-70">
              <FormRenderer mdxSource={mdxSource} scope={scope} />
            </div>
            <div className="flex flex-col gap-2 text-center text-balance">
              <h2 className="text-xl font-semibold">Submit your session</h2>
              <p className="text-sm text-muted-foreground">
                Sign in with Google to start. Your verified email links this submission to your speaker portal.
              </p>
            </div>
            <div className="mx-auto w-full max-w-sm">
              <SignInButton href={signInHref}>Continue with Google</SignInButton>
            </div>
          </section>
        ) : (
          <ErrorBoundary
            below
            fallback={<ErrorBoundary.ErrorMessage className="whitespace-pre-wrap text-sm text-destructive" />}
          >
            <div className="flex flex-col gap-6">
              <FormRenderer
                mdxSource={draft.pinnedMdxSource}
                scope={scope}
                initialValues={draft.values}
                initialParticipants={draft.participants}
                uploadFile={uploadFile}
                onChange={setLastSubmission}
                onSubmit={submit}
                submitLabel="Submit session"
              />
              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
                <Button variant="outline" loading={saving} onClick={() => save()}>
                  <SaveIcon data-icon="inline-start" />
                  Save draft
                </Button>
                {savedAt ? <span className="text-xs text-muted-foreground">Draft saved</span> : null}
                {submitting ? <span className="text-xs text-muted-foreground">Submitting…</span> : null}
                {error ? <p className="basis-full whitespace-pre-wrap text-sm text-destructive">{error}</p> : null}
              </div>
            </div>
          </ErrorBoundary>
        )}
      </div>
    </main>
  )
}
