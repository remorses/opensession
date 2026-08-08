// Event Settings page (/org/:orgId/e/:eventId/settings) — tabs driven by the
// ?tab= query param (details | tracks | formats | rooms | team). Details is a
// plain form posting to the updateEvent action; tracks/formats/rooms are
// Frame+Table CRUD lists (access-tab pattern); team links to the org members
// page (access is org-level, no per-event roles).
'use client'

import { useActionState, useState } from 'react'
import { ErrorBoundary, Link, router, useLoaderData } from 'spiceflow/react'
import { TrashIcon, UsersIcon } from 'lucide-react'
import {
  createFormat,
  createRoom,
  createTrack,
  deleteFormat,
  deleteRoom,
  deleteTrack,
  updateEvent,
} from '../actions.tsx'
import { cn } from '../lib/utils.ts'
import { toZonedSlot } from '../lib/conflicts.ts'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import { Input, NativeSelect, Textarea, TimezoneSelect } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'

export type SettingsTab = 'details' | 'tracks' | 'formats' | 'rooms' | 'team'

const tabs: { value: SettingsTab; label: string }[] = [
  { value: 'details', label: 'Details' },
  { value: 'tracks', label: 'Tracks' },
  { value: 'formats', label: 'Formats' },
  { value: 'rooms', label: 'Rooms' },
  { value: 'team', label: 'Team' },
]

export function EventSettings({ tab }: { tab: SettingsTab }) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event, tracks, formats, rooms } = useLoaderData('/org/:orgId/e/:eventId/*')

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure event details and the session library: tracks, formats, and rooms.
        </p>
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        {tabs.map(({ value, label }) => (
          <Link
            key={value}
            // Template-literal href form: params interpolated, query typed
            // from the settings page's zod query schema.
            href={router.href(`/org/${currentOrgId}/e/${event.id}/settings`, { tab: value })}
            className={cn(
              'relative -mb-px px-2.5 py-2 text-sm no-underline transition-colors',
              value === tab
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
            {value === tab ? (
              <span className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-sm bg-primary" />
            ) : null}
          </Link>
        ))}
      </div>

      {tab === 'details' ? <DetailsTab orgId={currentOrgId} event={event} /> : null}
      {tab === 'tracks' ? <TracksTab orgId={currentOrgId} eventId={event.id} tracks={tracks} /> : null}
      {tab === 'formats' ? <FormatsTab orgId={currentOrgId} eventId={event.id} formats={formats} /> : null}
      {tab === 'rooms' ? <RoomsTab orgId={currentOrgId} eventId={event.id} rooms={rooms} /> : null}
      {tab === 'team' ? <TeamTab orgId={currentOrgId} /> : null}
    </div>
  )
}

// ── Details ─────────────────────────────────────────────────────────

type EventRow = {
  id: string
  name: string
  slug: string
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
  websiteUrl: string | null
  location: string | null
  timezone: string
  startsAt: number
  endsAt: number
  description: string | null
  contactEmail: string | null
}

function FieldLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <label className={cn('flex flex-col gap-1.5 text-sm font-medium', className)}>{children}</label>
}

function DetailsTab({ orgId, event }: { orgId: string; event: EventRow }) {
  // useActionState gives a "Saved" confirmation; thrown errors are caught
  // by the ErrorBoundary below and keep the form editable.
  const [message, formAction] = useActionState(async (_prev: string | null, formData: FormData) => {
    await updateEvent({
      orgId,
      eventId: event.id,
      name: String(formData.get('name') ?? '').trim(),
      slug: String(formData.get('slug') ?? '').trim(),
      status: formData.get('status') === 'ACTIVE' ? 'ACTIVE' : formData.get('status') === 'ARCHIVED' ? 'ARCHIVED' : 'DRAFT',
      websiteUrl: String(formData.get('websiteUrl') ?? '').trim(),
      location: String(formData.get('location') ?? '').trim(),
      timezone: String(formData.get('timezone') ?? '').trim(),
      // Send the raw day keys. The server resolves them through the event
      // timezone; converting here would bake in the browser's zone instead.
      startsAt: String(formData.get('startsAt') ?? ''),
      endsAt: String(formData.get('endsAt') ?? ''),
      description: String(formData.get('description') ?? '').trim(),
      contactEmail: String(formData.get('contactEmail') ?? '').trim(),
    })
    return 'Saved'
  }, null)

  return (
    <ErrorBoundary
      below
      fallback={<ErrorBoundary.ErrorMessage className="text-sm text-destructive" />}
    >
      <form action={formAction} className="flex max-w-2xl flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FieldLabel>
            Event name
            <Input required name="name" defaultValue={event.name} maxLength={120} />
          </FieldLabel>
          <FieldLabel>
            Slug
            <Input
              required
              name="slug"
              defaultValue={event.slug}
              maxLength={60}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              title="Lowercase letters, numbers, and dashes"
              className="font-mono"
            />
          </FieldLabel>
          <FieldLabel>
            Status
            <NativeSelect name="status" defaultValue={event.status}>
              <option value="DRAFT">Draft</option>
              <option value="ACTIVE">Active</option>
              <option value="ARCHIVED">Archived</option>
            </NativeSelect>
          </FieldLabel>
          <FieldLabel>
            Website URL
            <Input name="websiteUrl" type="url" defaultValue={event.websiteUrl ?? ''} placeholder="https://…" />
          </FieldLabel>
          <FieldLabel>
            Location
            <Input name="location" defaultValue={event.location ?? ''} placeholder="San Francisco, CA" />
          </FieldLabel>
          <FieldLabel>
            Contact email
            <Input
              name="contactEmail"
              type="email"
              defaultValue={event.contactEmail ?? ''}
              placeholder="program@yourconference.com"
            />
            <span className="text-xs font-normal text-muted-foreground">
              Speakers reply here. Every email OpenSession sends for this event uses it as Reply-To.
            </span>
          </FieldLabel>
          <FieldLabel>
            Timezone
            <TimezoneSelect required name="timezone" value={event.timezone} />
          </FieldLabel>
          <FieldLabel>
            Starts
            <Input required name="startsAt" type="date" defaultValue={toZonedSlot(event.startsAt, event.timezone).dayKey} />
          </FieldLabel>
          <FieldLabel>
            Ends
            <Input required name="endsAt" type="date" defaultValue={toZonedSlot(event.endsAt, event.timezone).dayKey} />
          </FieldLabel>
        </div>
        <FieldLabel>
          Description
          <Textarea name="description" defaultValue={event.description ?? ''} rows={4} maxLength={5000} />
        </FieldLabel>
        <div className="flex items-center gap-3">
          <Button type="submit">Save</Button>
          {message ? <span className="text-sm text-muted-foreground">{message}</span> : null}
        </div>
      </form>
    </ErrorBoundary>
  )
}

// ── Library tables (tracks / formats / rooms) ───────────────────────
// Shared table chrome: add form on top, Frame+Table below, inline delete
// with per-row pending state (access-tab pattern). Server actions
// automatically re-render the page with fresh loader data.

function useRowDelete() {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function run<T>(id: string, action: () => Promise<T>) {
    setError(null)
    setPendingId(id)
    void (async () => {
      try {
        await action()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete')
      } finally {
        setPendingId((current) => (current === id ? null : current))
      }
    })()
  }

  return { pendingId, error, run }
}

function DeleteRowButton({ pending, label, onClick }: { pending: boolean; label: string; onClick: () => void }) {
  return (
    <Button
      aria-label={label}
      loading={pending}
      size="icon-xs"
      title={label}
      variant="ghost"
      onClick={onClick}
    >
      <TrashIcon className="size-3.5 text-muted-foreground" />
    </Button>
  )
}

function LibraryEmpty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-muted-foreground">{children}</p>
}

function TracksTab({ orgId, eventId, tracks }: {
  orgId: string
  eventId: string
  tracks: { id: string; name: string; color: string; sortOrder: number }[]
}) {
  const { pendingId, error, run } = useRowDelete()

  return (
    <div className="flex flex-col gap-3">
      <ErrorBoundary below fallback={<ErrorBoundary.ErrorMessage className="text-sm text-destructive" />}>
        <form
          className="flex items-center gap-2"
          action={async (formData: FormData) => {
            await createTrack({
              orgId,
              eventId,
              name: String(formData.get('name') ?? '').trim(),
              color: String(formData.get('color') ?? '#6366f1'),
            })
          }}
        >
          <Input required name="name" placeholder="Track name" maxLength={80} className="max-w-xs" />
          <input
            aria-label="Track color"
            name="color"
            type="color"
            defaultValue="#6366f1"
            className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1"
          />
          <Button type="submit" variant="outline">Add track</Button>
        </form>
      </ErrorBoundary>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {tracks.length === 0 ? (
        <LibraryEmpty>No tracks yet. Tracks group sessions by theme and color the agenda.</LibraryEmpty>
      ) : (
        <Frame className="w-full max-w-2xl">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Track</TableHead>
                <TableHead className="w-24">Color</TableHead>
                <TableHead className="w-20">Order</TableHead>
                <TableHead className="w-14" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tracks.map((track) => (
                <TableRow key={track.id}>
                  <TableCell>
                    <span className="text-sm font-medium">{track.name}</span>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-3.5 rounded-full border border-border"
                        style={{ backgroundColor: track.color }}
                      />
                      <span className="font-mono text-xs text-muted-foreground">{track.color}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground tabular-nums">{track.sortOrder}</span>
                  </TableCell>
                  <TableCell className="p-0">
                    <DeleteRowButton
                      label={`Delete track ${track.name}`}
                      pending={pendingId === track.id}
                      onClick={() => run(track.id, () => deleteTrack({ orgId, eventId, trackId: track.id }))}
                    />
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

function FormatsTab({ orgId, eventId, formats }: {
  orgId: string
  eventId: string
  formats: { id: string; name: string; defaultDurationMinutes: number | null }[]
}) {
  const { pendingId, error, run } = useRowDelete()

  return (
    <div className="flex flex-col gap-3">
      <ErrorBoundary below fallback={<ErrorBoundary.ErrorMessage className="text-sm text-destructive" />}>
        <form
          className="flex items-center gap-2"
          action={async (formData: FormData) => {
            const duration = String(formData.get('duration') ?? '').trim()
            await createFormat({
              orgId,
              eventId,
              name: String(formData.get('name') ?? '').trim(),
              defaultDurationMinutes: duration ? Number(duration) : null,
            })
          }}
        >
          <Input required name="name" placeholder="Format name (Talk, Workshop…)" maxLength={80} className="max-w-xs" />
          <Input
            name="duration"
            type="number"
            min={1}
            max={1440}
            placeholder="Minutes"
            className="w-28"
          />
          <Button type="submit" variant="outline">Add format</Button>
        </form>
      </ErrorBoundary>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {formats.length === 0 ? (
        <LibraryEmpty>
          No formats yet. Formats set the default session duration when placing talks on the agenda.
        </LibraryEmpty>
      ) : (
        <Frame className="w-full max-w-2xl">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Format</TableHead>
                <TableHead className="w-40">Default duration</TableHead>
                <TableHead className="w-14" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {formats.map((format) => (
                <TableRow key={format.id}>
                  <TableCell>
                    <span className="text-sm font-medium">{format.name}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {format.defaultDurationMinutes ? `${format.defaultDurationMinutes} min` : '—'}
                    </span>
                  </TableCell>
                  <TableCell className="p-0">
                    <DeleteRowButton
                      label={`Delete format ${format.name}`}
                      pending={pendingId === format.id}
                      onClick={() => run(format.id, () => deleteFormat({ orgId, eventId, formatId: format.id }))}
                    />
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

function RoomsTab({ orgId, eventId, rooms }: {
  orgId: string
  eventId: string
  rooms: { id: string; name: string }[]
}) {
  const { pendingId, error, run } = useRowDelete()

  return (
    <div className="flex flex-col gap-3">
      <ErrorBoundary below fallback={<ErrorBoundary.ErrorMessage className="text-sm text-destructive" />}>
        <form
          className="flex items-center gap-2"
          action={async (formData: FormData) => {
            await createRoom({
              orgId,
              eventId,
              name: String(formData.get('name') ?? '').trim(),
            })
          }}
        >
          <Input required name="name" placeholder="Room name (Main Stage, Hall A…)" maxLength={80} className="max-w-xs" />
          <Button type="submit" variant="outline">Add room</Button>
        </form>
      </ErrorBoundary>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {rooms.length === 0 ? (
        <LibraryEmpty>No rooms yet. Rooms are the columns of the agenda grid.</LibraryEmpty>
      ) : (
        <Frame className="w-full max-w-2xl">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Room</TableHead>
                <TableHead className="w-14" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rooms.map((room) => (
                <TableRow key={room.id}>
                  <TableCell>
                    <span className="text-sm font-medium">{room.name}</span>
                  </TableCell>
                  <TableCell className="p-0">
                    <DeleteRowButton
                      label={`Delete room ${room.name}`}
                      pending={pendingId === room.id}
                      onClick={() => run(room.id, () => deleteRoom({ orgId, eventId, roomId: room.id }))}
                    />
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

// ── Team ────────────────────────────────────────────────────────────

function TeamTab({ orgId }: { orgId: string }) {
  return (
    <div className="flex max-w-md flex-col items-start gap-3">
      <p className="text-sm text-muted-foreground">
        Team access is managed at the organization level. Every organization member can
        manage and review all of its events.
      </p>
      <Button variant="outline" render={<Link href={`/org/${orgId}/members`} />}>
        <UsersIcon />
        Manage members
      </Button>
    </div>
  )
}
