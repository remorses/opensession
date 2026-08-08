// Abstracts list ('use client'): status tabs, search, bulk queue actions,
// notify buttons, CSV export link, and Frame+Table of CONTENT sessions.
'use client'

import { useMemo, useState, useTransition } from 'react'
import { ErrorBoundary, Link, router, useLoaderData } from 'spiceflow/react'
import { DownloadIcon, InboxIcon, SearchIcon } from 'lucide-react'
import {
  bulkUpdateSessionStatus,
  notifyQueue,
  updateSessionStatus,
} from '../actions.tsx'
import {
  ABSTRACTS_STATUS_TABS,
  canTransition,
  type AbstractsStatusTab,
  type SessionStatus,
} from '../lib/submissions.ts'
import { cn, formatDateTimeUTC } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import { Badge, EmptyState, Input, NativeSelect } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'

export type AbstractListRow = {
  id: string
  status: SessionStatus
  title: string | null
  trackName: string | null
  formatName: string | null
  speakerNames: string[]
  formName: string | null
  avgRating: number | null
  yes: number
  maybe: number
  no: number
  notifiedAt: number | null
  submittedAt: number | null
}

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  const variant =
    status === 'PENDING'
      ? 'warning'
      : status === 'ACCEPT_QUEUE' || status === 'ACCEPTED'
        ? 'success'
        : status === 'DECLINE_QUEUE'
          ? 'warning'
          : status === 'DECLINED'
            ? 'destructive'
            : status === 'WITHDRAWN' || status === 'DRAFT'
              ? 'secondary'
              : 'outline'
  const label = status.replace(/_/g, ' ').toLowerCase()
  return (
    <Badge
      variant={variant}
      className={cn(
        'px-1.5 capitalize',
        status === 'DECLINE_QUEUE' && 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
      )}
    >
      {label}
    </Badge>
  )
}

export function AbstractsPage({
  status,
  q,
}: {
  status: AbstractsStatusTab
  q: string
}) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event } = useLoaderData('/org/:orgId/e/:eventId/*')
  const { abstracts, counts } = useLoaderData('/org/:orgId/e/:eventId/abstracts')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState(q)

  const allIds = useMemo(() => abstracts.map((row) => row.id), [abstracts])
  const allSelected = abstracts.length > 0 && abstracts.every((row) => selected.has(row.id))

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(allIds))
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function runBulk(nextStatus: SessionStatus) {
    const sessionIds = [...selected]
    if (sessionIds.length === 0) return
    setError(null)
    startTransition(async () => {
      try {
        await bulkUpdateSessionStatus({
          orgId: currentOrgId,
          eventId: event.id,
          sessionIds,
          status: nextStatus,
        })
        setSelected(new Set())
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Bulk update failed')
      }
    })
  }

  function runNotify(queue: 'accept' | 'decline') {
    setError(null)
    startTransition(async () => {
      try {
        await notifyQueue({ orgId: currentOrgId, eventId: event.id, queue })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Notify failed')
      }
    })
  }

  function applySearch(value: string) {
    setSearch(value)
    router.push(
      router.href(`/org/${currentOrgId}/e/${event.id}/abstracts`, {
        status,
        ...(value.trim() ? { q: value.trim() } : {}),
      }),
    )
  }

  const csvHref = `/org/${currentOrgId}/e/${event.id}/abstracts.csv${status !== 'all' || q ? `?${new URLSearchParams({
    ...(status !== 'all' ? { status } : {}),
    ...(q ? { q } : {}),
  }).toString()}` : ''}`

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Abstracts</h1>
          <p className="text-sm text-muted-foreground">
            Review submissions, move them through accept and decline queues, and notify speakers.
          </p>
        </div>
        <Button variant="outline" render={<a href={csvHref} />}>
          <DownloadIcon />
          Export CSV
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-border">
        {ABSTRACTS_STATUS_TABS.map((tab) => (
          <Link
            key={tab.value}
            href={router.href(`/org/${currentOrgId}/e/${event.id}/abstracts`, {
              status: tab.value,
              ...(q ? { q } : {}),
            })}
            className={cn(
              'relative -mb-px flex items-center gap-1.5 px-2.5 py-2 text-sm no-underline transition-colors',
              tab.value === status
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            <span className="text-xs text-muted-foreground tabular-nums">
              {counts[tab.value] ?? 0}
            </span>
            {tab.value === status ? (
              <span className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-sm bg-primary" />
            ) : null}
          </Link>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] grow max-w-sm">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search title, speaker, track…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applySearch(search)
            }}
            onBlur={() => {
              if (search !== q) applySearch(search)
            }}
          />
        </div>
        {selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground tabular-nums">
              {selected.size} selected
            </span>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => runBulk('ACCEPT_QUEUE')}>
              Move to accept queue
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => runBulk('DECLINE_QUEUE')}>
              Move to decline queue
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => runBulk('PENDING')}>
              Move to pending
            </Button>
          </div>
        ) : null}
        {(status === 'accept-queue' || counts['accept-queue'] > 0) ? (
          <Button size="sm" disabled={pending} onClick={() => runNotify('accept')}>
            Notify accept queue
          </Button>
        ) : null}
        {(status === 'decline-queue' || counts['decline-queue'] > 0) ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => runNotify('decline')}>
            Notify decline queue
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {abstracts.length === 0 ? (
        <EmptyState
          icon={<InboxIcon className="size-5 text-muted-foreground" />}
          title={counts.all === 0 ? 'No abstracts yet' : 'Nothing here'}
          description={
            counts.all === 0
              ? 'Submissions from open CFP forms will show up here.'
              : 'No abstracts match this filter.'
          }
        />
      ) : (
        <Frame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all"
                  />
                </TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Speakers</TableHead>
                <TableHead>Track</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead>Votes</TableHead>
                <TableHead>Form</TableHead>
                <TableHead>Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {abstracts.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selected.has(row.id)}
                      onChange={() => toggleOne(row.id)}
                      aria-label={`Select ${row.title ?? row.id}`}
                    />
                  </TableCell>
                  <TableCell>
                    <StatusCell
                      orgId={currentOrgId}
                      eventId={event.id}
                      sessionId={row.id}
                      status={row.status}
                    />
                  </TableCell>
                  <TableCell>
                    <Link
                      href={router.href(
                        `/org/${currentOrgId}/e/${event.id}/abstracts/${row.id}`,
                      )}
                      className="font-medium text-foreground no-underline hover:underline"
                    >
                      {row.title?.trim() || 'Untitled'}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate text-muted-foreground">
                    {row.speakerNames.join(', ') || '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.trackName || '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{row.formatName || '—'}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {row.avgRating == null ? '—' : row.avgRating.toFixed(1)}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    <span title="Yes / Maybe / No">
                      {row.yes}/{row.maybe}/{row.no}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.formName || '—'}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {row.submittedAt ? formatDateTimeUTC(row.submittedAt) : '—'}
                    {row.notifiedAt ? (
                      <span className="ml-1 text-xs text-success">· notified</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Frame>
      )}
    </div>
  )
}

function StatusCell({
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
  // Only list the current status plus legal edges — terminal statuses keep a
  // disabled single option so the select never offers illegal moves.
  const all: SessionStatus[] = [
    'DRAFT',
    'PENDING',
    'ACCEPT_QUEUE',
    'ACCEPTED',
    'DECLINE_QUEUE',
    'DECLINED',
    'WITHDRAWN',
  ]
  const options = all.filter((opt) => opt === status || canTransition(status, opt))
  const locked = options.length <= 1

  return (
    <ErrorBoundary
      below
      fallback={
        <div className="text-xs text-destructive">
          <ErrorBoundary.ErrorMessage />
        </div>
      }
    >
      <div className="flex items-center gap-1.5">
        <SessionStatusBadge status={status} />
        <NativeSelect
          className="h-7 min-h-7 min-w-[8rem] py-0 text-xs"
          disabled={pending || locked}
          value={status}
          onChange={(e) => {
            const next = e.target.value as SessionStatus
            if (next === status) return
            startTransition(async () => {
              await updateSessionStatus({ orgId, eventId, sessionId, status: next })
            })
          }}
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt.replace(/_/g, ' ').toLowerCase()}
            </option>
          ))}
        </NativeSelect>
      </div>
    </ErrorBoundary>
  )
}
