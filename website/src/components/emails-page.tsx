// Emails admin page ('use client'): the outbox log for one event with
// ?tab=all|queued|sent|failed|reminders, a per-row message preview, and a
// retry action on FAILED rows.
//
// The stored bodyHtml is a full email document rendered from user-controlled
// data. It is shown inside a sandboxed iframe via srcdoc — NEVER
// dangerouslySetInnerHTML, which would splice a whole <html> document (and any
// escaping mistake in templates.ts) straight into the dashboard.

'use client'

import { useState, useTransition } from 'react'
import { Link, router, useLoaderData } from 'spiceflow/react'
import { MailIcon, RotateCwIcon } from 'lucide-react'
import { retryEmail } from '../actions.tsx'
import { describeReminderSchedule } from '../lib/emails/reminders.ts'
import { cn, formatDateTimeUTC } from '../lib/utils.ts'
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
import { Badge, EmptyState } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import { runAction } from './ui/toast.tsx'

export type EmailsTab = 'all' | 'queued' | 'sent' | 'failed' | 'reminders'

export type EmailStatus = 'QUEUED' | 'SENT' | 'FAILED'

export type EmailListRow = {
  id: string
  kind: string
  toEmail: string
  subject: string
  status: EmailStatus
  attemptCount: number
  icsMethod: 'REQUEST' | 'CANCEL' | null
  errorMessage: string | null
  createdAt: number
  sentAt: number | null
  bodyHtml: string
  bodyText: string | null
  batchId: string | null
  batchRecipients: number | null
}

const tabs: { value: EmailsTab; label: string; status: EmailStatus | null }[] = [
  { value: 'all', label: 'All', status: null },
  { value: 'queued', label: 'Queued', status: 'QUEUED' },
  { value: 'sent', label: 'Sent', status: 'SENT' },
  { value: 'failed', label: 'Failed', status: 'FAILED' },
]

/** UPPER_SNAKE enum → "Decision accepted". */
function humanKind(kind: string): string {
  const words = kind.toLowerCase().replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function EmailStatusBadge({ status }: { status: EmailStatus }) {
  const variant =
    status === 'SENT' ? 'secondary' : status === 'FAILED' ? 'destructive' : 'outline'
  return (
    <Badge variant={variant} className="px-1.5 capitalize">
      {status.toLowerCase()}
    </Badge>
  )
}

export function EmailsPage({ tab }: { tab: EmailsTab }) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event } = useLoaderData('/org/:orgId/e/:eventId/*')
  const { emails } = useLoaderData('/org/:orgId/e/:eventId/emails')
  const [preview, setPreview] = useState<EmailListRow | null>(null)

  const active = tabs.find((row) => row.value === tab)
  const visible = active?.status ? emails.filter((row) => row.status === active.status) : emails

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Emails</h1>
        <p className="text-sm text-muted-foreground">
          Every message OpenSession sent for this event. Replies go to{' '}
          <span className="font-medium text-foreground">
            {event.contactEmail || 'notifications@opensession.dev'}
          </span>
          .
        </p>
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        {[...tabs, { value: 'reminders' as const, label: 'Reminders', status: null }].map(
          (row) => {
            const count =
              row.value === 'reminders'
                ? null
                : row.status
                  ? emails.filter((mail) => mail.status === row.status).length
                  : emails.length
            return (
              <Link
                key={row.value}
                href={router.href(`/org/${currentOrgId}/e/${event.id}/emails`, {
                  tab: row.value,
                })}
                className={cn(
                  'relative -mb-px flex items-center gap-1.5 px-2.5 py-2 text-sm no-underline transition-colors',
                  row.value === tab
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {row.label}
                {count == null ? null : (
                  <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
                )}
                {row.value === tab ? (
                  <span className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-sm bg-primary" />
                ) : null}
              </Link>
            )
          },
        )}
      </div>

      {tab === 'reminders' ? (
        <RemindersTab />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<MailIcon className="size-5 text-muted-foreground" />}
          title={emails.length === 0 ? 'No emails yet' : 'Nothing here'}
          description={
            emails.length === 0
              ? 'Submission confirmations, decisions, task nudges, and calendar invites all show up here.'
              : 'No messages with this status.'
          }
        />
      ) : (
        <Frame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <EmailRow
                  key={row.id}
                  orgId={currentOrgId}
                  eventId={event.id}
                  row={row}
                  onPreview={() => setPreview(row)}
                />
              ))}
            </TableBody>
          </Table>
        </Frame>
      )}

      <PreviewDialog row={preview} onClose={() => setPreview(null)} />
    </div>
  )
}

function EmailRow({
  orgId,
  eventId,
  row,
  onPreview,
}: {
  orgId: string
  eventId: string
  row: EmailListRow
  onPreview: () => void
}) {
  const [pending, startTransition] = useTransition()

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        {humanKind(row.kind)}
        {row.icsMethod ? (
          <Badge variant="outline" className="ml-1.5 px-1.5">
            ics
          </Badge>
        ) : null}
        {row.batchId ? (
          <div className="text-xs text-muted-foreground">
            Batch {row.batchId.slice(-6)} · {row.batchRecipients} recipients
          </div>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground">{row.toEmail}</TableCell>
      <TableCell className="max-w-sm">
        <button
          type="button"
          className="block max-w-full truncate text-left hover:underline"
          onClick={onPreview}
        >
          {row.subject}
        </button>
        {row.errorMessage ? (
          <div className="text-xs text-destructive">{row.errorMessage}</div>
        ) : null}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <EmailStatusBadge status={row.status} />
        {row.attemptCount > 1 ? (
          <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
            {row.attemptCount} tries
          </span>
        ) : null}
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {formatDateTimeUTC(row.createdAt)}
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {row.sentAt ? formatDateTimeUTC(row.sentAt) : '—'}
      </TableCell>
      <TableCell className="text-right">
        {row.status === 'FAILED' ? (
          <Button
            variant="outline"
            size="sm"
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                await runAction(() => retryEmail({ orgId, eventId, emailId: row.id }), {
                  fallbackError: 'Could not resend this email',
                })
              })
            }
          >
            <RotateCwIcon />
            Retry
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  )
}

function PreviewDialog({ row, onClose }: { row: EmailListRow | null; onClose: () => void }) {
  return (
    <Dialog
      open={row != null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {row ? (
        <DialogPopup className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{row.subject}</DialogTitle>
            <DialogDescription>
              {humanKind(row.kind)} to {row.toEmail}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {/* Sandboxed: no scripts, no same-origin access, no navigation.
                The body is a full HTML document built from user data, so it
                must never be inlined into the dashboard DOM. */}
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={row.bodyHtml}
              className="h-[28rem] w-full rounded-md border border-border bg-white"
            />
          </DialogPanel>
        </DialogPopup>
      ) : null}
    </Dialog>
  )
}

function RemindersTab() {
  return (
    <div className="flex max-w-2xl flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        Reminders are automatic. There is nothing to configure; the schedule below is fixed.
      </p>
      <ul className="flex list-disc flex-col gap-2 pl-5 text-muted-foreground">
        {describeReminderSchedule().map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  )
}
