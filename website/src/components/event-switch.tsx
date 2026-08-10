// Navbar event switcher (compressed, next to the org switcher — same
// pattern as akarso's profile switcher). The event id lives in the URL
// (/org/:orgId/e/:eventId), so switching is a plain client-side
// navigation. Also exports the create-event dialog used by the switcher
// and the no-events empty state.
'use client'

import { useState } from 'react'
import { ErrorBoundary, router, useLoaderData } from 'spiceflow/react'
import { CalendarIcon, CheckIcon, ChevronDownIcon, PlusIcon } from 'lucide-react'
import { cn } from '../lib/utils.ts'
import { createEvent } from '../actions.tsx'
import { Button } from './ui/button.tsx'
import { Input, TimezoneSelect } from './ui/primitives.tsx'
import { defaultTimezone } from '../lib/timezones.ts'
import {
  Dialog, DialogDescription, DialogHeader,
  DialogPanel, DialogPopup, DialogTitle,
} from './ui/dialog.tsx'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPopup,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx'

function currentEventIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/\/e\/([^/]+)/)
  return match?.[1] ?? null
}

export function EventSwitch() {
  const { events, currentOrgId, pathname } = useLoaderData('/org/:orgId/*')
  const [createOpen, setCreateOpen] = useState(false)
  const currentEventId = currentEventIdFromPathname(pathname)
  const current = events.find((event) => event.id === currentEventId)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            'flex items-center gap-2 rounded-md px-2 pt-2.5 pb-1.5 text-sm transition-colors hover:bg-accent data-[popup-open]:bg-accent',
          )}
        >
          <span className="max-w-40 truncate font-medium">
            {current?.name ?? (events.length === 0 ? 'No events' : 'Events')}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>

        <DropdownMenuPopup side="bottom" align="start" sideOffset={4}>
          <DropdownMenuLabel>Events</DropdownMenuLabel>
          {events.map((event) => (
            <DropdownMenuItem
              key={event.id}
              onClick={() => {
                if (event.id === currentEventId) return
                router.push(router.href('/org/:orgId/e/:eventId', { orgId: currentOrgId, eventId: event.id }))
              }}
            >
              <div className="flex size-6 items-center justify-center rounded-md border">
                <CalendarIcon className="size-3.5 shrink-0" />
              </div>
              <span className="flex-1 truncate">{event.name}</span>
              {event.id === currentEventId ? <CheckIcon className="size-3.5 text-muted-foreground" /> : null}
            </DropdownMenuItem>
          ))}
          {events.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onClick={() => setCreateOpen(true)}>
            <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
              <PlusIcon className="size-4" />
            </div>
            <span className="font-medium">Create event</span>
          </DropdownMenuItem>
        </DropdownMenuPopup>
      </DropdownMenu>
      <CreateEventDialog open={createOpen} onOpenChange={setCreateOpen} orgId={currentOrgId} />
    </>
  )
}

export function CreateEventDialog({ open, onOpenChange, orgId }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
}) {
  // Best-effort browser timezone (falls back to UTC when it is not one of the
  // curated ids); the server re-validates against IANA. Reading Intl during
  // render is safe here because the dialog body only mounts once the user opens
  // it on the client, so there is no SSR/hydration mismatch.
  const browserTimezone = defaultTimezone()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Create event</DialogTitle>
          <DialogDescription>
            Name, dates, and timezone. Everything else is configured later in
            the event settings.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ErrorBoundary
            below
            fallback={<ErrorBoundary.ErrorMessage className="mt-3 text-sm text-destructive" />}
          >
            <form
              className="flex flex-col gap-3"
              action={async (formData: FormData) => {
                const name = String(formData.get('name') ?? '').trim()
                const timezone = String(formData.get('timezone') ?? '').trim()
                const startsAt = String(formData.get('startsAt') ?? '')
                const endsAt = String(formData.get('endsAt') ?? '')
                // createEvent redirects to the new event's page.
                await createEvent({
                  orgId,
                  name,
                  timezone,
                  // Date-only inputs: start of day → end of day (UTC).
                  // Raw day keys: the server resolves them in the chosen
                  // event timezone, not the browser's.
                  startsAt,
                  endsAt,
                })
                onOpenChange(false)
              }}
            >
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Event name
                <Input autoFocus required name="name" placeholder="AI Engineer Summit 2026" maxLength={120} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Starts
                  <Input required name="startsAt" type="date" />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Ends
                  <Input required name="endsAt" type="date" />
                </label>
              </div>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Timezone
                <TimezoneSelect required name="timezone" value={browserTimezone} />
              </label>
              <Button type="submit" className="w-full">
                Create event
              </Button>
            </form>
          </ErrorBoundary>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

/** Empty state shown on /org/:orgId when the org has no events yet. */
export function NoEventsPage() {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const [open, setOpen] = useState(false)

  return (
    <div className="flex flex-col items-center gap-4 px-6 py-24 text-center text-balance">
      <div className="flex size-12 items-center justify-center rounded-full border">
        <CalendarIcon className="size-5 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-lg font-semibold tracking-tight">No events yet</span>
        <span className="text-sm text-muted-foreground">
          Create your first event to start collecting talk submissions.
        </span>
      </div>
      <Button onClick={() => setOpen(true)}>
        <PlusIcon />
        Create event
      </Button>
      <CreateEventDialog open={open} onOpenChange={setOpen} orgId={currentOrgId} />
    </div>
  )
}
