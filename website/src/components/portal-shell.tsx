// Speaker portal shell + pages ('use client'). Same-origin portal at
// /portal/:eventSlug/* — pill nav (Home · Submissions · Profile · Tasks),
// no admin sidebar. Back to Admin Mode when the user is an org member.

'use client'

import * as React from 'react'
import {
  CheckCircle2Icon,
  CircleIcon,
  ClipboardListIcon,
  ExternalLinkIcon,
  FileTextIcon,
  LogOutIcon,
  UserIcon,
} from 'lucide-react'
import { ErrorBoundary, Link, router, useLoaderData } from 'spiceflow/react'
import {
  addTaskComment,
  completeManualTaskAssignment,
  savePortalProfile,
  savePortalSubmission,
  submitPortalFormTask,
  withdrawPortalSubmission,
} from '../actions.tsx'
import type { FormSubmission, ValuesRecord } from '../forms/collect-fields.ts'
import {
  countOpenAssignments,
  filterPortalAssignments,
  PORTAL_TASKS_TABS,
  speakerDisplayImage,
  type PortalTasksTab,
} from '../lib/portal.ts'
import { cn, formatDateRange, formatDateTimeUTC } from '../lib/utils.ts'
import { OpenSessionLogo } from './auth-page.tsx'
import { PublicFormWizard, SubmittedSuccess } from './public-form-wizard.tsx'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import { Badge, EmptyState, Textarea } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import { SessionStatusBadge } from './abstracts-page.tsx'
import { toast, toastActionError } from './ui/toast.tsx'

type PortalShellData = {
  portalMissing: boolean
  event: {
    id: string
    orgId: string
    slug: string
    name: string
    startsAt: number
    endsAt: number
    timezone: string
  } | null
  speaker: {
    id: string
    firstName: string
    lastName: string
    email: string
    companyName: string | null
    headshotFileId: string | null
    avatarUrl: string | null
  } | null
  adminOrgPath: string | null
  userEmail: string
  userName: string
  submissions: Array<{
    id: string
    title: string | null
    status: Parameters<typeof SessionStatusBadge>[0]['status']
    trackName: string | null
    formatName: string | null
  }>
  assignments: Array<{
    id: string
    speakerId: string
    sessionId: string | null
    status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'
    target: 'SPEAKER' | 'SUBMISSION'
    source: 'MANUAL' | 'FORM'
    formId: string | null
    title: string
    sessionTitle: string | null
    dueAt: number | null
  }>
  openCfp: { slug: string; name: string } | null
}

function usePortalShell(): PortalShellData {
  return useLoaderData('/portal/:eventSlug/*')
}

const navItems = [
  { segment: '', label: 'Home' },
  { segment: 'submissions', label: 'Submissions' },
  { segment: 'profile', label: 'Profile' },
  { segment: 'tasks', label: 'Tasks' },
] as const

function portalPath(
  eventSlug: string,
  segment: '' | 'submissions' | 'profile' | 'tasks' | `submissions/${string}` | `tasks/${string}` = '',
) {
  if (segment.startsWith('submissions/')) {
    return router.href('/portal/:eventSlug/submissions/:sessionId', {
      eventSlug,
      sessionId: segment.slice('submissions/'.length),
    })
  }
  if (segment.startsWith('tasks/')) {
    return router.href('/portal/:eventSlug/tasks/:assignmentId', {
      eventSlug,
      assignmentId: segment.slice('tasks/'.length),
    })
  }
  if (segment === 'submissions') return router.href('/portal/:eventSlug/submissions', { eventSlug })
  if (segment === 'profile') return router.href('/portal/:eventSlug/profile', { eventSlug })
  if (segment === 'tasks') return router.href(`/portal/${eventSlug}/tasks`)
  return router.href('/portal/:eventSlug', { eventSlug })
}

export function PortalShell({
  active,
  children,
}: {
  active: 'home' | 'submissions' | 'profile' | 'tasks'
  children: React.ReactNode
}) {
  const data = usePortalShell()
  if (data.portalMissing || !data.event) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <EmptyState
          icon={<FileTextIcon className="size-5 text-muted-foreground" />}
          title="Event not found"
          description="This speaker portal link is invalid or the event was removed."
        />
      </main>
    )
  }
  const { event, userEmail, adminOrgPath } = data

  const signOut = async () => {
    await fetch('/api/auth/sign-out', { method: 'POST' })
    window.location.href = '/'
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-[996px] flex-col gap-4 px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <OpenSessionLogo imageClassName="h-7" />
              <div className="flex flex-col">
                <span className="text-sm font-semibold tracking-tight">{event.name}</span>
                <span className="text-xs text-muted-foreground">
                  {formatDateRange({ startMs: event.startsAt, endMs: event.endsAt, timezone: event.timezone })}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {adminOrgPath ? (
                <Button variant="outline" size="sm" render={<Link href={router.href('/org/:orgId/e/:eventId', { orgId: event.orgId, eventId: event.id })} />}>
                  Back to Admin Mode
                  <ExternalLinkIcon data-icon="inline-end" />
                </Button>
              ) : null}
              <span className="text-xs text-muted-foreground">{userEmail}</span>
              <Button variant="ghost" size="sm" onClick={signOut}>
                <LogOutIcon data-icon="inline-start" />
                Sign out
              </Button>
            </div>
          </div>
          <nav className="flex flex-wrap gap-1">
            {navItems.map((item) => {
              const isActive =
                (item.segment === '' && active === 'home')
                || (item.segment === 'submissions' && active === 'submissions')
                || (item.segment === 'profile' && active === 'profile')
                || (item.segment === 'tasks' && active === 'tasks')
              return (
                <Link
                  key={item.label}
                  href={portalPath(event.slug, item.segment)}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-sm no-underline transition-colors',
                    isActive
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[996px] px-4 py-8 sm:px-6">
        <ErrorBoundary
          below
          fallback={<ErrorBoundary.ErrorMessage className="whitespace-pre-wrap text-sm text-destructive" />}
        >
          {children}
        </ErrorBoundary>
      </main>
    </div>
  )
}

export function PortalHomePage() {
  const data = usePortalShell()
  if (data.portalMissing || !data.event) {
    return (
      <PortalShell active="home">
        <EmptyState
          icon={<FileTextIcon className="size-5 text-muted-foreground" />}
          title="Event not found"
          description="This speaker portal link is invalid."
        />
      </PortalShell>
    )
  }
  if (!data.speaker) {
    return (
      <PortalShell active="home">
        <EmptyState
          icon={<FileTextIcon className="size-5 text-muted-foreground" />}
          title="No speaker profile yet"
          description="Submit a talk through the event CFP, or wait until an organizer adds you as a co-speaker. Your verified account email must match."
        >
          {data.openCfp ? (
            <Button render={<Link href={router.href('/submit/:eventSlug/:formSlug', { eventSlug: data.event.slug, formSlug: data.openCfp.slug })} />}>
              Submit a talk
            </Button>
          ) : null}
        </EmptyState>
      </PortalShell>
    )
  }
  const { event, speaker, submissions, assignments } = data
  const openTasks = countOpenAssignments(assignments.map((row) => ({ status: row.status })))
  const image = speakerDisplayImage(speaker)
  const orderedAssignments = [...assignments].sort((a, b) => {
    const statusOrder = Number(a.status === 'COMPLETED') - Number(b.status === 'COMPLETED')
    if (statusOrder !== 0) return statusOrder
    return (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)
  })
  const nextTask = orderedAssignments.find((row) => row.status !== 'COMPLETED')

  return (
    <PortalShell active="home">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Speaker portal</h1>
          <p className="text-sm text-muted-foreground">
            Manage your submissions, profile, and onboarding tasks for
            {' '}
            {event.name}
            .
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <Frame className="flex flex-col gap-4 p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-medium">My submissions</h2>
              <Button
                variant="outline"
                size="sm"
                render={<Link href={portalPath(event.slug, 'submissions')} />}
              >
                View all
              </Button>
            </div>
            {submissions.length === 0 ? (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-muted-foreground">No submissions yet.</p>
                {data.openCfp ? (
                  <Button size="sm" render={<Link href={router.href('/submit/:eventSlug/:formSlug', { eventSlug: event.slug, formSlug: data.openCfp.slug })} />}>
                    Submit a talk
                  </Button>
                ) : null}
              </div>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {submissions.slice(0, 5).map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-3 py-3">
                    <Link
                      href={portalPath(event.slug, `submissions/${row.id}`)}
                      className="min-w-0 truncate text-sm font-medium no-underline hover:underline"
                    >
                      {row.title || 'Untitled draft'}
                    </Link>
                    <SessionStatusBadge status={row.status} />
                  </li>
                ))}
              </ul>
            )}
          </Frame>

          <Frame className="flex flex-col gap-4 p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-medium">My profile</h2>
              <Button
                variant="outline"
                size="sm"
                render={<Link href={portalPath(event.slug, 'profile')} />}
              >
                Edit
              </Button>
            </div>
            <div className="flex items-center gap-4">
              {image ? (
                <img src={image} alt="" className="size-14 rounded-full object-cover" />
              ) : (
                <div className="flex size-14 items-center justify-center rounded-full bg-muted text-sm font-medium">
                  {speaker.firstName.slice(0, 1)}
                  {speaker.lastName.slice(0, 1)}
                </div>
              )}
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">
                  {speaker.firstName}
                  {' '}
                  {speaker.lastName}
                </span>
                <span className="truncate text-sm text-muted-foreground">{speaker.email}</span>
                {speaker.companyName ? (
                  <span className="text-sm text-muted-foreground">{speaker.companyName}</span>
                ) : null}
              </div>
            </div>
          </Frame>
        </div>

        <Frame className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-medium">Tasks</h2>
            <Badge variant={openTasks > 0 ? 'warning' : 'success'} className="px-1.5">
              {openTasks}
              {' '}
              open
            </Badge>
          </div>
          {nextTask ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Next incomplete task</span>
                <Link href={portalPath(event.slug, `tasks/${nextTask.id}`)} className="font-medium no-underline hover:underline">{nextTask.title}</Link>
                <span className="text-sm text-muted-foreground">{nextTask.dueAt ? `Due ${formatDateTimeUTC(nextTask.dueAt)}` : 'No due date'} · {nextTask.source === 'MANUAL' ? 'Mark complete' : 'Submit and complete'}</span>
              </div>
              <Button render={<Link href={portalPath(event.slug, `tasks/${nextTask.id}`)} />}>Continue</Button>
            </div>
          ) : null}
          {assignments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tasks assigned yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {orderedAssignments.slice(0, 6).map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 py-3">
                  <Link
                    href={portalPath(event.slug, `tasks/${row.id}`)}
                    className="text-sm font-medium no-underline hover:underline"
                  >
                    {row.title}
                  </Link>
                  <TaskStatusIcon status={row.status} />
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="outline"
            className="self-start"
            render={<Link href={portalPath(event.slug, 'tasks')} />}
          >
            All tasks
          </Button>
        </Frame>
      </div>
    </PortalShell>
  )
}

export function PortalSubmissionsPage() {
  const data = usePortalShell()
  if (data.portalMissing || !data.event) {
    return (
      <PortalShell active="submissions">
        <EmptyState
          icon={<FileTextIcon className="size-5 text-muted-foreground" />}
          title="Event not found"
          description="This speaker portal link is invalid."
        />
      </PortalShell>
    )
  }
  const { event, submissions } = data
  return (
    <PortalShell active="submissions">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Submissions</h1>
          <p className="text-sm text-muted-foreground">
            Sessions where you are the submitter or a listed speaker.
          </p>
        </div>
        {submissions.length === 0 ? (
          <EmptyState
            icon={<FileTextIcon className="size-5 text-muted-foreground" />}
            title="No submissions"
            description="When you submit a CFP form, it will show up here."
          >
            {data.openCfp ? (
              <Button render={<Link href={router.href('/submit/:eventSlug/:formSlug', { eventSlug: event.slug, formSlug: data.openCfp.slug })} />}>
                Submit a talk
              </Button>
            ) : null}
          </EmptyState>
        ) : (
          <Frame>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Track</TableHead>
                  <TableHead>Format</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {submissions.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Link
                        href={portalPath(event.slug, `submissions/${row.id}`)}
                        className="font-medium no-underline hover:underline"
                      >
                        {row.title || 'Untitled draft'}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{row.trackName ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{row.formatName ?? '—'}</TableCell>
                    <TableCell><SessionStatusBadge status={row.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Frame>
        )}
      </div>
    </PortalShell>
  )
}

type SubmissionDetailData = {
  detail: {
    id: string
    title: string | null
    description: string | null
    status: Parameters<typeof SessionStatusBadge>[0]['status']
    trackName: string | null
    formatName: string | null
    speakers: Array<{ id: string; firstName: string; lastName: string; email: string; roleLabel: string }>
  } | null
  draft: {
    mdxSource: string
    values: ValuesRecord
    participants: ValuesRecord[]
    formId: string
    responseId: string
  } | null
  scope: { tracks: Array<{ value: string; label: string }>; formats: Array<{ value: string; label: string }> }
  canEdit: boolean
  editBlockMessage: string | null
  canWithdraw: boolean
}

export function PortalSubmissionDetailPage() {
  const shell = usePortalShell()
  const {
    detail,
    draft,
    scope,
    canEdit,
    editBlockMessage,
    canWithdraw,
  } = useLoaderData('/portal/:eventSlug/submissions/:sessionId') as SubmissionDetailData
  const [error, setError] = React.useState<string | null>(null)
  const [withdrawing, setWithdrawing] = React.useState(false)
  const [editing, setEditing] = React.useState(false)

  if (shell.portalMissing || !shell.event) {
    return (
      <PortalShell active="submissions">
        <EmptyState
          icon={<FileTextIcon className="size-5 text-muted-foreground" />}
          title="Event not found"
          description="This speaker portal link is invalid."
        />
      </PortalShell>
    )
  }
  const event = shell.event

  if (!detail) {
    return (
      <PortalShell active="submissions">
        <EmptyState
          icon={<FileTextIcon className="size-5 text-muted-foreground" />}
          title="Submission not found"
          description="This session is missing or you do not have access."
        />
      </PortalShell>
    )
  }

  const uploadFile = makeUpload({ eventId: event.id, formResponseId: draft?.responseId })

  const withdraw = async () => {
    setWithdrawing(true)
    setError(null)
    try {
      await withdrawPortalSubmission({ eventId: event.id, sessionId: detail.id })
    } catch (cause) {
      setError(toastActionError(cause, 'Could not withdraw'))
    } finally {
      setWithdrawing(false)
    }
  }

  const save = async (submission: FormSubmission) => {
    setError(null)
    await savePortalSubmission({
      eventId: event.id,
      sessionId: detail.id,
      submission,
      submit: true,
    })
  }

  return (
    <PortalShell active="submissions">
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Link
              href={portalPath(event.slug, 'submissions')}
              className="text-sm text-muted-foreground no-underline hover:underline"
            >
              ← Submissions
            </Link>
            <h1 className="text-xl font-semibold tracking-tight text-balance">
              {detail.title || 'Untitled draft'}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <SessionStatusBadge status={detail.status} />
              {detail.trackName ? <Badge variant="outline" className="px-1.5">{detail.trackName}</Badge> : null}
              {detail.formatName ? <Badge variant="outline" className="px-1.5">{detail.formatName}</Badge> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {canEdit && draft && !editing ? (
              <Button variant="outline" onClick={() => setEditing(true)}>Edit</Button>
            ) : null}
            {canWithdraw ? (
              <Button variant="destructive" loading={withdrawing} onClick={withdraw}>
                Withdraw
              </Button>
            ) : null}
          </div>
        </div>

        {error ? <p className="whitespace-pre-wrap text-sm text-destructive">{error}</p> : null}
        {editBlockMessage ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-muted-foreground">
            {editBlockMessage} Contact the event team if you need to make a change.
          </p>
        ) : null}

        {editing && draft ? (
          <PublicFormWizard
            mdxSource={draft.mdxSource}
            scope={scope}
            initialValues={draft.values}
            initialParticipants={draft.participants}
            authenticated
            accountEmail={shell.userEmail}
            accountName={shell.userName}
            signInHref="/"
            uploadFile={uploadFile}
            onSubmit={save}
            submitLabel="Save changes"
          />
        ) : (
          <Frame className="flex flex-col gap-4 p-5">
            {detail.description ? (
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-muted-foreground">Abstract</span>
                <p className="whitespace-pre-wrap text-sm">{detail.description}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No abstract on file.</p>
            )}
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-muted-foreground">Speakers</span>
              <ul className="flex flex-col gap-1 text-sm">
                {detail.speakers.map((person) => (
                  <li key={person.id}>
                    {person.firstName}
                    {' '}
                     {person.lastName}
                    <Badge variant="secondary" className="ml-2 px-1.5">{person.roleLabel}</Badge>
                    <span className="text-muted-foreground">
                      {' '}
                      ·
                      {person.email}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </Frame>
        )}
      </div>
    </PortalShell>
  )
}

type ProfileLoaderData = {
  profileForm: { id: string; name: string } | null
  profileMdx: string | null
  initialValues: ValuesRecord
}

export function PortalProfilePage() {
  const shell = usePortalShell()
  const { profileForm, profileMdx, initialValues } =
    useLoaderData('/portal/:eventSlug/profile') as ProfileLoaderData
  const [done, setDone] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  if (shell.portalMissing || !shell.event || !shell.speaker) {
    return (
      <PortalShell active="profile">
        <EmptyState
          icon={<UserIcon className="size-5 text-muted-foreground" />}
          title="Event not found"
          description="This speaker portal link is invalid."
        />
      </PortalShell>
    )
  }
  const { event, speaker, userEmail, userName } = shell
  const uploadFile = makeUpload({ eventId: event.id, formId: profileForm?.id })
  const profileImage = speakerDisplayImage(speaker)

  if (!profileForm || !profileMdx) {
    return (
      <PortalShell active="profile">
        <EmptyState
          icon={<UserIcon className="size-5 text-muted-foreground" />}
          title="No profile form"
          description="Organizers have not published a speaker profile form for this event."
        />
      </PortalShell>
    )
  }

  if (done) {
    return (
      <PortalShell active="profile">
        <div className="flex flex-col items-center gap-4">
          {profileImage ? (
            <img
              src={profileImage}
              alt={`${speaker.firstName} ${speaker.lastName} saved headshot`}
              className="size-24 rounded-full object-cover"
            />
          ) : null}
          <SubmittedSuccess
            title={`${speaker.firstName} ${speaker.lastName}`}
            footer={(
              <Button variant="outline" render={<Link href={portalPath(event.slug)} />}>
                Back to home
              </Button>
            )}
          />
        </div>
      </PortalShell>
    )
  }

  return (
    <PortalShell active="profile">
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-4">
          {profileImage ? (
            <img src={profileImage} alt={`${speaker.firstName} ${speaker.lastName} headshot`} className="size-20 rounded-full object-cover" />
          ) : null}
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
            <p className="text-sm text-muted-foreground">
              Update the details organizers show on the schedule and speaker pages.
            </p>
          </div>
        </div>
        {error ? <p className="whitespace-pre-wrap text-sm text-destructive">{error}</p> : null}
        <PublicFormWizard
          mdxSource={profileMdx}
          initialValues={initialValues}
          authenticated
          accountEmail={userEmail}
          accountName={userName}
          signInHref={router.href('/')}
          uploadFile={uploadFile}
          submitLabel="Save profile"
          onSubmit={async (submission) => {
            setError(null)
            try {
              await savePortalProfile({
                eventId: event.id,
                formId: profileForm.id,
                submission,
              })
              setDone(true)
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'Could not save profile')
              throw cause
            }
          }}
        />
      </div>
    </PortalShell>
  )
}

export function PortalTasksPage({ tab }: { tab: PortalTasksTab }) {
  const data = usePortalShell()
  if (data.portalMissing || !data.event) {
    return (
      <PortalShell active="tasks">
        <EmptyState
          icon={<ClipboardListIcon className="size-5 text-muted-foreground" />}
          title="Event not found"
          description="This speaker portal link is invalid."
        />
      </PortalShell>
    )
  }
  const { event, assignments } = data
  const portalRows = assignments.map((row) => ({
    id: row.id,
    speakerId: row.speakerId,
    sessionId: row.sessionId,
    status: row.status,
    target: row.target,
    source: row.source,
    formId: row.formId,
  }))
  const visibleIds = new Set(filterPortalAssignments(portalRows, tab).map((row) => row.id))
  const visible = assignments.filter((row) => visibleIds.has(row.id)).sort((a, b) => {
    const statusOrder = Number(a.status === 'COMPLETED') - Number(b.status === 'COMPLETED')
    if (statusOrder !== 0) return statusOrder
    return (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)
  })
  const nextTaskId = visible.find((row) => row.status !== 'COMPLETED')?.id

  return (
    <PortalShell active="tasks">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Tasks</h1>
          <p className="text-sm text-muted-foreground">Start with the first incomplete task. Manual tasks use Mark complete; form tasks use Submit and complete.</p>
        </div>
        <div className="flex items-center gap-1 border-b border-border">
          {PORTAL_TASKS_TABS.map((item) => (
            <Link
              key={item.value}
              href={router.href(`/portal/${event.slug}/tasks`, { tab: item.value })}
              className={cn(
                'relative -mb-px px-2.5 py-2 text-sm no-underline transition-colors',
                item.value === tab ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
              {item.value === tab ? (
                <span className="absolute inset-x-2.5 bottom-0 h-0.5 bg-foreground" />
              ) : null}
            </Link>
          ))}
        </div>
        {visible.length === 0 ? (
          <EmptyState
            icon={<ClipboardListIcon className="size-5 text-muted-foreground" />}
            title="No tasks"
            description="Nothing in this tab right now."
          />
        ) : (
          <Frame>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => (
                  <TableRow key={row.id} className={row.id === nextTaskId ? 'bg-muted/40' : undefined}>
                    <TableCell>
                      <Link
                        href={portalPath(event.slug, `tasks/${row.id}`)}
                        className="font-medium no-underline hover:underline"
                      >
                        {row.title}
                        {row.id === nextTaskId ? <Badge variant="warning" className="ml-2 px-1.5">Next</Badge> : null}
                      </Link>
                      {row.sessionTitle ? (
                        <div className="text-xs text-muted-foreground">{row.sessionTitle}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground"><span className="capitalize">{row.target.toLowerCase()}</span><span className="block text-xs">{row.source === 'MANUAL' ? 'Mark complete' : 'Submit and complete'}</span></TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.dueAt ? formatDateTimeUTC(row.dueAt) : '—'}
                    </TableCell>
                    <TableCell><TaskStatusIcon status={row.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Frame>
        )}
      </div>
    </PortalShell>
  )
}

type TaskDetailData = {
  assignment: {
    id: string
    title: string
    instructionsHtml: string | null
    source: 'MANUAL' | 'FORM'
    status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'
    sessionTitle: string | null
    dueAt: number | null
  } | null
  formMdx: string | null
  scope: { tracks: Array<{ value: string; label: string }>; formats: Array<{ value: string; label: string }> }
  initialValues: ValuesRecord
  initialParticipants: ValuesRecord[]
  deliverables: Array<{
    fieldName: string
    currentFileId: string
    versions: Array<{ id: string; fileName: string; sizeBytes: number; createdAt: number }>
    comments: Array<{ id: string; body: string; createdAt: number; authorName: string }>
  }>
}

export function PortalTaskDetailPage() {
  const shell = usePortalShell()
  const { assignment, formMdx, scope, initialValues, initialParticipants, deliverables } =
    useLoaderData('/portal/:eventSlug/tasks/:assignmentId')
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const [uploaded, setUploaded] = React.useState<Record<string, TaskDetailData['deliverables'][number]['versions']>>({})

  if (shell.portalMissing || !shell.event) {
    return (
      <PortalShell active="tasks">
        <EmptyState
          icon={<ClipboardListIcon className="size-5 text-muted-foreground" />}
          title="Event not found"
          description="This speaker portal link is invalid."
        />
      </PortalShell>
    )
  }
  const { event, userEmail, userName } = shell

  if (!assignment) {
    return (
      <PortalShell active="tasks">
        <EmptyState
          icon={<ClipboardListIcon className="size-5 text-muted-foreground" />}
          title="Task not found"
          description="This assignment is missing or not yours."
        />
      </PortalShell>
    )
  }

  const uploadFile = makeUpload({
    eventId: event.id,
    taskAssignmentId: assignment.id,
    onUploaded(fieldName, versions) {
      setUploaded((current) => ({ ...current, [fieldName]: versions }))
    },
  })
  const completed = done || assignment.status === 'COMPLETED'
  const visibleDeliverables = deliverables.map((slot) => ({ ...slot }))
  for (const [fieldName, versions] of Object.entries(uploaded)) {
    const existing = visibleDeliverables.find((slot) => slot.fieldName === fieldName)
    if (existing) existing.versions = versions
    else visibleDeliverables.push({ fieldName, currentFileId: versions[0]?.id ?? '', versions, comments: [] })
  }

  return (
    <PortalShell active="tasks">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Link
            href={portalPath(event.slug, 'tasks')}
            className="text-sm text-muted-foreground no-underline hover:underline"
          >
            ← Tasks
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">{assignment.title}</h1>
          {assignment.instructionsHtml ? (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {assignment.instructionsHtml}
            </p>
          ) : null}
          {assignment.sessionTitle ? (
            <p className="text-sm text-muted-foreground">
              Session:
              {' '}
              {assignment.sessionTitle}
            </p>
          ) : null}
          {assignment.dueAt ? (
            <p className="text-sm text-muted-foreground">Due: {formatDateTimeUTC(assignment.dueAt)}</p>
          ) : null}
        </div>
        {error ? <p className="whitespace-pre-wrap text-sm text-destructive">{error}</p> : null}

        <p className="border-y border-border py-3 text-sm text-muted-foreground">
          {assignment.source === 'MANUAL'
            ? 'This is a manual task. Use Mark complete when you have finished the requested work.'
            : 'This is a form task. Use Submit and complete. A replacement upload keeps the task complete and preserves every earlier file version.'}
        </p>

        {completed ? (
          <Frame className="flex flex-col gap-1 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCircle2Icon className="size-4" />
              Task complete
            </div>
            {assignment.source === 'FORM' ? (
              <p className="text-sm text-muted-foreground">
                You can upload and submit a replacement below. The task will stay complete and earlier file versions will remain available.
              </p>
            ) : null}
          </Frame>
        ) : null}
        {assignment.source === 'MANUAL' ? (!completed ? (
          <Button
            className="self-start"
            loading={pending}
            onClick={() => startTransition(async () => {
              setError(null)
              try {
                await completeManualTaskAssignment({
                  eventId: event.id,
                  assignmentId: assignment.id,
                })
                setDone(true)
              } catch (cause) {
                setError(toastActionError(cause, 'Could not complete task'))
              }
            })}
          >
            Mark complete
          </Button>
        ) : null) : formMdx ? (
          <PublicFormWizard
            mdxSource={formMdx}
            scope={scope}
            initialValues={initialValues}
            initialParticipants={initialParticipants}
            authenticated
            accountEmail={userEmail}
            accountName={userName}
            signInHref={router.href('/')}
            uploadFile={uploadFile}
            submitLabel={completed ? 'Submit replacement' : 'Submit and complete'}
            onSubmit={async (submission) => {
              setError(null)
              try {
                await submitPortalFormTask({
                  eventId: event.id,
                  assignmentId: assignment.id,
                  submission,
                })
                setDone(true)
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Could not submit task')
                throw cause
              }
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">This form task has no published form version.</p>
        )}
        <TaskDeliverables
          eventId={event.id}
          assignmentId={assignment.id}
          deliverables={visibleDeliverables}
        />
      </div>
    </PortalShell>
  )
}

function TaskStatusIcon({ status }: { status: string }) {
  if (status === 'COMPLETED') {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-success">
        <CheckCircle2Icon className="size-4" />
        Done
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
      <CircleIcon className="size-4" />
      {status === 'IN_PROGRESS' ? 'In progress' : 'Not started'}
    </span>
  )
}

function TaskDeliverables({ eventId, assignmentId, deliverables }: {
  eventId: string
  assignmentId: string
  deliverables: TaskDetailData['deliverables']
}) {
  if (deliverables.length === 0) return null
  return (
    <Frame className="flex flex-col gap-5 p-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">Uploaded files</h2>
        <p className="text-sm text-muted-foreground">Every upload stays available. The newest version is current.</p>
      </div>
      {deliverables.map((slot) => (
        <TaskDeliverableThread
          key={slot.fieldName}
          eventId={eventId}
          assignmentId={assignmentId}
          slot={slot}
        />
      ))}
    </Frame>
  )
}

function TaskDeliverableThread({ eventId, assignmentId, slot }: {
  eventId: string
  assignmentId: string
  slot: TaskDetailData['deliverables'][number]
}) {
  const [body, setBody] = React.useState('')
  const [pending, startTransition] = React.useTransition()
  return (
    <section className="grid gap-5 border-t border-border pt-4 first:border-0 first:pt-0 lg:grid-cols-2">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{slot.fieldName}</h3>
        {slot.versions.map((file, index) => (
          <div key={file.id} className="flex items-center justify-between gap-3 border-b border-border pb-2 last:border-0">
            <div className="min-w-0">
              <Link href={router.href('/files/:fileId', { fileId: file.id })} className="text-sm font-medium no-underline hover:underline">
                {file.fileName}
              </Link>
              <p className="text-xs text-muted-foreground">
                v{slot.versions.length - index} · {formatDateTimeUTC(file.createdAt)}
              </p>
            </div>
            <Badge variant={index === 0 ? 'success' : 'outline'}>{index === 0 ? 'Current' : 'Previous'}</Badge>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Comments</h3>
        {slot.comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No comments yet.</p>
        ) : slot.comments.map((comment) => (
          <div key={comment.id} className="flex flex-col gap-0.5 border-b border-border pb-2 last:border-0">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{comment.authorName}</span> · {formatDateTimeUTC(comment.createdAt)}
            </p>
            <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
          </div>
        ))}
        <Textarea
          aria-label={`Comment on ${slot.fieldName}`}
          rows={2}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add a note for the organizer"
        />
        <Button
          size="sm"
          className="self-start"
          disabled={pending || !body.trim()}
          onClick={() => startTransition(async () => {
            try {
              await addTaskComment({ eventId, assignmentId, fieldName: slot.fieldName, body })
              setBody('')
              toast.success('Comment added')
            } catch (error) {
              toastActionError(error, 'Could not add comment')
            }
          })}
        >
          {pending ? 'Adding...' : 'Add comment'}
        </Button>
      </div>
    </section>
  )
}

type UploadedVersion = { id: string; fileName: string; sizeBytes: number; createdAt: number }

function makeUpload({ eventId, taskAssignmentId, formResponseId, formId, onUploaded }: {
  eventId: string
  taskAssignmentId?: string
  formResponseId?: string
  formId?: string
  onUploaded?: (fieldName: string, versions: UploadedVersion[]) => void
}) {
  return async (file: File, fieldName: string) => {
    const body = new FormData()
    body.set('file', file)
    body.set('eventId', eventId)
    body.set('fieldName', fieldName)
    if (taskAssignmentId) {
      body.set('taskAssignmentId', taskAssignmentId)
    }
    if (formResponseId) body.set('formResponseId', formResponseId)
    if (formId) body.set('formId', formId)
    body.set(
      'kind',
      fieldName.includes('headshot') ? 'HEADSHOT'
        : fieldName.includes('slides') ? 'SLIDES'
          : file.type.startsWith('image/') ? 'IMAGE'
            : 'DOCUMENT',
    )
    const response = await fetch('/api/upload', { method: 'POST', body })
    const result: {
      fileId?: string
      error?: string
      message?: string
      versions?: UploadedVersion[]
    } = await response.json()
    if (!response.ok || !result.fileId) throw new Error(result.message ?? result.error ?? 'Upload failed')
    if (result.versions) onUploaded?.(fieldName, result.versions)
    return result.fileId
  }
}
