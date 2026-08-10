// Restricted reviewer portal. It only consumes /review loaders, so organizer
// membership, navigation, participants in blind rounds, and other reviews are absent.
'use client'

import { useState, useTransition } from 'react'
import { ArrowLeftIcon, CheckIcon, CircleIcon, ShieldAlertIcon } from 'lucide-react'
import { Link, router, useLoaderData } from 'spiceflow/react'
import { recuseEvaluationReview, saveEvaluationReview } from '../actions.tsx'
import { OpenSessionLogo } from './auth-page.tsx'
import { FormRenderer, type FormSubmission } from '../forms/form-renderer.tsx'
import { cn, formatDateTimeUTC } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { Frame, FramePanel } from './ui/frame.tsx'
import { Badge, EmptyState, Textarea } from './ui/primitives.tsx'
import { runAction } from './ui/toast.tsx'

type ReviewerTab = 'to-review' | 'my-reviews' | 'progress'

function ReviewerShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background px-4 py-6 sm:px-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex items-center justify-between border-b border-border pb-4">
          <OpenSessionLogo imageClassName="h-7" />
          <Badge variant="outline">Reviewer access</Badge>
        </header>
        {children}
      </div>
    </main>
  )
}

function roundAvailability(round: { status: string; opensAt: number | null; closesAt: number | null }) {
  const now = Date.now()
  if (round.status !== 'OPEN') return { open: false, label: round.status === 'CLOSED' ? 'Closed' : 'Not open', detail: `The organizer set this round to ${round.status.toLowerCase()}.` }
  if (round.opensAt != null && round.opensAt > now) return { open: false, label: 'Scheduled', detail: `Reviewing opens ${formatDateTimeUTC(round.opensAt)}.` }
  if (round.closesAt != null && round.closesAt <= now) return { open: false, label: 'Closed', detail: `The review window closed ${formatDateTimeUTC(round.closesAt)}.` }
  return { open: true, label: 'Open', detail: round.closesAt ? `Submit reviews before ${formatDateTimeUTC(round.closesAt)}.` : 'No closing date is set.' }
}

export function ReviewerDashboard({ tab }: { tab: ReviewerTab }) {
  const data = useLoaderData('/review/:formId')
  const tabs: Array<{ value: ReviewerTab; label: string }> = [
    { value: 'to-review', label: 'To Review' },
    { value: 'my-reviews', label: 'My Reviews' },
    { value: 'progress', label: 'Progress' },
  ]
  const rows = tab === 'to-review'
    ? data.assignments.filter((row) => row.state === 'ASSIGNED' || row.state === 'IN_PROGRESS')
    : data.assignments.filter((row) => row.state === 'COMPLETED' || row.state === 'RECUSED')
  const availability = roundAvailability(data.round)

  return <ReviewerShell>
    <div className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold tracking-tight">{data.round.name}</h1>
      <p className="text-sm text-muted-foreground">{data.event.name}</p>
    </div>
    <div className="flex flex-wrap items-start justify-between gap-3 border-y border-border py-3">
      <div className="flex flex-col gap-0.5"><span className="text-sm font-medium">Round status: {availability.label}</span><span className="text-sm text-muted-foreground">{availability.detail}</span></div>
      <div className="max-w-xl text-sm text-muted-foreground">{data.round.blind ? 'Blind review is on. Speaker names, profiles, and identity-related answers are hidden. Score the submission only from the content shown.' : 'Blind review is off. Speaker details are visible where the submission includes them.'}</div>
    </div>
    <nav className="flex items-center gap-1 border-b border-border">
      {tabs.map((item) => <Link
        key={item.value}
        href={router.href('/review/:formId', { formId: data.round.id, tab: item.value })}
        className={cn('relative -mb-px px-2.5 py-2 text-sm no-underline', item.value === tab ? 'font-medium text-foreground' : 'text-muted-foreground')}
      >{item.label}{item.value === tab ? <span className="absolute inset-x-2.5 bottom-0 h-0.5 bg-primary" /> : null}</Link>)}
    </nav>
    {tab === 'progress' ? <Progress assigned={data.progress.assigned} completed={data.progress.completed} recused={data.progress.recused} /> : (
      rows.length === 0 ? <EmptyState icon={<CheckIcon />} title={tab === 'to-review' ? 'All caught up' : 'No completed reviews'} description={tab === 'to-review' ? 'There are no outstanding assigned submissions.' : 'Submitted and recused reviews appear here.'} /> : (
        <div className="flex flex-col gap-3">{rows.map((row) => <AssignmentRow key={row.id} row={row} formId={data.round.id} />)}</div>
      )
    )}
  </ReviewerShell>
}

function AssignmentRow({ row, formId }: { row: any; formId: string }) {
  return <Frame><FramePanel className="flex flex-wrap items-center justify-between gap-3">
    <div className="flex min-w-0 items-start gap-3">
      {row.state === 'COMPLETED' ? <CheckIcon className="mt-0.5 size-4 text-success" /> : row.state === 'RECUSED' ? <ShieldAlertIcon className="mt-0.5 size-4 text-warning" /> : <CircleIcon className="mt-0.5 size-4 text-muted-foreground" />}
      <div className="flex min-w-0 flex-col gap-1">
        <Link href={router.href('/review/:formId/:reviewId', { formId, reviewId: row.id })} className="truncate font-medium text-foreground no-underline hover:underline">{row.session.title ?? 'Untitled'}</Link>
        <span className="text-sm text-muted-foreground">{[row.session.trackName, row.session.formatName].filter(Boolean).join(' · ') || 'No track or format'}</span>
      </div>
    </div>
    <Badge variant={row.state === 'COMPLETED' ? 'success' : row.state === 'RECUSED' ? 'warning' : 'secondary'}>{row.state.toLowerCase().replace('_', ' ')}</Badge>
  </FramePanel></Frame>
}

function Progress({ assigned, completed, recused }: { assigned: number; completed: number; recused: number }) {
  const actionable = Math.max(0, assigned - recused)
  const percent = actionable === 0 ? 100 : Math.round(completed / actionable * 100)
  return <Frame><FramePanel className="flex flex-col gap-4">
    <div className="flex flex-wrap gap-10">
      <Metric label="Assigned" value={assigned} />
      <Metric label="Completed" value={completed} />
      <Metric label="Recused" value={recused} />
      <Metric label="Progress" value={`${percent}%`} />
    </div>
    <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${percent}%` }} /></div>
  </FramePanel></Frame>
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return <div className="flex flex-col gap-0.5"><span className="text-2xl font-semibold tabular-nums">{value}</span><span className="text-sm text-muted-foreground">{label}</span></div>
}

export function ReviewerAssignmentPage() {
  const data = useLoaderData('/review/:formId/:reviewId')
  const row = data.assignment
  const [submission, setSubmission] = useState<FormSubmission>({ values: row.values, participants: [] })
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()
  const locked = row.state === 'COMPLETED' || row.state === 'RECUSED'
  const availability = roundAvailability(data.round)
  const remaining = Math.max(0, data.progress.assigned - data.progress.completed - data.progress.recused)

  return <ReviewerShell>
    <Link href={router.href('/review/:formId', { formId: data.round.id })} className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground no-underline"><ArrowLeftIcon className="size-4" />Review queue</Link>
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold tracking-tight text-balance">{row.session.title ?? 'Untitled'}</h1><Badge variant="secondary">{row.state.toLowerCase()}</Badge></div>
      <p className="text-sm text-muted-foreground">{[row.session.trackName, row.session.formatName].filter(Boolean).join(' · ')}</p>
    </div>
    <div className="flex flex-wrap items-start justify-between gap-3 border-y border-border py-3">
      <div className="flex flex-col gap-0.5"><span className="text-sm font-medium">Round status: {availability.label}</span><span className="text-sm text-muted-foreground">{availability.detail}</span></div>
      <div className="text-sm text-muted-foreground"><span className="font-medium text-foreground">{data.progress.completed} completed</span> · {remaining} remaining · {data.progress.assigned} assigned overall</div>
      <p className="w-full text-sm text-muted-foreground">{data.round.blind ? 'This is a blind review. Speaker identity and identity-related answers are not included on this page.' : 'This round is not blind. Participant details are shown below when available.'}</p>
    </div>
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-5">
        <Frame><FramePanel className="flex flex-col gap-3"><h2 className="text-sm font-medium">Abstract</h2><p className="whitespace-pre-wrap text-sm leading-relaxed">{row.session.description || 'No abstract provided.'}</p></FramePanel></Frame>
        {row.session.fieldValues.length > 0 ? <Frame><FramePanel className="flex flex-col gap-3"><h2 className="text-sm font-medium">Submission answers</h2><dl className="flex flex-col gap-3">{row.session.fieldValues.map((field: any) => <div key={`${field.name}:${field.value}`}><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{field.name}</dt><dd className="whitespace-pre-wrap text-sm">{field.value}</dd></div>)}</dl></FramePanel></Frame> : null}
        {!data.round.blind && row.session.participants.length > 0 ? <Frame><FramePanel className="flex flex-col gap-3"><h2 className="text-sm font-medium">Participants</h2>{row.session.participants.map((participant: any) => <div key={participant.email} className="text-sm"><div className="font-medium">{participant.firstName} {participant.lastName} · {participant.roleLabel}</div><div className="text-muted-foreground">{[participant.email, participant.companyName, participant.jobTitle].filter(Boolean).join(' · ')}</div></div>)}</FramePanel></Frame> : null}
      </div>
      <div className="flex flex-col gap-4">
        <Frame><FramePanel className="flex flex-col gap-4"><h2 className="text-sm font-medium">Scorecard</h2>
          {row.state === 'RECUSED' ? <p className="text-sm text-muted-foreground">Recused: {row.recusalReason}</p> : <>
            <FormRenderer mdxSource={row.mdxSource} initialValues={row.values} onChange={setSubmission} />
            {availability.open ? <div className="flex flex-wrap gap-2"><Button disabled={pending || locked} variant="outline" onClick={() => startTransition(async () => { await runAction(() => saveEvaluationReview({ reviewId: row.id, submission, submit: false }), { success: 'Draft saved' }) })}>Save draft</Button><Button disabled={pending || locked} onClick={() => startTransition(async () => { await runAction(() => saveEvaluationReview({ reviewId: row.id, submission, submit: true }), { success: 'Review submitted' }) })}>Submit review</Button></div> : <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">Saving and submitting are unavailable while this round is {availability.label.toLowerCase()}.</p>}
          </>}
        </FramePanel></Frame>
        {!locked ? <Frame><FramePanel className="flex flex-col gap-3"><h2 className="text-sm font-medium">Conflict of interest</h2><Textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why can you not review this submission?" /><Button variant="outline" disabled={pending || reason.trim().length < 3} onClick={() => startTransition(async () => { await runAction(() => recuseEvaluationReview({ reviewId: row.id, reason }), { success: 'You were recused from this submission' }) })}>Recuse from this review</Button></FramePanel></Frame> : null}
      </div>
    </div>
  </ReviewerShell>
}
