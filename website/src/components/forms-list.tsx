// Forms list ('use client') — /org/:orgId/e/:eventId/forms
// One organizer page for CFP and PORTAL forms.
// Table shows purpose, target, status, and the share link speakers use.
// Rows open the shared MDX editor at /forms/:formId.
'use client'

import { useState } from 'react'
import { ErrorBoundary, Link, router, useLoaderData } from 'spiceflow/react'
import { CheckIcon, CopyIcon, ExternalLinkIcon, FileTextIcon, PlusIcon } from 'lucide-react'
import { createForm } from '../actions.tsx'
import { formatDateUTC, formatDateTimeUTC } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import { Badge, EmptyState, Input, NativeSelect } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import {
  Dialog, DialogDescription, DialogHeader,
  DialogPanel, DialogPopup, DialogTitle,
} from './ui/dialog.tsx'

/** Public speaker-facing CFP fill URL for one form. */
export function publicCfpPath(eventSlug: string, formSlug: string) {
  return router.href('/submit/:eventSlug/:formSlug', { eventSlug, formSlug })
}

/** Portal home speakers open to fill PORTAL forms (via tasks / profile). */
export function portalSharePath(eventSlug: string) {
  return router.href('/portal/:eventSlug', { eventSlug })
}

/** Path organizers copy and send. CFP = public submit URL; PORTAL = speaker portal. */
export function formSharePath(input: {
  purpose: 'CFP' | 'PORTAL' | 'EVALUATION'
  eventSlug: string
  formSlug: string
}) {
  if (input.purpose === 'CFP') return publicCfpPath(input.eventSlug, input.formSlug)
  if (input.purpose === 'PORTAL') return portalSharePath(input.eventSlug)
  return null
}

export type FormStatus = 'DRAFT' | 'OPEN' | 'CLOSED' | 'ARCHIVED'

export type FormListRow = {
  id: string
  name: string
  slug: string
  status: FormStatus
  purpose: 'CFP' | 'PORTAL' | 'EVALUATION'
  target: 'SUBMISSION' | 'SPEAKER'
  closesAt: number | null
  createdAt: number
  /** SUBMITTED / DRAFT FormResponse counts, aggregated in the loader. */
  submitted: number
  drafts: number
}

export function FormStatusBadge({ status }: { status: FormStatus }) {
  const variant =
    status === 'OPEN' ? 'success' : status === 'CLOSED' ? 'warning' : status === 'ARCHIVED' ? 'outline' : 'secondary'
  return (
    <Badge variant={variant} className="px-1.5 capitalize">
      {status.toLowerCase()}
    </Badge>
  )
}

export function FormPurposeBadge({
  purpose,
  target,
}: {
  purpose: FormListRow['purpose']
  target: FormListRow['target']
}) {
  if (purpose === 'CFP') {
    return (
      <Badge variant="secondary" className="px-1.5">
        CFP
      </Badge>
    )
  }
  if (purpose === 'EVALUATION') {
    return <Badge variant="outline" className="px-1.5">Evaluation</Badge>
  }
  return (
    <Badge variant="outline" className="px-1.5">
      Portal · {target === 'SPEAKER' ? 'Speaker' : 'Submission'}
    </Badge>
  )
}

export function FormsListPage() {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event, appUrl } = useLoaderData('/org/:orgId/e/:eventId/*')
  const { forms } = useLoaderData('/org/:orgId/e/:eventId/forms')
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Forms</h1>
          <p className="text-sm text-muted-foreground">
            CFP forms collect public talk proposals. Portal forms are filled from the speaker portal and linked from tasks.
            Copy the share link from each row.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <PlusIcon />
          Create form
        </Button>
      </div>

      {forms.length === 0 ? (
        <EmptyState
          icon={<FileTextIcon className="size-5 text-muted-foreground" />}
          title="No forms yet"
          description="Create a CFP form to collect talk submissions, or a portal form for speaker tasks."
        >
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            Create form
          </Button>
        </EmptyState>
      ) : (
        <FormsTable
          orgId={currentOrgId}
          eventId={event.id}
          eventSlug={event.slug}
          appUrl={appUrl}
          rows={forms}
        />
      )}

      <CreateFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        orgId={currentOrgId}
        eventId={event.id}
      />
    </div>
  )
}

function FormsTable({
  orgId,
  eventId,
  eventSlug,
  appUrl,
  rows,
}: {
  orgId: string
  eventId: string
  eventSlug: string
  appUrl?: string
  rows: FormListRow[]
}) {
  return (
    <Frame className="w-full">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Form</TableHead>
            <TableHead className="w-40">Purpose</TableHead>
            <TableHead className="w-24">Status</TableHead>
            <TableHead className="w-56">Share link</TableHead>
            <TableHead className="w-28 text-right">Submissions</TableHead>
            <TableHead className="w-20 text-right">Drafts</TableHead>
            <TableHead className="w-44">Closes</TableHead>
            <TableHead className="w-32">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((form) => {
            const sharePath = formSharePath({
              purpose: form.purpose,
              eventSlug,
              formSlug: form.slug,
            })
            return (
              <TableRow
                key={form.id}
                className="cursor-pointer"
                onClick={() => router.push(router.href('/org/:orgId/e/:eventId/forms/:formId', { orgId, eventId, formId: form.id }))}
              >
                <TableCell>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium">{form.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{form.slug}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <FormPurposeBadge purpose={form.purpose} target={form.target} />
                </TableCell>
                <TableCell>
                  <FormStatusBadge status={form.status} />
                </TableCell>
                <TableCell onClick={(event) => event.stopPropagation()}>
                  {sharePath ? (
                    <ShareFormLink
                      path={sharePath}
                      appUrl={appUrl}
                      live={form.status === 'OPEN'}
                      purpose={form.purpose}
                    />
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <span className="text-sm tabular-nums">{form.submitted}</span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="text-sm text-muted-foreground tabular-nums">{form.drafts}</span>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {form.closesAt ? formatDateTimeUTC(form.closesAt) : 'No close'}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground tabular-nums">{formatDateUTC(form.createdAt)}</span>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Frame>
  )
}

export function ShareFormLink({
  path,
  appUrl,
  live,
  purpose,
}: {
  path: string
  appUrl?: string
  live: boolean
  purpose: 'CFP' | 'PORTAL' | 'EVALUATION'
}) {
  const [copied, setCopied] = useState(false)
  const absoluteUrl = appUrl ? new URL(path, appUrl).href : path

  async function copy() {
    const text =
      typeof window !== 'undefined'
        ? `${window.location.origin}${path}`
        : absoluteUrl
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1">
        <Link
          href={path}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 truncate font-mono text-xs text-foreground underline underline-offset-4"
          title={path}
        >
          {path}
        </Link>
        <Button
          aria-label="Copy share link"
          size="icon-xs"
          variant="ghost"
          title="Copy share link"
          onClick={copy}
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-success-foreground" />
          ) : (
            <CopyIcon className="size-3.5 text-muted-foreground" />
          )}
        </Button>
        <Button
          aria-label="Open share link"
          size="icon-xs"
          variant="ghost"
          title="Open share link"
          render={<Link href={path} target="_blank" rel="noreferrer" />}
        >
          <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
        </Button>
      </div>
      {purpose === 'CFP' && !live ? (
        <span className="text-[11px] text-muted-foreground">
          Public only when form is Open and event is Active
        </span>
      ) : null}
      {purpose === 'PORTAL' ? (
        <span className="text-[11px] text-muted-foreground">Speakers open this in the portal</span>
      ) : null}
    </div>
  )
}

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function CreateFormDialog({
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
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [purpose, setPurpose] = useState<'CFP' | 'PORTAL'>('CFP')

  const effectiveSlug = slugTouched ? slug : deriveSlug(name)
  const showTarget = purpose === 'PORTAL'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setName('')
          setSlug('')
          setSlugTouched(false)
          setPurpose('CFP')
        }
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Create form</DialogTitle>
          <DialogDescription>
            The form starts from a template you edit as MDX — fields, copy, and conditional logic in one document.
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
                await createForm({
                  orgId,
                  eventId,
                  name: name.trim(),
                  slug: effectiveSlug || undefined,
                  purpose,
                  target: showTarget
                    ? (formData.get('target') === 'SPEAKER' ? 'SPEAKER' : 'SUBMISSION')
                    : undefined,
                })
              }}
            >
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Name
                <Input
                  autoFocus
                  required
                  name="name"
                  value={name}
                  maxLength={120}
                  placeholder="Call for Papers 2026"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Slug
                <Input
                  required
                  name="slug"
                  value={effectiveSlug}
                  maxLength={60}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  title="Lowercase letters, numbers, and dashes"
                  className="font-mono"
                  onChange={(e) => {
                    setSlugTouched(true)
                    setSlug(e.target.value)
                  }}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Purpose
                <NativeSelect
                  name="purpose"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value === 'PORTAL' ? 'PORTAL' : 'CFP')}
                >
                  <option value="CFP">CFP — public call for speakers</option>
                  <option value="PORTAL">Portal — assigned to speakers via tasks</option>
                </NativeSelect>
              </label>
              {showTarget ? (
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Target
                  <NativeSelect name="target" defaultValue="SUBMISSION">
                    <option value="SUBMISSION">Submission — about a specific session</option>
                    <option value="SPEAKER">Speaker — about the speaker</option>
                  </NativeSelect>
                </label>
              ) : null}
              <Button type="submit" className="w-full">
                Create form
              </Button>
            </form>
          </ErrorBoundary>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}
