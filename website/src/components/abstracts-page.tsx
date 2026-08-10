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
import { runAction, toast, toastActionError } from './ui/toast.tsx'
import { Button } from './ui/button.tsx'
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from './ui/dialog.tsx'
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
  notifiedAt: number | null
  submittedAt: number | null
}

const queueContext: Record<AbstractsStatusTab, { title: string; description: string }> = {
  all: { title: 'All submissions', description: 'See every proposal and its current decision state.' },
  pending: { title: 'Pending review', description: 'Move reviewed proposals into an accept or decline queue. Queue moves are draft decisions.' },
  'accept-queue': { title: 'Draft accept decisions', description: 'Speakers have not been informed. Review this shortlist, then Notify to finalize acceptance and send decision messages.' },
  accepted: { title: 'Final accepted decisions', description: 'Acceptance is final. The notified marker confirms delivery. Content still needs public approval before it can appear in a published program.' },
  'decline-queue': { title: 'Draft decline decisions', description: 'Speakers have not been informed. Review this list, then Notify to finalize declines and send decision messages.' },
  declined: { title: 'Final declined decisions', description: 'The decline is final. The notified marker confirms delivery. Use the detail page only when a proposal needs reconsideration.' },
  withdrawn: { title: 'Withdrawn submissions', description: 'These proposals are no longer in the active decision workflow.' },
  drafts: { title: 'Speaker drafts', description: 'These proposals were started but not submitted for review.' },
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
  const [notifyDialog, setNotifyDialog] = useState<'accept' | 'decline' | null>(null)

  const allIds = useMemo(() => abstracts.map((row) => row.id), [abstracts])
  const allSelected = abstracts.length > 0 && abstracts.every((row) => selected.has(row.id))
  const context = queueContext[status]

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
      const result = await runAction(
        () => bulkUpdateSessionStatus({
          orgId: currentOrgId,
          eventId: event.id,
          sessionIds,
          status: nextStatus,
        }),
        { fallbackError: 'Bulk update failed' },
      )
      if (result) setSelected(new Set())
      else setError('Bulk update failed')
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

      <div className="grid overflow-hidden rounded-lg border border-border sm:grid-cols-5">
        {['Pending review', 'Accept queue', 'Decline queue', 'Notify speakers', 'Public approval'].map((label, index) => (
          <div key={label} className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-sm last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"><span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-xs text-muted-foreground">{index + 1}</span><span>{label}</span></div>
        ))}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4 border-l-2 border-primary pl-3">
        <div className="flex max-w-3xl flex-col gap-1"><h2 className="text-sm font-medium">{context.title}</h2><p className="text-sm text-muted-foreground">{context.description}</p></div>
        {status === 'accept-queue' ? <Button size="sm" disabled={pending || counts['accept-queue'] === 0} onClick={() => setNotifyDialog('accept')}>Review and notify {counts['accept-queue']} acceptance{counts['accept-queue'] === 1 ? '' : 's'}</Button> : null}
        {status === 'decline-queue' ? <Button size="sm" variant="outline" disabled={pending || counts['decline-queue'] === 0} onClick={() => setNotifyDialog('decline')}>Review and notify {counts['decline-queue']} decline{counts['decline-queue'] === 1 ? '' : 's'}</Button> : null}
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
      <DecisionNotificationDialog
        open={notifyDialog != null}
        onOpenChange={(open) => { if (!open) setNotifyDialog(null) }}
        queue={notifyDialog ?? 'accept'}
        orgId={currentOrgId}
        eventId={event.id}
        eventName={event.name}
        count={notifyDialog === 'decline' ? counts['decline-queue'] : counts['accept-queue']}
        visibleRows={abstracts.filter((row) => row.status === (notifyDialog === 'decline' ? 'DECLINE_QUEUE' : 'ACCEPT_QUEUE'))}
      />
    </div>
  )
}

function DecisionNotificationDialog({
  open,
  onOpenChange,
  queue,
  orgId,
  eventId,
  eventName,
  count,
  visibleRows,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  queue: 'accept' | 'decline'
  orgId: string
  eventId: string
  eventName: string
  count: number
  visibleRows: AbstractListRow[]
}) {
  const [pending, startTransition] = useTransition()
  const accepted = queue === 'accept'
  const subject = accepted
    ? `Your talk was accepted for ${eventName}`
    : `An update on your ${eventName} submission`
  const body = accepted
    ? 'Good news: your talk was accepted. Open the speaker portal to review your onboarding tasks.'
    : 'Thank you for submitting. The program committee did not select this talk for the event.'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Preview {accepted ? 'acceptance' : 'decline'} notifications</DialogTitle>
          <DialogDescription>
            This will finalize {count} queued submission{count === 1 ? '' : 's'} and create one personalized outbox message per speaker.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {visibleRows.length > 0 ? (
            <div className="flex flex-col gap-1 text-sm text-muted-foreground">
              {visibleRows.slice(0, 5).map((row) => (
                <span key={row.id}>{row.title || 'Untitled'} · {row.speakerNames.join(', ') || 'No speaker'}</span>
              ))}
              {count > visibleRows.length ? <span>Plus {count - visibleRows.length} more in this queue</span> : null}
            </div>
          ) : null}
          <Frame className="flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase text-muted-foreground">Subject</span>
              <strong className="text-sm">{subject}</strong>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase text-muted-foreground">Message preview</span>
              <p className="text-sm text-muted-foreground">{body}</p>
              <p className="text-sm text-muted-foreground">Each email includes the submission title and speaker portal link.</p>
            </div>
          </Frame>
          {accepted ? (
            <p className="text-sm text-muted-foreground">
              Accepted sessions become schedulable immediately. They remain private until an organizer explicitly approves their visibility, so unpublished content cannot leak into the attendee program.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            loading={pending}
            disabled={count === 0}
            onClick={() => startTransition(async () => {
              const result = await runAction(
                () => notifyQueue({ orgId, eventId, queue }),
                { fallbackError: 'Could not notify the queue' },
              )
              if (!result) return
              toast.success(
                `Finalized ${result.updated} submission${result.updated === 1 ? '' : 's'}. Created ${result.emailsQueued} outbox message${result.emailsQueued === 1 ? '' : 's'}; ${result.emailsSent} sent immediately.`,
                'Decision notifications queued',
              )
              onOpenChange(false)
            })}
          >
            Send {count} notification{count === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
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
    .filter((opt) => !(status === 'ACCEPT_QUEUE' && opt === 'ACCEPTED') && !(status === 'DECLINE_QUEUE' && opt === 'DECLINED'))
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
            const next = options.find((option) => option === e.target.value)
            if (!next || next === status) return
            startTransition(async () => {
              await runAction(
                () => updateSessionStatus({ orgId, eventId, sessionId, status: next }),
                { fallbackError: 'Could not update status' },
              )
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
