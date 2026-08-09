// Anonymous public program and iframe widgets. All five surfaces consume the
// same server projection, so public pages, embeds, and feeds cannot drift.
'use client'

import { useState, useSyncExternalStore } from 'react'
import { CalendarPlusIcon, SearchIcon, UserRoundIcon, XIcon } from 'lucide-react'
import { Link, router } from 'spiceflow/react'
import {
  filterPublicSessions,
  type PublicProgram,
  type PublicProgramFilters,
  type PublicSession,
  type PublicSpeaker,
} from '../lib/public-program.ts'
import { formatDayLabel, layoutDayColumns, minutesToLabel } from '../lib/conflicts.ts'
import { cn } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from './ui/dialog.tsx'
import { Badge, EmptyState, Input, NativeSelect } from './ui/primitives.tsx'

export type PublicProgramView = 'sessions' | 'speakers' | 'agenda' | 'itinerary' | 'gallery'

type Props = {
  program: PublicProgram
  view: PublicProgramView
  embed?: boolean
  initialFilters?: PublicProgramFilters
  accent?: string
  compact?: boolean
  visibleFields?: string[]
}

const views: Array<{ value: PublicProgramView; label: string }> = [
  { value: 'sessions', label: 'Sessions' },
  { value: 'speakers', label: 'Speakers' },
  { value: 'agenda', label: 'Agenda' },
  { value: 'itinerary', label: 'Itinerary' },
  { value: 'gallery', label: 'Gallery' },
]

type PersonalStore = {
  getSnapshot: () => string[]
  getServerSnapshot: () => string[]
  subscribe: (listener: () => void) => () => void
  toggle: (id: string) => void
}

const EMPTY_SELECTION: string[] = []
const personalStores = new Map<string, PersonalStore>()

function getPersonalStore(slug: string): PersonalStore {
  const existing = personalStores.get(slug)
  if (existing) return existing
  const key = `opensession:${slug}:personal-schedule`
  let snapshot = EMPTY_SELECTION
  const read = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? '[]')
      const next = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
      if (next.join('\0') !== snapshot.join('\0')) snapshot = next
    } catch {
      snapshot = EMPTY_SELECTION
    }
    return snapshot
  }
  const notify = () => window.dispatchEvent(new Event(key))
  const store: PersonalStore = {
    getSnapshot: read,
    getServerSnapshot: () => EMPTY_SELECTION,
    subscribe(listener) {
      const onStorage = (event: StorageEvent) => {
        if (event.key === key) listener()
      }
      window.addEventListener('storage', onStorage)
      window.addEventListener(key, listener)
      return () => {
        window.removeEventListener('storage', onStorage)
        window.removeEventListener(key, listener)
      }
    },
    toggle(id) {
      const next = read().includes(id) ? read().filter((value) => value !== id) : [...read(), id]
      localStorage.setItem(key, JSON.stringify(next))
      snapshot = next
      notify()
    },
  }
  personalStores.set(slug, store)
  return store
}

export function PublicProgramPage({
  program,
  view,
  embed = false,
  initialFilters = {},
  accent,
  compact = false,
  visibleFields,
}: Props) {
  const [filters, setFilters] = useState<PublicProgramFilters>(initialFilters)
  const [selectedDay, setSelectedDay] = useState(program.days[0] ?? '')
  const [sessionDetail, setSessionDetail] = useState<PublicSession | null>(null)
  const [speakerDetail, setSpeakerDetail] = useState<PublicSpeaker | null>(null)
  const [personalOnly, setPersonalOnly] = useState(false)
  const [personalStore] = useState(() => getPersonalStore(program.event.slug))
  const personalIds = useSyncExternalStore(
    personalStore.subscribe,
    personalStore.getSnapshot,
    personalStore.getServerSnapshot,
  )
  const filtered = filterPublicSessions(program.sessions, filters)
  const visibleSessions = personalOnly
    ? filtered.filter((session) => personalIds.includes(session.id))
    : filtered
  const visibleSpeakers = program.speakers.filter((speaker) => {
    const q = filters.q?.trim().toLocaleLowerCase('en-US') ?? ''
    return !q || speaker.name.toLocaleLowerCase('en-US').includes(q)
  })
  const accentStyle = accent ? { '--primary': accent } as React.CSSProperties : undefined

  return (
    <main
      style={accentStyle}
      className={cn(
        'min-h-screen bg-background text-foreground',
        embed ? 'px-3 py-4 sm:px-5' : 'px-4 py-8 sm:px-6 lg:px-8',
        compact && 'text-sm',
      )}
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        {!embed ? (
          <header className="flex flex-col gap-4 border-b border-border pb-5">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Public program</span>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{program.event.name}</h1>
              <p className="text-sm text-muted-foreground">
                {[program.event.location, program.event.timezone].filter(Boolean).join(' · ')}
              </p>
            </div>
            <nav className="flex gap-1 overflow-x-auto">
              {views.map((item) => (
                <Link
                  key={item.value}
                  href={router.href(`/public/${program.event.slug}/${item.value}`)}
                  className={cn(
                    'whitespace-nowrap rounded-md px-3 py-1.5 text-sm no-underline transition-colors',
                    item.value === view ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </header>
        ) : (
          <div className="flex items-baseline justify-between gap-4 border-b border-border pb-3">
            <h1 className="text-lg font-semibold">{program.event.name}</h1>
            <span className="text-xs text-muted-foreground">OpenSession</span>
          </div>
        )}

        <ProgramFilters
          program={program}
          filters={filters}
          onChange={setFilters}
          speakerOnly={view === 'speakers' || view === 'gallery'}
        />

        {view === 'sessions' ? (
          <SessionsList sessions={visibleSessions} onOpen={setSessionDetail} visibleFields={visibleFields} />
        ) : view === 'speakers' ? (
          <SpeakersList speakers={visibleSpeakers} sessions={program.sessions} onOpen={setSpeakerDetail} />
        ) : view === 'agenda' ? (
          <PublicAgenda
            program={program}
            sessions={visibleSessions}
            selectedDay={selectedDay}
            onDayChange={setSelectedDay}
            onOpen={setSessionDetail}
          />
        ) : view === 'gallery' ? (
          <SpeakerGallery speakers={visibleSpeakers} onOpen={setSpeakerDetail} />
        ) : (
          <Itinerary
            program={program}
            sessions={visibleSessions}
            selectedDay={selectedDay}
            onDayChange={setSelectedDay}
            personalIds={personalIds}
            personalOnly={personalOnly}
            onPersonalOnlyChange={setPersonalOnly}
            onToggle={personalStore.toggle}
            onOpen={setSessionDetail}
          />
        )}
      </div>

      <SessionDetail session={sessionDetail} onClose={() => setSessionDetail(null)} />
      <SpeakerDetail
        speaker={speakerDetail}
        sessions={program.sessions}
        onClose={() => setSpeakerDetail(null)}
      />
    </main>
  )
}

function ProgramFilters({
  program,
  filters,
  onChange,
  speakerOnly,
}: {
  program: PublicProgram
  filters: PublicProgramFilters
  onChange: (filters: PublicProgramFilters) => void
  speakerOnly: boolean
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      <label className="relative min-w-0 grow sm:max-w-sm">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input
          aria-label={speakerOnly ? 'Search speakers' : 'Search sessions and speakers'}
          className="pl-8"
          value={filters.q ?? ''}
          placeholder={speakerOnly ? 'Search speakers' : 'Search title or speaker'}
          onChange={(event) => onChange({ ...filters, q: event.target.value || undefined })}
        />
      </label>
      {!speakerOnly ? (
        <>
          <FilterSelect label="Track" value={filters.track} rows={program.tracks} onChange={(track) => onChange({ ...filters, track })} />
          <FilterSelect label="Format" value={filters.format} rows={program.formats} onChange={(format) => onChange({ ...filters, format })} />
          <FilterSelect label="Room" value={filters.room} rows={program.rooms} onChange={(room) => onChange({ ...filters, room })} />
        </>
      ) : null}
    </div>
  )
}

function FilterSelect({
  label,
  value,
  rows,
  onChange,
}: {
  label: string
  value?: string
  rows: Array<{ id: string; name: string }>
  onChange: (value: string | undefined) => void
}) {
  return (
    <NativeSelect aria-label={`Filter by ${label}`} value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)}>
      <option value="">All {label.toLocaleLowerCase('en-US')}s</option>
      {rows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
    </NativeSelect>
  )
}

function SessionsList({ sessions, onOpen, visibleFields }: { sessions: PublicSession[]; onOpen: (session: PublicSession) => void; visibleFields?: string[] }) {
  if (sessions.length === 0) return <ProgramEmpty />
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm tabular-nums text-muted-foreground">{sessions.length} sessions</span>
      {sessions.map((session) => <SessionCard key={session.id} session={session} onOpen={onOpen} visibleFields={visibleFields} />)}
    </div>
  )
}

function SessionCard({ session, onOpen, visibleFields }: { session: PublicSession; onOpen: (session: PublicSession) => void; visibleFields?: string[] }) {
  const [expanded, setExpanded] = useState(false)
  const shown = (field: string) => !visibleFields || visibleFields.includes(field)
  return (
    <article className="grid gap-3 border-b border-border pb-5 sm:grid-cols-[9rem_1fr_auto]">
      <div className="flex flex-col gap-1 text-sm tabular-nums">
        <span className="font-medium">{session.dayLabel}</span>
        {shown('time') ? <span className="text-muted-foreground">{session.timeLabel}</span> : null}
        {shown('room') ? <span className="text-muted-foreground">{session.room.name}</span> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap gap-1.5">
          {shown('track') && session.track ? <Badge variant="outline">{session.track.name}</Badge> : null}
          {shown('format') && session.format ? <Badge variant="secondary">{session.format.name}</Badge> : null}
        </div>
        <h2 className="text-lg font-semibold tracking-tight">{session.title}</h2>
        {shown('description') && session.description ? (
          <div className="flex flex-col items-start gap-1">
            <p className={cn('text-sm leading-6 text-muted-foreground', !expanded && 'line-clamp-2')}>{session.description}</p>
            <button type="button" className="text-sm font-medium hover:underline" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show less' : 'Show more'}
            </button>
          </div>
        ) : null}
        {shown('speakers') ? <SpeakerNames speakers={session.speakers} /> : null}
      </div>
      <Button size="sm" variant="outline" onClick={() => onOpen(session)}>Details</Button>
    </article>
  )
}

function SpeakerNames({ speakers }: { speakers: PublicSpeaker[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {speakers.map((speaker) => (
        <span key={speaker.id}>
          <strong>{speaker.name}</strong>
          {[speaker.jobTitle, speaker.companyName].filter(Boolean).length > 0 ? (
            <span className="text-muted-foreground"> · {[speaker.jobTitle, speaker.companyName].filter(Boolean).join(', ')}</span>
          ) : null}
        </span>
      ))}
    </div>
  )
}

function SpeakersList({
  speakers,
  sessions,
  onOpen,
}: {
  speakers: PublicSpeaker[]
  sessions: PublicSession[]
  onOpen: (speaker: PublicSpeaker) => void
}) {
  if (speakers.length === 0) return <ProgramEmpty />
  return (
    <div className="flex flex-col divide-y divide-border">
      {speakers.map((speaker) => (
        <button key={speaker.id} type="button" className="grid gap-4 py-4 text-left sm:grid-cols-[3rem_1fr_auto]" onClick={() => onOpen(speaker)}>
          <SpeakerPhoto speaker={speaker} />
          <span className="flex min-w-0 flex-col gap-1">
            <strong>{speaker.name}</strong>
            <span className="text-sm text-muted-foreground">{[speaker.jobTitle, speaker.companyName].filter(Boolean).join(' · ') || 'Speaker'}</span>
            {speaker.bio ? <span className="line-clamp-2 text-sm text-muted-foreground">{speaker.bio}</span> : null}
          </span>
          <span className="text-sm tabular-nums text-muted-foreground">{speaker.sessionIds.filter((id) => sessions.some((session) => session.id === id)).length} sessions</span>
        </button>
      ))}
    </div>
  )
}

function PublicAgenda({
  program,
  sessions,
  selectedDay,
  onDayChange,
  onOpen,
}: {
  program: PublicProgram
  sessions: PublicSession[]
  selectedDay: string
  onDayChange: (day: string) => void
  onOpen: (session: PublicSession) => void
}) {
  const daySessions = sessions.filter((session) => session.dayKey === selectedDay)
  const grid = layoutDayColumns({
    dayKey: selectedDay,
    rooms: program.rooms,
    placements: daySessions.map((session) => ({
      session,
      roomId: session.room.id,
      startMinute: session.startMinute,
      endMinute: session.endMinute,
    })),
  })
  return (
    <div className="flex flex-col gap-4">
      <DayTabs days={program.days} selectedDay={selectedDay} onChange={onDayChange} />
      {daySessions.length === 0 ? <ProgramEmpty /> : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <div
            className="grid min-w-[42rem]"
            style={{
              gridTemplateColumns: `4rem repeat(${program.rooms.length}, minmax(9rem, 1fr))`,
              gridTemplateRows: `2.5rem repeat(${grid.slots.length}, 1.35rem)`,
            }}
          >
            {program.rooms.map((room, index) => <strong key={room.id} className="border-b border-l border-border px-2 py-2 text-xs" style={{ gridColumn: index + 2 }}>{room.name}</strong>)}
            {grid.slots.map((minute, index) => minute % 60 === 0 ? <span key={minute} className="pr-2 text-right text-[11px] tabular-nums text-muted-foreground" style={{ gridRow: index + 2 }}>{minutesToLabel(minute)}</span> : null)}
            {program.rooms.flatMap((room, roomIndex) => grid.slots.map((minute, slotIndex) => <span key={`${room.id}-${minute}`} className="border-b border-l border-border/50" style={{ gridColumn: roomIndex + 2, gridRow: slotIndex + 2 }} />))}
            {grid.columns.flatMap((column, columnIndex) => column.items.map((item) => (
              <button
                key={item.session.id}
                type="button"
                onClick={() => onOpen(item.session)}
                className="z-10 m-0.5 flex flex-col gap-0.5 overflow-hidden rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-left"
                style={{
                  gridColumn: columnIndex + 2,
                  gridRow: `${item.startRow + 2} / span ${item.rowSpan}`,
                  width: `${100 / item.laneCount}%`,
                  marginLeft: `${(100 / item.laneCount) * item.lane}%`,
                }}
              >
                <strong className="w-full truncate text-xs">{item.session.title}</strong>
                <span className="w-full truncate text-[11px] text-muted-foreground">{item.session.track?.name ?? item.session.format?.name}</span>
              </button>
            )))}
          </div>
        </div>
      )}
    </div>
  )
}

function Itinerary({
  program,
  sessions,
  selectedDay,
  onDayChange,
  personalIds,
  personalOnly,
  onPersonalOnlyChange,
  onToggle,
  onOpen,
}: {
  program: PublicProgram
  sessions: PublicSession[]
  selectedDay: string
  onDayChange: (day: string) => void
  personalIds: string[]
  personalOnly: boolean
  onPersonalOnlyChange: (value: boolean) => void
  onToggle: (id: string) => void
  onOpen: (session: PublicSession) => void
}) {
  const daySessions = personalOnly
    ? sessions
    : sessions.filter((session) => session.dayKey === selectedDay)
  const exportHref = `/public/${encodeURIComponent(program.event.slug)}/personal.ics?${new URLSearchParams(personalIds.map((id) => ['session', id])).toString()}`
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {personalOnly
          ? <span className="text-sm font-medium">All event days</span>
          : <DayTabs days={program.days} selectedDay={selectedDay} onChange={onDayChange} />}
        <div className="flex items-center gap-2">
          <Button size="sm" variant={personalOnly ? 'default' : 'outline'} onClick={() => onPersonalOnlyChange(!personalOnly)}>
            My schedule ({personalIds.length})
          </Button>
          {personalIds.length > 0 ? <Button size="sm" variant="outline" render={<a href={exportHref} download />}>Export ICS</Button> : null}
        </div>
      </div>
      {daySessions.length === 0 ? <ProgramEmpty /> : daySessions.map((session) => (
        <article key={session.id} className="grid gap-3 border-b border-border pb-4 sm:grid-cols-[7rem_1fr_auto]">
          <div className="flex flex-col gap-1 tabular-nums"><strong>{session.timeLabel}</strong><span className="text-sm text-muted-foreground">{session.dayLabel}</span><span className="text-sm text-muted-foreground">{session.room.name}</span></div>
          <div className="flex flex-col gap-2">
            <span className="flex flex-wrap gap-1.5">{session.track ? <Badge variant="outline">{session.track.name}</Badge> : null}{session.format ? <Badge variant="secondary">{session.format.name}</Badge> : null}</span>
            <button type="button" className="text-left text-lg font-semibold hover:underline" onClick={() => onOpen(session)}>{session.title}</button>
            {session.description ? <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">{session.description}</p> : null}
            <SpeakerNames speakers={session.speakers} />
          </div>
          <Button size="sm" variant={personalIds.includes(session.id) ? 'default' : 'outline'} onClick={() => onToggle(session.id)}>
            <CalendarPlusIcon />
            {personalIds.includes(session.id) ? 'Added' : 'Add'}
          </Button>
        </article>
      ))}
    </div>
  )
}

function SpeakerGallery({ speakers, onOpen }: { speakers: PublicSpeaker[]; onOpen: (speaker: PublicSpeaker) => void }) {
  if (speakers.length === 0) return <ProgramEmpty />
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-4">
      {speakers.map((speaker) => (
        <button key={speaker.id} type="button" className="flex min-w-0 flex-col gap-3 text-left" onClick={() => onOpen(speaker)}>
          <SpeakerPhoto speaker={speaker} large />
          <span className="flex min-w-0 flex-col gap-0.5">
            <strong className="truncate">{speaker.name}</strong>
            <span className="truncate text-sm text-muted-foreground">{speaker.jobTitle || 'Speaker'}</span>
            <span className="truncate text-sm text-muted-foreground">{speaker.companyName || 'Independent'}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

function SpeakerPhoto({ speaker, large = false }: { speaker: PublicSpeaker; large?: boolean }) {
  if (speaker.photoUrl) return <img src={speaker.photoUrl} alt="" className={cn('size-12 rounded-full object-cover', large && 'aspect-square size-full rounded-lg bg-muted')} />
  return (
    <span className={cn('flex size-12 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground', large && 'aspect-square size-full rounded-lg text-3xl')}>
      {(speaker.firstName[0] ?? '') + (speaker.lastName[0] ?? '') || <UserRoundIcon />}
    </span>
  )
}

function DayTabs({ days, selectedDay, onChange }: { days: string[]; selectedDay: string; onChange: (day: string) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto">
      {days.map((day) => <Button key={day} size="sm" variant={day === selectedDay ? 'default' : 'ghost'} onClick={() => onChange(day)}>{formatDayLabel(day)}</Button>)}
    </div>
  )
}

function SessionDetail({ session, onClose }: { session: PublicSession | null; onClose: () => void }) {
  if (!session) return null
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader><DialogTitle>{session.title}</DialogTitle></DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2 text-sm text-muted-foreground"><span>{session.dayLabel} · {session.timeLabel}</span><span>·</span><span>{session.room.name}</span></div>
            <div className="flex flex-wrap gap-1.5">{session.track ? <Badge variant="outline">{session.track.name}</Badge> : null}{session.format ? <Badge variant="secondary">{session.format.name}</Badge> : null}</div>
            {session.description ? <p className="whitespace-pre-wrap text-sm leading-6">{session.description}</p> : null}
            <SpeakerNames speakers={session.speakers} />
            <div className="flex justify-end"><Button variant="outline" onClick={onClose}><XIcon />Close</Button></div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

function SpeakerDetail({ speaker, sessions, onClose }: { speaker: PublicSpeaker | null; sessions: PublicSession[]; onClose: () => void }) {
  if (!speaker) return null
  return <SpeakerDetailContent key={speaker.id} speaker={speaker} sessions={sessions} onClose={onClose} />
}

function SpeakerDetailContent({ speaker, sessions, onClose }: { speaker: PublicSpeaker; sessions: PublicSession[]; onClose: () => void }) {
  const [bioExpanded, setBioExpanded] = useState(false)
  const speakerSessions = sessions.filter((session) => speaker.sessionIds.includes(session.id))
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader><DialogTitle>{speaker.name}</DialogTitle></DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-[5rem_1fr]"><SpeakerPhoto speaker={speaker} /><div className="flex flex-col items-start gap-1"><strong>{speaker.jobTitle || 'Speaker'}</strong><span className="text-sm text-muted-foreground">{speaker.companyName || 'Independent'}</span>{speaker.bio ? <><p className={cn('text-sm leading-6', !bioExpanded && 'line-clamp-4')}>{speaker.bio}</p><button type="button" className="text-sm font-medium hover:underline" onClick={() => setBioExpanded(!bioExpanded)}>{bioExpanded ? 'Show less' : 'Show more'}</button></> : null}</div></div>
            <div className="flex flex-col gap-2"><strong>Sessions ({speakerSessions.length})</strong>{speakerSessions.map((session) => <div key={session.id} className="flex flex-col border-b border-border pb-2 text-sm"><span className="font-medium">{session.title}</span><span className="text-muted-foreground">{session.dayLabel} · {session.timeLabel} · {session.room.name}</span></div>)}</div>
            <div className="flex justify-end"><Button variant="outline" onClick={onClose}>Close</Button></div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

function ProgramEmpty() {
  return <EmptyState icon={<SearchIcon />} title="No matching program items" description="Clear the search or filters to see more of the published program." />
}
