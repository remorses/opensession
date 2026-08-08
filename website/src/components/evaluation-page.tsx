// Evaluation page: To Review | My Reviews | Progress tabs.
'use client'

import { useState, useTransition } from 'react'
import { ErrorBoundary, Link, router, useLoaderData } from 'spiceflow/react'
import { StarIcon } from 'lucide-react'
import { upsertReview } from '../actions.tsx'
import { cn } from '../lib/utils.ts'
import { SessionStatusBadge } from './abstracts-page.tsx'
import type { SessionStatus } from '../lib/submissions.ts'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import { EmptyState, NativeSelect, Textarea } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'

export type EvaluationTab = 'to-review' | 'my-reviews' | 'progress'

const tabs: { value: EvaluationTab; label: string }[] = [
  { value: 'to-review', label: 'To Review' },
  { value: 'my-reviews', label: 'My Reviews' },
  { value: 'progress', label: 'Progress' },
]

export function EvaluationPage({ tab }: { tab: EvaluationTab }) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event } = useLoaderData('/org/:orgId/e/:eventId/*')
  const data = useLoaderData('/org/:orgId/e/:eventId/evaluation')

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Evaluation</h1>
        <p className="text-sm text-muted-foreground">
          Vote, rate, and comment on pending submissions; track review coverage.
        </p>
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        {tabs.map((t) => (
          <Link
            key={t.value}
            href={router.href(`/org/${currentOrgId}/e/${event.id}/evaluation`, { tab: t.value })}
            className={cn(
              'relative -mb-px px-2.5 py-2 text-sm no-underline transition-colors',
              t.value === tab
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            {t.value === 'to-review' ? (
              <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
                {data.toReview.length}
              </span>
            ) : null}
            {t.value === tab ? (
              <span className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-sm bg-primary" />
            ) : null}
          </Link>
        ))}
      </div>

      {tab === 'to-review' ? (
        <ToReviewTab orgId={currentOrgId} eventId={event.id} rows={data.toReview} />
      ) : null}
      {tab === 'my-reviews' ? (
        <MyReviewsTab orgId={currentOrgId} eventId={event.id} rows={data.myReviews} />
      ) : null}
      {tab === 'progress' ? (
        <ProgressTab
          orgId={currentOrgId}
          eventId={event.id}
          reviewers={data.reviewerProgress}
          coverage={data.sessionCoverage}
        />
      ) : null}
    </div>
  )
}

type ReviewableRow = {
  id: string
  title: string | null
  status: SessionStatus
  speakerNames: string[]
  trackName: string | null
  formatName: string | null
}

function ToReviewTab({
  orgId,
  eventId,
  rows,
}: {
  orgId: string
  eventId: string
  rows: ReviewableRow[]
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<StarIcon className="size-5 text-muted-foreground" />}
        title="All caught up"
        description="No pending submissions left for you to review."
      />
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {rows.map((row) => (
        <InlineReviewCard key={row.id} orgId={orgId} eventId={eventId} row={row} />
      ))}
    </div>
  )
}

function InlineReviewCard({
  orgId,
  eventId,
  row,
  initial,
}: {
  orgId: string
  eventId: string
  row: ReviewableRow
  initial?: { vote: 'YES' | 'MAYBE' | 'NO'; rating: number | null; comment: string | null }
}) {
  const [vote, setVote] = useState<'YES' | 'MAYBE' | 'NO'>(initial?.vote ?? 'YES')
  const [rating, setRating] = useState(initial?.rating != null ? String(initial.rating) : '')
  const [comment, setComment] = useState(initial?.comment ?? '')
  const [pending, startTransition] = useTransition()
  const [done, setDone] = useState(false)

  if (done && !initial) return null

  return (
    <Frame>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <Link
              href={router.href(`/org/${orgId}/e/${eventId}/abstracts/${row.id}`)}
              className="font-medium text-foreground no-underline hover:underline"
            >
              {row.title?.trim() || 'Untitled'}
            </Link>
            <p className="text-sm text-muted-foreground">
              {row.speakerNames.join(', ') || 'No speakers'}
              {row.trackName ? ` · ${row.trackName}` : ''}
              {row.formatName ? ` · ${row.formatName}` : ''}
            </p>
          </div>
          <SessionStatusBadge status={row.status} />
        </div>
        <ErrorBoundary
          below
          fallback={
            <div className="text-sm text-destructive">
              <ErrorBoundary.ErrorMessage />
            </div>
          }
        >
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs font-medium">
              Vote
              <NativeSelect
                className="min-w-[7rem]"
                value={vote}
                onChange={(e) => setVote(e.target.value as typeof vote)}
              >
                <option value="YES">Yes</option>
                <option value="MAYBE">Maybe</option>
                <option value="NO">No</option>
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium">
              Rating
              <NativeSelect
                className="min-w-[7rem]"
                value={rating}
                onChange={(e) => setRating(e.target.value)}
              >
                <option value="">—</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="flex min-w-[12rem] grow flex-col gap-1 text-xs font-medium">
              Comment
              <Textarea
                rows={1}
                className="min-h-9 py-2"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </label>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                startTransition(async () => {
                  await upsertReview({
                    orgId,
                    eventId,
                    sessionId: row.id,
                    vote,
                    rating: rating ? Number(rating) : null,
                    comment: comment.trim() || null,
                  })
                  if (!initial) setDone(true)
                  router.refresh()
                })
              }}
            >
              {pending ? 'Saving…' : initial ? 'Update' : 'Save'}
            </Button>
          </div>
        </ErrorBoundary>
      </div>
    </Frame>
  )
}

function MyReviewsTab({
  orgId,
  eventId,
  rows,
}: {
  orgId: string
  eventId: string
  rows: Array<
    ReviewableRow & {
      vote: 'YES' | 'MAYBE' | 'NO'
      rating: number | null
      comment: string | null
    }
  >
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<StarIcon className="size-5 text-muted-foreground" />}
        title="No reviews yet"
        description="Reviews you submit will show up here so you can edit them."
      />
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {rows.map((row) => (
        <InlineReviewCard
          key={row.id}
          orgId={orgId}
          eventId={eventId}
          row={row}
          initial={{ vote: row.vote, rating: row.rating, comment: row.comment }}
        />
      ))}
    </div>
  )
}

function ProgressTab({
  orgId,
  eventId,
  reviewers,
  coverage,
}: {
  orgId: string
  eventId: string
  reviewers: Array<{
    reviewerId: string
    name: string
    email: string
    total: number
    yes: number
    maybe: number
    no: number
  }>
  coverage: Array<{
    sessionId: string
    title: string
    status: string
    reviewCount: number
  }>
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Per reviewer</h2>
        {reviewers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reviews submitted yet.</p>
        ) : (
          <Frame>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reviewer</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Yes</TableHead>
                  <TableHead>Maybe</TableHead>
                  <TableHead>No</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reviewers.map((row) => (
                  <TableRow key={row.reviewerId}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{row.name}</span>
                        <span className="text-xs text-muted-foreground">{row.email}</span>
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">{row.total}</TableCell>
                    <TableCell className="tabular-nums">{row.yes}</TableCell>
                    <TableCell className="tabular-nums">{row.maybe}</TableCell>
                    <TableCell className="tabular-nums">{row.no}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Frame>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Per session coverage</h2>
        {coverage.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sessions in the review pipeline.</p>
        ) : (
          <Frame>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reviews</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {coverage.map((row) => (
                  <TableRow key={row.sessionId}>
                    <TableCell>
                      <Link
                        href={router.href(
                          `/org/${orgId}/e/${eventId}/abstracts/${row.sessionId}`,
                        )}
                        className="font-medium no-underline hover:underline"
                      >
                        {row.title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <SessionStatusBadge status={row.status as SessionStatus} />
                    </TableCell>
                    <TableCell className="tabular-nums">{row.reviewCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Frame>
        )}
      </div>
    </div>
  )
}
