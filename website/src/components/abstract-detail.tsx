// Abstract detail page: typed fields, custom KV answers, participants,
// review panel, and decision status actions.
'use client'

import { useState, useTransition } from 'react'
import { Link, router, useLoaderData } from 'spiceflow/react'
import { ArrowLeftIcon, HistoryIcon, PencilIcon } from 'lucide-react'
import {
  restoreSessionRevision,
  saveSessionContent,
  setSessionVisibility,
  updateSessionStatus,
} from '../actions.tsx'
import { runAction, toast, toastActionError } from './ui/toast.tsx'
import type { SessionStatus } from '../lib/submissions.ts'
import { formatDateTimeUTC } from '../lib/utils.ts'
import { SessionStatusBadge } from './abstracts-page.tsx'
import { Button } from './ui/button.tsx'
import { Frame, FramePanel } from './ui/frame.tsx'
import {
  Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle,
} from './ui/dialog.tsx'
import { Badge, Input, NativeSelect, Textarea } from './ui/primitives.tsx'

export function AbstractDetailPage() {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event, tracks, formats } = useLoaderData('/org/:orgId/e/:eventId/*')
  const data = useLoaderData('/org/:orgId/e/:eventId/abstracts/:sessionId')
  const { session, participants, reviews, fieldValues, trackName, formatName, formName, revisions } =
    data
  const [editOpen, setEditOpen] = useState(false)
  const [visibilityPending, startVisibility] = useTransition()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link
          href={router.href(`/org/${currentOrgId}/e/${event.id}/abstracts`)}
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" />
          Abstracts
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-balance">
                {session.title?.trim() || 'Untitled'}
              </h1>
              <SessionStatusBadge status={session.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              {[trackName, formatName, formName].filter(Boolean).join(' · ') || 'No track or format'}
              {session.submittedAt ? ` · submitted ${formatDateTimeUTC(session.submittedAt)}` : ''}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col items-start gap-2"><span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Decision</span><DecisionActions orgId={currentOrgId} eventId={event.id} sessionId={session.id} status={session.status} /></div>
            <div className="flex flex-col items-start gap-2"><span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Public visibility</span><div className="flex flex-wrap items-center gap-2"><NativeSelect aria-label="Content approval" className="w-36" disabled={visibilityPending} value={session.visibility} onChange={(change) => startVisibility(async () => {
              const visibility = change.target.value === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE'
              const result = await runAction(() => setSessionVisibility({ orgId: currentOrgId, eventId: event.id, sessionId: session.id, visibility }), { fallbackError: 'Could not update content approval' })
              if (result) toast.success(visibility === 'PUBLIC' ? 'Content approved for public output' : 'Content returned to private')
            })}><option value="PRIVATE">Not approved</option><option value="PUBLIC">Approved</option></NativeSelect><Button size="sm" variant="outline" onClick={() => setEditOpen(true)}><PencilIcon data-icon="inline-start" />Edit content</Button></div></div>
          </div>
        </div>
      </div>

      <div className="grid overflow-hidden rounded-lg border border-border sm:grid-cols-4">
        <div className="border-b border-border px-3 py-2.5 sm:border-b-0 sm:border-r"><span className="text-sm font-medium">Accepted</span><p className="text-xs text-muted-foreground">{session.status === 'ACCEPTED' ? 'The proposal is now a program session.' : 'Requires a final accepted decision.'}</p></div>
        <div className="border-b border-border px-3 py-2.5 sm:border-b-0 sm:border-r"><span className="text-sm font-medium">Notified</span><p className="text-xs text-muted-foreground">Decision email reached the speaker{session.notifiedAt ? ` on ${formatDateTimeUTC(session.notifiedAt)}` : ': not yet'}.</p></div>
        <div className="border-b border-border px-3 py-2.5 sm:border-b-0 sm:border-r"><span className="text-sm font-medium">Approved</span><p className="text-xs text-muted-foreground">Content is allowed in public output: {session.visibility === 'PUBLIC' ? 'yes' : 'no'}.</p></div>
        <div className="px-3 py-2.5"><span className="text-sm font-medium">Published</span><p className="text-xs text-muted-foreground">The event program must also be published and the session scheduled.</p></div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-5">
          <Frame>
            <FramePanel className="flex flex-col gap-4">
              <h2 className="text-sm font-medium">Abstract</h2>
              {session.description ? (
                <div className="whitespace-pre-wrap text-sm leading-relaxed">
                  {session.description}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No description.</p>
              )}
            </FramePanel>
          </Frame>

          {fieldValues.length > 0 ? (
            <Frame>
              <FramePanel className="flex flex-col gap-3">
                <h2 className="text-sm font-medium">Custom answers</h2>
                <dl className="flex flex-col gap-3">
                  {fieldValues.map((field) => (
                    <div key={`${field.name}:${field.value}:${field.subjectSpeakerId ?? ''}`} className="flex flex-col gap-0.5">
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {field.name}
                        {field.subjectLabel ? ` · ${field.subjectLabel}` : ''}
                      </dt>
                      <dd className="text-sm whitespace-pre-wrap">{field.value}</dd>
                    </div>
                  ))}
                </dl>
              </FramePanel>
            </Frame>
          ) : null}

          <Frame>
            <FramePanel className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">Participants</h2>
              {participants.length === 0 ? (
                <p className="text-sm text-muted-foreground">No speakers listed.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {participants.map((p) => (
                    <li key={p.id} className="flex flex-col gap-0.5 text-sm">
                      <span className="font-medium">
                        {[p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || 'Speaker'}
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          {p.roleLabel}
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        {[p.email, p.companyName, p.jobTitle].filter(Boolean).join(' · ')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </FramePanel>
          </Frame>
        </div>

        <div className="flex flex-col gap-5">
          <Frame>
            <FramePanel className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">Assigned reviews ({reviews.length})</h2>
              {reviews.length === 0 ? (
                <p className="text-sm text-muted-foreground">No reviews yet.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {reviews.map((review) => (
                    <li key={review.id} className="flex flex-col gap-1 border-b border-border pb-3 last:border-0 last:pb-0">
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="font-medium">{review.reviewerName} · {review.roundName}</span>
                        <Badge variant={review.state === 'COMPLETED' ? 'success' : 'secondary'}>{review.state.toLowerCase()}</Badge>
                      </div>
                      {review.values.map((value) => <p key={`${value.name}:${value.value}`} className="text-sm text-muted-foreground whitespace-pre-wrap"><span className="font-medium text-foreground">{value.name}:</span> {value.value}</p>)}
                      {review.recusalReason ? <p className="text-sm text-muted-foreground">Recused: {review.recusalReason}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </FramePanel>
          </Frame>

          <Frame>
            <FramePanel className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <HistoryIcon className="size-4 text-muted-foreground" />
                <h2 className="text-sm font-medium">Content history ({revisions.length})</h2>
              </div>
              {revisions.length === 0 ? (
                <p className="text-sm text-muted-foreground">Edits made here will appear as restorable versions.</p>
              ) : revisions.map((revision) => (
                <RevisionRow
                  key={revision.id}
                  orgId={currentOrgId}
                  eventId={event.id}
                  sessionId={session.id}
                  revision={revision}
                />
              ))}
            </FramePanel>
          </Frame>
        </div>
      </div>
      <SessionContentDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        orgId={currentOrgId}
        eventId={event.id}
        session={session}
        tracks={tracks}
        formats={formats}
      />
    </div>
  )
}

function RevisionRow({ orgId, eventId, sessionId, revision }: {
  orgId: string
  eventId: string
  sessionId: string
  revision: {
    id: string
    title: string | null
    description: string | null
    editorName: string
    createdAt: number
    restoredFromRevisionId: string | null
  }
}) {
  const [pending, startTransition] = useTransition()
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{revision.title ?? 'Untitled'}</p>
        <p className="text-xs text-muted-foreground">
          {revision.editorName} · {formatDateTimeUTC(revision.createdAt)}
          {revision.restoredFromRevisionId ? ' · restored' : ''}
        </p>
        <p className="line-clamp-2 text-xs text-muted-foreground">{revision.description ?? 'No abstract'}</p>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => startTransition(async () => {
          await runAction(() => restoreSessionRevision({
            orgId,
            eventId,
            sessionId,
            revisionId: revision.id,
          }), { success: 'Revision restored', fallbackError: 'Could not restore revision' })
        })}
      >
        {pending ? 'Restoring...' : 'Restore'}
      </Button>
    </div>
  )
}

function SessionContentDialog({ open, onOpenChange, orgId, eventId, session, tracks, formats }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  eventId: string
  session: {
    id: string
    title: string | null
    description: string | null
    trackId: string | null
    formatId: string | null
    coverImageFileId: string | null
  }
  tracks: Array<{ id: string; name: string }>
  formats: Array<{ id: string; name: string }>
}) {
  const [pending, startTransition] = useTransition()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit session content</DialogTitle>
          <DialogDescription>Each save creates an immutable version with your name and timestamp.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form className="flex flex-col gap-4" onSubmit={(event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            startTransition(async () => {
              const saved = await runAction(() => saveSessionContent({
                orgId,
                eventId,
                sessionId: session.id,
                title: String(form.get('title')),
                description: String(form.get('description')).trim() || null,
                trackId: String(form.get('trackId')).trim() || null,
                formatId: String(form.get('formatId')).trim() || null,
                coverImageFileId: session.coverImageFileId,
              }), { success: 'Session content saved', fallbackError: 'Could not save session content' })
              if (saved) onOpenChange(false)
            })
          }}>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Title
              <Input name="title" required maxLength={300} defaultValue={session.title ?? ''} />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Abstract
              <Textarea name="description" rows={9} maxLength={20_000} defaultValue={session.description ?? ''} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Track
                <NativeSelect name="trackId" defaultValue={session.trackId ?? ''}>
                  <option value="">No track</option>
                  {tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}
                </NativeSelect>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Format
                <NativeSelect name="formatId" defaultValue={session.formatId ?? ''}>
                  <option value="">No format</option>
                  {formats.map((format) => <option key={format.id} value={format.id}>{format.name}</option>)}
                </NativeSelect>
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={pending}>{pending ? 'Saving...' : 'Save version'}</Button>
            </div>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

function DecisionActions({
  orgId,
  eventId,
  sessionId,
  status,
}: {
  orgId: string
  eventId: string
  sessionId: string
  status: SessionStatus
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function move(next: SessionStatus) {
    setError(null)
    startTransition(async () => {
      try {
        await updateSessionStatus({ orgId, eventId, sessionId, status: next })
        toast.success(`Moved to ${next.replaceAll('_', ' ').toLowerCase()}`, 'Decision updated')
      } catch (err) {
        setError(toastActionError(err, 'Status update failed'))
      }
    })
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap gap-2">
        {status === 'PENDING' || status === 'DECLINE_QUEUE' ? (
          <Button size="sm" disabled={pending} onClick={() => move('ACCEPT_QUEUE')}>
            Accept queue
          </Button>
        ) : null}
        {status === 'PENDING' || status === 'ACCEPT_QUEUE' ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => move('DECLINE_QUEUE')}>
            Decline queue
          </Button>
        ) : null}
        {status === 'ACCEPTED' ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => move('DECLINE_QUEUE')}>
            Reconsider for decline
          </Button>
        ) : null}
        {status === 'DECLINED' ? (
          <Button size="sm" disabled={pending} onClick={() => move('ACCEPT_QUEUE')}>
            Reconsider for acceptance
          </Button>
        ) : null}
        {status === 'ACCEPT_QUEUE' || status === 'DECLINE_QUEUE' ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => move('PENDING')}>
            Back to pending
          </Button>
        ) : null}
        {status === 'PENDING' || status === 'DRAFT' || status === 'ACCEPT_QUEUE' || status === 'DECLINE_QUEUE' ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => move('WITHDRAWN')}>
            Withdraw
          </Button>
        ) : null}
      </div>
      {status === 'ACCEPT_QUEUE' || status === 'DECLINE_QUEUE' ? <p className="max-w-sm text-xs text-muted-foreground">This is a draft decision. Finalize it and inform speakers from the matching queue on the Abstracts page.</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
