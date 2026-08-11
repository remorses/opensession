// Event Settings page (/org/:orgId/e/:eventId/settings) — tabs driven by the
// ?tab= query param (details | tracks | formats | rooms | team | api). Details is a
// plain form posting to the updateEvent action; tracks/formats/rooms are
// Frame+Table CRUD lists (access-tab pattern); team links to the org members
// page (access is org-level, no per-event roles).
'use client'

import { useActionState, useState } from 'react'
import { ErrorBoundary, Link, router, useLoaderData } from 'spiceflow/react'
import { ExternalLinkIcon, KeyRoundIcon, TrashIcon, UsersIcon } from 'lucide-react'
import {
  createApiKey,
  createFormat,
  createRoom,
  createTrack,
  deleteFormat,
  deleteRoom,
  deleteTrack,
  revokeApiKey,
  updateEvent,
} from '../actions.tsx'
import { API_SCOPES, type ApiScope } from '../api-schemas.ts'
import { cn, formatDateTimeUTC, nextTrackColor } from '../lib/utils.ts'
import { toZonedSlot } from '../lib/conflicts.ts'
import { Button } from './ui/button.tsx'
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from './ui/dialog.tsx'
import { Frame } from './ui/frame.tsx'
import { Input, NativeSelect, Textarea, TimezoneSelect } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import { toastActionError } from './ui/toast.tsx'

export type SettingsTab = 'details' | 'tracks' | 'formats' | 'rooms' | 'team' | 'api'

const tabs: { value: SettingsTab; label: string }[] = [
  { value: 'details', label: 'Details' },
  { value: 'tracks', label: 'Tracks' },
  { value: 'formats', label: 'Formats' },
  { value: 'rooms', label: 'Rooms' },
  { value: 'team', label: 'Team' },
  { value: 'api', label: 'API' },
]

export function EventSettings({ tab }: { tab: SettingsTab }) {
  const { currentOrgId, role } = useLoaderData('/org/:orgId/*')
  const { event, tracks, formats, rooms } = useLoaderData('/org/:orgId/e/:eventId/*')
  const { apiKeys } = useLoaderData('/org/:orgId/e/:eventId/settings')

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
      {tab === 'api' ? <ApiTab orgId={currentOrgId} eventId={event.id} admin={role === 'admin'} apiKeys={apiKeys} /> : null}
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
        setError(toastActionError(err, 'Failed to delete'))
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
  const defaultColor = nextTrackColor(tracks.map((track) => track.color))

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
               color: String(formData.get('color') ?? defaultColor),
            })
          }}
        >
          <Input required name="name" placeholder="Track name" maxLength={80} className="max-w-xs" />
          <input
            aria-label="Track color"
            name="color"
            type="color"
            key={defaultColor}
            defaultValue={defaultColor}
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
      <Button variant="outline" render={<Link href={router.href('/org/:orgId/members', { orgId })} />}>
        <UsersIcon />
        Manage members
      </Button>
    </div>
  )
}

// ── API keys ────────────────────────────────────────────────────────

type ApiKeyRow = {
  id: string
  name: string
  keyPrefix: string
  scopes: ApiScope[]
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED'
  createdAt: number
}

function ApiTab({ orgId, eventId, admin, apiKeys }: {
  orgId: string
  eventId: string
  admin: boolean
  apiKeys: ApiKeyRow[]
}) {
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-2xl flex-col gap-1">
          <h2 className="font-medium">Event API keys</h2>
          <p className="text-sm text-muted-foreground">
            Use event-scoped keys to manage sessions, speakers, reviews, and schedule data from code.
          </p>
        </div>
        <Button variant="outline" render={<Link href={router.href('/docs/api')} target="_blank" />}>
          <ExternalLinkIcon />
          API reference
        </Button>
      </div>

      {admin ? (
        <ErrorBoundary below fallback={<ErrorBoundary.ErrorMessage className="text-sm text-destructive" />}>
          <form
            className="flex flex-col gap-3 rounded-xl border border-border p-4"
            action={async (formData: FormData) => {
              const result = await createApiKey({
                orgId,
                eventId,
                name: String(formData.get('name') ?? '').trim(),
                scopes: formData.getAll('scope').map(String) as ApiScope[],
              })
              setCreatedSecret(result.secret)
            }}
          >
            <div className="flex flex-wrap items-end gap-2">
              <FieldLabel className="min-w-64 grow">
                Key name
                <Input required name="name" maxLength={80} placeholder="Website integration" />
              </FieldLabel>
              <Button type="submit">
                <KeyRoundIcon />
                Create key
              </Button>
            </div>
            <fieldset className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <legend className="pb-2 text-sm font-medium">Scopes</legend>
              {API_SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-sm">
                  <input defaultChecked name="scope" type="checkbox" value={scope} className="size-4 accent-primary" />
                  <span className="font-mono text-xs">{scope}</span>
                </label>
              ))}
            </fieldset>
          </form>
        </ErrorBoundary>
      ) : (
        <p className="text-sm text-muted-foreground">Only organization admins can create or revoke API keys.</p>
      )}

      {apiKeys.length === 0 ? (
        <LibraryEmpty>No API keys yet.</LibraryEmpty>
      ) : (
        <Frame>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-14" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.map((key) => {
                const active = key.status === 'ACTIVE'
                return (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell className="font-mono text-xs">{key.keyPrefix}…</TableCell>
                    <TableCell className="max-w-72 text-xs text-muted-foreground">{key.scopes.join(', ')}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {key.lastUsedAt ? formatDateTimeUTC(key.lastUsedAt) : 'Never'}
                    </TableCell>
                    <TableCell className="text-xs">{key.status === 'ACTIVE' ? 'Active' : key.status === 'EXPIRED' ? 'Expired' : 'Revoked'}</TableCell>
                    <TableCell className="p-0">
                      {admin && active ? (
                        <DeleteRowButton
                          label={`Revoke API key ${key.name}`}
                          pending={pendingId === key.id}
                          onClick={() => {
                            setPendingId(key.id)
                            void revokeApiKey({ orgId, eventId, apiKeyId: key.id })
                              .catch((error) => toastActionError(error, 'Failed to revoke API key'))
                              .finally(() => setPendingId(null))
                          }}
                        />
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Frame>
      )}

      <Dialog open={createdSecret != null} onOpenChange={(open) => { if (!open) setCreatedSecret(null) }}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <DialogDescription>Copy this key now. OpenSession stores only its hash, so it cannot be shown again.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input readOnly value={createdSecret ?? ''} className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  )
}
