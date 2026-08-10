// Agenda builder ('use client') — /org/:orgId/e/:eventId/agenda.
// Views are query params (?view=list|day|week|rooms|conflicts&day=YYYY-MM-DD).
//
// TIME RULE: this component NEVER converts epochs. The loader resolves every
// session to the event timezone and hands over { dayKey, startMinute,
// endMinute }; placement sends a wall clock back ({ dayKey, startMinute,
// durationMinutes }) and the server turns it into UTC ms. That keeps SSR and
// the browser byte-identical and keeps DST logic in exactly one place.
//
// Placement is click-to-place: click a grid cell (optionally after picking a
// session in the unscheduled rail) and the drawer opens pre-filled with the
// format's default duration. Pointer drag-and-drop is deliberately not built.
'use client'

import { useMemo, useState, useTransition } from 'react'
import { Link, router, useLoaderData } from 'spiceflow/react'
import { CalendarDaysIcon, TriangleAlertIcon } from 'lucide-react'
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
  layoutDayColumns,
  minutesToLabel,
  type AgendaConflictRow,
  type AgendaSessionRow,
  type ZonedPlacement,
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

export type AgendaView = 'list' | 'day' | 'week' | 'rooms' | 'conflicts'

type AgendaRow = AgendaSessionRow

const views: { value: AgendaView; label: string }[] = [
  { value: 'list', label: 'List' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'rooms', label: 'Rooms' },
  { value: 'conflicts', label: 'Conflicts' },
]

/** Fallback slot length when the session's format sets no default. */
const FALLBACK_DURATION = 30
const SLOT_MINUTES = 15
const ROW_HEIGHT = '1.15rem'

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
  const { sessions, days, selectedDay, conflicts, timezone } = useLoaderData(
    '/org/:orgId/e/:eventId/agenda',
  )
  const [draft, setDraft] = useState<PlacementDraft | null>(null)
  /** Rail selection: the next clicked cell places THIS session. */
  const [picked, setPicked] = useState<string | null>(null)
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof previewAutoPlace>> | null>(null)
  const [publicationOpen, setPublicationOpen] = useState(false)
  const [toolbarPending, startToolbarTransition] = useTransition()

  const conflicting = useMemo(() => conflictSessionIds(conflicts), [conflicts])
  const scheduled = sessions.filter(isScheduled)
  const unscheduled = sessions.filter((row) => !isScheduled(row))
  const publication = summarizeProgramPublication(sessions)
  const acceptedContent = sessions.filter((row) => row.kind === 'CONTENT' && row.status === 'ACCEPTED')
  const acceptedUnscheduledCount = acceptedContent.filter((row) => !isScheduled(row)).length
  const privateAcceptedCount = acceptedContent.filter((row) => row.visibility === 'PRIVATE').length

  function openPlacement(partial: Partial<PlacementDraft> & { sessionId?: string }) {
    const sessionId = partial.sessionId ?? picked ?? unscheduled[0]?.id ?? sessions[0]?.id ?? ''
    const row = sessions.find((item) => item.id === sessionId)
    setDraft({
      sessionId,
      roomId: partial.roomId ?? row?.roomId ?? rooms[0]?.id ?? '',
      dayKey: partial.dayKey ?? row?.dayKey ?? selectedDay,
      startMinute: partial.startMinute ?? row?.startMinute ?? 9 * 60,
      durationMinutes: partial.durationMinutes ?? (row ? durationOf(row) : FALLBACK_DURATION),
    })
    setPicked(null)
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
              ...(item.value === 'day' || item.value === 'week' ? { day: selectedDay } : {}),
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
      ) : view === 'day' ? (
        <DayView
          orgId={currentOrgId}
          eventId={event.id}
          days={days}
          selectedDay={selectedDay}
          rooms={rooms}
          sessions={sessions}
          conflicting={conflicting}
          picked={picked}
          onPick={setPicked}
          onPlace={openPlacement}
        />
      ) : view === 'week' ? (
        <WeekView days={days} sessions={scheduled} conflicting={conflicting} onPlace={openPlacement} />
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

// ── Day grid ────────────────────────────────────────────────────────

function DayView({
  orgId,
  eventId,
  days,
  selectedDay,
  rooms,
  sessions,
  conflicting,
  picked,
  onPick,
  onPlace,
}: {
  orgId: string
  eventId: string
  days: string[]
  selectedDay: string
  rooms: { id: string; name: string }[]
  sessions: AgendaRow[]
  conflicting: Set<string>
  picked: string | null
  onPick: (id: string | null) => void
  onPlace: (partial: Partial<PlacementDraft> & { sessionId?: string }) => void
}) {
  const placements: ZonedPlacement<AgendaRow>[] = sessions.flatMap((row) =>
    row.dayKey === selectedDay && row.roomId && row.startMinute != null && row.endMinute != null
      ? [{ session: row, roomId: row.roomId, startMinute: row.startMinute, endMinute: row.endMinute }]
      : [],
  )
  const grid = layoutDayColumns({
    dayKey: selectedDay,
    rooms,
    placements,
    slotMinutes: SLOT_MINUTES,
  })
  const rail = sessions.filter((row) => !isScheduled(row))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1">
        {days.map((day) => (
          <Link
            key={day}
            href={router.href(`/org/${orgId}/e/${eventId}/agenda`, { view: 'day', day })}
            className={cn(
              'rounded-md px-2.5 py-1 text-sm no-underline transition-colors',
              day === selectedDay
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            {formatDayLabel(day)}
          </Link>
        ))}
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        <Frame className="min-w-0 grow overflow-x-auto">
          <div
            className="grid min-w-[36rem] p-2"
            style={{
              gridTemplateColumns: `3.75rem repeat(${rooms.length}, minmax(8rem, 1fr))`,
              gridTemplateRows: `auto repeat(${grid.slots.length}, ${ROW_HEIGHT})`,
            }}
          >
            <div style={{ gridColumn: 1, gridRow: 1 }} />
            {rooms.map((room, index) => (
              <div
                key={room.id}
                style={{ gridColumn: index + 2, gridRow: 1 }}
                className="truncate border-b border-border px-2 pb-1.5 text-xs font-medium"
              >
                {room.name}
              </div>
            ))}

            {grid.slots.map((minute, index) =>
              minute % 60 === 0 ? (
                <div
                  key={`t-${minute}`}
                  style={{ gridColumn: 1, gridRow: index + 2 }}
                  className="pr-2 text-right text-[11px] tabular-nums text-muted-foreground"
                >
                  {minutesToLabel(minute)}
                </div>
              ) : null,
            )}

            {rooms.map((room, roomIndex) =>
              grid.slots.map((minute, slotIndex) => (
                <button
                  key={`${room.id}-${minute}`}
                  type="button"
                  aria-label={`Place at ${minutesToLabel(minute)} in ${room.name}`}
                  onClick={() =>
                    onPlace({
                      roomId: room.id,
                      dayKey: selectedDay,
                      startMinute: minute,
                      ...(picked ? { sessionId: picked } : {}),
                    })
                  }
                  style={{ gridColumn: roomIndex + 2, gridRow: slotIndex + 2 }}
                  className={cn(
                    'border-b border-l border-border/40 transition-colors hover:bg-accent/60',
                    minute % 60 === 0 && 'border-b-border/70',
                  )}
                />
              )),
            )}

            {grid.columns.map((column, columnIndex) =>
              column.items.map((item) => (
                <button
                  key={item.session.id}
                  type="button"
                  onClick={() => onPlace({ sessionId: item.session.id })}
                  style={{
                    gridColumn: columnIndex + 2,
                    gridRow: `${item.startRow + 2} / span ${item.rowSpan}`,
                    // Double-booked rooms split the column instead of stacking
                    // blocks on top of each other (unreadable, and the overlap
                    // is exactly what the organizer must see).
                    width: `${100 / item.laneCount}%`,
                    marginLeft: `${(100 / item.laneCount) * item.lane}%`,
                    borderInlineStartColor: conflicting.has(item.session.id)
                      ? 'var(--destructive)'
                      : (item.session.trackColor ?? undefined),
                  }}
                  className={cn(
                    'z-10 m-px flex flex-col items-start gap-0.5 overflow-hidden rounded-md border border-s-4 px-1.5 py-1 text-left',
                    item.session.kind === 'SERVICE'
                      ? 'border-border bg-muted text-muted-foreground'
                      : 'border-primary/30 bg-primary/10',
                    conflicting.has(item.session.id) && 'border-destructive/60 bg-destructive/10',
                  )}
                >
                  <span className="w-full truncate text-xs font-medium leading-tight">
                    {item.session.title}
                  </span>
                  <span className="w-full truncate text-[11px] tabular-nums opacity-70">
                    {minutesToLabel(item.startMinute)}–{minutesToLabel(item.endMinute)}
                  </span>
                  {item.session.trackName ? (
                    <span className="w-full truncate text-[10px] opacity-70">{item.session.trackName}</span>
                  ) : null}
                </button>
              )),
            )}
          </div>
        </Frame>

        <div className="flex w-full shrink-0 flex-col gap-2 lg:w-64">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium">Unscheduled</span>
            <span className="text-xs tabular-nums text-muted-foreground">{rail.length}</span>
          </div>
          {rail.length === 0 ? (
            <p className="text-sm text-muted-foreground">Everything has a slot.</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Pick one, then click a slot in the grid.
              </p>
              <div className="flex flex-col gap-1">
                {rail.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => onPick(picked === row.id ? null : row.id)}
                    style={{ borderInlineStartColor: row.trackColor ?? undefined }}
                    className={cn(
                      'flex flex-col items-start gap-0.5 rounded-md border border-s-4 px-2 py-1.5 text-left transition-colors',
                      picked === row.id
                        ? 'border-primary bg-primary/10'
                        : 'border-border hover:bg-accent/60',
                    )}
                  >
                    <span className="w-full truncate text-sm font-medium">{row.title}</span>
                    <span className="w-full truncate text-xs text-muted-foreground">
                      {[row.formatName, row.trackName, row.speakerNames.join(', ')]
                        .filter(Boolean)
                        .join(' · ') || 'No details'}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Other views ─────────────────────────────────────────────────────

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

function WeekView({
  days,
  sessions,
  conflicting,
  onPlace,
}: {
  days: string[]
  sessions: AgendaRow[]
  conflicting: Set<string>
  onPlace: (partial: Partial<PlacementDraft> & { sessionId?: string }) => void
}) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {days.map((day) => {
        const items = sessions
          .filter((row) => row.dayKey === day)
          .sort((a, b) => (a.startMinute ?? 0) - (b.startMinute ?? 0))
        return (
          <div key={day} className="flex w-56 shrink-0 flex-col gap-2">
            <div className="flex items-baseline justify-between border-b border-border pb-1.5">
              <span className="text-sm font-medium">{formatDayLabel(day)}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{items.length}</span>
            </div>
            {items.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing scheduled.</p>
            ) : (
              items.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => onPlace({ sessionId: row.id })}
                  style={{
                    borderInlineStartColor: conflicting.has(row.id)
                      ? 'var(--destructive)'
                      : (row.trackColor ?? undefined),
                  }}
                  className={cn(
                    'flex flex-col items-start gap-0.5 rounded-md border border-s-4 px-2 py-1.5 text-left transition-colors hover:bg-accent/60',
                    conflicting.has(row.id) ? 'border-destructive/60' : 'border-border',
                  )}
                >
                  <span className="w-full truncate text-xs tabular-nums text-muted-foreground">
                    {row.timeLabel} · {row.roomName}
                  </span>
                  <span className="w-full truncate text-sm font-medium">{row.title}</span>
                  {row.trackName ? <span className="w-full truncate text-xs text-muted-foreground">{row.trackName}</span> : null}
                </button>
              ))
            )}
          </div>
        )
      })}
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
                            view: 'day',
                            day: conflict.dayKey,
                          })}
                        />
                      }
                    >
                      Open day
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
