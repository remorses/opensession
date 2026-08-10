// Organizer Files workspace: task-slot status, immutable versions, comments,
// filters, reminders, and a streaming ZIP export of selected current files.
'use client'

import { DownloadIcon, FilesIcon, MailIcon } from 'lucide-react'
import { useState, useTransition } from 'react'
import { Link, router, useLoaderData } from 'spiceflow/react'
import { addTaskComment, remindTaskAssignments } from '../actions.tsx'
import { formatDateTimeUTC } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { Frame, FramePanel } from './ui/frame.tsx'
import { Badge, EmptyState, NativeSelect, Textarea } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import { toast, toastActionError } from './ui/toast.tsx'

type FilesStatus = 'all' | 'incomplete' | 'complete'
type FilesKind = 'all' | 'slides' | 'images' | 'documents'

type FileSlot = {
  slotKey: string
  assignmentId: string
  fieldName: string
  taskTitle: string
  dueAt: number | null
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'
  speakerName: string
  sessionTitle: string | null
  versions: Array<{
    id: string
    fileName: string
    mimeType: string
    sizeBytes: number
    createdAt: number
    current: boolean
    selectedOnSubmit: boolean
  }>
  comments: Array<{ id: string; body: string; createdAt: number; authorName: string }>
}

type FilesLoaderData = {
  fileSlots: FileSlot[]
  otherFiles: Array<{
    id: string
    fileName: string
    kind: string
    createdAt: number
  }>
}

function matchesKind(slot: FileSlot, kind: FilesKind): boolean {
  if (kind === 'all') return true
  const file = slot.versions[0]
  if (!file) return kind === 'documents'
  if (kind === 'images') return file.mimeType.startsWith('image/')
  if (kind === 'slides') {
    return file.mimeType === 'application/pdf'
      || /\.(key|ppt|pptx|odp)$/i.test(file.fileName)
  }
  return !file.mimeType.startsWith('image/')
}

export function FilesPage({ status, kind, fileSlots, otherFiles }: {
  status: FilesStatus
  kind: FilesKind
  fileSlots: FilesLoaderData['fileSlots']
  otherFiles: FilesLoaderData['otherFiles']
}) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event } = useLoaderData('/org/:orgId/e/:eventId/*')
  const [selected, setSelected] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)
  const [reminding, startReminder] = useTransition()
  const visible = fileSlots.filter((slot) => {
    if (status === 'complete' && slot.status !== 'COMPLETED') return false
    if (status === 'incomplete' && slot.status === 'COMPLETED') return false
    return matchesKind(slot, kind)
  })
  const selectable = visible.filter((slot) => slot.versions.length > 0).map((slot) => slot.slotKey)
  const allSelected = selectable.length > 0 && selectable.every((slot) => selected.includes(slot))
  const selectedSlots = visible.filter((slot) => selected.includes(slot.slotKey))
  const incompleteAssignments = [...new Set(
    visible.filter((slot) => slot.status !== 'COMPLETED').map((slot) => slot.assignmentId),
  )]
  const zipHref = `/org/${currentOrgId}/e/${event.id}/files.zip?${new URLSearchParams(
    selectedSlots.map((slot) => ['slot', slot.slotKey]),
  )}`

  function setFilters(next: { status?: FilesStatus; kind?: FilesKind }) {
    router.push(router.href(`/org/${currentOrgId}/e/${event.id}/files`, {
      status: next.status ?? status,
      kind: next.kind ?? kind,
    }))
  }

  async function downloadZip() {
    if (selectedSlots.length === 0) return
    const fileLabel = selectedSlots.length === 1 ? 'file' : 'files'
    setExporting(true)
    toast.info(`Generating ${selectedSlots.length} current ${fileLabel}`)
    try {
      const response = await fetch(zipHref)
      if (!response.ok) throw new Error((await response.text()) || 'Could not generate the ZIP')
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `${event.slug}-files.zip`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast.success(`ZIP ready with ${selectedSlots.length} current ${fileLabel}`)
    } catch (error) {
      toastActionError(error, 'Could not generate the ZIP')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Files</h1>
          <p className="text-sm text-muted-foreground">
            Track requested deliverables, review every version, and send current files to AV or web teams.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={reminding || incompleteAssignments.length === 0}
            onClick={() => startReminder(async () => {
              try {
                const result = await remindTaskAssignments({
                  orgId: currentOrgId,
                  eventId: event.id,
                  assignmentIds: incompleteAssignments,
                })
                toast.success(`Queued ${result.queued} task reminders`)
              } catch (error) {
                toastActionError(error, 'Could not send reminders')
              }
            })}
          >
            <MailIcon data-icon="inline-start" />
            {reminding ? 'Sending...' : `Remind ${incompleteAssignments.length || ''}`}
          </Button>
          <Button
            disabled={exporting || selectedSlots.length === 0}
            onClick={downloadZip}
          >
            <DownloadIcon data-icon="inline-start" />
            {exporting ? 'Generating ZIP...' : `Download current ZIP ${selectedSlots.length || ''}`}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 border-y border-border py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><span className="font-medium">Assignment status</span><p className="text-muted-foreground">Tracks whether the whole task is not started, in progress, or complete.</p></div>
        <div><span className="font-medium">File presence</span><p className="text-muted-foreground">A task can have no upload, one upload, or several immutable versions.</p></div>
        <div><span className="font-medium">Current version</span><p className="text-muted-foreground">The newest upload. Selected current uploads are included in the ZIP.</p></div>
        <div><span className="font-medium">Submitted version</span><p className="text-muted-foreground">The version selected when the speaker last submitted the form.</p></div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <NativeSelect
            aria-label="Filter files by task status"
            className="w-40"
            value={status}
            onChange={(event) => setFilters({ status: event.target.value === 'complete' ? 'complete' : event.target.value === 'incomplete' ? 'incomplete' : 'all' })}
          >
            <option value="all">All statuses</option>
            <option value="incomplete">Incomplete</option>
            <option value="complete">Complete</option>
          </NativeSelect>
          <NativeSelect
            aria-label="Filter files by kind"
            className="w-40"
            value={kind}
            onChange={(event) => setFilters({ kind: event.target.value === 'slides' ? 'slides' : event.target.value === 'images' ? 'images' : event.target.value === 'documents' ? 'documents' : 'all' })}
          >
            <option value="all">All file kinds</option>
            <option value="slides">Slides</option>
            <option value="images">Images</option>
            <option value="documents">Documents</option>
          </NativeSelect>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(event) => setSelected(event.target.checked
              ? [...new Set([...selected, ...selectable])]
              : selected.filter((slot) => !selectable.includes(slot)))}
          />
          Select visible uploads
        </label>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<FilesIcon />}
          title="No matching deliverables"
          description="Change the filters, or create a form task with a file-upload field in Tasks."
        >
          <Button render={<Link href={router.href(`/org/${currentOrgId}/e/${event.id}/tasks`)} />}>
            Create a file form task
          </Button>
        </EmptyState>
      ) : (
        <Frame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>Deliverable</TableHead>
                <TableHead>Speaker / session</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Versions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((slot) => (
                <FileSlotRows
                  key={slot.slotKey}
                  eventId={event.id}
                  slot={slot}
                  selected={selected.includes(slot.slotKey)}
                  onSelected={(checked) => setSelected(checked
                    ? [...new Set([...selected, slot.slotKey])]
                    : selected.filter((key) => key !== slot.slotKey))}
                />
              ))}
            </TableBody>
          </Table>
        </Frame>
      )}

      {otherFiles.length > 0 ? (
        <Frame>
          <FramePanel className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">Other event assets</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {otherFiles.map((file) => (
                <Link key={file.id} href={router.href('/files/:fileId', { fileId: file.id })} className="text-sm no-underline hover:underline">
                  <span className="font-medium">{file.fileName}</span>
                  <span className="block text-xs text-muted-foreground">
                    {file.kind.toLowerCase()} · {formatDateTimeUTC(file.createdAt)}
                  </span>
                </Link>
              ))}
            </div>
          </FramePanel>
        </Frame>
      ) : null}
    </div>
  )
}

function FileSlotRows({ eventId, slot, selected, onSelected }: {
  eventId: string
  slot: FileSlot
  selected: boolean
  onSelected: (selected: boolean) => void
}) {
  const [comment, setComment] = useState('')
  const [pending, startTransition] = useTransition()
  const current = slot.versions[0]
  return (
    <>
      <TableRow>
        <TableCell>
          <input
            type="checkbox"
            aria-label={`Select ${slot.taskTitle} for ${slot.speakerName}`}
            checked={selected}
            disabled={!current}
            onChange={(event) => onSelected(event.target.checked)}
          />
        </TableCell>
        <TableCell>
          <div className="font-medium">{slot.taskTitle}</div>
          <div className="text-xs text-muted-foreground">Field: {slot.fieldName}</div>
        </TableCell>
        <TableCell>
          <div>{slot.speakerName}</div>
          <div className="text-xs text-muted-foreground">{slot.sessionTitle ?? 'Speaker profile'}</div>
        </TableCell>
        <TableCell className="text-muted-foreground">
          {slot.dueAt ? formatDateTimeUTC(slot.dueAt) : '—'}
        </TableCell>
        <TableCell>
          <Badge variant={slot.status === 'COMPLETED' ? 'success' : slot.status === 'IN_PROGRESS' ? 'warning' : 'secondary'}>
            {slot.status.toLowerCase().replace('_', ' ')}
          </Badge>
        </TableCell>
        <TableCell>
          <span className="tabular-nums">{slot.versions.length}</span>
          {current ? <span className="block text-xs text-muted-foreground">{current.fileName}</span> : null}
        </TableCell>
      </TableRow>
      <TableRow className="bg-muted/20">
        <TableCell />
        <TableCell colSpan={5}>
          <details className="group">
            <summary className="cursor-pointer text-sm font-medium">
              Version history and comments
            </summary>
            <div className="grid gap-5 py-4 lg:grid-cols-2">
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Versions</h3>
                {slot.versions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No file uploaded.</p>
                ) : slot.versions.map((file, index) => (
                  <div key={file.id} className="flex items-center justify-between gap-3 border-b border-border pb-2 last:border-0">
                    <div className="min-w-0 text-sm">
                      <Link href={router.href('/files/:fileId', { fileId: file.id })} className="font-medium no-underline hover:underline">
                        {file.fileName}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        v{slot.versions.length - index} · {formatDateTimeUTC(file.createdAt)} · {formatBytes(file.sizeBytes)}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      {file.current ? <Badge variant="success">Current</Badge> : <Badge variant="outline">Previous</Badge>}
                      {file.selectedOnSubmit ? <Badge variant="secondary">Submitted</Badge> : null}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Comments</h3>
                {slot.comments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No comments yet.</p>
                ) : slot.comments.map((item) => (
                  <div key={item.id} className="flex flex-col gap-0.5 border-b border-border pb-2 last:border-0">
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{item.authorName}</span> · {formatDateTimeUTC(item.createdAt)}
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{item.body}</p>
                  </div>
                ))}
                {current ? (
                  <div className="flex flex-col gap-2">
                    <Textarea
                      aria-label={`Comment on ${slot.taskTitle}`}
                      rows={2}
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder="Reply to the speaker"
                    />
                    <Button
                      size="sm"
                      className="self-start"
                      disabled={pending || !comment.trim()}
                      onClick={() => startTransition(async () => {
                        try {
                          await addTaskComment({
                            eventId,
                            assignmentId: slot.assignmentId,
                            fieldName: slot.fieldName,
                            body: comment,
                          })
                          setComment('')
                          toast.success('Comment added')
                        } catch (error) {
                          toastActionError(error, 'Could not add comment')
                        }
                      })}
                    >
                      {pending ? 'Adding...' : 'Add comment'}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          </details>
        </TableCell>
      </TableRow>
    </>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
