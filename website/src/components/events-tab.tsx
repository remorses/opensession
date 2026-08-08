// Events tab: the org page listing all events in a table (same Frame +
// Table pattern as the members table) with a create-event dialog.
'use client'

import { useState } from 'react'
import { ErrorBoundary, useLoaderData } from 'spiceflow/react'
import { CalendarPlusIcon } from 'lucide-react'
import { createEvent } from '../actions.tsx'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import { Input } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import {
  Dialog, DialogDescription, DialogHeader,
  DialogPanel, DialogPopup, DialogTitle,
} from './ui/dialog.tsx'

/** Deterministic UTC date (yyyy-mm-dd). toLocaleDateString causes SSR
 *  hydration mismatches (workerd and browser format locales differently). */
function formatDate(epochMs: number): string {
  const d = new Date(epochMs)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  ACTIVE: 'bg-green-500/15 text-green-700 dark:text-green-400',
  ARCHIVED: 'bg-muted text-muted-foreground line-through',
}

export function EventsTab() {
  const { events, currentOrgId } = useLoaderData('/org/:orgId/*')

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Events</h1>
          <p className="text-sm text-muted-foreground">
            Each event has its own CFP forms, speakers, agenda, and portal.
          </p>
        </div>
        <CreateEventButton orgId={currentOrgId} />
      </div>
      {events.length === 0 ? (
        <Frame className="w-full">
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-balance">
            <span className="text-sm font-medium">No events yet</span>
            <span className="text-sm text-muted-foreground">
              Create your first event to start collecting talk submissions.
            </span>
          </div>
        </Frame>
      ) : (
        <Frame className="w-full">
          <Table className="table-fixed">
            <colgroup>
              <col className="w-1/3" />
              <col className="w-40" />
              <col className="w-28" />
              <col className="w-48" />
            </colgroup>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Dates</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell>
                    {/* TODO: link to /org/:orgId/e/:eventId once the event
                        shell exists. Plain text until then. */}
                    <span className="text-sm font-medium">{event.name}</span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs text-muted-foreground">{event.slug}</span>
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[event.status] ?? ''}`}>
                      {event.status.toLowerCase()}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatDate(event.startsAt)} → {formatDate(event.endsAt)}
                    </span>
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

function CreateEventButton({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false)
  // Best-effort browser timezone; the server validates against IANA.
  const defaultTimezone =
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <CalendarPlusIcon />
        Create event
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
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
                  await createEvent({
                    orgId,
                    name,
                    timezone,
                    // Date-only inputs: start of day → end of day (UTC).
                    startsAt: Date.parse(`${startsAt}T00:00:00Z`),
                    endsAt: Date.parse(`${endsAt}T23:59:59Z`),
                  })
                  setOpen(false)
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
                  <Input required name="timezone" defaultValue={defaultTimezone} placeholder="America/Los_Angeles" />
                </label>
                <Button type="submit" className="w-full">
                  Create event
                </Button>
              </form>
            </ErrorBoundary>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  )
}
