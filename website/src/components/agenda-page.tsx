// Agenda builder ('use client') — /org/:orgId/e/:eventId/agenda.
// Views are query params (?view=list|week|rooms|conflicts).
//
// TIME RULE: this component NEVER converts epochs. The loader resolves every
// session to the event timezone and hands over { dayKey, startMinute,
// endMinute }; placement sends a wall clock back ({ dayKey, startMinute,
// durationMinutes }) and the server turns it into UTC ms. That keeps SSR and
// the browser byte-identical and keeps DST logic in exactly one place.
//
// Placement uses a drawer opened from the toolbar or a session row. It starts
// with the format's default duration and sends wall-clock values to the server.
'use client'

import { useCallback, useMemo, useState, useTransition } from 'react'
import { Link, router, useLoaderData } from 'spiceflow/react'
import { CalendarDaysIcon, GripVerticalIcon, TriangleAlertIcon } from 'lucide-react'
import {
  applyAutoPlace,
  previewAutoPlace,
  scheduleSession,
  setProgramPublication,
  unscheduleSession,
} from '../actions.tsx'
import {
  conflictSessionIds,
  formatDayLabel,
  minutesToLabel,
  type AgendaConflictRow,
  type AgendaSessionRow,
} from '../lib/conflicts.ts'
import { summarizeProgramPublication } from '../lib/public-program.ts'
import { cn } from '../lib/utils.ts'
import { runAction, toast } from './ui/toast.tsx'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from './ui/dialog.tsx'
import { Badge, EmptyState, Input, NativeSelect } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'

export type AgendaView = 'list' | 'week' | 'rooms' | 'conflicts'

type AgendaRow = AgendaSessionRow

const views: { value: AgendaView; label: string }[] = [
  { value: 'list', label: 'List' },
  { value: 'week', label: 'Week' },
  { value: 'rooms', label: 'Rooms' },
  { value: 'conflicts', label: 'Conflicts' },
]

/** Fallback slot length when the session's format sets no default. */
const FALLBACK_DURATION = 30

type PlacementDraft = {
  sessionId: string
  roomId: string
  dayKey: string
  startMinute: number
  durationMinutes: number
}

function isScheduled(row: AgendaRow): boolean {
  return row.roomId != null && row.startMinute != null && row.dayKey != null
}

function durationOf(row: AgendaRow): number {
  if (row.startMinute != null && row.endMinute != null && row.endMinute > row.startMinute) {
    return row.endMinute - row.startMinute
  }
  return row.defaultDurationMinutes ?? FALLBACK_DURATION
}

export function AgendaPage({ view }: { view: AgendaView }) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event, rooms } = useLoaderData('/org/:orgId/e/:eventId/*')
  const { sessions, days, conflicts, timezone } = useLoaderData(
    '/org/:orgId/e/:eventId/agenda',
  )
  const [draft, setDraft] = useState<PlacementDraft | null>(null)
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof previewAutoPlace>> | null>(null)
  const [publicationOpen, setPublicationOpen] = useState(false)
  const [toolbarPending, startToolbarTransition] = useTransition()
  // Drag-and-drop: local override of { roomId, dayKey, sortIndex } per session.
  // Only populated when the user drags/moves a session. Cleared on save.
  type PendingMove = { roomId: string; dayKey: string; sortIndex: number }
  const [pendingMoves, setPendingMoves] = useState<Map<string, PendingMove>>(new Map())
  const [savePending, startSaveTransition] = useTransition()

  const conflicting = useMemo(() => conflictSessionIds(conflicts), [conflicts])
  // Apply pending moves to determine scheduled/unscheduled lists
  const sessionsWithMoves = useMemo(() => {
    if (pendingMoves.size === 0) return sessions
    return sessions.map((row) => {
      const move = pendingMoves.get(row.id)
      if (!move) return row
      return { ...row, dayKey: move.dayKey, roomId: move.roomId, roomName: rooms.find((r) => r.id === move.roomId)?.name ?? row.roomName }
    })
  }, [sessions, pendingMoves, rooms])
  const scheduled = sessionsWithMoves.filter(isScheduled)
  const unscheduled = sessionsWithMoves.filter((row) => !isScheduled(row))
  const publication = summarizeProgramPublication(sessions)
  const acceptedContent = sessions.filter((row) => row.kind === 'CONTENT' && row.status === 'ACCEPTED')
  const acceptedUnscheduledCount = acceptedContent.filter((row) => !isScheduled(row)).length
  const privateAcceptedCount = acceptedContent.filter((row) => row.visibility === 'PRIVATE').length

  async function saveAgendaMoves() {
    if (pendingMoves.size === 0) return
    // For each moved session, compute its new startMinute based on where
    // it was dropped relative to its neighbors. Only the moved session's
    // time changes; other sessions stay put.
    const updates: Array<{ sessionId: string; dayKey: string; startMinute: number; durationMinutes: number; roomId: string }> = []

    for (const [sessionId, move] of pendingMoves) {
      const row = sessions.find((s) => s.id === sessionId)
      if (!row) continue
      const dur = durationOf(row)

      // Find all unmoved sessions already in the target day, sorted by time
      const neighbors = sessions
        .filter((s) => {
          if (s.id === sessionId) return false
          const sMove = pendingMoves.get(s.id)
          const sDay = sMove?.dayKey ?? s.dayKey
          return sDay === move.dayKey && isScheduled(s)
        })
        .sort((a, b) => (a.startMinute ?? 0) - (b.startMinute ?? 0))

      let startMinute: number
      if (neighbors.length === 0) {
        // Empty day: start at 9:00
        startMinute = 9 * 60
      } else {
        // Find insertion point based on sortIndex
        const insertIdx = neighbors.findIndex((n) => (n.startMinute ?? 0) > move.sortIndex)
        if (insertIdx === 0) {
          // Dropped before all neighbors: start at the first neighbor's time minus duration,
          // but not before 8:00
          startMinute = Math.max(8 * 60, (neighbors[0]!.startMinute ?? 9 * 60) - dur)
        } else if (insertIdx === -1) {
          // Dropped after all neighbors: start after the last one ends
          const last = neighbors[neighbors.length - 1]!
          startMinute = (last.startMinute ?? 0) + durationOf(last)
        } else {
          // Dropped between two neighbors: start after the one above ends
          const above = neighbors[insertIdx - 1]!
          startMinute = (above.startMinute ?? 0) + durationOf(above)
        }
      }

      updates.push({ sessionId, dayKey: move.dayKey, startMinute, durationMinutes: dur, roomId: move.roomId })
    }

    let success = 0
    for (const update of updates) {
      const result = await runAction(
        () => scheduleSession({
          orgId: currentOrgId,
          eventId: event.id,
          sessionId: update.sessionId,
          roomId: update.roomId,
          dayKey: update.dayKey,
          startMinute: update.startMinute,
          durationMinutes: update.durationMinutes,
          confirmConflicts: true,
        }),
        { fallbackError: 'Could not save agenda change' },
      )
      if (result) success++
    }
    if (success > 0) {
      toast.success(`${success} session${success === 1 ? '' : 's'} updated.`, 'Agenda saved')
      setPendingMoves(new Map())
    }
  }

  function openPlacement(partial: Partial<PlacementDraft> & { sessionId?: string }) {
    const sessionId = partial.sessionId ?? unscheduled[0]?.id ?? sessions[0]?.id ?? ''
    const row = sessions.find((item) => item.id === sessionId)
    setDraft({
      sessionId,
      roomId: partial.roomId ?? row?.roomId ?? rooms[0]?.id ?? '',
      dayKey: partial.dayKey ?? row?.dayKey ?? days[0] ?? '',
      startMinute: partial.startMinute ?? row?.startMinute ?? 9 * 60,
      durationMinutes: partial.durationMinutes ?? (row ? durationOf(row) : FALLBACK_DURATION),
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Agenda</h1>
          <p className="text-sm text-muted-foreground">
            {scheduled.length} scheduled · {unscheduled.length} unscheduled · times in {timezone}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {event.programPublishedAt ? (
            <Button
              variant="outline"
              render={<Link href={router.href(`/public/${event.slug}/agenda`)} target="_blank" />}
            >
              View public agenda
            </Button>
          ) : null}
          <div className="flex items-center gap-2" aria-label="Build agenda actions">
            {pendingMoves.size > 0 ? (
              <>
                <span className="text-sm text-muted-foreground">{pendingMoves.size} unsaved</span>
                <Button variant="outline" onClick={() => setPendingMoves(new Map())}>
                  Discard
                </Button>
                <Button
                  disabled={savePending}
                  onClick={() => startSaveTransition(() => saveAgendaMoves())}
                >
                  {savePending ? 'Saving…' : 'Save changes'}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={toolbarPending || rooms.length === 0 || unscheduled.length === 0}
                  onClick={() => {
                    startToolbarTransition(async () => {
                      const result = await runAction(
                        () => previewAutoPlace({ orgId: currentOrgId, eventId: event.id }),
                        { fallbackError: 'Could not build an automatic placement preview' },
                      )
                      if (result) setPlan(result)
                    })
                  }}
                >
                  Auto-place
                </Button>
                <Button
                  disabled={rooms.length === 0 || sessions.length === 0}
                  onClick={() => openPlacement({})}
                >
                  <CalendarDaysIcon />
                  Place
                </Button>
              </>
            )}
          </div>
          <div className="border-l border-border pl-3">
            <Button
              variant={event.programPublishedAt ? 'outline' : 'default'}
              disabled={toolbarPending}
              onClick={() => setPublicationOpen(true)}
            >
              {event.programPublishedAt ? 'Review unpublish' : 'Review and publish'}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-y border-border py-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1" aria-label="Program lifecycle">
          <LifecycleStep label="Accepted" complete={acceptedContent.length > 0} detail={`${acceptedContent.length}`} />
          <span className="text-muted-foreground">→</span>
          <LifecycleStep label="Public approval" complete={acceptedContent.length > 0 && privateAcceptedCount === 0} detail={`${acceptedContent.length - privateAcceptedCount}/${acceptedContent.length}`} />
          <span className="text-muted-foreground">→</span>
          <LifecycleStep label="Scheduled" complete={acceptedContent.length > 0 && acceptedUnscheduledCount === 0} detail={`${acceptedContent.length - acceptedUnscheduledCount}/${acceptedContent.length}`} />
          <span className="text-muted-foreground">→</span>
          <LifecycleStep label="Conflicts resolved" complete={conflicts.length === 0} detail={`${conflicts.length} warnings`} />
          <span className="text-muted-foreground">→</span>
          <LifecycleStep label="Published" complete={event.programPublishedAt != null} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground">
            Accepted sessions must be approved and scheduled. Public service blocks follow the same publication gate.
            {' '}{publication.publicScheduledCount} agenda items will appear; {publication.privateScheduledCount} private scheduled items and {acceptedUnscheduledCount} accepted unscheduled sessions will not.
          </p>
          <div className="flex flex-wrap gap-3">
            {privateAcceptedCount > 0 ? (
              <Link href={router.href(`/org/${currentOrgId}/e/${event.id}/sessions`, { tab: 'all' })} className="text-foreground underline underline-offset-4">
                Review public approval
              </Link>
            ) : null}
            {conflicts.length > 0 ? (
              <Link href={router.href(`/org/${currentOrgId}/e/${event.id}/agenda`, { view: 'conflicts' })} className="text-foreground underline underline-offset-4">
                Review conflicts
              </Link>
            ) : null}
            {event.programPublishedAt ? (
              <Link href={router.href(`/public/${event.slug}/agenda`)} target="_blank" className="text-foreground underline underline-offset-4">
                /public/{event.slug}/agenda
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        {views.map((item) => (
          <Link
            key={item.value}
            href={router.href(`/org/${currentOrgId}/e/${event.id}/agenda`, {
              view: item.value,
            })}
            className={cn(
              'relative -mb-px flex items-center gap-1.5 px-2.5 py-2 text-sm no-underline transition-colors',
              item.value === view
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
            {item.value === 'conflicts' && conflicts.length > 0 ? (
              <span className="text-xs tabular-nums text-destructive">{conflicts.length}</span>
            ) : null}
            {item.value === view ? (
              <span className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-sm bg-primary" />
            ) : null}
          </Link>
        ))}
      </div>

      {rooms.length === 0 ? (
        <EmptyState
          icon={<CalendarDaysIcon className="size-5 text-muted-foreground" />}
          title="No rooms yet"
          description="Add rooms in Settings → Rooms before building the agenda."
        >
          <Button
            variant="outline"
            render={
              <Link
                href={router.href(`/org/${currentOrgId}/e/${event.id}/settings`, { tab: 'rooms' })}
              />
            }
          >
            Add rooms
          </Button>
        </EmptyState>
      ) : view === 'week' ? (
        <WeekView
          days={days}
          rooms={rooms}
          sessions={sessionsWithMoves}
          unscheduled={unscheduled}
          conflicting={conflicting}
          onPlace={openPlacement}
          pendingMoves={pendingMoves}
          onPendingMovesChange={setPendingMoves}
        />
      ) : view === 'rooms' ? (
        <RoomsView rooms={rooms} sessions={sessions} conflicting={conflicting} onPlace={openPlacement} />
      ) : view === 'conflicts' ? (
        <ConflictsView conflicts={conflicts} orgId={currentOrgId} eventId={event.id} />
      ) : (
        <ListView
          orgId={currentOrgId}
          eventId={event.id}
          sessions={scheduled}
          unscheduled={unscheduled}
          conflicting={conflicting}
          onPlace={openPlacement}
        />
      )}

      <PlacementDialog
        draft={draft}
        onClose={() => setDraft(null)}
        orgId={currentOrgId}
        eventId={event.id}
        rooms={rooms}
        days={days}
        sessions={sessions}
      />
      <AutoPlaceDialog
        plan={plan}
        onClose={() => setPlan(null)}
        orgId={currentOrgId}
        eventId={event.id}
      />
      <PublicationDialog
        open={publicationOpen}
        onOpenChange={setPublicationOpen}
        published={event.programPublishedAt != null}
        orgId={currentOrgId}
        eventId={event.id}
        eventSlug={event.slug}
        publicScheduledCount={publication.publicScheduledCount}
        privateScheduledCount={publication.privateScheduledCount}
        acceptedUnscheduledCount={acceptedUnscheduledCount}
        conflictCount={conflicts.length}
      />
    </div>
  )
}

function LifecycleStep({ label, complete, detail }: { label: string; complete: boolean; detail?: string }) {
  return (
    <span className={cn('flex items-center gap-1 font-medium', complete ? 'text-success' : 'text-muted-foreground')}>
      <span aria-hidden>{complete ? '●' : '○'}</span>
      {label}{detail ? <span className="font-normal tabular-nums">({detail})</span> : null}
    </span>
  )
}

function PublicationDialog({
  open,
  onOpenChange,
  published,
  orgId,
  eventId,
  eventSlug,
  publicScheduledCount,
  privateScheduledCount,
  acceptedUnscheduledCount,
  conflictCount,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  published: boolean
  orgId: string
  eventId: string
  eventSlug: string
  publicScheduledCount: number
  privateScheduledCount: number
  acceptedUnscheduledCount: number
  conflictCount: number
}) {
  const [pending, startTransition] = useTransition()
  const destination = `/public/${eventSlug}/agenda`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{published ? 'Unpublish public program?' : 'Publish public program?'}</DialogTitle>
          <DialogDescription>
            Review what attendees will see. Conflicts are warnings and do not block publication.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
              <dt>Public scheduled agenda items</dt><dd className="font-medium tabular-nums">{publicScheduledCount}</dd>
              <dt>Private scheduled agenda items</dt><dd className="font-medium tabular-nums">{privateScheduledCount}</dd>
              <dt>Accepted unscheduled sessions</dt><dd className="font-medium tabular-nums">{acceptedUnscheduledCount}</dd>
              <dt>Conflict warnings</dt><dd className={cn('font-medium tabular-nums', conflictCount > 0 && 'text-warning')}>{conflictCount}</dd>
            </dl>
            <div className="flex flex-col gap-1 border-t border-border pt-3 text-sm">
              <strong>Exact impact</strong>
              <p className="text-muted-foreground">
                {published
                  ? `The public program, embeds, and feeds will stop returning attendee program data. Organizer schedule data stays unchanged.`
                  : `${publicScheduledCount} public scheduled agenda item${publicScheduledCount === 1 ? '' : 's'} will become visible. Private and unscheduled items stay hidden.`}
              </p>
            </div>
            <div className="flex flex-col gap-1 text-sm">
              <strong>Public agenda destination</strong>
              <Link href={router.href(`/public/${eventSlug}/agenda`)} target="_blank" className="w-fit text-foreground underline underline-offset-4">{destination}</Link>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant={published ? 'destructive' : 'default'}
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                const result = await runAction(
                  () => setProgramPublication({ orgId, eventId, published: !published }),
                  { fallbackError: published ? 'Could not unpublish the program' : 'Could not publish the program' },
                )
                if (!result) return
                onOpenChange(false)
                if (result.published) {
                  const privateWarning = result.privateScheduledCount > 0
                    ? ` ${result.privateScheduledCount} scheduled agenda item${result.privateScheduledCount === 1 ? ' remains' : 's remain'} private and will not appear.`
                    : ''
                  toast.success(
                    `The public agenda is live with ${result.publicScheduledCount} agenda item${result.publicScheduledCount === 1 ? '' : 's'}.${privateWarning}`,
                    'Program published',
                  )
                } else {
                  toast.success('The attendee agenda is no longer public.', 'Program unpublished')
                }
              })
            }}
          >
            {pending ? 'Updating…' : published ? 'Unpublish program' : 'Publish program'}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

function AutoPlaceDialog({
  plan,
  onClose,
  orgId,
  eventId,
}: {
  plan: Awaited<ReturnType<typeof previewAutoPlace>> | null
  onClose: () => void
  orgId: string
  eventId: string
}) {
  const [pending, startTransition] = useTransition()
  if (!plan) return null
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Automatic placement preview</DialogTitle>
          <DialogDescription>
            Existing slots stay fixed. The planner uses the first conflict-free day, time, and room.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Will place ({plan.placements.length})</span>
              {plan.placements.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sessions can be placed.</p>
              ) : plan.placements.map((placement) => (
                <div key={placement.sessionId} className="flex items-center justify-between gap-4 text-sm">
                  <span className="truncate font-medium">{placement.title}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatDayLabel(placement.dayKey)} · {minutesToLabel(placement.startMinute)} · {placement.roomName}
                  </span>
                </div>
              ))}
            </div>
            {plan.unplaced.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-destructive">Still unplaced ({plan.unplaced.length})</span>
                {plan.unplaced.map((row) => <span key={row.sessionId} className="text-sm text-muted-foreground">{row.title}</span>)}
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button
                type="button"
                disabled={pending || plan.placements.length === 0}
                onClick={() => {
                  startTransition(async () => {
                    const result = await runAction(
                      () => applyAutoPlace({ orgId, eventId }),
                      { fallbackError: 'Could not apply the automatic placement plan' },
                    )
                    if (result) onClose()
                  })
                }}
              >
                {pending ? 'Applying…' : `Apply ${plan.placements.length} placements`}
              </Button>
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

// ── Agenda views ──────────────────────────────────────────────────────

function ListView({
  orgId,
  eventId,
  sessions,
  unscheduled,
  conflicting,
  onPlace,
}: {
  orgId: string
  eventId: string
  sessions: AgendaRow[]
  unscheduled: AgendaRow[]
  conflicting: Set<string>
  onPlace: (partial: Partial<PlacementDraft> & { sessionId?: string }) => void
}) {
  const [pending, startTransition] = useTransition()
  const sorted = [...sessions].sort(
    (a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0) || a.title.localeCompare(b.title),
  )

  if (sorted.length === 0 && unscheduled.length === 0) {
    return (
      <EmptyState
        icon={<CalendarDaysIcon className="size-5 text-muted-foreground" />}
        title="Nothing to schedule yet"
        description="Accept abstracts or add service sessions, then place them on the agenda."
      />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <Frame>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Room</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Track</TableHead>
              <TableHead>Format</TableHead>
              <TableHead>Speakers</TableHead>
              <TableHead className="w-40" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap">
                  {row.dayKey ? formatDayLabel(row.dayKey) : '—'}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                  {row.timeLabel ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">{row.roomName ?? '—'}</TableCell>
                <TableCell>
                  <span className="font-medium">{row.title}</span>
                  {conflicting.has(row.id) ? (
                    <Badge variant="destructive" className="ml-2 px-1.5">
                      conflict
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground">{row.trackName ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">{row.formatName ?? '—'}</TableCell>
                <TableCell className="max-w-[12rem] truncate text-muted-foreground">
                  {row.speakerNames.join(', ') || '—'}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => onPlace({ sessionId: row.id })}>
                      Move
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => {
                        startTransition(async () => {
                          await runAction(
                            () => unscheduleSession({ orgId, eventId, sessionId: row.id }),
                            { fallbackError: 'Could not unschedule' },
                          )
                        })
                      }}
                    >
                      Unschedule
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Frame>

      {unscheduled.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Unscheduled ({unscheduled.length})</span>
          <div className="flex flex-wrap gap-2">
            {unscheduled.map((row) => (
              <Button key={row.id} size="sm" variant="outline" onClick={() => onPlace({ sessionId: row.id })}>
                {row.title}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ── Kanban week view (native HTML drag-and-drop, hover.dev pattern) ──
// Columns = days. Cards drag freely between day columns to reschedule.
// Each card shows room + time; a room dropdown lets users reassign rooms.
// Drop indicators between cards highlight during drag.

function getIndicators(columnId: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-column="${columnId}"][data-before]`))
}

function getNearestIndicator(e: React.DragEvent, columnId: string) {
  const indicators = getIndicators(columnId)
  let closest = { offset: Number.NEGATIVE_INFINITY, element: indicators[indicators.length - 1]! }
  for (const indicator of indicators) {
    const box = indicator.getBoundingClientRect()
    const offset = e.clientY - (box.top + box.height / 2)
    if (offset < 0 && offset > closest.offset) closest = { offset, element: indicator }
  }
  return closest
}

function clearHighlights(columnId?: string) {
  const selector = columnId ? `[data-column="${columnId}"][data-before]` : '[data-before]'
  document.querySelectorAll<HTMLElement>(selector).forEach((el) => { el.style.opacity = '0' })
}

function highlightIndicator(e: React.DragEvent, columnId: string) {
  clearHighlights(columnId)
  const { element } = getNearestIndicator(e, columnId)
  if (element) element.style.opacity = '1'
}

function DropIndicator({ beforeId, columnId }: { beforeId: string; columnId: string }) {
  return (
    <div
      data-before={beforeId}
      data-column={columnId}
      className="my-0.5 h-0.5 w-full rounded-full bg-primary opacity-0 transition-opacity"
    />
  )
}

function WeekView({
  days,
  rooms,
  sessions,
  unscheduled,
  conflicting,
  onPlace,
  pendingMoves,
  onPendingMovesChange,
}: {
  days: string[]
  rooms: { id: string; name: string }[]
  sessions: AgendaRow[]
  unscheduled: AgendaRow[]
  conflicting: Set<string>
  onPlace: (partial: Partial<PlacementDraft> & { sessionId?: string }) => void
  pendingMoves: Map<string, { roomId: string; dayKey: string; sortIndex: number }>
  onPendingMovesChange: (moves: Map<string, { roomId: string; dayKey: string; sortIndex: number }>) => void
}) {
  // Sessions grouped by day column
  const dayItems = useMemo(() => {
    const map = new Map<string, AgendaRow[]>()
    for (const day of days) map.set(day, [])
    for (const row of sessions) {
      if (!row.dayKey || !map.has(row.dayKey)) continue
      if (!isScheduled(row)) continue
      map.get(row.dayKey)!.push(row)
    }
    for (const [, items] of map) {
      items.sort((a, b) => {
        const aMove = pendingMoves.get(a.id)
        const bMove = pendingMoves.get(b.id)
        const aKey = aMove ? aMove.sortIndex : (a.startMinute ?? 0)
        const bKey = bMove ? bMove.sortIndex : (b.startMinute ?? 0)
        return aKey - bKey
      })
    }
    return map
  }, [days, sessions, pendingMoves])

  const handleDragStart = useCallback((e: React.DragEvent, sessionId: string) => {
    e.dataTransfer.setData('text/plain', sessionId)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, columnId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    highlightIndicator(e, columnId)
  }, [])

  const handleDragLeave = useCallback((_e: React.DragEvent, columnId: string) => {
    clearHighlights(columnId)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, targetDay: string) => {
    e.preventDefault()
    clearHighlights()
    const sessionId = e.dataTransfer.getData('text/plain')
    if (!sessionId) return

    const { element } = getNearestIndicator(e, targetDay)
    const beforeId = element?.getAttribute('data-before') ?? '-1'
    const items = dayItems.get(targetDay) ?? []

    let sortIndex: number
    if (beforeId === '-1') {
      const last = items[items.length - 1]
      sortIndex = last ? (last.startMinute ?? 0) + durationOf(last) + 1 : 0
    } else {
      const targetIdx = items.findIndex((row) => row.id === beforeId)
      if (targetIdx <= 0) {
        sortIndex = (items[0]?.startMinute ?? 0) - 1
      } else {
        const prev = items[targetIdx - 1]!
        const prevKey = pendingMoves.get(prev.id)?.sortIndex ?? (prev.startMinute ?? 0)
        const nextKey = pendingMoves.get(beforeId)?.sortIndex ?? (items[targetIdx]?.startMinute ?? 0)
        sortIndex = (prevKey + nextKey) / 2
      }
    }

    // Keep the session's current room (or first room as fallback)
    const row = sessions.find((s) => s.id === sessionId)
    const existingMove = pendingMoves.get(sessionId)
    const roomId = existingMove?.roomId ?? row?.roomId ?? rooms[0]?.id ?? ''

    const next = new Map(pendingMoves)
    next.set(sessionId, { roomId, dayKey: targetDay, sortIndex })
    onPendingMovesChange(next)
  }, [dayItems, sessions, rooms, pendingMoves, onPendingMovesChange])

  const handleRoomChange = useCallback((sessionId: string, newRoomId: string) => {
    const row = sessions.find((s) => s.id === sessionId)
    const existing = pendingMoves.get(sessionId)
    const next = new Map(pendingMoves)
    next.set(sessionId, {
      roomId: newRoomId,
      dayKey: existing?.dayKey ?? row?.dayKey ?? days[0] ?? '',
      sortIndex: existing?.sortIndex ?? (row?.startMinute ?? 0),
    })
    onPendingMovesChange(next)
  }, [sessions, days, pendingMoves, onPendingMovesChange])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-stretch gap-3 overflow-x-auto pb-2">
        {days.map((day) => {
          const items = dayItems.get(day) ?? []
          return (
            <div key={day} className="flex w-56 shrink-0 flex-col gap-1">
              <div className="flex items-baseline justify-between border-b border-border pb-1.5">
                <span className="text-sm font-medium">{formatDayLabel(day)}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{items.length}</span>
              </div>
              <div
                className="flex flex-1 flex-col transition-colors"
                onDragOver={(e) => handleDragOver(e, day)}
                onDragLeave={(e) => handleDragLeave(e, day)}
                onDrop={(e) => handleDrop(e, day)}
              >
                {items.map((row) => {
                  const move = pendingMoves.get(row.id)
                  const currentRoomId = move?.roomId ?? row.roomId ?? ''
                  const roomName = rooms.find((r) => r.id === currentRoomId)?.name ?? row.roomName
                  return (
                    <div key={row.id}>
                      <DropIndicator beforeId={row.id} columnId={day} />
                      <button
                        type="button"
                        draggable
                        onDragStart={(e) => handleDragStart(e, row.id)}
                        onClick={() => onPlace({ sessionId: row.id })}
                        className={cn(
                          'flex w-full cursor-grab items-start gap-1.5 rounded border px-1.5 py-1 text-left transition-colors active:cursor-grabbing hover:bg-accent/60',
                          conflicting.has(row.id) ? 'border-destructive/60' : 'border-border',
                          pendingMoves.has(row.id) && 'ring-2 ring-primary/30',
                        )}
                      >
                        <GripVerticalIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground/40" />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-xs font-medium leading-tight">{row.title}</span>
                          <span className="truncate text-[11px] tabular-nums text-muted-foreground">
                            {row.timeLabel} · {roomName}
                          </span>
                        </div>
                        {row.trackColor ? (
                          <span className="mt-0.5 size-2 shrink-0 rounded-full" style={{ backgroundColor: row.trackColor }} />
                        ) : null}
                      </button>
                    </div>
                  )
                })}
                <DropIndicator beforeId="-1" columnId={day} />
              </div>
            </div>
          )
        })}
      </div>

      {unscheduled.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Unscheduled ({unscheduled.length})</span>
          <div className="flex flex-wrap gap-2">
            {unscheduled.map((row) => (
              <Button key={row.id} size="sm" variant="outline" onClick={() => onPlace({ sessionId: row.id })}>
                {row.title}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function RoomsView({
  rooms,
  sessions,
  conflicting,
  onPlace,
}: {
  rooms: { id: string; name: string }[]
  sessions: AgendaRow[]
  conflicting: Set<string>
  onPlace: (partial: Partial<PlacementDraft> & { sessionId?: string }) => void
}) {
  const groups = [
    ...rooms.map((room) => ({
      key: room.id,
      label: room.name,
      items: sessions
        .filter((row) => row.roomId === room.id)
        .sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0)),
    })),
    {
      key: '__unscheduled',
      label: 'Unscheduled',
      items: sessions.filter((row) => !isScheduled(row)),
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{group.label}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{group.items.length}</span>
          </div>
          {group.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing here.</p>
          ) : (
            <Frame>
              <Table>
                <TableBody>
                  {group.items.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="w-40 whitespace-nowrap tabular-nums text-muted-foreground">
                        {row.dayKey ? `${formatDayLabel(row.dayKey)} · ${row.timeLabel}` : '—'}
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{row.title}</span>
                        {conflicting.has(row.id) ? (
                          <Badge variant="destructive" className="ml-2 px-1.5">
                            conflict
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-[14rem] truncate text-muted-foreground">
                        {row.speakerNames.join(', ') || '—'}
                      </TableCell>
                      <TableCell className="w-24">
                        <div className="flex justify-end">
                          <Button size="sm" variant="ghost" onClick={() => onPlace({ sessionId: row.id })}>
                            {isScheduled(row) ? 'Move' : 'Place'}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Frame>
          )}
        </div>
      ))}
    </div>
  )
}

function ConflictsView({
  conflicts,
  orgId,
  eventId,
}: {
  conflicts: AgendaConflictRow[]
  orgId: string
  eventId: string
}) {
  if (conflicts.length === 0) {
    return (
      <EmptyState
        icon={<CalendarDaysIcon className="size-5 text-muted-foreground" />}
        title="No conflicts"
        description="No room double-bookings and no speaker booked in two places at once."
      />
    )
  }

  return (
    <Frame>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Reason</TableHead>
            <TableHead>Detail</TableHead>
            <TableHead>When</TableHead>
            <TableHead>Sessions</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {conflicts.map((conflict, index) => (
            <TableRow key={`${conflict.aId}-${conflict.bId}-${conflict.reason}-${index}`}>
              <TableCell>
                <Badge variant="destructive" className="px-1.5">
                  <TriangleAlertIcon className="size-3" />
                  {conflict.reason === 'ROOM' ? 'Room' : 'Speaker'}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{conflict.detail}</TableCell>
              <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                {conflict.timeLabel || '—'}
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <ConflictSide
                    orgId={orgId}
                    eventId={eventId}
                    id={conflict.aId}
                    title={conflict.aTitle}
                    kind={conflict.aKind}
                  />
                  <ConflictSide
                    orgId={orgId}
                    eventId={eventId}
                    id={conflict.bId}
                    title={conflict.bTitle}
                    kind={conflict.bKind}
                  />
                </div>
              </TableCell>
              <TableCell>
                <div className="flex justify-end">
                  {conflict.dayKey ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      render={
                        <Link
                          href={router.href(`/org/${orgId}/e/${eventId}/agenda`, {
                            view: 'week',
                          })}
                        />
                      }
                    >
                      Open week
                    </Button>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Frame>
  )
}

function ConflictSide({
  orgId,
  eventId,
  id,
  title,
  kind,
}: {
  orgId: string
  eventId: string
  id: string
  title: string
  kind: 'CONTENT' | 'SERVICE'
}) {
  if (kind !== 'CONTENT') return <span className="text-sm">{title}</span>
  return (
    <Link
      href={router.href(`/org/${orgId}/e/${eventId}/abstracts/${id}`)}
      className="text-sm text-foreground no-underline hover:underline"
    >
      {title}
    </Link>
  )
}

// ── Placement drawer ────────────────────────────────────────────────

function PlacementDialog({
  draft,
  onClose,
  orgId,
  eventId,
  rooms,
  days,
  sessions,
}: {
  draft: PlacementDraft | null
  onClose: () => void
  orgId: string
  eventId: string
  rooms: { id: string; name: string }[]
  days: string[]
  sessions: AgendaRow[]
}) {
  // Remount per draft so the local form state always starts from the click.
  if (!draft) return null
  return (
    <PlacementForm
      key={`${draft.sessionId}-${draft.dayKey}-${draft.startMinute}-${draft.roomId}`}
      draft={draft}
      onClose={onClose}
      orgId={orgId}
      eventId={eventId}
      rooms={rooms}
      days={days}
      sessions={sessions}
    />
  )
}

function PlacementForm({
  draft,
  onClose,
  orgId,
  eventId,
  rooms,
  days,
  sessions,
}: {
  draft: PlacementDraft
  onClose: () => void
  orgId: string
  eventId: string
  rooms: { id: string; name: string }[]
  days: string[]
  sessions: AgendaRow[]
}) {
  const [sessionId, setSessionId] = useState(draft.sessionId)
  const [roomId, setRoomId] = useState(draft.roomId)
  const [dayKey, setDayKey] = useState(draft.dayKey)
  const [time, setTime] = useState(minutesToLabel(draft.startMinute))
  const [duration, setDuration] = useState(draft.durationMinutes)
  const [warnings, setWarnings] = useState<
    Array<{ title: string; reason: string; detail: string; timeLabel: string }>
  >([])
  const [pending, startTransition] = useTransition()

  const current = sessions.find((row) => row.id === sessionId)

  function submit(confirmConflicts: boolean) {
    const [hours, minutes] = time.split(':').map(Number)
    const startMinute = (hours ?? 0) * 60 + (minutes ?? 0)
    startTransition(async () => {
      const result = await runAction(
        () => scheduleSession({
          orgId,
          eventId,
          sessionId,
          roomId,
          dayKey,
          startMinute,
          durationMinutes: duration,
          confirmConflicts,
        }),
        { fallbackError: 'Could not place the session' },
      )
      if (!result) return
      if (!result.scheduled) {
        setWarnings(
          result.conflicts.map((conflict) => ({
            title: conflict.title,
            reason: conflict.reason === 'ROOM' ? 'Same room' : 'Shared speaker',
            detail: conflict.detail,
            timeLabel: conflict.timeLabel,
          })),
        )
        return
      }
      onClose()
    })
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Place session</DialogTitle>
          <DialogDescription>
            Times are in the event timezone. Overlaps only warn — you can schedule anyway.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              setWarnings([])
              submit(false)
            }}
          >
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Session
              <NativeSelect
                required
                value={sessionId}
                onChange={(e) => {
                  const next = e.target.value
                  setSessionId(next)
                  const row = sessions.find((item) => item.id === next)
                  if (row) setDuration(durationOf(row))
                  setWarnings([])
                }}
              >
                {sessions.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.title}
                    {isScheduled(row) ? ' (scheduled)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Room
              <NativeSelect required value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            {/* Day needs more width than Start/Minutes ("Sun, Sep 22" vs "09:00" / "30"). */}
            <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_5.5rem] gap-3">
              <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
                Day
                <NativeSelect value={dayKey} onChange={(e) => setDayKey(e.target.value)}>
                  {days.map((day) => (
                    <option key={day} value={day}>
                      {formatDayLabel(day)}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
                Start
                <Input
                  required
                  type="time"
                  step={900}
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="w-full"
                />
              </label>
              <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
                Minutes
                <Input
                  required
                  type="number"
                  min={5}
                  max={720}
                  step={5}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  className="w-full"
                />
              </label>
            </div>
            {current?.defaultDurationMinutes ? (
              <p className="text-xs text-muted-foreground">
                {current.formatName} default: {current.defaultDurationMinutes} minutes.
              </p>
            ) : null}

            {warnings.length > 0 ? (
              <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5">
                <span className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                  <TriangleAlertIcon className="size-3.5" />
                  This slot conflicts
                </span>
                <ul className="flex flex-col gap-1">
                  {warnings.map((warning, index) => (
                    <li key={index} className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{warning.title}</span>
                      {' — '}
                      {warning.reason}: {warning.detail}
                      {warning.timeLabel ? ` (${warning.timeLabel})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              {warnings.length > 0 ? (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={pending}
                  onClick={() => submit(true)}
                >
                  Schedule anyway
                </Button>
              ) : (
                <Button type="submit" disabled={pending}>
                  {pending ? 'Placing…' : 'Place'}
                </Button>
              )}
            </div>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}
