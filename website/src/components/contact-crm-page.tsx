// Organization-level speaker CRM: cross-event directory, profiles, explicit
// saved segments, fixed sourcing board, outreach, merge, and derived metrics.
'use client'

import { useState, useTransition } from 'react'
import { Link, router, useLoaderData } from 'spiceflow/react'
import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  GitMergeIcon,
  MailIcon,
  PlusIcon,
  TagsIcon,
  UploadIcon,
  UsersIcon,
} from 'lucide-react'
import {
  addContactNote,
  addContactTag,
  addContactToEvent,
  importContacts,
  mergeContacts,
  moveContactStage,
  saveContact,
  saveContactSegment,
  sendContactOutreach,
} from '../actions.tsx'
import {
  CONTACT_STAGES,
  filterContacts,
  parseContactCsv,
  prepareContactImport,
  sameNameDuplicateGroups,
  stageLabel,
  type ContactCsvRow,
  type ContactStage,
} from '../lib/contact-crm.ts'
import { applySpeakerMergeFields } from '../lib/speaker-operations.ts'
import { cn, formatDateTimeUTC } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from './ui/dialog.tsx'
import { Frame, FramePanel } from './ui/frame.tsx'
import { Badge, EmptyState, Input, NativeSelect, Textarea } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import { toast, toastActionError } from './ui/toast.tsx'

type CrmView = 'directory' | 'segments' | 'pipeline' | 'dashboard'

const viewTabs: Array<{ value: CrmView; label: string }> = [
  { value: 'directory', label: 'Directory' },
  { value: 'segments', label: 'Segments' },
  { value: 'pipeline', label: 'Sourcing pipeline' },
  { value: 'dashboard', label: 'Dashboard' },
]

export function ContactCrmPage({ view, contactId, segmentId }: {
  view: CrmView
  contactId?: string
  segmentId?: string
}) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const data = useLoaderData('/org/:orgId/crm')
  const contact = contactId ? data.contacts.find((row) => row.id === contactId) : null
  if (contact) return <ContactProfile orgId={currentOrgId} contact={contact} events={data.events} />

  return <div className="flex flex-col gap-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Speaker CRM</h1>
        <p className="text-sm text-muted-foreground">One cross-event directory and sourcing pipeline for this organization.</p>
      </div>
      <Badge variant="outline">Organization level</Badge>
    </div>
    <div className="flex overflow-x-auto border-b border-border">
      {viewTabs.map((tab) => <Link
        key={tab.value}
        href={router.href(`/org/${currentOrgId}/crm`, { view: tab.value })}
        className={cn(
          'relative -mb-px shrink-0 px-3 py-2 text-sm no-underline',
          view === tab.value ? 'font-medium text-foreground' : 'text-muted-foreground',
        )}
      >
        {tab.label}
        {view === tab.value ? <span className="absolute inset-x-3 bottom-0 h-0.5 bg-primary" /> : null}
      </Link>)}
    </div>
    {view === 'directory' ? <Directory orgId={currentOrgId} data={data} initialSegmentId={segmentId} /> : null}
    {view === 'segments' ? <Segments orgId={currentOrgId} data={data} selectedId={segmentId} /> : null}
    {view === 'pipeline' ? <Pipeline orgId={currentOrgId} data={data} /> : null}
    {view === 'dashboard' ? <CrmDashboard orgId={currentOrgId} data={data} /> : null}
  </div>
}

function Directory({ orgId, data, initialSegmentId }: { orgId: string; data: any; initialSegmentId?: string }) {
  const initialSegment = data.segments.find((segment: any) => segment.id === initialSegmentId)
  const [search, setSearch] = useState('')
  const [company, setCompany] = useState(initialSegment?.companyName ?? '')
  const [title, setTitle] = useState(initialSegment?.jobTitle ?? '')
  const [tagId, setTagId] = useState(initialSegment?.tagId ?? '')
  const [selected, setSelected] = useState<string[]>([])
  const [dialog, setDialog] = useState<'add' | 'import' | 'segment' | 'outreach' | 'event' | 'merge' | null>(null)
  const visible = filterContacts(data.contacts, { search, company, title, tagId })
  const duplicateGroups = sameNameDuplicateGroups(data.contacts)
  const duplicateContacts = [...duplicateGroups.values()].flat()
  const hasFilters = Boolean(company || title || tagId)
  const clearFilters = () => { setCompany(''); setTitle(''); setTagId('') }
  return <>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setDialog('add')}><PlusIcon data-icon="inline-start" />Add contact</Button>
        <Button variant="outline" onClick={() => setDialog('import')}><UploadIcon data-icon="inline-start" />Import CSV</Button>
        {duplicateContacts.length > 1 ? <Button variant="outline" onClick={() => setDialog('merge')}><GitMergeIcon data-icon="inline-start" />Merge duplicates</Button> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={selected.length === 0} onClick={() => setDialog('event')}>Add to event</Button>
        <Button variant="outline" disabled={selected.length < 2} onClick={() => setDialog('outreach')}><MailIcon data-icon="inline-start" />Email {selected.length || ''}</Button>
      </div>
    </div>
    <div className="grid gap-2 lg:grid-cols-[minmax(14rem,1fr)_13rem_13rem_12rem_auto]">
      <Input aria-label="Search contacts" placeholder="Search name, email, company, or title" value={search} onChange={(event) => setSearch(event.target.value)} />
      <Input aria-label="Filter by company" placeholder="Company filter" value={company} onChange={(event) => setCompany(event.target.value)} />
      <Input aria-label="Filter by title" placeholder="Job title filter" value={title} onChange={(event) => setTitle(event.target.value)} />
      <NativeSelect aria-label="Filter by tag" value={tagId} onChange={(event) => setTagId(event.target.value)}>
        <option value="">All tags</option>
        {data.tags.map((tag: any) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
      </NativeSelect>
      <Button variant="ghost" disabled={!hasFilters} onClick={clearFilters}>Clear filters</Button>
    </div>
    {hasFilters ? <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Active criteria:</span>
      {company ? <Badge variant="secondary">Company: {company}</Badge> : null}
      {title ? <Badge variant="secondary">Title: {title}</Badge> : null}
      {tagId ? <Badge variant="secondary">Tag: {data.tags.find((tag: any) => tag.id === tagId)?.name}</Badge> : null}
      <Button size="sm" variant="outline" onClick={() => setDialog('segment')}>Save segment</Button>
    </div> : null}
    {visible.length === 0 ? <EmptyState icon={<UsersIcon />} title="No matching contacts" description="Clear filters, import a CSV, or add a contact." /> : <Frame>
      <Table><TableHeader><TableRow>
        <TableHead className="w-10"><input type="checkbox" aria-label="Select visible contacts" checked={visible.length > 0 && visible.every((row: any) => selected.includes(row.id))} onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, ...visible.map((row: any) => row.id)])] : selected.filter((id) => !visible.some((row: any) => row.id === id)))} /></TableHead>
        <TableHead>Contact</TableHead><TableHead>Company</TableHead><TableHead>Tags</TableHead><TableHead>Events</TableHead><TableHead>Pipeline</TableHead>
      </TableRow></TableHeader><TableBody>{visible.map((contact: any) => {
        const duplicate = duplicateGroups.get(`${contact.firstName} ${contact.lastName}`.toLowerCase())
        return <TableRow key={contact.id}>
          <TableCell><input type="checkbox" aria-label={`Select ${contact.firstName} ${contact.lastName}`} checked={selected.includes(contact.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, contact.id] : selected.filter((id) => id !== contact.id))} /></TableCell>
          <TableCell><Link className="font-medium no-underline hover:underline" href={router.href(`/org/${orgId}/crm`, { view: 'directory', contact: contact.id })}>{contact.firstName} {contact.lastName}</Link><div className="text-xs text-muted-foreground">{contact.email}{contact.jobTitle ? ` · ${contact.jobTitle}` : ''}</div>{duplicate ? <Badge variant="warning">Possible duplicate</Badge> : null}</TableCell>
          <TableCell>{contact.companyName ?? '—'}</TableCell>
          <TableCell><div className="flex flex-wrap gap-1">{contact.tags.map((tag: any) => <Badge key={tag.id} variant="secondary">{tag.name}</Badge>)}</div></TableCell>
          <TableCell>{contact.connections.length}</TableCell>
          <TableCell>{contact.stage ? <Badge variant={contact.stage === 'CONFIRMED' ? 'success' : contact.stage === 'DECLINED' ? 'destructive' : 'secondary'}>{stageLabel(contact.stage)}</Badge> : 'Not enrolled'}</TableCell>
        </TableRow>
      })}</TableBody></Table>
    </Frame>}
    <ContactDialog open={dialog === 'add'} onOpenChange={(open: boolean) => setDialog(open ? 'add' : null)} orgId={orgId} />
    <ImportContactsDialog open={dialog === 'import'} onOpenChange={(open: boolean) => setDialog(open ? 'import' : null)} orgId={orgId} existingEmails={data.contacts.map((contact: any) => contact.email)} />
    <SegmentDialog open={dialog === 'segment'} onOpenChange={(open: boolean) => setDialog(open ? 'segment' : null)} orgId={orgId} companyName={company} jobTitle={title} tagId={tagId} />
    <ContactEventDialog open={dialog === 'event'} onOpenChange={(open: boolean) => setDialog(open ? 'event' : null)} orgId={orgId} contactIds={selected} events={data.events} />
    <OutreachDialog open={dialog === 'outreach'} onOpenChange={(open: boolean) => setDialog(open ? 'outreach' : null)} orgId={orgId} contacts={data.contacts.filter((contact: any) => selected.includes(contact.id))} events={data.events} />
    <MergeDialog open={dialog === 'merge'} onOpenChange={(open: boolean) => setDialog(open ? 'merge' : null)} orgId={orgId} contacts={duplicateContacts} />
  </>
}

function ContactDialog({ open, onOpenChange, orgId, contact }: any) {
  const [pending, startTransition] = useTransition()
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPopup><DialogHeader><DialogTitle>{contact ? 'Edit contact' : 'Add contact'}</DialogTitle><DialogDescription>Canonical organization profile reused across every event.</DialogDescription></DialogHeader><DialogPanel>
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); startTransition(async () => { try { await saveContact({ orgId, contactId: contact?.id, firstName: String(form.get('firstName')), lastName: String(form.get('lastName')), email: String(form.get('email')), jobTitle: String(form.get('jobTitle')), companyName: String(form.get('companyName')), bio: String(form.get('bio')) }); toast.success(contact ? 'Contact saved' : 'Contact added'); onOpenChange(false) } catch (error) { toastActionError(error, 'Could not save contact') } }) }}>
      <label className="flex flex-col gap-1 text-sm">First name<Input name="firstName" required defaultValue={contact?.firstName ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm">Last name<Input name="lastName" required defaultValue={contact?.lastName ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">Email<Input name="email" type="email" required defaultValue={contact?.email ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm">Job title<Input name="jobTitle" defaultValue={contact?.jobTitle ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm">Company<Input name="companyName" defaultValue={contact?.companyName ?? ''} /></label>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">Bio<Textarea name="bio" rows={4} defaultValue={contact?.bio ?? ''} /></label>
      <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={pending}>{pending ? 'Saving...' : 'Save contact'}</Button></div>
    </form>
  </DialogPanel></DialogPopup></Dialog>
}

function ImportContactsDialog({ open, onOpenChange, orgId, existingEmails }: any) {
  const [source, setSource] = useState('')
  const [pending, startTransition] = useTransition()
  let rows: ContactCsvRow[] = []
  let preview = { inserted: [] as ContactCsvRow[], skipped: [] as ContactCsvRow[], errors: [] as Array<{ row: number; message: string }> }
  try { rows = source ? parseContactCsv(source) : []; preview = prepareContactImport(rows, existingEmails) } catch (error) { preview.errors = [{ row: 0, message: error instanceof Error ? error.message : 'Invalid CSV' }] }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPopup className="max-w-3xl"><DialogHeader><DialogTitle>Import organization contacts</DialogTitle><DialogDescription>Map the standard name, email, title, company, and bio columns. Normalized email prevents duplicate imports.</DialogDescription></DialogHeader><DialogPanel className="flex flex-col gap-4">
    <Input type="file" accept=".csv,text/csv" onChange={async (event) => { const file = event.target.files?.[0]; if (file) setSource(await file.text()) }} />
    {rows.length ? <><p className="text-sm">Validation preview: {preview.inserted.length} new, {preview.skipped.length} duplicate, {preview.errors.length} invalid.</p><Frame><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Title</TableHead><TableHead>Company</TableHead><TableHead>Result</TableHead></TableRow></TableHeader><TableBody>{rows.map((row, index) => <TableRow key={`${row.email}:${index}`}><TableCell>{row.firstName} {row.lastName}</TableCell><TableCell>{row.email}</TableCell><TableCell>{row.jobTitle}</TableCell><TableCell>{row.companyName}</TableCell><TableCell>{preview.errors.some((error) => error.row === index + 1) ? 'Invalid' : preview.skipped.some((item) => item.email === row.email) ? 'Duplicate' : 'Ready'}</TableCell></TableRow>)}</TableBody></Table></Frame></> : null}
    {preview.errors.length ? <p className="whitespace-pre-wrap text-sm text-destructive">{preview.errors.map((error) => `${error.row ? `Row ${error.row}: ` : ''}${error.message}`).join('\n')}</p> : null}
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={pending || !rows.length || preview.errors.length > 0} onClick={() => startTransition(async () => { try { const result = await importContacts({ orgId, rows }); toast.success(`Imported ${result.inserted}; skipped ${result.skipped}`); onOpenChange(false) } catch (error) { toastActionError(error, 'Import failed') } })}>{pending ? 'Importing...' : `Import ${preview.inserted.length} contacts`}</Button></div>
  </DialogPanel></DialogPopup></Dialog>
}

function SegmentDialog({ open, onOpenChange, orgId, companyName, jobTitle, tagId }: any) {
  const [pending, startTransition] = useTransition()
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPopup><DialogHeader><DialogTitle>Save dynamic segment</DialogTitle><DialogDescription>This segment always recalculates from its explicit company, title, and tag criteria.</DialogDescription></DialogHeader><DialogPanel><form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); startTransition(async () => { try { await saveContactSegment({ orgId, name: String(form.get('name')), companyName, jobTitle, tagId: tagId || null }); toast.success('Segment saved'); onOpenChange(false) } catch (error) { toastActionError(error, 'Could not save segment') } }) }}><label className="flex flex-col gap-1 text-sm">Segment name<Input name="name" required defaultValue="AI Experts" /></label><div className="flex flex-wrap gap-1"><Badge variant="secondary">Company: {companyName || 'Any'}</Badge><Badge variant="secondary">Title: {jobTitle || 'Any'}</Badge>{tagId ? <Badge variant="secondary">Tag filter</Badge> : null}</div><Button type="submit" disabled={pending}>{pending ? 'Saving...' : 'Save dynamic segment'}</Button></form></DialogPanel></DialogPopup></Dialog>
}

function Segments({ orgId, data, selectedId }: any) {
  const selected = data.segments.find((segment: any) => segment.id === selectedId) ?? data.segments[0]
  if (!selected) return <EmptyState icon={<TagsIcon />} title="No saved segments" description="Apply directory filters, then save the result as a dynamic segment." />
  const members = filterContacts(data.contacts, { search: '', company: selected.companyName ?? '', title: selected.jobTitle ?? '', tagId: selected.tagId ?? '' })
  return <div className="grid gap-5 lg:grid-cols-[16rem_1fr]"><Frame><FramePanel className="flex flex-col gap-1">{data.segments.map((segment: any) => <Link key={segment.id} href={router.href(`/org/${orgId}/crm`, { view: 'segments', segment: segment.id })} className={cn('rounded-md px-2 py-2 text-sm no-underline', segment.id === selected.id ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground')}>{segment.name}<span className="block text-xs">Dynamic segment</span></Link>)}</FramePanel></Frame><div className="flex flex-col gap-3"><div><h2 className="font-semibold">{selected.name}</h2><p className="text-sm text-muted-foreground">{members.length} matching contacts · {[selected.companyName, selected.jobTitle, selected.tag?.name].filter(Boolean).join(' · ')}</p></div><Frame><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Company</TableHead></TableRow></TableHeader><TableBody>{members.map((contact: any) => <TableRow key={contact.id}><TableCell><Link href={router.href(`/org/${orgId}/crm`, { view: 'directory', contact: contact.id })}>{contact.firstName} {contact.lastName}</Link></TableCell><TableCell>{contact.email}</TableCell><TableCell>{contact.companyName}</TableCell></TableRow>)}</TableBody></Table></Frame></div></div>
}

function Pipeline({ orgId, data }: any) {
  const [enrollOpen, setEnrollOpen] = useState(false)
  return <><div className="flex justify-end"><Button onClick={() => setEnrollOpen(true)}><PlusIcon data-icon="inline-start" />Enroll contact</Button></div><div className="grid min-w-[70rem] grid-cols-6 gap-3 overflow-x-auto">{CONTACT_STAGES.map((stage) => {
    const contacts = data.contacts.filter((contact: any) => contact.stage === stage)
    return <section key={stage} className="flex min-h-72 flex-col gap-2 rounded-lg bg-muted/50 p-2"><div className="flex items-center justify-between px-1 text-xs font-medium uppercase tracking-wide"><span>{stageLabel(stage)}</span><span>{contacts.length}</span></div>{contacts.map((contact: any) => <Frame key={contact.id}><FramePanel className="flex flex-col gap-2"><Link className="font-medium no-underline hover:underline" href={router.href(`/org/${orgId}/crm`, { view: 'pipeline', contact: contact.id })}>{contact.firstName} {contact.lastName}</Link><div className="text-xs text-muted-foreground">{contact.companyName ?? contact.email}</div>{contact.score != null ? <Badge variant="outline">Score {contact.score}</Badge> : null}<NativeSelect aria-label={`Move ${contact.firstName} ${contact.lastName}`} value={contact.stage} onChange={(event) => moveContactStage({ orgId, contactId: contact.id, stage: event.target.value as ContactStage }).catch((error) => toastActionError(error, 'Could not move contact'))}>{CONTACT_STAGES.map((value) => <option key={value} value={value}>{stageLabel(value)}</option>)}</NativeSelect></FramePanel></Frame>)}</section>
  })}</div><EnrollDialog open={enrollOpen} onOpenChange={setEnrollOpen} orgId={orgId} contacts={data.contacts.filter((contact: any) => !contact.stage)} /></>
}

function EnrollDialog({ open, onOpenChange, orgId, contacts }: any) {
  const [pending, startTransition] = useTransition()
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPopup><DialogHeader><DialogTitle>Enroll sourcing prospect</DialogTitle><DialogDescription>Add score and rationale to the fixed organization pipeline.</DialogDescription></DialogHeader><DialogPanel><form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); startTransition(async () => { try { await moveContactStage({ orgId, contactId: String(form.get('contactId')), stage: String(form.get('stage')) as ContactStage, score: Number(form.get('score')), rationale: String(form.get('rationale')) }); toast.success('Contact enrolled'); onOpenChange(false) } catch (error) { toastActionError(error, 'Could not enroll contact') } }) }}><label className="flex flex-col gap-1 text-sm">Contact<NativeSelect name="contactId" required><option value="">Select contact...</option>{contacts.map((contact: any) => <option key={contact.id} value={contact.id}>{contact.firstName} {contact.lastName}</option>)}</NativeSelect></label><label className="flex flex-col gap-1 text-sm">Starting stage<NativeSelect name="stage" defaultValue="IDENTIFIED">{CONTACT_STAGES.map((stage) => <option key={stage} value={stage}>{stageLabel(stage)}</option>)}</NativeSelect></label><label className="flex flex-col gap-1 text-sm">Score<Input name="score" type="number" min={0} max={100} defaultValue={85} /></label><label className="flex flex-col gap-1 text-sm">Rationale<Textarea name="rationale" rows={3} defaultValue="Strong platform-engineering track record; ideal for Platform & Infra track." /></label><Button type="submit" disabled={pending || !contacts.length}>{pending ? 'Enrolling...' : 'Enroll contact'}</Button></form></DialogPanel></DialogPopup></Dialog>
}

function ContactProfile({ orgId, contact, events }: any) {
  const [dialog, setDialog] = useState<'edit' | 'event' | null>(null)
  const [pending, startTransition] = useTransition()
  return <div className="flex flex-col gap-6">
    <Link href={router.href(`/org/${orgId}/crm`, { view: 'directory' })} className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground no-underline"><ArrowLeftIcon data-icon="inline-start" />Directory</Link>
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex flex-col gap-1"><div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold">{contact.firstName} {contact.lastName}</h1>{contact.stage ? <Badge variant="secondary">{stageLabel(contact.stage)}</Badge> : null}</div><div className="text-sm text-muted-foreground">{[contact.jobTitle, contact.companyName].filter(Boolean).join(' · ')}</div><div className="text-sm text-muted-foreground">{contact.email}</div></div><div className="flex gap-2"><Button variant="outline" onClick={() => setDialog('event')}>Add to event</Button><Button onClick={() => setDialog('edit')}>Edit profile</Button></div></div>
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]"><div className="flex flex-col gap-5">
      <Frame><FramePanel className="flex flex-col gap-3"><h2 className="text-sm font-medium">Profile</h2><p className="whitespace-pre-wrap text-sm">{contact.bio || 'No bio yet.'}</p><div className="flex flex-wrap gap-1">{contact.tags.map((tag: any) => <Badge key={tag.id} variant="secondary">{tag.name}</Badge>)}</div><form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); startTransition(async () => { try { await addContactTag({ orgId, contactId: contact.id, name: String(form.get('tag')) }); toast.success('Tag added'); event.currentTarget.reset() } catch (error) { toastActionError(error, 'Could not add tag') } }) }}><Input name="tag" required placeholder="Add tag, for example AI" /><Button type="submit" variant="outline" disabled={pending}>Add tag</Button></form></FramePanel></Frame>
      <Frame><FramePanel className="flex flex-col gap-3"><h2 className="text-sm font-medium">Internal notes</h2><form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); startTransition(async () => { try { await addContactNote({ orgId, contactId: contact.id, body: String(form.get('body')) }); toast.success('Note saved'); event.currentTarget.reset() } catch (error) { toastActionError(error, 'Could not save note') } }) }}><Textarea name="body" required rows={3} placeholder="Add a private organizer note" /><Button type="submit" disabled={pending}>Save note</Button></form>{contact.activities.filter((activity: any) => activity.kind === 'NOTE').map((activity: any) => <div key={activity.id} className="border-t border-border pt-3"><p className="whitespace-pre-wrap text-sm">{activity.body}</p><p className="text-xs text-muted-foreground">{activity.actorName} · {formatDateTimeUTC(activity.createdAt)}</p></div>)}</FramePanel></Frame>
      <Frame><FramePanel className="flex flex-col gap-3"><h2 className="text-sm font-medium">Connections across events</h2>{contact.connections.length ? contact.connections.map((connection: any) => <div key={connection.speakerId} className="border-b border-border pb-2 text-sm last:border-0"><div className="font-medium">{connection.eventName}</div><div className="text-xs text-muted-foreground">{connection.sessionTitles.join(', ') || 'Speaker roster'}</div></div>) : <p className="text-sm text-muted-foreground">Not linked to an event yet.</p>}</FramePanel></Frame>
    </div><div className="flex flex-col gap-5">
      <Frame><FramePanel className="flex flex-col gap-3"><h2 className="text-sm font-medium">Sourcing card</h2><label className="flex flex-col gap-1 text-sm">Stage<NativeSelect value={contact.stage ?? ''} onChange={(event) => moveContactStage({ orgId, contactId: contact.id, stage: event.target.value as ContactStage }).catch((error) => toastActionError(error))}><option value="" disabled>Not enrolled</option>{CONTACT_STAGES.map((stage) => <option key={stage} value={stage}>{stageLabel(stage)}</option>)}</NativeSelect></label><div className="text-sm">Score: {contact.score ?? '—'}</div><p className="text-sm text-muted-foreground">{contact.rationale || 'No rationale.'}</p></FramePanel></Frame>
      <Frame><FramePanel className="flex flex-col gap-3"><h2 className="text-sm font-medium">Activity and stage history</h2>{contact.activities.length ? contact.activities.map((activity: any) => <div key={activity.id} className="border-b border-border pb-2 text-sm last:border-0"><div>{activity.kind === 'STAGE_TRANSITION' ? `${activity.fromStage ? stageLabel(activity.fromStage) : 'Not enrolled'} → ${stageLabel(activity.toStage)}` : activity.body}</div><div className="text-xs text-muted-foreground">{activity.kind.replaceAll('_', ' ').toLowerCase()} · {formatDateTimeUTC(activity.createdAt)}</div></div>) : <p className="text-sm text-muted-foreground">No activity yet.</p>}</FramePanel></Frame>
      <Frame><FramePanel className="flex flex-col gap-3"><h2 className="text-sm font-medium">Outreach history</h2>{contact.emailMessages.length ? contact.emailMessages.map((message: any) => <div key={message.id} className="border-b border-border pb-2 text-sm last:border-0"><div>{message.subject}</div><div className="text-xs text-muted-foreground">{message.status.toLowerCase()} · {formatDateTimeUTC(message.createdAt)}</div></div>) : <p className="text-sm text-muted-foreground">No outreach yet.</p>}</FramePanel></Frame>
    </div></div>
    <ContactDialog open={dialog === 'edit'} onOpenChange={(open: boolean) => setDialog(open ? 'edit' : null)} orgId={orgId} contact={contact} />
    <ContactEventDialog open={dialog === 'event'} onOpenChange={(open: boolean) => setDialog(open ? 'event' : null)} orgId={orgId} contactIds={[contact.id]} events={events} />
  </div>
}

function ContactEventDialog({ open, onOpenChange, orgId, contactIds, events }: any) {
  const [pending, startTransition] = useTransition()
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPopup><DialogHeader><DialogTitle>Add contacts to event</DialogTitle><DialogDescription>Profile fields carry into the event speaker roster without re-entry.</DialogDescription></DialogHeader><DialogPanel><form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); const eventId = String(new FormData(event.currentTarget).get('eventId')); startTransition(async () => { try { for (const contactId of contactIds) await addContactToEvent({ orgId, contactId, eventId }); toast.success(`Added ${contactIds.length} contact${contactIds.length === 1 ? '' : 's'} to event`); onOpenChange(false) } catch (error) { toastActionError(error, 'Could not add contacts') } }) }}><label className="flex flex-col gap-1 text-sm">Event<NativeSelect name="eventId" required><option value="">Select event...</option>{events.map((event: any) => <option key={event.id} value={event.id}>{event.name}</option>)}</NativeSelect></label><Button type="submit" disabled={pending || !contactIds.length}>{pending ? 'Adding...' : 'Add to event'}</Button></form></DialogPanel></DialogPopup></Dialog>
}

function OutreachDialog({ open, onOpenChange, orgId, contacts, events }: any) {
  const [eventId, setEventId] = useState(events[0]?.id ?? '')
  const [subject, setSubject] = useState('Speak at DevFlow Conf 2027?')
  const [body, setBody] = useState('Hi {{firstName}},\n\nWould you like to speak at {{eventName}}? We would love to hear from you.\n\nOpen the speaker portal: {{portalUrl}}')
  const [pending, startTransition] = useTransition()
  const previewContact = contacts[0]
  const selectedEvent = events.find((event: any) => event.id === eventId)
  let preview = 'Select at least two contacts.'
  if (previewContact && selectedEvent) preview = applySpeakerMergeFields(body, { firstName: previewContact.firstName, lastName: previewContact.lastName, email: previewContact.email, eventName: selectedEvent.name, portalUrl: `/portal/${selectedEvent.slug}`, sessionTitles: [] })
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPopup className="max-w-2xl"><DialogHeader><DialogTitle>Email {contacts.length} contacts</DialogTitle><DialogDescription>Each personalized message is stored in the existing event outbox and contact history.</DialogDescription></DialogHeader><DialogPanel className="flex flex-col gap-3"><label className="flex flex-col gap-1 text-sm">Event<NativeSelect value={eventId} onChange={(event) => setEventId(event.target.value)}>{events.map((event: any) => <option key={event.id} value={event.id}>{event.name}</option>)}</NativeSelect></label><label className="flex flex-col gap-1 text-sm">Subject<Input value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label className="flex flex-col gap-1 text-sm">Body<Textarea rows={7} value={body} onChange={(event) => setBody(event.target.value)} /></label><p className="text-xs text-muted-foreground">Merge tags: {'{{firstName}}'}, {'{{lastName}}'}, {'{{email}}'}, {'{{eventName}}'}, {'{{portalUrl}}'}</p><Frame><FramePanel className="flex flex-col gap-2"><span className="text-xs font-medium uppercase text-muted-foreground">Preview for {previewContact?.firstName ?? 'recipient'}</span><strong className="text-sm">{subject}</strong><p className="whitespace-pre-wrap text-sm">{preview}</p></FramePanel></Frame><Button disabled={pending || contacts.length < 2 || !eventId} onClick={() => startTransition(async () => { try { const result = await sendContactOutreach({ orgId, eventId, contactIds: contacts.map((contact: any) => contact.id), subject, body }); toast.success(`Queued ${result.queued} personalized messages`); onOpenChange(false) } catch (error) { toastActionError(error, 'Outreach failed') } })}>{pending ? 'Sending...' : `Send to ${contacts.length} contacts`}</Button></DialogPanel></DialogPopup></Dialog>
}

function MergeDialog({ open, onOpenChange, orgId, contacts }: any) {
  const [primaryId, setPrimaryId] = useState(contacts[0]?.id ?? '')
  const [duplicateId, setDuplicateId] = useState(contacts[1]?.id ?? '')
  const [pending, startTransition] = useTransition()
  const primary = contacts.find((contact: any) => contact.id === primaryId)
  const duplicate = contacts.find((contact: any) => contact.id === duplicateId)
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogPopup className="max-w-2xl"><DialogHeader><DialogTitle>Merge duplicate contacts</DialogTitle><DialogDescription>Choose the surviving primary. Speaker links, tags, activity, and email history move to it. This cannot be undone.</DialogDescription></DialogHeader><DialogPanel className="flex flex-col gap-4"><div className="grid gap-3 sm:grid-cols-2"><label className="flex flex-col gap-1 text-sm">Primary contact<NativeSelect value={primaryId} onChange={(event) => setPrimaryId(event.target.value)}>{contacts.map((contact: any) => <option key={contact.id} value={contact.id}>{contact.firstName} {contact.lastName} · {contact.email}</option>)}</NativeSelect></label><label className="flex flex-col gap-1 text-sm">Duplicate to remove<NativeSelect value={duplicateId} onChange={(event) => setDuplicateId(event.target.value)}>{contacts.map((contact: any) => <option key={contact.id} value={contact.id}>{contact.firstName} {contact.lastName} · {contact.email}</option>)}</NativeSelect></label></div><Frame><Table><TableHeader><TableRow><TableHead>Field</TableHead><TableHead>Primary value</TableHead><TableHead>Duplicate value</TableHead></TableRow></TableHeader><TableBody>{['email', 'jobTitle', 'companyName', 'bio'].map((field) => <TableRow key={field}><TableCell className="capitalize">{field}</TableCell><TableCell>{primary?.[field] || '—'}</TableCell><TableCell>{duplicate?.[field] || '—'}</TableCell></TableRow>)}</TableBody></Table></Frame><Button variant="destructive" disabled={pending || !primary || !duplicate || primaryId === duplicateId} onClick={() => startTransition(async () => { try { await mergeContacts({ orgId, primaryId, duplicateId }); toast.success('Contacts merged'); onOpenChange(false) } catch (error) { toastActionError(error, 'Merge failed') } })}>{pending ? 'Merging...' : 'Merge into primary'}</Button></DialogPanel></DialogPopup></Dialog>
}

function CrmDashboard({ orgId, data }: any) {
  return <div className="flex flex-col gap-5"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
    ['Total contacts', data.metrics.totalContacts],
    ['Organization events', data.metrics.events],
    ['Returning speakers', data.metrics.returningSpeakers],
    ['Active pipeline', data.metrics.inPipeline],
  ].map(([label, value]) => <Frame key={label}><FramePanel className="flex flex-col gap-1"><span className="text-sm text-muted-foreground">{label}</span><strong className="text-2xl tabular-nums">{value}</strong></FramePanel></Frame>)}</div><Frame><FramePanel className="flex flex-col gap-3"><div className="flex items-center gap-2"><ChartNoAxesColumnIcon /><h2 className="font-medium">Top companies</h2></div>{data.metrics.topCompanies.length ? data.metrics.topCompanies.map((company: any) => <Link key={company.name} href={router.href(`/org/${orgId}/crm`, { view: 'directory' })} className="flex items-center justify-between border-b border-border pb-2 text-sm no-underline last:border-0"><span>{company.name}</span><Badge variant="secondary">{company.count}</Badge></Link>) : <p className="text-sm text-muted-foreground">Add company data to populate this widget.</p>}</FramePanel></Frame></div>
}
