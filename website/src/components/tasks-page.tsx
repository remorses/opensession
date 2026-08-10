// Tasks page: TaskDefinition CRUD with assignment progress (n of m complete).
'use client'

import { useState, useTransition } from 'react'
import { ErrorBoundary, Link, router, useLoaderData } from 'spiceflow/react'
import { ListChecksIcon, PlusIcon, TrashIcon } from 'lucide-react'
import {
  createTaskDefinition,
  deleteTaskDefinition,
  updateTaskDefinition,
  updateTaskAssignmentDue,
  remindTaskAssignments,
} from '../actions.tsx'
import { cn, formatDateUTC } from '../lib/utils.ts'
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
import { Badge, EmptyState, Input, NativeSelect, Textarea } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import { toast, toastActionError } from './ui/toast.tsx'

export type TasksTab = 'all' | 'speaker' | 'submission'

const tabs: { value: TasksTab; label: string; match: 'SPEAKER' | 'SUBMISSION' | null }[] = [
  { value: 'all', label: 'All', match: null },
  { value: 'speaker', label: 'Speaker Tasks', match: 'SPEAKER' },
  { value: 'submission', label: 'Submission Tasks', match: 'SUBMISSION' },
]

export type TaskListRow = {
  id: string
  title: string
  instructionsHtml: string | null
  target: 'SPEAKER' | 'SUBMISSION'
  source: 'MANUAL' | 'FORM'
  assignmentPolicy: 'SELECTED' | 'ALL_ACCEPTED'
  formId: string | null
  formName: string | null
  dueAt: number | null
  sortOrder: number
  total: number
  completed: number
  inProgress: number
  notStarted: number
  assignments: Array<{ id: string; status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'; dueAt: number | null; speakerId: string; speakerName: string; sessionId: string | null; sessionTitle: string | null }>
}

export function TasksPage({ tab }: { tab: TasksTab }) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event } = useLoaderData('/org/:orgId/e/:eventId/*')
  const { tasks, portalForms, speakers, acceptedSessions } = useLoaderData('/org/:orgId/e/:eventId/tasks')
  const [createOpen, setCreateOpen] = useState(false)
  const [assignmentFilter, setAssignmentFilter] = useState<'all' | 'incomplete' | 'complete'>('all')
  const [selectedAssignments, setSelectedAssignments] = useState<string[]>([])
  const [reminding, startReminder] = useTransition()

  const active = tabs.find((t) => t.value === tab) ?? tabs[0]!
  const visible = active.match
    ? tasks.filter((task) => task.target === active.match)
    : tasks
  const visibleIncompleteIds = visible.flatMap((task) => task.assignments)
    .filter((assignment) => assignment.status !== 'COMPLETED')
    .filter((assignment) => assignmentFilter !== 'complete')
    .map((assignment) => assignment.id)
  const selectedIncompleteIds = selectedAssignments.filter((id) => visible.some((task) =>
    task.assignments.some((assignment) => assignment.id === id && assignment.status !== 'COMPLETED')))
  const allAssignmentsSelected = visibleIncompleteIds.length > 0
    && visibleIncompleteIds.every((id) => selectedAssignments.includes(id))

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Tasks</h1>
          <p className="text-sm text-muted-foreground">
            Define what speakers must do, assign it to people or sessions, then track completion in the speaker portal.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <PlusIcon />
          Add task
        </Button>
      </div>

      <div className="grid gap-3 border-y border-border py-4 text-sm md:grid-cols-3">
        <div><span className="font-medium">1. Definition</span><p className="text-muted-foreground">Choose instructions, action type, target, policy, and default due date.</p></div>
        <div><span className="font-medium">2. Assignments</span><p className="text-muted-foreground">Each speaker gets a row with its own status and due-date override.</p></div>
        <div><span className="font-medium">3. Speaker completion</span><p className="text-muted-foreground">Manual tasks use Mark complete. Form tasks use Submit and complete.</p></div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <NativeSelect aria-label="Filter task assignments" className="w-44" value={assignmentFilter} onChange={(event) => setAssignmentFilter(event.target.value === 'complete' ? 'complete' : event.target.value === 'incomplete' ? 'incomplete' : 'all')}>
          <option value="all">All assignments</option>
          <option value="incomplete">Incomplete</option>
          <option value="complete">Complete</option>
        </NativeSelect>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={allAssignmentsSelected} disabled={visibleIncompleteIds.length === 0} onChange={(event) => setSelectedAssignments(event.target.checked ? [...new Set([...selectedAssignments, ...visibleIncompleteIds])] : selectedAssignments.filter((id) => !visibleIncompleteIds.includes(id)))} />Select visible incomplete</label>
          <Button variant="outline" disabled={reminding || selectedIncompleteIds.length === 0} onClick={() => startReminder(async () => {
            try {
              const result = await remindTaskAssignments({ orgId: currentOrgId, eventId: event.id, assignmentIds: selectedIncompleteIds })
              toast.success(`Queued ${result.queued} task reminders`)
            } catch (error) {
              toastActionError(error, 'Could not send task reminders')
            }
          })}>{reminding ? 'Sending...' : `Remind selected incomplete (${selectedIncompleteIds.length})`}</Button>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        {tabs.map((t) => {
          const count = t.match
            ? tasks.filter((task) => task.target === t.match).length
            : tasks.length
          return (
            <Link
              key={t.value}
              href={router.href(`/org/${currentOrgId}/e/${event.id}/tasks`, { tab: t.value })}
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
          icon={<ListChecksIcon className="size-5 text-muted-foreground" />}
          title={tasks.length === 0 ? 'No tasks yet' : 'Nothing here'}
          description={
            tasks.length === 0
              ? 'Add speaker or submission tasks. They auto-assign when you accept abstracts.'
              : 'No tasks in this tab.'
          }
        >
          {tasks.length === 0 ? (
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              Add task
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <Frame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((task) => (
                <TaskRow
                  key={task.id}
                  orgId={currentOrgId}
                  eventId={event.id}
                  task={task}
                  portalForms={portalForms}
                  speakers={speakers}
                  acceptedSessions={acceptedSessions}
                  assignmentFilter={assignmentFilter}
                  selectedAssignments={selectedAssignments}
                  onAssignmentSelected={(assignmentId, checked) => setSelectedAssignments(checked ? [...new Set([...selectedAssignments, assignmentId])] : selectedAssignments.filter((id) => id !== assignmentId))}
                />
              ))}
            </TableBody>
          </Table>
        </Frame>
      )}

      <TaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        orgId={currentOrgId}
        eventId={event.id}
        portalForms={portalForms}
        speakers={speakers}
        acceptedSessions={acceptedSessions}
        mode="create"
      />
    </div>
  )
}

function TaskRow({
  orgId,
  eventId,
  task,
  portalForms,
  speakers,
  acceptedSessions,
  assignmentFilter,
  selectedAssignments,
  onAssignmentSelected,
}: {
  orgId: string
  eventId: string
  task: TaskListRow
  portalForms: Array<{ id: string; name: string; target: 'SPEAKER' | 'SUBMISSION' }>
  speakers: Array<{ id: string; name: string; status: string }>
  acceptedSessions: Array<{ id: string; title: string; speakerNames: string[] }>
  assignmentFilter: 'all' | 'incomplete' | 'complete'
  selectedAssignments: string[]
  onAssignmentSelected: (assignmentId: string, checked: boolean) => void
}) {
  const [editOpen, setEditOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const pct = task.total === 0 ? 0 : Math.round((task.completed / task.total) * 100)

  return (<>
    <TableRow>
      <TableCell>
        <button
          type="button"
          className="text-left font-medium hover:underline"
          onClick={() => setEditOpen(true)}
        >
          {task.title}
        </button>
        {task.formName ? (
          <div className="text-xs text-muted-foreground">Form: {task.formName}</div>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="px-1.5 capitalize">
          {task.target.toLowerCase()}
        </Badge>
        <div className="text-xs text-muted-foreground">{task.target === 'SPEAKER' ? 'One task per selected speaker' : 'Tied to an accepted session'}</div>
      </TableCell>
      <TableCell>
        <Badge variant="secondary" className="px-1.5 capitalize">
          {task.source.toLowerCase()}
        </Badge>
        <div className="text-xs text-muted-foreground">{task.source === 'MANUAL' ? 'Speaker marks it complete' : 'Linked form must be submitted'}</div>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {task.dueAt ? formatDateUTC(task.dueAt) : '—'}
      </TableCell>
      <TableCell>
        <div className="flex min-w-[8rem] flex-col gap-1">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {task.completed} of {task.total}
            </span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}>
            Edit
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={pending}
            aria-label="Delete task"
            onClick={() => {
              if (!window.confirm(`Delete task "${task.title}"? Assignments will be removed.`)) {
                return
              }
              setError(null)
              startTransition(async () => {
                try {
                  await deleteTaskDefinition({
                    orgId,
                    eventId,
                    taskDefinitionId: task.id,
                  })
                } catch (err) {
                  setError(toastActionError(err, 'Delete failed'))
                }
              })
            }}
          >
            <TrashIcon />
          </Button>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </TableCell>
      <TaskDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        orgId={orgId}
        eventId={eventId}
        portalForms={portalForms}
        speakers={speakers}
        acceptedSessions={acceptedSessions}
        mode="edit"
        task={task}
      />
    </TableRow>
    {task.assignments.filter((assignment) => assignmentFilter === 'all' || (assignmentFilter === 'complete' ? assignment.status === 'COMPLETED' : assignment.status !== 'COMPLETED')).map((assignment) => <TableRow key={assignment.id} className="bg-muted/20">
      <TableCell className="pl-8 text-sm"><label className="flex items-center gap-2"><input type="checkbox" aria-label={`Select ${task.title} for ${assignment.speakerName}`} checked={selectedAssignments.includes(assignment.id)} onChange={(event) => onAssignmentSelected(assignment.id, event.target.checked)} />{assignment.speakerName}</label></TableCell>
      <TableCell colSpan={2} className="text-xs text-muted-foreground">{assignment.sessionTitle ?? 'Speaker task'}</TableCell>
      <TableCell><Input aria-label={`Due date for ${assignment.speakerName}`} type="date" disabled={pending} defaultValue={assignment.dueAt ? new Date(assignment.dueAt).toISOString().slice(0, 10) : ''} onBlur={(event) => { const dueAt = event.target.value ? Date.parse(`${event.target.value}T23:59:59Z`) : null; startTransition(async () => { try { await updateTaskAssignmentDue({ orgId, eventId, assignmentId: assignment.id, dueAt }) } catch (error) { setError(toastActionError(error, 'Could not update the due date')) } }) }} /></TableCell>
      <TableCell><Badge variant={assignment.status === 'COMPLETED' ? 'success' : 'secondary'}>{assignment.status.toLowerCase().replace('_', ' ')}</Badge></TableCell>
      <TableCell><Button size="sm" variant="ghost" loading={pending} disabled={assignment.status === 'COMPLETED'} onClick={() => startTransition(async () => { try { const result = await remindTaskAssignments({ orgId, eventId, assignmentIds: [assignment.id] }); toast.success(`Queued ${result.queued} task reminder`) } catch (error) { setError(toastActionError(error, 'Could not send the reminder')) } })}>{assignment.status === 'COMPLETED' ? 'Complete' : 'Remind'}</Button></TableCell>
    </TableRow>)}
  </>)
}

function TaskDialog({
  open,
  onOpenChange,
  orgId,
  eventId,
  portalForms,
  speakers,
  acceptedSessions,
  mode,
  task,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  eventId: string
  portalForms: Array<{ id: string; name: string; target: 'SPEAKER' | 'SUBMISSION' }>
  speakers: Array<{ id: string; name: string; status: string }>
  acceptedSessions: Array<{ id: string; title: string; speakerNames: string[] }>
  mode: 'create' | 'edit'
  task?: TaskListRow
}) {
  const [title, setTitle] = useState(task?.title ?? '')
  const [target, setTarget] = useState<'SPEAKER' | 'SUBMISSION'>(task?.target ?? 'SPEAKER')
  const [source, setSource] = useState<'MANUAL' | 'FORM'>(task?.source ?? 'MANUAL')
  const [formId, setFormId] = useState(task?.formId ?? '')
  const [instructions, setInstructions] = useState(task?.instructionsHtml ?? '')
  const [dueDate, setDueDate] = useState(
    task?.dueAt ? new Date(task.dueAt).toISOString().slice(0, 10) : '',
  )
  const [assignmentPolicy, setAssignmentPolicy] = useState<'SELECTED' | 'ALL_ACCEPTED'>(task?.assignmentPolicy ?? 'SELECTED')
  const [speakerIds, setSpeakerIds] = useState<string[]>([])
  const [sessionIds, setSessionIds] = useState<string[]>([])
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const formsForTarget = portalForms.filter((form) => form.target === target)

  // Reset local state when opening for create or switching task.
  function handleOpenChange(next: boolean) {
    if (next) {
      setTitle(task?.title ?? '')
      setTarget(task?.target ?? 'SPEAKER')
      setSource(task?.source ?? 'MANUAL')
      setFormId(task?.formId ?? '')
      setInstructions(task?.instructionsHtml ?? '')
      setDueDate(task?.dueAt ? new Date(task.dueAt).toISOString().slice(0, 10) : '')
      setAssignmentPolicy(task?.assignmentPolicy ?? 'SELECTED')
      setError(null)
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Add task' : 'Edit task'}</DialogTitle>
          <DialogDescription>
            MANUAL tasks are checkboxes in the portal. FORM tasks complete when the linked portal
            form is submitted.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ErrorBoundary
            below
            fallback={
              <div className="text-sm text-destructive">
                <ErrorBoundary.ErrorMessage />
              </div>
            }
          >
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                setError(null)
                const dueAt = dueDate
                  ? Date.parse(`${dueDate}T23:59:59Z`)
                  : null
                startTransition(async () => {
                  try {
                    if (mode === 'create') {
                      await createTaskDefinition({
                        orgId,
                        eventId,
                        title: title.trim(),
                        target,
                        source,
                        formId: source === 'FORM' ? formId || null : null,
                        instructionsHtml: instructions.trim() || undefined,
                        dueAt,
                        assignmentPolicy,
                        speakerIds,
                        sessionIds,
                      })
                    } else if (task) {
                      await updateTaskDefinition({
                        orgId,
                        eventId,
                        taskDefinitionId: task.id,
                        title: title.trim(),
                        target,
                        source,
                        formId: source === 'FORM' ? formId || null : null,
                        instructionsHtml: instructions.trim() || null,
                        dueAt,
                      })
                    }
                    onOpenChange(false)
                  } catch (err) {
                    setError(toastActionError(err, 'Save failed'))
                  }
                })
              }}
            >
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Title
                <Input
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Complete speaker profile"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Target
                  <NativeSelect
                    disabled={mode === 'edit'}
                    value={target}
                    onChange={(e) => {
                      const next = e.target.value === 'SUBMISSION' ? 'SUBMISSION' : 'SPEAKER'
                      setTarget(next)
                      setFormId('')
                    }}
                  >
                    <option value="SPEAKER">Speaker</option>
                    <option value="SUBMISSION">Submission</option>
                  </NativeSelect>
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Source
                  <NativeSelect
                    disabled={mode === 'edit'}
                    value={source}
                    onChange={(e) => setSource(e.target.value === 'FORM' ? 'FORM' : 'MANUAL')}
                  >
                    <option value="MANUAL">Manual</option>
                    <option value="FORM">Form</option>
                  </NativeSelect>
                </label>
              </div>
              {mode === 'create' ? <>
                <label className="flex flex-col gap-1.5 text-sm font-medium">Assignment policy<NativeSelect value={assignmentPolicy} onChange={(event) => setAssignmentPolicy(event.target.value === 'ALL_ACCEPTED' ? 'ALL_ACCEPTED' : 'SELECTED')}><option value="SELECTED">Selected only</option><option value="ALL_ACCEPTED">All accepted, including future</option></NativeSelect><span className="font-normal text-muted-foreground">{assignmentPolicy === 'SELECTED' ? 'Creates assignments only for the people or accepted sessions selected below.' : 'Assigns current accepted participants now and future accepted participants automatically.'}</span></label>
                {assignmentPolicy === 'SELECTED' ? <div className="grid max-h-48 gap-3 overflow-auto rounded-md border border-border p-3 sm:grid-cols-2">
                  <fieldset className="flex flex-col gap-2"><legend className="text-sm font-medium">Speakers</legend>{speakers.map((speaker) => <label key={speaker.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={speakerIds.includes(speaker.id)} onChange={(event) => setSpeakerIds(event.target.checked ? [...speakerIds, speaker.id] : speakerIds.filter((id) => id !== speaker.id))} />{speaker.name}</label>)}</fieldset>
                  <fieldset className="flex flex-col gap-2"><legend className="text-sm font-medium">Accepted sessions</legend>{acceptedSessions.map((session) => <label key={session.id} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={sessionIds.includes(session.id)} onChange={(event) => setSessionIds(event.target.checked ? [...sessionIds, session.id] : sessionIds.filter((id) => id !== session.id))} /><span>{session.title}<span className="block text-xs text-muted-foreground">{session.speakerNames.join(', ')}</span></span></label>)}</fieldset>
                </div> : <p className="text-xs text-muted-foreground">Current accepted participants are assigned now. Future accepted sessions are assigned automatically.</p>}
              </> : null}
              {source === 'FORM' ? (
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Portal form
                  <NativeSelect
                    required
                    value={formId}
                    onChange={(e) => setFormId(e.target.value)}
                  >
                    <option value="">Select a form…</option>
                    {formsForTarget.map((form) => (
                      <option key={form.id} value={form.id}>
                        {form.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              ) : null}
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Definition due date (optional)
                <Input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
                <span className="font-normal text-muted-foreground">Used for new assignments. Changing it later does not replace existing row due dates; edit a row to override that assignment.</span>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Instructions (optional)
                <Textarea
                  rows={3}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </label>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
                </Button>
              </div>
            </form>
          </ErrorBoundary>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}
