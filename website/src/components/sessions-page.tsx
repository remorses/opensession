// Sessions list ('use client'): the schedulable half of the program —
// ACCEPTED content sessions plus SERVICE blocks (breaks, lunch, registration).
// Tabs are query params (?tab=all|scheduled|unscheduled|service). Times arrive
// from the loader already rendered in the event timezone, so this component
// never touches Intl (SSR and the browser would disagree).
'use client'

import { useState, useTransition } from 'react'
import { Link, router, useLoaderData } from 'spiceflow/react'
import { CalendarPlusIcon, MicIcon, PlusIcon, TrashIcon } from 'lucide-react'
import {
  createServiceSession,
  deleteServiceSession,
  setSessionVisibility,
  unscheduleSession,
} from '../actions.tsx'
import type { AgendaSessionRow } from '../lib/conflicts.ts'
import { cn } from '../lib/utils.ts'
import { runAction, toast } from './ui/toast.tsx'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from './ui/dialog.tsx'
import { Badge, EmptyState, Input, NativeSelect, Textarea } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'

export type SessionsTab = 'all' | 'scheduled' | 'unscheduled' | 'service'

type SessionRow = AgendaSessionRow

const tabs: { value: SessionsTab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'unscheduled', label: 'Unscheduled' },
  { value: 'service', label: 'Service' },
]

function matchesTab(row: SessionRow, tab: SessionsTab): boolean {
  if (tab === 'all') return true
  if (tab === 'service') return row.kind === 'SERVICE'
  const scheduled = row.startsAt != null && row.roomId != null
  return tab === 'scheduled' ? scheduled : !scheduled
}

export function SessionsPage({ tab }: { tab: SessionsTab }) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event } = useLoaderData('/org/:orgId/e/:eventId/*')
  const { sessions } = useLoaderData('/org/:orgId/e/:eventId/sessions')
  const [createOpen, setCreateOpen] = useState(false)

  const visible = sessions.filter((row) => matchesTab(row, tab))

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Sessions</h1>
          <p className="text-sm text-muted-foreground">
            Accepted talks and service blocks. Place them on the agenda, and control what the
            public schedule shows.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2" aria-label="Schedule actions">
            <Button
              variant="outline"
              render={
                <Link href={router.href(`/org/${currentOrgId}/e/${event.id}/agenda`, { view: 'week' })} />
              }
            >
              <CalendarPlusIcon />
              Build agenda
            </Button>
          </div>
          <div className="border-l border-border pl-3">
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              Add service block
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-3 border-y border-border py-3 text-sm md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <strong>Accepted content</strong>
          <p className="text-muted-foreground">
            Talks arrive here after acceptance. Approve them for public view and schedule them before they can appear to attendees.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <strong>Service blocks</strong>
          <p className="text-muted-foreground">
            Breaks, lunch, and registration can be Public or Private. A Public service block still appears only after it is scheduled and the program is published.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        {tabs.map((item) => (
          <Link
            key={item.value}
            href={router.href(`/org/${currentOrgId}/e/${event.id}/sessions`, { tab: item.value })}
            className={cn(
              'relative -mb-px flex items-center gap-1.5 px-2.5 py-2 text-sm no-underline transition-colors',
              item.value === tab
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
            <span className="text-xs text-muted-foreground tabular-nums">
              {sessions.filter((row) => matchesTab(row, item.value)).length}
            </span>
            {item.value === tab ? (
              <span className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-sm bg-primary" />
            ) : null}
          </Link>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<MicIcon className="size-5 text-muted-foreground" />}
          title={sessions.length === 0 ? 'No sessions yet' : 'Nothing here'}
          description={
            sessions.length === 0
              ? 'Accept abstracts to fill this list, or add a service block like lunch or registration.'
              : 'No sessions match this tab.'
          }
        >
          {sessions.length === 0 ? (
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              Add service session
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <Frame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Speakers</TableHead>
                <TableHead>Track</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Room</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Public visibility</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <SessionsRow
                  key={row.id}
                  orgId={currentOrgId}
                  eventId={event.id}
                  row={row}
                />
              ))}
            </TableBody>
          </Table>
        </Frame>
      )}

      <ServiceSessionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        orgId={currentOrgId}
        eventId={event.id}
      />
    </div>
  )
}

function SessionsRow({
  orgId,
  eventId,
  row,
}: {
  orgId: string
  eventId: string
  row: SessionRow
}) {
  const [pending, startTransition] = useTransition()
  const scheduled = row.startsAt != null && row.roomId != null

  return (
    <TableRow>
      <TableCell>
        {row.kind === 'CONTENT' ? (
          <Link
            href={router.href(`/org/${orgId}/e/${eventId}/abstracts/${row.id}`)}
            className="font-medium text-foreground no-underline hover:underline"
          >
            {row.title}
          </Link>
        ) : (
          <span className="font-medium">{row.title}</span>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={row.kind === 'SERVICE' ? 'secondary' : 'outline'} className="px-1.5 capitalize">
          {row.kind.toLowerCase()}
        </Badge>
      </TableCell>
      <TableCell className="max-w-[12rem] truncate text-muted-foreground">
        {row.speakerNames.join(', ') || '—'}
      </TableCell>
      <TableCell className="text-muted-foreground">{row.trackName || '—'}</TableCell>
      <TableCell className="text-muted-foreground">{row.formatName || '—'}</TableCell>
      <TableCell className="text-muted-foreground">{row.roomName || '—'}</TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
        {row.dayKey && row.timeLabel ? `${row.dayKey} · ${row.timeLabel}` : '—'}
      </TableCell>
      <TableCell>
        <NativeSelect
          className="h-7 min-h-7 min-w-[6.5rem] py-0 text-xs"
          disabled={pending}
          value={row.visibility}
          onChange={(e) => {
            const visibility = e.target.value
            if (visibility !== 'PUBLIC' && visibility !== 'PRIVATE') return
            if (visibility === row.visibility) return
            startTransition(async () => {
              const result = await runAction(
                () => setSessionVisibility({ orgId, eventId, sessionId: row.id, visibility }),
                { fallbackError: 'Could not change visibility' },
              )
              if (result) {
                const label = row.kind === 'CONTENT'
                  ? visibility === 'PUBLIC' ? 'Approved for public view' : 'Not approved for public view'
                  : visibility === 'PUBLIC' ? 'Public' : 'Private'
                toast.success(`${row.title} is now ${label.toLowerCase()}.`, 'Visibility updated')
              }
            })
          }}
        >
          {row.kind === 'CONTENT' ? (
            <>
              <option value="PUBLIC">Approved for public</option>
              <option value="PRIVATE">Not approved</option>
            </>
          ) : (
            <>
              <option value="PUBLIC">Public</option>
              <option value="PRIVATE">Private</option>
            </>
          )}
        </NativeSelect>
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {scheduled ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                startTransition(async () => {
                  const result = await runAction(
                    () => unscheduleSession({ orgId, eventId, sessionId: row.id }),
                    { fallbackError: 'Could not unschedule' },
                  )
                  if (result) toast.success(`${row.title} was removed from the agenda.`, 'Session unscheduled')
                })
              }}
            >
              Unschedule
            </Button>
          ) : null}
          {row.kind === 'SERVICE' ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete ${row.title}`}
              disabled={pending}
              onClick={() => {
                if (!window.confirm(`Delete "${row.title}"?`)) return
                startTransition(async () => {
                  await runAction(
                    () => deleteServiceSession({ orgId, eventId, sessionId: row.id }),
                    { fallbackError: 'Could not delete' },
                  )
                })
              }}
            >
              <TrashIcon />
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  )
}

function ServiceSessionDialog({
  open,
  onOpenChange,
  orgId,
  eventId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  eventId: string
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<'PUBLIC' | 'PRIVATE'>('PUBLIC')
  const [pending, startTransition] = useTransition()

  function handleOpenChange(next: boolean) {
    if (next) {
      setTitle('')
      setDescription('')
      setVisibility('PUBLIC')
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add service session</DialogTitle>
          <DialogDescription>
            Breaks, lunch, and registration. No speakers, no CFP — place it on the agenda like any
            other block. Public blocks still require a schedule slot and a published program.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              startTransition(async () => {
                const created = await runAction(
                  () => createServiceSession({
                    orgId,
                    eventId,
                    title: title.trim(),
                    description: description.trim() || undefined,
                    visibility,
                  }),
                  { fallbackError: 'Could not create the session' },
                )
                if (created) onOpenChange(false)
              })
            }}
          >
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Title
              <Input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Lunch break"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Description (optional)
              <Textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Visibility
              <NativeSelect
                value={visibility}
                onChange={(e) => {
                  const next = e.target.value
                  if (next === 'PUBLIC' || next === 'PRIVATE') setVisibility(next)
                }}
              >
                <option value="PUBLIC">Public</option>
                <option value="PRIVATE">Private</option>
              </NativeSelect>
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}
