// Forms list pages ('use client'):
// - FormsListPage: /org/:orgId/e/:eventId/forms — CFP forms with
//   ?status= tabs (all|draft|open|closed|archived) and per-status counts.
// - PortalFormsPage: /org/:orgId/e/:eventId/portal-forms — PORTAL forms
//   with ?tab= target tabs (speaker|submission).
// Both share the Frame+Table list and the create dialog; rows open the
// shared MDX editor page (/forms/:formId).
'use client'

import { useState } from 'react'
import { ErrorBoundary, Link, router, useLoaderData } from 'spiceflow/react'
import { FileTextIcon, PlusIcon } from 'lucide-react'
import { createForm } from '../actions.tsx'
import { cn, formatDateUTC, formatDateTimeUTC } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import { Badge, EmptyState, Input, NativeSelect } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import {
  Dialog, DialogDescription, DialogHeader,
  DialogPanel, DialogPopup, DialogTitle,
} from './ui/dialog.tsx'

export type FormStatus = 'DRAFT' | 'OPEN' | 'CLOSED' | 'ARCHIVED'
export type FormStatusTab = 'all' | 'draft' | 'open' | 'closed' | 'archived'
export type PortalTargetTab = 'speaker' | 'submission'

export type FormListRow = {
  id: string
  name: string
  slug: string
  status: FormStatus
  purpose: 'CFP' | 'PORTAL'
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

// ── CFP forms list (?status=) ───────────────────────────────────────

const statusTabs: { value: FormStatusTab; label: string; match: FormStatus | null }[] = [
  { value: 'all', label: 'All', match: null },
  { value: 'draft', label: 'Draft', match: 'DRAFT' },
  { value: 'open', label: 'Open', match: 'OPEN' },
  { value: 'closed', label: 'Closed', match: 'CLOSED' },
  { value: 'archived', label: 'Archived', match: 'ARCHIVED' },
]

export function FormsListPage({ status }: { status: FormStatusTab }) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event } = useLoaderData('/org/:orgId/e/:eventId/*')
  const { forms } = useLoaderData('/org/:orgId/e/:eventId/forms')
  const [createOpen, setCreateOpen] = useState(false)

  const active = statusTabs.find((tab) => tab.value === status) ?? statusTabs[0]!
  const visible = active.match ? forms.filter((form) => form.status === active.match) : forms

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Forms</h1>
          <p className="text-sm text-muted-foreground">
            CFP forms collect abstract, session, and participant information for your event.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <PlusIcon />
          Create form
        </Button>
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        {statusTabs.map((tab) => {
          const count = tab.match ? forms.filter((form) => form.status === tab.match).length : forms.length
          return (
            <Link
              key={tab.value}
              href={router.href(`/org/${currentOrgId}/e/${event.id}/forms`, { status: tab.value })}
              className={cn(
                'relative -mb-px flex items-center gap-1.5 px-2.5 py-2 text-sm no-underline transition-colors',
                tab.value === status
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
              <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
              {tab.value === status ? (
                <span className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-sm bg-primary" />
              ) : null}
            </Link>
          )
        })}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<FileTextIcon className="size-5 text-muted-foreground" />}
          title={forms.length === 0 ? 'No forms yet' : 'Nothing here'}
          description={
            forms.length === 0
              ? 'Create a CFP form to start collecting talk submissions.'
              : 'No forms with this status.'
          }
        >
          {forms.length === 0 ? (
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              Create form
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <FormsTable orgId={currentOrgId} eventId={event.id} rows={visible} />
      )}

      <CreateFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        orgId={currentOrgId}
        eventId={event.id}
        allowPurposeChoice
      />
    </div>
  )
}

// ── Portal forms list (?tab=) ───────────────────────────────────────

const targetTabs: { value: PortalTargetTab; label: string; match: 'SPEAKER' | 'SUBMISSION' }[] = [
  { value: 'speaker', label: 'Speaker Forms', match: 'SPEAKER' },
  { value: 'submission', label: 'Submission Forms', match: 'SUBMISSION' },
]

export function PortalFormsPage({ tab }: { tab: PortalTargetTab }) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event } = useLoaderData('/org/:orgId/e/:eventId/*')
  const { forms } = useLoaderData('/org/:orgId/e/:eventId/portal-forms')
  const [createOpen, setCreateOpen] = useState(false)

  const active = targetTabs.find((t) => t.value === tab) ?? targetTabs[0]!
  const visible = forms.filter((form) => form.target === active.match)

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Portal Forms</h1>
          <p className="text-sm text-muted-foreground">
            Forms speakers fill from the portal — linkable from tasks.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <PlusIcon />
          Create portal form
        </Button>
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        {targetTabs.map((t) => {
          const count = forms.filter((form) => form.target === t.match).length
          return (
            <Link
              key={t.value}
              href={router.href(`/org/${currentOrgId}/e/${event.id}/portal-forms`, { tab: t.value })}
              className={cn(
                'relative -mb-px flex items-center gap-1.5 px-2.5 py-2 text-sm no-underline transition-colors',
                t.value === tab
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
              {t.value === tab ? (
                <span className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-sm bg-primary" />
              ) : null}
            </Link>
          )
        })}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<FileTextIcon className="size-5 text-muted-foreground" />}
          title="No portal forms"
          description="Create a portal form and link it from a speaker or submission task."
        >
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            Create portal form
          </Button>
        </EmptyState>
      ) : (
        <FormsTable orgId={currentOrgId} eventId={event.id} rows={visible} />
      )}

      <CreateFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        orgId={currentOrgId}
        eventId={event.id}
        fixedPurpose="PORTAL"
        defaultTarget={active.match}
      />
    </div>
  )
}

// ── Shared table ────────────────────────────────────────────────────

function FormsTable({ orgId, eventId, rows }: { orgId: string; eventId: string; rows: FormListRow[] }) {
  return (
    <Frame className="w-full">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Form</TableHead>
            <TableHead className="w-40">Slug</TableHead>
            <TableHead className="w-24">Status</TableHead>
            <TableHead className="w-28 text-right">Submissions</TableHead>
            <TableHead className="w-20 text-right">Drafts</TableHead>
            <TableHead className="w-44">Closes</TableHead>
            <TableHead className="w-32">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((form) => (
            <TableRow
              key={form.id}
              className="cursor-pointer"
              onClick={() => router.push(`/org/${orgId}/e/${eventId}/forms/${form.id}`)}
            >
              <TableCell>
                <span className="text-sm font-medium">{form.name}</span>
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs text-muted-foreground">{form.slug}</span>
              </TableCell>
              <TableCell>
                <FormStatusBadge status={form.status} />
              </TableCell>
              <TableCell className="text-right">
                <span className="text-sm tabular-nums">{form.submitted}</span>
              </TableCell>
              <TableCell className="text-right">
                <span className="text-sm text-muted-foreground tabular-nums">{form.drafts}</span>
              </TableCell>
              <TableCell>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {form.closesAt ? formatDateTimeUTC(form.closesAt) : '—'}
                </span>
              </TableCell>
              <TableCell>
                <span className="text-sm text-muted-foreground tabular-nums">{formatDateUTC(form.createdAt)}</span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Frame>
  )
}

// ── Create dialog ───────────────────────────────────────────────────

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function CreateFormDialog({ open, onOpenChange, orgId, eventId, allowPurposeChoice, fixedPurpose, defaultTarget }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  eventId: string
  /** Forms page: purpose select (CFP default, target shown for PORTAL). */
  allowPurposeChoice?: boolean
  /** Portal forms page: purpose locked to PORTAL, target select. */
  fixedPurpose?: 'PORTAL'
  defaultTarget?: 'SPEAKER' | 'SUBMISSION'
}) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [purpose, setPurpose] = useState<'CFP' | 'PORTAL'>(fixedPurpose ?? 'CFP')

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
          setPurpose(fixedPurpose ?? 'CFP')
        }
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{fixedPurpose === 'PORTAL' ? 'Create portal form' : 'Create form'}</DialogTitle>
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
                // createForm redirects to the editor of the new form.
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
              {allowPurposeChoice ? (
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
              ) : null}
              {showTarget ? (
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Target
                  <NativeSelect name="target" defaultValue={defaultTarget ?? 'SUBMISSION'}>
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
