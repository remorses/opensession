// Organizer evaluation workspace: rounds, reviewer pools, bulk assignments,
// progress/reminders, weighted results, and CSV export.
'use client'

import { useState, useTransition } from 'react'
import { DownloadIcon, PlusIcon, SendIcon, StarIcon } from 'lucide-react'
import { ErrorBoundary, Link, router, useLoaderData } from 'spiceflow/react'
import {
  assignEvaluationReviews,
  createForm,
  inviteEvaluationReviewer,
  remindEvaluationReviewer,
} from '../actions.tsx'
import { sortEvaluationResults } from '../lib/reviews.ts'
import { cn, formatDateTimeUTC } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import { Badge, EmptyState, Input, NativeSelect } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import { runAction } from './ui/toast.tsx'

export type EvaluationTab = 'rounds' | 'reviewers' | 'assignments' | 'progress' | 'results'

const tabs: Array<{ value: EvaluationTab; label: string }> = [
  { value: 'rounds', label: 'Rounds' },
  { value: 'reviewers', label: 'Reviewers' },
  { value: 'assignments', label: 'Assignments' },
  { value: 'progress', label: 'Progress' },
  { value: 'results', label: 'Results' },
]

export function EvaluationPage({ tab }: { tab: EvaluationTab }) {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event, tracks } = useLoaderData('/org/:orgId/e/:eventId/*')
  const data = useLoaderData('/org/:orgId/e/:eventId/evaluation')

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Evaluation</h1>
        <p className="text-sm text-muted-foreground">
          Configure independent rounds, assign restricted reviewers, and compare weighted results.
        </p>
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
  results: Array<{ sessionId: string; title: string; aggregate: number | null; completed: number; assigned: number; answers: Record<string, string> }>
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
  return (
    <div className="flex flex-col gap-4">
      <ErrorBoundary below fallback={<ErrorBoundary.ErrorMessage className="text-sm text-destructive" />}>
        <form
          className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-[1fr_12rem_12rem_auto_auto]"
          action={(formData) => startTransition(async () => {
            const opensAt = Date.parse(String(formData.get('opensAt') ?? ''))
            const closesAt = Date.parse(String(formData.get('closesAt') ?? ''))
            await createForm({
              orgId,
              eventId,
              name: String(formData.get('name') ?? '').trim(),
              purpose: 'EVALUATION',
              opensAt: Number.isNaN(opensAt) ? null : opensAt,
              closesAt: Number.isNaN(closesAt) ? null : closesAt,
              blind: formData.get('blind') === 'on',
            })
          })}
        >
          <Input required name="name" placeholder="Initial Review" maxLength={120} />
          <Input name="opensAt" type="datetime-local" aria-label="Opens at" />
          <Input name="closesAt" type="datetime-local" aria-label="Closes at" />
          <label className="flex items-center gap-2 text-sm"><input name="blind" type="checkbox" /> Blind</label>
          <Button type="submit" disabled={creating}><PlusIcon />Create round</Button>
        </form>
      </ErrorBoundary>
      {rounds.length === 0 ? <EmptyState icon={<StarIcon />} title="No evaluation rounds" description="Create a round, then edit its MDX scorecard." /> : (
        <Frame><Table><TableHeader><TableRow><TableHead>Round</TableHead><TableHead>Dates</TableHead><TableHead>Scorecard</TableHead><TableHead>Reviewers</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>
          {rounds.map((round) => <TableRow key={round.id}>
            <TableCell><Link className="font-medium no-underline hover:underline" href={`/org/${orgId}/e/${eventId}/forms/${round.id}`}>{round.name}</Link></TableCell>
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
  return <div className="flex flex-col gap-4">
    <RoundSelect rounds={rounds} value={roundId} onChange={setRoundId} />
    <ErrorBoundary below fallback={<ErrorBoundary.ErrorMessage className="text-sm text-destructive" />}>
      <form className="flex max-w-xl gap-2" action={async (formData) => {
        const result = await inviteEvaluationReviewer({ orgId, eventId, formId: round.id, email: String(formData.get('email') ?? '') })
        setInviteUrl(result.inviteUrl)
      }}>
        <Input required name="email" type="email" placeholder="sam@example.com" />
        <Button type="submit"><SendIcon />Invite reviewer</Button>
      </form>
    </ErrorBoundary>
    {inviteUrl ? <Input readOnly className="max-w-xl font-mono text-xs" value={inviteUrl} onClick={(event) => event.currentTarget.select()} /> : null}
    <Frame><Table><TableHeader><TableRow><TableHead>Reviewer</TableHead><TableHead>Email</TableHead><TableHead>Assigned</TableHead><TableHead>Complete</TableHead></TableRow></TableHeader><TableBody>
      {round.reviewers.map((reviewer) => {
        const progress = round.progress.find((row) => row.reviewerId === reviewer.id)
        return <TableRow key={reviewer.id}><TableCell>{reviewer.name}</TableCell><TableCell className="text-muted-foreground">{reviewer.email}</TableCell><TableCell>{progress?.assigned ?? 0}</TableCell><TableCell>{progress?.completed ?? 0}</TableCell></TableRow>
      })}
      {round.invitations.filter((invite) => !round.reviewers.some((reviewer) => reviewer.email.toLowerCase() === invite.email.toLowerCase())).map((invite) => <TableRow key={invite.id}><TableCell><Badge variant="secondary">Pending invite</Badge></TableCell><TableCell>{invite.email}</TableCell><TableCell>0</TableCell><TableCell>0</TableCell></TableRow>)}
    </TableBody></Table></Frame>
  </div>
}

function Assignments({ orgId, eventId, rounds, sessions, tracks }: { orgId: string; eventId: string; rounds: Round[]; sessions: any[]; tracks: Array<{ id: string; name: string }> }) {
  const [roundId, setRoundId] = useState(rounds[0]?.id ?? '')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const round = rounds.find((item) => item.id === roundId)
  if (!round) return <EmptyState icon={<StarIcon />} title="Create a round first" description="Assignments need a round and reviewer pool." />
  return <div className="flex flex-col gap-4">
    <RoundSelect rounds={rounds} value={roundId} onChange={(value) => { setRoundId(value); setSelected(new Set()) }} />
    <ErrorBoundary below fallback={<ErrorBoundary.ErrorMessage className="text-sm text-destructive" />}>
      <form className="flex flex-col gap-3" action={async (formData) => {
        await assignEvaluationReviews({
          orgId, eventId, formId: round.id,
          reviewerId: String(formData.get('reviewerId') ?? ''),
          trackId: String(formData.get('trackId') ?? '') || null,
          limit: Number(formData.get('limit') ?? 10),
          sessionIds: [...selected],
        })
        setSelected(new Set())
      }}>
        <div className="flex flex-wrap gap-2">
          <NativeSelect required name="reviewerId" className="max-w-xs"><option value="">Select reviewer</option>{round.reviewers.map((reviewer) => <option key={reviewer.id} value={reviewer.id}>{reviewer.name}</option>)}</NativeSelect>
          <NativeSelect name="trackId" className="max-w-xs"><option value="">All tracks</option>{tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}</NativeSelect>
          <Input required name="limit" type="number" min={1} max={100} defaultValue={10} className="w-28" aria-label="Assignment limit" />
          <Button type="submit" disabled={selected.size === 0}>Assign {selected.size} selected</Button>
        </div>
        <Frame><Table><TableHeader><TableRow><TableHead className="w-10" /><TableHead>Submission</TableHead><TableHead>Track</TableHead><TableHead>Current assignments</TableHead></TableRow></TableHeader><TableBody>
          {sessions.map((session) => <TableRow key={session.id}><TableCell><input type="checkbox" checked={selected.has(session.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(session.id)) next.delete(session.id); else next.add(session.id); return next })} /></TableCell><TableCell>{session.title ?? 'Untitled'}</TableCell><TableCell>{session.trackName ?? '—'}</TableCell><TableCell>{round.assignments.filter((assignment) => assignment.sessionId === session.id).length}</TableCell></TableRow>)}
        </TableBody></Table></Frame>
      </form>
    </ErrorBoundary>
  </div>
}

function Progress({ orgId, eventId, rounds }: { orgId: string; eventId: string; rounds: Round[] }) {
  const [roundId, setRoundId] = useState(rounds[0]?.id ?? '')
  const round = rounds.find((item) => item.id === roundId)
  if (!round) return <EmptyState icon={<StarIcon />} title="No progress yet" description="Create a round and assignments first." />
  return <div className="flex flex-col gap-5"><RoundSelect rounds={rounds} value={roundId} onChange={setRoundId} />
    <Frame><Table><TableHeader><TableRow><TableHead>Reviewer</TableHead><TableHead>Assigned</TableHead><TableHead>In progress</TableHead><TableHead>Complete</TableHead><TableHead>Recused</TableHead><TableHead /></TableRow></TableHeader><TableBody>
      {round.progress.map((row) => <TableRow key={row.reviewerId}><TableCell><div className="flex flex-col"><span>{row.name}</span><span className="text-xs text-muted-foreground">{row.email}</span></div></TableCell><TableCell>{row.assigned}</TableCell><TableCell>{row.inProgress}</TableCell><TableCell>{row.completed}</TableCell><TableCell>{row.recused}</TableCell><TableCell><Button size="sm" variant="outline" disabled={row.completed + row.recused >= row.assigned} onClick={() => void runAction(() => remindEvaluationReviewer({ orgId, eventId, formId: round.id, reviewerId: row.reviewerId }), { success: 'Reminder queued' })}>Remind</Button></TableCell></TableRow>)}
    </TableBody></Table></Frame>
    <Frame><Table><TableHeader><TableRow><TableHead>Submission</TableHead><TableHead>Assigned</TableHead><TableHead>Complete</TableHead></TableRow></TableHeader><TableBody>{round.coverage.map((row) => <TableRow key={row.sessionId}><TableCell>{row.title}</TableCell><TableCell>{row.assigned}</TableCell><TableCell>{row.completed}</TableCell></TableRow>)}</TableBody></Table></Frame>
  </div>
}

function Results({ orgId, eventId, rounds }: { orgId: string; eventId: string; rounds: Round[] }) {
  const [roundId, setRoundId] = useState(rounds[0]?.id ?? '')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  const round = rounds.find((item) => item.id === roundId)
  if (!round) return <EmptyState icon={<StarIcon />} title="No results yet" description="Completed scorecards appear here." />
  const rows = sortEvaluationResults(round.results, direction)
  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center gap-2"><RoundSelect rounds={rounds} value={roundId} onChange={setRoundId} /><Button variant="outline" onClick={() => setDirection((value) => value === 'desc' ? 'asc' : 'desc')}>Score {direction === 'desc' ? 'high to low' : 'low to high'}</Button><Button variant="outline" render={<a href={`/org/${orgId}/e/${eventId}/evaluation/${round.id}/results.csv`} />}><DownloadIcon />Export CSV</Button></div>
    <Frame><Table><TableHeader><TableRow><TableHead>Submission</TableHead><TableHead>Weighted score</TableHead><TableHead>Complete</TableHead>{round.fields.map((field) => <TableHead key={field.name}>{field.name}{field.weight ? ` ×${field.weight}` : ''}</TableHead>)}</TableRow></TableHeader><TableBody>
      {rows.map((row) => <TableRow key={row.sessionId}><TableCell><Link href={`/org/${orgId}/e/${eventId}/abstracts/${row.sessionId}`} className="font-medium no-underline hover:underline">{row.title}</Link></TableCell><TableCell className="tabular-nums">{row.aggregate?.toFixed(2) ?? '—'}</TableCell><TableCell>{row.completed}/{row.assigned}</TableCell>{round.fields.map((field) => <TableCell key={field.name} className="max-w-52 whitespace-pre-wrap text-muted-foreground">{row.answers[field.name] ?? '—'}</TableCell>)}</TableRow>)}
    </TableBody></Table></Frame>
  </div>
}
