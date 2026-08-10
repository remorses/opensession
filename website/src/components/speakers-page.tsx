// Organizer speaker roster, profile detail, participant controls, CSV import,
// portal invitations, custom communications, files, tasks, and message history.
'use client'

import { useMemo, useState, useTransition } from 'react'
import { Link, router, useLoaderData } from 'spiceflow/react'
import { ArrowLeftIcon, MailIcon, PlusIcon, UploadIcon, UsersIcon } from 'lucide-react'
import {
  importSpeakers,
  inviteSpeakerToPortal,
  removeSessionParticipant,
  saveSessionParticipant,
  saveSpeaker,
  saveOrganizerSpeakerProfile,
  sendCustomSpeakerCommunication,
} from '../actions.tsx'
import {
  applySpeakerMergeFields,
  filterSpeakers,
  parseSpeakerCsv,
  prepareSpeakerImport,
  SPEAKER_MERGE_FIELDS,
  speakerCsvHeaders,
  type SpeakerCsvField,
  type SpeakerCsvRow,
  type SpeakerStatus,
} from '../lib/speaker-operations.ts'
import type { OrganizerSpeakerDetail } from '../lib/portal-server.ts'
import { cn, formatDateTimeUTC } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import {
  Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle,
} from './ui/dialog.tsx'
import { Frame, FramePanel } from './ui/frame.tsx'
import { Badge, EmptyState, Input, NativeSelect, Textarea } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import { toast, toastActionError } from './ui/toast.tsx'

const statusLabels: Record<SpeakerStatus, string> = {
  PENDING: 'Pending', INVITED: 'Invited', CONFIRMED: 'Confirmed', DECLINED: 'Declined',
}

function participantRole(value: string): 'SPEAKER' | 'MODERATOR' {
  return value === 'MODERATOR' ? 'MODERATOR' : 'SPEAKER'
}

function confirmationStatus(value: string): 'PENDING' | 'CONFIRMED' | 'DECLINED' {
  if (value === 'CONFIRMED' || value === 'DECLINED') return value
  return 'PENDING'
}

function speakerStatus(value: string): SpeakerStatus {
  if (value === 'INVITED' || value === 'CONFIRMED' || value === 'DECLINED') return value
  return 'PENDING'
}

function customFieldLabel(name: string) {
  const field = name.replace(/^speaker\./, '').replace(/([a-z])([A-Z])/g, '$1 $2')
  return field.charAt(0).toUpperCase() + field.slice(1)
}

function SpeakerStatusBadge({ status }: { status: SpeakerStatus }) {
  const variant = status === 'CONFIRMED' ? 'success' : status === 'DECLINED' ? 'destructive' : 'secondary'
  return <Badge variant={variant}>{statusLabels[status]}</Badge>
}

export function SpeakersPage({ initialStatus }: {
  initialStatus: 'all' | 'pending' | 'invited' | 'confirmed' | 'declined'
}) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event, appUrl } = useLoaderData('/org/:orgId/e/:eventId/*')
  const { speakers, existingEmails } = useLoaderData('/org/:orgId/e/:eventId/speakers')
  const portalUrl = new URL(`/portal/${event.slug}`, appUrl).href
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [composeOpen, setComposeOpen] = useState(false)
  const visible = filterSpeakers(speakers, {
    search,
    status: initialStatus === 'all' ? 'ALL' : speakerStatus(initialStatus.toUpperCase()),
  })
  const allVisibleSelected = visible.length > 0 && visible.every((row) => selected.includes(row.id))
  const clearFilters = () => {
    setSearch('')
    router.push(router.href(`/org/${currentOrgId}/e/${event.id}/speakers`, { status: 'all' }))
  }

  return <div className="flex flex-col gap-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Speakers</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">Manage the event roster, portal access, sessions, tasks, and communications. Roster status tracks organizer outreach; each session keeps its own confirmation status.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setImportOpen(true)}><UploadIcon />Import CSV</Button>
        <Button variant="outline" disabled={selected.length === 0} onClick={() => setComposeOpen(true)}><MailIcon />Message selected ({selected.length})</Button>
        <Button onClick={() => setAddOpen(true)}><PlusIcon />Add speaker</Button>
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-2 border-b border-border">
      {(['all', 'pending', 'invited', 'confirmed', 'declined'] as const).map((status) => (
        <Link key={status} href={router.href(`/org/${currentOrgId}/e/${event.id}/speakers`, { status })}
          className={cn('relative -mb-px px-2.5 py-2 text-sm capitalize no-underline', status === initialStatus ? 'font-medium text-foreground' : 'text-muted-foreground')}>
          {status} <span className="text-xs">{status === 'all' ? speakers.length : speakers.filter((row) => row.status === status.toUpperCase()).length}</span>
          {status === initialStatus ? <span className="absolute inset-x-2.5 bottom-0 h-[2px] bg-primary" /> : null}
        </Link>
      ))}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Input className="min-w-64 flex-1" aria-label="Search speakers" placeholder="Search name, email, title, or company" value={search} onChange={(event) => setSearch(event.target.value)} />
      <span className="text-sm font-medium tabular-nums">{selected.length} selected for messaging</span>
    </div>
    {visible.length === 0 ? <EmptyState icon={<UsersIcon />} title="No matching speakers" description={speakers.length === 0 ? 'Add one speaker or import a CSV to start the roster.' : 'Clear the search and roster-status filter to see the full roster.'}>
      <div className="flex flex-wrap justify-center gap-2">
        {speakers.length === 0 ? <Button variant="outline" onClick={() => setImportOpen(true)}><UploadIcon />Import CSV</Button> : <Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
        <Button onClick={() => setAddOpen(true)}><PlusIcon />Add speaker</Button>
      </div>
    </EmptyState> : <Frame>
      <Table><TableHeader><TableRow>
        <TableHead className="w-10"><input aria-label="Select visible speakers" type="checkbox" checked={allVisibleSelected} onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, ...visible.map((row) => row.id)])] : selected.filter((id) => !visible.some((row) => row.id === id)))} /></TableHead>
        <TableHead>Speaker</TableHead><TableHead>Status</TableHead><TableHead>Company</TableHead><TableHead>Sessions</TableHead><TableHead>Open tasks</TableHead>
      </TableRow></TableHeader><TableBody>{visible.map((speaker) => <TableRow key={speaker.id}>
        <TableCell><input aria-label={`Select ${speaker.firstName} ${speaker.lastName}`} type="checkbox" checked={selected.includes(speaker.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, speaker.id] : selected.filter((id) => id !== speaker.id))} /></TableCell>
        <TableCell><Link className="font-medium no-underline hover:underline" href={router.href(`/org/${currentOrgId}/e/${event.id}/speakers/${speaker.id}`)}>{speaker.firstName} {speaker.lastName}</Link><div className="text-xs text-muted-foreground">{speaker.email}{speaker.jobTitle ? ` · ${speaker.jobTitle}` : ''}</div></TableCell>
        <TableCell><SpeakerStatusBadge status={speaker.status} /></TableCell>
        <TableCell>{speaker.companyName ?? '—'}</TableCell><TableCell>{speaker.sessions}</TableCell><TableCell>{speaker.outstandingTasks}</TableCell>
      </TableRow>)}</TableBody></Table>
    </Frame>}
    <SpeakerDialog open={addOpen} onOpenChange={setAddOpen} orgId={currentOrgId} eventId={event.id} />
    <ImportDialog open={importOpen} onOpenChange={setImportOpen} orgId={currentOrgId} eventId={event.id} existingEmails={existingEmails} />
    <ComposeDialog open={composeOpen} onOpenChange={setComposeOpen} orgId={currentOrgId} event={event} portalUrl={portalUrl} speakers={speakers.filter((row) => selected.includes(row.id))} />
  </div>
}

function SpeakerDialog({ open, onOpenChange, orgId, eventId, speaker }: any) {
  const [pending, startTransition] = useTransition()
  const [headshotFileId, setHeadshotFileId] = useState<string | null>(speaker?.headshotFileId ?? null)
  const [uploading, setUploading] = useState(false)
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPopup className="max-w-xl"><DialogHeader><DialogTitle>{speaker ? 'Edit speaker' : 'Add speaker'}</DialogTitle><DialogDescription>Roster status is independent from confirmation on each session.</DialogDescription></DialogHeader><DialogPanel>
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); startTransition(async () => { try { const result = await saveSpeaker({ orgId, eventId, speakerId: speaker?.id, firstName: String(data.get('firstName')), lastName: String(data.get('lastName')), email: String(data.get('email')), status: speakerStatus(String(data.get('status'))), jobTitle: String(data.get('jobTitle')), companyName: String(data.get('companyName')), bio: String(data.get('bio')), pronouns: String(data.get('pronouns')), websiteUrl: String(data.get('websiteUrl')), linkedinUrl: String(data.get('linkedinUrl')), twitterUrl: String(data.get('twitterUrl')), headshotFileId }); onOpenChange(false); toast.success(result.created ? 'Speaker added' : 'Speaker saved') } catch (error) { toastActionError(error, 'Could not save speaker') } }) }}>
      <label className="flex flex-col gap-2 text-sm sm:col-span-2">
        Headshot
        <div className="flex items-center gap-3">
          {headshotFileId ? <img src={`/files/${headshotFileId}`} alt="Headshot preview" className="size-16 rounded-full object-cover" /> : null}
          <div className="flex flex-col gap-1">
            <Input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={uploading}
              onChange={async (event) => {
                const file = event.target.files?.[0]
                if (!file) return
                setUploading(true)
                try {
                  const body = new FormData()
                  body.set('file', file)
                  body.set('eventId', eventId)
                  body.set('kind', 'HEADSHOT')
                  const response = await fetch('/api/upload', { method: 'POST', body })
                  const result: { fileId?: string; message?: string } = await response.json()
                  if (!response.ok || !result.fileId) throw new Error(result.message ?? 'Upload failed')
                  setHeadshotFileId(result.fileId)
                  toast.success('Headshot uploaded. Save the profile to apply it.')
                } catch (error) {
                  toastActionError(error, 'Could not upload headshot')
                } finally {
                  setUploading(false)
                }
              }}
            />
            <span className="text-xs text-muted-foreground">PNG, JPEG, or WebP · Maximum 100 MB</span>
          </div>
        </div>
      </label>
      <label className="flex flex-col gap-1 text-sm">First name<Input name="firstName" required defaultValue={speaker?.firstName ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm">Last name<Input name="lastName" required defaultValue={speaker?.lastName ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">Email<Input name="email" type="email" required defaultValue={speaker?.email ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm">Title<Input name="jobTitle" defaultValue={speaker?.jobTitle ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm">Company<Input name="companyName" defaultValue={speaker?.companyName ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm">Status<NativeSelect name="status" defaultValue={speaker?.status ?? 'PENDING'}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></label>
      <label className="flex flex-col gap-1 text-sm">Pronouns<Input name="pronouns" defaultValue={speaker?.pronouns ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">Bio<Textarea name="bio" rows={4} defaultValue={speaker?.bio ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm">Website<Input name="websiteUrl" defaultValue={speaker?.websiteUrl ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm">LinkedIn<Input name="linkedinUrl" defaultValue={speaker?.linkedinUrl ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm">X / Twitter<Input name="twitterUrl" defaultValue={speaker?.twitterUrl ?? ''} /></label>
      <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={pending || uploading}>{pending ? 'Saving...' : 'Save'}</Button></div>
    </form>
  </DialogPanel></DialogPopup></Dialog>
}

const csvFields: Array<{ field: SpeakerCsvField; label: string }> = [
  { field: 'name', label: 'Full name' },
  { field: 'firstName', label: 'First name' },
  { field: 'lastName', label: 'Last name' },
  { field: 'email', label: 'Email' },
  { field: 'jobTitle', label: 'Title' },
  { field: 'companyName', label: 'Company' },
  { field: 'bio', label: 'Bio' },
]

function ImportDialog({ open, onOpenChange, orgId, eventId, existingEmails }: { open: boolean; onOpenChange: (open: boolean) => void; orgId: string; eventId: string; existingEmails: string[] }) {
  const [source, setSource] = useState('')
  const [mapping, setMapping] = useState<Partial<Record<SpeakerCsvField, string>>>({})
  const [error, setError] = useState('')
  const [pending, startTransition] = useTransition()
  const preview = useMemo<{
    headers: string[]
    rows: SpeakerCsvRow[]
    inserted: SpeakerCsvRow[]
    skipped: SpeakerCsvRow[]
    errors: Array<{ row: number; message: string }>
  }>(() => {
    if (!source) return { headers: [], rows: [], inserted: [], skipped: [], errors: [] }
    try {
      const rows = parseSpeakerCsv(source, mapping)
      return { headers: speakerCsvHeaders(source), rows, ...prepareSpeakerImport(rows, existingEmails) }
    } catch (cause) {
      return { headers: [], rows: [], inserted: [], skipped: [], errors: [{ row: 0, message: cause instanceof Error ? cause.message : 'Could not parse CSV' }] }
    }
  }, [existingEmails, mapping, source])
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPopup className="max-w-3xl"><DialogHeader><DialogTitle>Import speakers</DialogTitle><DialogDescription>Columns: name or first_name + last_name, email, title, company, bio. Header names are the mapping and can be changed before upload.</DialogDescription></DialogHeader><DialogPanel className="flex flex-col gap-4">
    <Input type="file" accept=".csv,text/csv" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; setSource(await file.text()); setMapping({}); setError('') }} />
    {preview.headers.length > 0 ? <div className="grid gap-3 sm:grid-cols-2">{csvFields.map(({ field, label }) => <label key={field} className="flex flex-col gap-1 text-sm">{label}<NativeSelect value={mapping[field] ?? ''} onChange={(event) => setMapping((current) => ({ ...current, [field]: event.target.value }))}><option value="">Automatic</option>{preview.headers.map((header) => <option key={header} value={header}>{header}</option>)}</NativeSelect></label>)}</div> : null}
    {preview.rows.length > 0 ? <><p className="text-sm text-muted-foreground">Preview: {preview.inserted.length} new, {preview.skipped.length} duplicates, {preview.errors.length} invalid.</p><Frame><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Title</TableHead><TableHead>Company</TableHead></TableRow></TableHeader><TableBody>{preview.rows.map((row, index) => <TableRow key={`${row.email}:${index}`}><TableCell>{row.firstName} {row.lastName}</TableCell><TableCell>{row.email}</TableCell><TableCell>{row.jobTitle}</TableCell><TableCell>{row.companyName}</TableCell></TableRow>)}</TableBody></Table></Frame></> : null}
    {preview.errors.length > 0 ? <p className="whitespace-pre-wrap text-sm text-destructive">{preview.errors.map((item) => `${item.row ? `Row ${item.row}: ` : ''}${item.message}`).join('\n')}</p> : null}
    {error ? <p className="text-sm text-destructive">{error}</p> : null}
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={pending || preview.rows.length === 0 || preview.errors.length > 0} onClick={() => startTransition(async () => { try { const result = await importSpeakers({ orgId, eventId, rows: preview.rows }); if (result.errors.length) { setError(result.errors.map((item) => `Row ${item.row}: ${item.message}`).join('\n')); return } toast.success(`Imported ${result.inserted}; skipped ${result.skipped} duplicates`); onOpenChange(false) } catch (cause) { setError(toastActionError(cause, 'Import failed')) } })}>{pending ? 'Importing...' : `Import ${preview.inserted.length} new speakers`}</Button></div>
  </DialogPanel></DialogPopup></Dialog>
}

function ComposeDialog({ open, onOpenChange, orgId, event, portalUrl, speakers }: any) {
  const [subject, setSubject] = useState(`Welcome to ${event.name} speakers`)
  const [body, setBody] = useState('Hi {{firstName}},\n\nWelcome to {{eventName}}. Your sessions: {{sessions}}\n\nOpen your portal: {{portalUrl}}')
  const [pending, startTransition] = useTransition()
  const previewSpeaker = speakers[0]
  let preview = 'Select at least one recipient.'
  let previewSubject = subject
  let previewError = ''
  if (previewSpeaker) {
    try {
      const recipient = { firstName: previewSpeaker.firstName, lastName: previewSpeaker.lastName, email: previewSpeaker.email, eventName: event.name, portalUrl, sessionTitles: previewSpeaker.sessionTitles }
      previewSubject = applySpeakerMergeFields(subject, recipient)
      preview = applySpeakerMergeFields(body, recipient)
    } catch (error) { previewError = error instanceof Error ? error.message : 'Invalid merge field' }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPopup className="max-w-2xl"><DialogHeader><DialogTitle>Message {speakers.length} speakers</DialogTitle><DialogDescription>One rendered outbox snapshot is saved per recipient under one batch.</DialogDescription></DialogHeader><DialogPanel className="flex flex-col gap-4">
    <div className="text-xs text-muted-foreground">Merge fields: {SPEAKER_MERGE_FIELDS.join(', ')}</div>
    <label className="flex flex-col gap-1 text-sm">Subject<Input value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
    <label className="flex flex-col gap-1 text-sm">Body<Textarea rows={7} value={body} onChange={(event) => setBody(event.target.value)} /></label>
    <Frame><FramePanel className="flex flex-col gap-2"><div className="text-xs font-medium uppercase text-muted-foreground">Preview for {previewSpeaker?.firstName ?? 'recipient'}</div><div className="text-sm font-medium">{previewSubject}</div><div className="whitespace-pre-wrap text-sm">{preview}</div></FramePanel></Frame>
    {previewError ? <p className="text-sm text-destructive">{previewError}</p> : null}
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={pending || Boolean(previewError) || speakers.length === 0} onClick={() => startTransition(async () => { try { const result = await sendCustomSpeakerCommunication({ orgId, eventId: event.id, speakerIds: speakers.map((row: any) => row.id), subject, body }); toast.success(`Queued ${result.queued} personalized messages`); onOpenChange(false) } catch (error) { toastActionError(error, 'Message failed') } })}>{pending ? 'Sending...' : `Send ${speakers.length}`}</Button></div>
  </DialogPanel></DialogPopup></Dialog>
}

export function SpeakerDetailPage() {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event } = useLoaderData('/org/:orgId/e/:eventId/*')
  // Spiceflow's merged-loader inference collapses this deep relational route
  // to never. The projection is defined and returned by the server helper.
  const detail: OrganizerSpeakerDetail = useLoaderData(
    '/org/:orgId/e/:eventId/speakers/:speakerId',
  )
  const { speaker, sessions, profileForm } = detail
  const [editOpen, setEditOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  if (!speaker) return <EmptyState icon={<UsersIcon />} title="Speaker not found" description="This speaker does not belong to the event." />
  return <div className="flex flex-col gap-6">
    <Link href={router.href(`/org/${currentOrgId}/e/${event.id}/speakers`)} className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground no-underline"><ArrowLeftIcon />Speakers</Link>
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex gap-4">
      {speaker.headshotFileId || speaker.avatarUrl ? <img className="size-20 rounded-full object-cover" src={speaker.headshotFileId ? `/files/${speaker.headshotFileId}` : speaker.avatarUrl!} alt="" /> : <div className="flex size-20 items-center justify-center rounded-full bg-muted text-xl">{speaker.firstName[0]}{speaker.lastName[0]}</div>}
      <div className="flex flex-col gap-1"><div className="flex items-center gap-2"><h1 className="text-xl font-semibold">{speaker.firstName} {speaker.lastName}</h1><SpeakerStatusBadge status={speaker.status} /></div><div className="text-sm text-muted-foreground">{[speaker.jobTitle, speaker.companyName].filter(Boolean).join(' · ')}</div><div className="text-sm text-muted-foreground">{speaker.email}</div></div>
    </div><div className="flex max-w-md flex-col items-end gap-2"><div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={pending} onClick={() => startTransition(async () => { try { const result = await inviteSpeakerToPortal({ orgId: currentOrgId, eventId: event.id, speakerId: speaker.id }); toast.success(result.sent ? 'Portal invitation sent' : 'Portal invitation queued') } catch (error) { toastActionError(error, 'Invitation failed') } })}>Send portal invite</Button>{profileForm?.customFields.length ? <Button variant="outline" onClick={() => setProfileOpen(true)}>Edit custom fields</Button> : null}<Button onClick={() => setEditOpen(true)}>Edit profile</Button></div><p className="text-right text-xs text-muted-foreground">Portal access uses the speaker's verified email. This invitation does not create organizer access.</p></div></div>
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-5">
        <Frame><FramePanel className="flex flex-col gap-3"><h2 className="text-sm font-medium">Profile</h2><p className="whitespace-pre-wrap text-sm">{speaker.bio || 'No bio yet.'}</p><div className="flex flex-wrap gap-3 text-sm">{[speaker.websiteUrl, speaker.linkedinUrl, speaker.twitterUrl].filter(Boolean).map((url) => <Link key={url} href={url!}>{url}</Link>)}</div>{profileForm?.customFields.length ? <dl className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">{profileForm.customFields.map((field) => <div key={field.name} className="flex flex-col gap-1"><dt className="text-xs font-medium text-muted-foreground">{customFieldLabel(field.name)}</dt><dd className="whitespace-pre-wrap text-sm">{Array.isArray(field.value) ? field.value.join(', ') : field.value || 'Not provided'}</dd></div>)}</dl> : null}</FramePanel></Frame>
        <Frame><FramePanel className="flex flex-col gap-3"><div className="flex items-start justify-between gap-3"><div className="flex flex-col gap-1"><h2 className="text-sm font-medium">Sessions, roles, and confirmation</h2><p className="text-xs text-muted-foreground">Confirmation below applies only to that session. It does not change the roster status shown above.</p></div><Button size="sm" variant="outline" onClick={() => setAttachOpen(true)}>Attach session</Button></div>
          {speaker.participations.length === 0 ? <p className="text-sm text-muted-foreground">No sessions attached.</p> : speaker.participations.map((part) => <div key={part.id} className="grid gap-2 border-b border-border pb-3 last:border-0 sm:grid-cols-[1fr_8rem_9rem_5rem_auto]">
            <div className="text-sm font-medium">{part.session?.title ?? 'Removed session'}</div>
            <NativeSelect value={part.role} onChange={(change) => saveSessionParticipant({ orgId: currentOrgId, eventId: event.id, sessionId: part.sessionId, speakerId: speaker.id, role: participantRole(change.target.value), confirmationStatus: part.confirmationStatus, sortOrder: part.sortOrder }).catch((error) => toastActionError(error))}><option value="SPEAKER">Speaker</option><option value="MODERATOR">Moderator</option></NativeSelect>
            <NativeSelect value={part.confirmationStatus} onChange={(change) => saveSessionParticipant({ orgId: currentOrgId, eventId: event.id, sessionId: part.sessionId, speakerId: speaker.id, role: part.role, confirmationStatus: confirmationStatus(change.target.value), sortOrder: part.sortOrder }).catch((error) => toastActionError(error))}><option value="PENDING">Pending</option><option value="CONFIRMED">Confirmed</option><option value="DECLINED">Declined</option></NativeSelect>
            <Input aria-label="Order" type="number" min={0} defaultValue={part.sortOrder} onBlur={(change) => saveSessionParticipant({ orgId: currentOrgId, eventId: event.id, sessionId: part.sessionId, speakerId: speaker.id, role: part.role, confirmationStatus: part.confirmationStatus, sortOrder: Number(change.target.value) }).catch((error) => toastActionError(error))} />
            <Button size="sm" variant="ghost" onClick={() => removeSessionParticipant({ orgId: currentOrgId, eventId: event.id, sessionId: part.sessionId, speakerId: speaker.id }).catch((error) => toastActionError(error))}>Detach</Button>
          </div>)}</FramePanel></Frame>
        <Frame><Table><TableHeader><TableRow><TableHead>Task</TableHead><TableHead>Session</TableHead><TableHead>Due</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{speaker.taskAssignments.map((row) => <TableRow key={row.id}><TableCell>{row.taskDefinition?.title}</TableCell><TableCell>{row.session?.title ?? 'Speaker'}</TableCell><TableCell>{row.dueAt ? formatDateTimeUTC(row.dueAt) : '—'}</TableCell><TableCell><Badge variant={row.status === 'COMPLETED' ? 'success' : 'secondary'}>{row.status.toLowerCase().replace('_', ' ')}</Badge></TableCell></TableRow>)}</TableBody></Table></Frame>
      </div>
      <div className="flex flex-col gap-5">
        <Frame><FramePanel className="flex flex-col gap-3"><h2 className="text-sm font-medium">Files</h2>{speaker.uploadedFiles.length === 0 ? <p className="text-sm text-muted-foreground">No uploaded files.</p> : speaker.uploadedFiles.map((file) => <Link key={file.id} href={router.href('/files/:fileId', { fileId: file.id })} className="text-sm"><span className="font-medium">{file.fileName}</span><span className="block text-xs text-muted-foreground">{file.mimeType} · {formatDateTimeUTC(file.createdAt)}</span></Link>)}</FramePanel></Frame>
        <Frame><FramePanel className="flex flex-col gap-3"><h2 className="text-sm font-medium">Email history</h2>{speaker.emailMessages.length === 0 ? <p className="text-sm text-muted-foreground">No messages.</p> : speaker.emailMessages.map((mail) => <div key={mail.id} className="border-b border-border pb-2 text-sm last:border-0"><div className="font-medium">{mail.subject}</div><div className="text-xs text-muted-foreground">{mail.kind.replaceAll('_', ' ').toLowerCase()} · {mail.status.toLowerCase()} · {formatDateTimeUTC(mail.createdAt)}{mail.batchId ? ` · batch ${mail.batchId.slice(-6)}` : ''}</div></div>)}</FramePanel></Frame>
      </div>
    </div>
    <SpeakerDialog open={editOpen} onOpenChange={setEditOpen} orgId={currentOrgId} eventId={event.id} speaker={speaker} />
    {profileForm && profileOpen ? <Dialog open onOpenChange={setProfileOpen}><DialogPopup className="max-w-xl"><DialogHeader><DialogTitle>Edit custom profile fields</DialogTitle><DialogDescription>These fields come from {profileForm.name}. Their answers stay private to organizers.</DialogDescription></DialogHeader><DialogPanel><form className="flex flex-col gap-4" onSubmit={(submitEvent) => { submitEvent.preventDefault(); const data = new FormData(submitEvent.currentTarget); startTransition(async () => { try { const values = { ...profileForm.initialValues }; for (const field of profileForm.customFields) values[field.name] = String(data.get(field.name) ?? ''); await saveOrganizerSpeakerProfile({ orgId: currentOrgId, eventId: event.id, speakerId: speaker.id, formId: profileForm.id, submission: { values, participants: [] } }); setProfileOpen(false); toast.success('Custom profile fields saved') } catch (error) { toastActionError(error, 'Could not save custom fields') } }) }}>{profileForm.customFields.map((field) => <label key={field.name} className="flex flex-col gap-1 text-sm">{customFieldLabel(field.name)}<Textarea name={field.name} rows={3} defaultValue={Array.isArray(field.value) ? field.value.join('\n') : field.value} /></label>)}<div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setProfileOpen(false)}>Cancel</Button><Button type="submit" disabled={pending}>{pending ? 'Saving...' : 'Save custom fields'}</Button></div></form></DialogPanel></DialogPopup></Dialog> : null}
    <AttachDialog open={attachOpen} onOpenChange={setAttachOpen} orgId={currentOrgId} eventId={event.id} speakerId={speaker.id} sessions={sessions} />
  </div>
}

function AttachDialog({ open, onOpenChange, orgId, eventId, speakerId, sessions }: any) {
  const [pending, startTransition] = useTransition()
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPopup><DialogHeader><DialogTitle>Attach to session</DialogTitle><DialogDescription>Add as a speaker or moderator. Existing links are updated.</DialogDescription></DialogHeader><DialogPanel><form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); startTransition(async () => { try { await saveSessionParticipant({ orgId, eventId, speakerId, sessionId: String(data.get('sessionId')), role: participantRole(String(data.get('role'))), confirmationStatus: 'PENDING', sortOrder: Number(data.get('sortOrder')) }); toast.success('Participant saved'); onOpenChange(false) } catch (error) { toastActionError(error, 'Could not attach speaker') } }) }}><label className="flex flex-col gap-1 text-sm">Session<NativeSelect name="sessionId" required><option value="">Select session...</option>{sessions.map((session: { id: string; title: string | null }) => <option key={session.id} value={session.id}>{session.title ?? 'Untitled'}</option>)}</NativeSelect></label><label className="flex flex-col gap-1 text-sm">Role<NativeSelect name="role"><option value="SPEAKER">Speaker</option><option value="MODERATOR">Moderator</option></NativeSelect></label><label className="flex flex-col gap-1 text-sm">Order<Input name="sortOrder" type="number" min={0} defaultValue={0} /></label><Button type="submit" disabled={pending}>{pending ? 'Saving...' : 'Attach'}</Button></form></DialogPanel></DialogPopup></Dialog>
}
