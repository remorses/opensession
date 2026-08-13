// Organizer evaluation workspace: rounds, reviewer pools, bulk assignments,
// progress/reminders, weighted results, and CSV export.
'use client'

import { useState, useTransition } from 'react'
import { CheckIcon, CopyIcon, DownloadIcon, PlusIcon, SendIcon, StarIcon } from 'lucide-react'
import { ErrorBoundary, Link, router, useLoaderData } from 'spiceflow/react'
import {
  assignEvaluationReviews,
  createForm,
  inviteEvaluationReviewer,
  remindEvaluationReviewers,
} from '../actions.tsx'
import { sortEvaluationResults, type EvaluationResult } from '../lib/reviews.ts'
import { cn, formatDateTimeUTC } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import { Badge, EmptyState, Input, NativeSelect } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import { runAction, toast, toastActionError } from './ui/toast.tsx'

export type EvaluationTab = 'rounds' | 'reviewers' | 'assignments' | 'progress' | 'results'

const tabs: Array<{ value: EvaluationTab; label: string }> = [
  { value: 'rounds', label: 'Rounds' },
  { value: 'reviewers', label: 'Reviewers' },
  { value: 'assignments', label: 'Assignments' },
  { value: 'progress', label: 'Progress' },
  { value: 'results', label: 'Results' },
]

const tabContext: Record<EvaluationTab, { title: string; description: string }> = {
  rounds: { title: 'Create evaluation rounds', description: 'Set the review window and privacy rules, then open each round scorecard to define its questions.' },
  reviewers: { title: 'Invite round reviewers', description: 'Reviewer access is scoped to one round. Invitees cannot open organizer pages or submissions that are not assigned to them.' },
  assignments: { title: 'Assign submissions', description: 'Choose an active reviewer first, then select submissions. Track and limit rules are applied when assignments are created.' },
  progress: { title: 'Monitor review work', description: 'See reviewer load and submission coverage. Reminders go only to selected reviewers with unfinished work.' },
  results: { title: 'Compare completed scorecards', description: 'Weighted scores and answers appear as reviewers submit. Incomplete and unassigned submissions stay visible.' },
}

export function EvaluationPage({ tab }: { tab: EvaluationTab }) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event, tracks } = useLoaderData('/org/:orgId/e/:eventId/*')
  const data = useLoaderData('/org/:orgId/e/:eventId/evaluation')
  const hasRound = data.rounds.length > 0
  const hasScorecard = data.rounds.some((round) => round.fields.length > 0)
  const hasReviewers = data.rounds.some((round) => round.reviewers.length > 0)
  const hasAssignments = data.rounds.some((round) => round.assignments.length > 0)
  const hasResults = data.rounds.some((round) => round.results.some((result) => result.completed > 0))
  const context = tabContext[tab]

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Evaluation</h1>
        <p className="text-sm text-muted-foreground">
          Configure independent rounds, assign restricted reviewers, and compare weighted results.
        </p>
      </div>
      <div className="grid overflow-hidden rounded-lg border border-border sm:grid-cols-5">
        {[
          ['Create round', hasRound],
          ['Edit scorecard', hasScorecard],
          ['Invite reviewers', hasReviewers],
          ['Assign submissions', hasAssignments],
          ['Review results', hasResults],
        ].map(([label, complete], index) => (
          <div key={String(label)} className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-sm last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
            <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border text-xs', complete ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground')}>
              {complete ? <CheckIcon className="size-3" /> : index + 1}
            </span>
            <span className={cn(complete ? 'font-medium text-foreground' : 'text-muted-foreground')}>{label}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border">
        {tabs.map((item) => (
          <Link
            key={item.value}
            href={router.href(`/org/${currentOrgId}/e/${event.id}/evaluation`, { tab: item.value })}
            className={cn(
              'relative -mb-px px-2.5 py-2 text-sm no-underline transition-colors',
              item.value === tab ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
            {item.value === tab ? <span className="absolute inset-x-2.5 bottom-0 h-0.5 rounded-sm bg-primary" /> : null}
          </Link>
        ))}
      </div>
      <div className="flex flex-col gap-1 border-l-2 border-primary pl-3">
        <h2 className="text-sm font-medium">{context.title}</h2>
        <p className="text-sm text-muted-foreground">{context.description}</p>
      </div>
      {tab === 'rounds' ? <Rounds orgId={currentOrgId} eventId={event.id} rounds={data.rounds} /> : null}
      {tab === 'reviewers' ? <Reviewers orgId={currentOrgId} eventId={event.id} rounds={data.rounds} /> : null}
      {tab === 'assignments' ? <Assignments orgId={currentOrgId} eventId={event.id} rounds={data.rounds} sessions={data.sessions} tracks={tracks} /> : null}
      {tab === 'progress' ? <Progress orgId={currentOrgId} eventId={event.id} rounds={data.rounds} /> : null}
      {tab === 'results' ? <Results orgId={currentOrgId} eventId={event.id} rounds={data.rounds} /> : null}
    </div>
  )
}

type Round = {
  id: string
  name: string
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'ARCHIVED'
  opensAt: number | null
  closesAt: number | null
  blind: boolean
  fields: Array<{ name: string; type: string; weight?: number }>
  reviewers: Array<{ id: string; name: string; email: string }>
  invitations: Array<{ id: string; email: string; expiresAt: number }>
  assignments: Array<{ id: string; sessionId: string; reviewerId: string; state: string }>
  progress: Array<{ reviewerId: string; name: string; email: string; assigned: number; completed: number; inProgress: number; recused: number }>
  coverage: Array<{ sessionId: string; title: string; assigned: number; completed: number }>
  results: EvaluationResult[]
}

function RoundSelect({ rounds, value, onChange }: { rounds: Round[]; value: string; onChange: (value: string) => void }) {
  return (
    <NativeSelect className="max-w-xs" value={value} onChange={(event) => onChange(event.target.value)}>
      {rounds.map((round) => <option key={round.id} value={round.id}>{round.name}</option>)}
    </NativeSelect>
  )
}

function Rounds({ orgId, eventId, rounds }: { orgId: string; eventId: string; rounds: Round[] }) {
  const [creating, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [opensAt, setOpensAt] = useState('')
  const [closesAt, setClosesAt] = useState('')
  const [blind, setBlind] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-4">
      <form
        className="grid gap-4 rounded-lg border border-border p-4 md:grid-cols-2"
        action={() => startTransition(async () => {
          setError(null)
          const parsedOpensAt = opensAt ? Date.parse(opensAt) : null
          const parsedClosesAt = closesAt ? Date.parse(closesAt) : null
          try {
            if (parsedOpensAt != null && Number.isNaN(parsedOpensAt)) throw new Error('Open date is invalid')
            if (parsedClosesAt != null && Number.isNaN(parsedClosesAt)) throw new Error('Close date is invalid')
            await createForm({
              orgId,
              eventId,
              name,
              purpose: 'EVALUATION',
              opensAt: parsedOpensAt,
              closesAt: parsedClosesAt,
              blind,
            })
            toast.success(`"${name.trim()}" is now available in evaluation rounds.`, 'Round created')
            setName('')
            setOpensAt('')
            setClosesAt('')
            setBlind(false)
          } catch (cause) {
            setError(toastActionError(cause, 'Could not create the evaluation round'))
          }
        })}
      >
          <label className="flex flex-col gap-1.5 text-sm font-medium md:col-span-2">
            Round name
            <Input required name="name" placeholder="Initial review" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
            <span className="text-xs font-normal text-muted-foreground">Reviewers see this name in their private review workspace.</span>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Opens at
            <Input name="opensAt" type="datetime-local" value={opensAt} onChange={(event) => setOpensAt(event.target.value)} />
            <span className="text-xs font-normal text-muted-foreground">Optional. Review work is blocked before this time.</span>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Closes at
            <Input name="closesAt" type="datetime-local" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} />
            <span className="text-xs font-normal text-muted-foreground">Optional. Review work is blocked at and after this time.</span>
          </label>
          <div className="flex flex-wrap items-end justify-between gap-4 border-t border-border pt-4 md:col-span-2">
            <label className="flex max-w-xl items-start gap-2 text-sm">
              <input className="mt-0.5" name="blind" type="checkbox" checked={blind} onChange={(event) => setBlind(event.target.checked)} />
              <span className="flex flex-col gap-0.5"><span className="font-medium">Blind review</span><span className="text-muted-foreground">Hide speaker identity and identity-related answers from reviewers. Organizers still see the full submission.</span></span>
            </label>
            <Button type="submit" disabled={creating}><PlusIcon />Create round</Button>
          </div>
          {error ? <p className="text-sm text-destructive md:col-span-2" role="alert">{error}</p> : null}
      </form>
      {rounds.length === 0 ? <EmptyState icon={<StarIcon />} title="No evaluation rounds" description="Create a round, then edit its MDX scorecard." /> : (
        <Frame><Table><TableHeader><TableRow><TableHead>Round</TableHead><TableHead>Dates</TableHead><TableHead>Scorecard</TableHead><TableHead>Reviewers</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>
          {rounds.map((round) => <TableRow key={round.id}>
            <TableCell><Link className="font-medium no-underline hover:underline" href={router.href('/org/:orgId/e/:eventId/forms/:formId', { orgId, eventId, formId: round.id })}>{round.name}</Link></TableCell>
            <TableCell className="text-muted-foreground">{round.opensAt ? formatDateTimeUTC(round.opensAt) : 'Any time'} to {round.closesAt ? formatDateTimeUTC(round.closesAt) : 'No close'}</TableCell>
            <TableCell className="text-muted-foreground">{round.fields.map((field) => field.name).join(', ') || 'No fields'}</TableCell>
            <TableCell className="tabular-nums">{round.reviewers.length}</TableCell>
            <TableCell><Badge variant={round.status === 'OPEN' ? 'success' : 'secondary'}>{round.status.toLowerCase()}{round.blind ? ' · blind' : ''}</Badge></TableCell>
          </TableRow>)}
        </TableBody></Table></Frame>
      )}
    </div>
  )
}

function Reviewers({ orgId, eventId, rounds }: { orgId: string; eventId: string; rounds: Round[] }) {
  const [roundId, setRoundId] = useState(rounds[0]?.id ?? '')
  const [inviteUrl, setInviteUrl] = useState('')
  const round = rounds.find((item) => item.id === roundId)
  if (!round) return <EmptyState icon={<StarIcon />} title="Create a round first" description="Reviewer pools belong to one evaluation round." />
  const pendingInvites = round.invitations.filter((invite) => !round.reviewers.some((reviewer) => reviewer.email.toLowerCase() === invite.email.toLowerCase()))
  return <div className="flex flex-col gap-4">
    <RoundSelect rounds={rounds} value={roundId} onChange={setRoundId} />
    <p className="max-w-3xl text-sm text-muted-foreground">An invitation grants access only to this round. A pending invite has not been accepted. An active reviewer has accepted with the invited email and can receive assignments.</p>
    <ErrorBoundary below fallback={<ErrorBoundary.ErrorMessage className="text-sm text-destructive" />}>
      <form className="flex max-w-xl gap-2" action={async (formData) => {
        const result = await inviteEvaluationReviewer({ orgId, eventId, formId: round.id, email: String(formData.get('email') ?? '') })
        setInviteUrl(result.inviteUrl)
        toast.success(`Invitation created for ${String(formData.get('email') ?? '')}`, 'Reviewer invited')
      }}>
        <Input required name="email" type="email" placeholder="sam@example.com" />
        <Button type="submit"><SendIcon />Invite reviewer</Button>
      </form>
    </ErrorBoundary>
    {inviteUrl ? <div className="flex max-w-2xl items-center gap-2"><Input readOnly className="font-mono text-xs" value={inviteUrl} onClick={(event) => event.currentTarget.select()} /><Button variant="outline" onClick={async () => { await navigator.clipboard.writeText(inviteUrl); toast.success('Reviewer invite URL copied') }}><CopyIcon />Copy URL</Button></div> : null}
    {round.reviewers.length === 0 && pendingInvites.length === 0 ? <EmptyState icon={<StarIcon />} title="No reviewers for this round" description="Invite a reviewer. They become active after they accept with the invited email." /> : <Frame><Table><TableHeader><TableRow><TableHead>Access</TableHead><TableHead>Reviewer</TableHead><TableHead>Email</TableHead><TableHead>Assigned</TableHead><TableHead>Complete</TableHead></TableRow></TableHeader><TableBody>
      {round.reviewers.map((reviewer) => {
        const progress = round.progress.find((row) => row.reviewerId === reviewer.id)
        return <TableRow key={reviewer.id}><TableCell><Badge variant="success">Active</Badge></TableCell><TableCell>{reviewer.name}</TableCell><TableCell className="text-muted-foreground">{reviewer.email}</TableCell><TableCell>{progress?.assigned ?? 0}</TableCell><TableCell>{progress?.completed ?? 0}</TableCell></TableRow>
      })}
      {pendingInvites.map((invite) => <TableRow key={invite.id}><TableCell><Badge variant="secondary">Pending invite</Badge></TableCell><TableCell className="text-muted-foreground">Not accepted</TableCell><TableCell>{invite.email}</TableCell><TableCell>—</TableCell><TableCell>—</TableCell></TableRow>)}
    </TableBody></Table></Frame>}
  </div>
}

function Assignments({ orgId, eventId, rounds, sessions, tracks }: { orgId: string; eventId: string; rounds: Round[]; sessions: any[]; tracks: Array<{ id: string; name: string }> }) {
  const [roundId, setRoundId] = useState(rounds[0]?.id ?? '')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const round = rounds.find((item) => item.id === roundId)
  if (!round) return <EmptyState icon={<StarIcon />} title="Create a round first" description="Assignments need a round and reviewer pool." />
  return <div className="flex flex-col gap-4">
    <RoundSelect rounds={rounds} value={roundId} onChange={(value) => { setRoundId(value); setSelected(new Set()) }} />
    <div className="grid gap-3 border-y border-border py-3 text-sm sm:grid-cols-4">
      <p><span className="font-medium">Reviewer</span><br /><span className="text-muted-foreground">Only active reviewers in this round are available.</span></p>
      <p><span className="font-medium">Track filter</span><br /><span className="text-muted-foreground">Excludes selected submissions outside one track.</span></p>
      <p><span className="font-medium">Limit</span><br /><span className="text-muted-foreground">Caps new work from this selected set.</span></p>
      <p><span className="font-medium">Existing load</span><br /><span className="text-muted-foreground">Duplicate assignments are kept and are not counted as new.</span></p>
    </div>
    {round.reviewers.length === 0 ? <p className="text-sm text-warning-foreground">Invite a reviewer and wait for them to accept before assigning submissions.</p> : null}
    <ErrorBoundary below fallback={<ErrorBoundary.ErrorMessage className="text-sm text-destructive" />}>
      <form className="flex flex-col gap-3" action={async (formData) => {
        const result = await assignEvaluationReviews({
          orgId, eventId, formId: round.id,
          reviewerId: String(formData.get('reviewerId') ?? ''),
          trackId: String(formData.get('trackId') ?? '') || null,
          limit: Number(formData.get('limit') ?? 10),
          sessionIds: [...selected],
        })
        toast.success(`${result.assigned} new assignment${result.assigned === 1 ? '' : 's'} created`, 'Assignments updated')
        setSelected(new Set())
      }}>
        <div className="flex flex-wrap gap-2">
          <NativeSelect required name="reviewerId" className="max-w-xs"><option value="">Select reviewer</option>{round.reviewers.map((reviewer) => <option key={reviewer.id} value={reviewer.id}>{reviewer.name}</option>)}</NativeSelect>
          <NativeSelect name="trackId" className="max-w-xs"><option value="">All tracks</option>{tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}</NativeSelect>
          <Input required name="limit" type="number" min={1} max={100} defaultValue={10} className="w-28" aria-label="Assignment limit" />
          <Button type="submit" disabled={selected.size === 0 || round.reviewers.length === 0}>Assign {selected.size} selected</Button>
        </div>
        {sessions.length === 0 ? <EmptyState icon={<StarIcon />} title="No submissions to assign" description="Submitted abstracts appear here when they are ready for evaluation." /> : <Frame><Table><TableHeader><TableRow><TableHead className="w-10" /><TableHead>Submission</TableHead><TableHead>Track</TableHead><TableHead>Current assignments</TableHead></TableRow></TableHeader><TableBody>
          {sessions.map((session) => <TableRow key={session.id}><TableCell><input type="checkbox" checked={selected.has(session.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(session.id)) next.delete(session.id); else next.add(session.id); return next })} /></TableCell><TableCell>{session.title ?? 'Untitled'}</TableCell><TableCell>{session.trackName ?? '—'}</TableCell><TableCell>{round.assignments.filter((assignment) => assignment.sessionId === session.id).length}</TableCell></TableRow>)}
        </TableBody></Table></Frame>}
      </form>
    </ErrorBoundary>
  </div>
}

function Progress({ orgId, eventId, rounds }: { orgId: string; eventId: string; rounds: Round[] }) {
  const [roundId, setRoundId] = useState(rounds[0]?.id ?? '')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()
  const round = rounds.find((item) => item.id === roundId)
  if (!round) return <EmptyState icon={<StarIcon />} title="No progress yet" description="Create a round and assignments first." />
  return <div className="flex flex-col gap-5"><div className="flex flex-wrap items-center gap-2"><RoundSelect rounds={rounds} value={roundId} onChange={(value) => { setRoundId(value); setSelected(new Set()) }} /><Button variant="outline" loading={pending} disabled={selected.size === 0} onClick={() => startTransition(async () => { await runAction(async () => { await remindEvaluationReviewers({ orgId, eventId, formId: round.id, reviewerIds: [...selected] }); setSelected(new Set()) }, { success: `Reminder${selected.size === 1 ? '' : 's'} queued` }) })}><SendIcon />Remind selected</Button></div>
    {round.progress.length === 0 ? <EmptyState icon={<StarIcon />} title="No reviewer progress" description="Assign submissions to active reviewers to start tracking work." /> : <Frame><Table><TableHeader><TableRow><TableHead className="w-10" /><TableHead>Reviewer</TableHead><TableHead>Assigned</TableHead><TableHead>In progress</TableHead><TableHead>Complete</TableHead><TableHead>Recused</TableHead></TableRow></TableHeader><TableBody>
      {round.progress.map((row) => { const hasUnfinished = row.completed + row.recused < row.assigned; return <TableRow key={row.reviewerId}><TableCell><input type="checkbox" aria-label={`Select ${row.name}`} disabled={!hasUnfinished} checked={selected.has(row.reviewerId)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(row.reviewerId)) next.delete(row.reviewerId); else next.add(row.reviewerId); return next })} /></TableCell><TableCell><div className="flex flex-col"><span>{row.name}</span><span className="text-xs text-muted-foreground">{row.email}</span></div></TableCell><TableCell>{row.assigned}</TableCell><TableCell>{row.inProgress}</TableCell><TableCell>{row.completed}</TableCell><TableCell>{row.recused}</TableCell></TableRow> })}
    </TableBody></Table></Frame>}
    {round.coverage.length === 0 ? <EmptyState icon={<StarIcon />} title="No submission coverage" description="Submissions appear here with their assigned and completed review counts." /> : <Frame><Table><TableHeader><TableRow><TableHead>Submission</TableHead><TableHead>Assigned</TableHead><TableHead>Complete</TableHead></TableRow></TableHeader><TableBody>{round.coverage.map((row) => <TableRow key={row.sessionId}><TableCell>{row.title}</TableCell><TableCell>{row.assigned}</TableCell><TableCell>{row.completed}</TableCell></TableRow>)}</TableBody></Table></Frame>}
  </div>
}

function Results({ orgId, eventId, rounds }: { orgId: string; eventId: string; rounds: Round[] }) {
  const [roundId, setRoundId] = useState(rounds[0]?.id ?? '')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  const round = rounds.find((item) => item.id === roundId)
  if (!round) return <EmptyState icon={<StarIcon />} title="No results yet" description="Completed scorecards appear here." />
  const rows = sortEvaluationResults(round.results, direction)
  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center gap-2"><RoundSelect rounds={rounds} value={roundId} onChange={setRoundId} /><Button variant="outline" onClick={() => setDirection((value) => value === 'desc' ? 'asc' : 'desc')}>Score {direction === 'desc' ? 'high to low' : 'low to high'}</Button><Button variant="outline" render={<a href={router.href('/org/:orgId/e/:eventId/evaluation/:formId/results.csv', { orgId, eventId, formId: round.id })} />}><DownloadIcon />Export CSV</Button></div>
    {rows.length === 0 ? <EmptyState icon={<StarIcon />} title="No evaluation results" description="Assigned submissions appear here. Scores fill in as reviewers submit scorecards." /> : <Frame><Table><TableHeader><TableRow><TableHead>Submission</TableHead><TableHead>Status</TableHead><TableHead>Weighted score</TableHead><TableHead>Complete</TableHead>{round.fields.map((field) => <TableHead key={field.name}>{field.name}{field.weight ? ` ×${field.weight}` : ''}</TableHead>)}</TableRow></TableHeader><TableBody>
      {rows.map((row) => <TableRow key={row.sessionId}><TableCell><Link href={router.href('/org/:orgId/e/:eventId/abstracts/:sessionId', { orgId, eventId, sessionId: row.sessionId })} className="font-medium no-underline hover:underline">{row.title}</Link></TableCell><TableCell><Badge variant={row.status === 'COMPLETED' ? 'success' : 'secondary'}>{row.status.toLowerCase().replace('_', ' ')}</Badge></TableCell><TableCell className="tabular-nums">{row.aggregate?.toFixed(2) ?? '—'}</TableCell><TableCell>{row.completed}/{row.assigned}</TableCell>{round.fields.map((field) => <TableCell key={field.name} className="max-w-52 whitespace-pre-wrap text-muted-foreground">{row.answers[field.name] ?? '—'}</TableCell>)}</TableRow>)}
    </TableBody></Table></Frame>}
  </div>
}
