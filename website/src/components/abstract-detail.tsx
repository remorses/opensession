// Abstract detail page: typed fields, custom KV answers, participants,
// review panel, and decision status actions.
'use client'

import { useState, useTransition } from 'react'
import { ErrorBoundary, Link, router, useLoaderData } from 'spiceflow/react'
import { ArrowLeftIcon } from 'lucide-react'
import { updateSessionStatus, upsertReview } from '../actions.tsx'
import type { SessionStatus } from '../lib/submissions.ts'
import { formatDateTimeUTC } from '../lib/utils.ts'
import { SessionStatusBadge } from './abstracts-page.tsx'
import { Button } from './ui/button.tsx'
import { Frame, FramePanel } from './ui/frame.tsx'
import { NativeSelect, Textarea } from './ui/primitives.tsx'

export function AbstractDetailPage() {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event } = useLoaderData('/org/:orgId/e/:eventId/*')
  const data = useLoaderData('/org/:orgId/e/:eventId/abstracts/:sessionId')
  const { session, participants, reviews, fieldValues, myReview, trackName, formatName, formName } =
    data

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
        <div className="flex flex-wrap items-start justify-between gap-3">
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
          <DecisionActions
            orgId={currentOrgId}
            eventId={event.id}
            sessionId={session.id}
            status={session.status}
          />
        </div>
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
                          {p.role.toLowerCase()}
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
          <ReviewPanel
            orgId={currentOrgId}
            eventId={event.id}
            sessionId={session.id}
            myReview={myReview}
          />
          <Frame>
            <FramePanel className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">All reviews ({reviews.length})</h2>
              {reviews.length === 0 ? (
                <p className="text-sm text-muted-foreground">No reviews yet.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {reviews.map((review) => (
                    <li key={review.id} className="flex flex-col gap-1 border-b border-border pb-3 last:border-0 last:pb-0">
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="font-medium">{review.reviewerName}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {review.vote}
                          {review.rating != null ? ` · ${review.rating}★` : ''}
                        </span>
                      </div>
                      {review.comment ? (
                        <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                          {review.comment}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </FramePanel>
          </Frame>
        </div>
      </div>
    </div>
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
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Status update failed')
      }
    })
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
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
        {status === 'ACCEPT_QUEUE' ? (
          <Button size="sm" disabled={pending} onClick={() => move('ACCEPTED')}>
            Accept now
          </Button>
        ) : null}
        {status === 'DECLINE_QUEUE' ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => move('DECLINED')}>
            Decline now
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
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

function ReviewPanel({
  orgId,
  eventId,
  sessionId,
  myReview,
}: {
  orgId: string
  eventId: string
  sessionId: string
  myReview: {
    vote: 'YES' | 'MAYBE' | 'NO'
    rating: number | null
    comment: string | null
  } | null
}) {
  const [vote, setVote] = useState<'YES' | 'MAYBE' | 'NO'>(myReview?.vote ?? 'YES')
  const [rating, setRating] = useState<string>(myReview?.rating != null ? String(myReview.rating) : '')
  const [comment, setComment] = useState(myReview?.comment ?? '')
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)

  return (
    <Frame>
      <FramePanel className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Your review</h2>
        <ErrorBoundary
          below
          fallback={
            <div className="text-sm text-destructive">
              <ErrorBoundary.ErrorMessage />
            </div>
          }
        >
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Vote</span>
            <NativeSelect value={vote} onChange={(e) => setVote(e.target.value as typeof vote)}>
              <option value="YES">Yes</option>
              <option value="MAYBE">Maybe</option>
              <option value="NO">No</option>
            </NativeSelect>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Rating (optional)</span>
            <NativeSelect value={rating} onChange={(e) => setRating(e.target.value)}>
              <option value="">No rating</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={String(n)}>
                  {n}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Comment</span>
            <Textarea
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Optional notes for the team"
            />
          </label>
          <Button
            disabled={pending}
            onClick={() => {
              setMessage(null)
              startTransition(async () => {
                await upsertReview({
                  orgId,
                  eventId,
                  sessionId,
                  vote,
                  rating: rating ? Number(rating) : null,
                  comment: comment.trim() || null,
                })
                setMessage('Saved')
              })
            }}
          >
            {pending ? 'Saving…' : myReview ? 'Update review' : 'Submit review'}
          </Button>
          {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
        </ErrorBoundary>
      </FramePanel>
    </Frame>
  )
}
