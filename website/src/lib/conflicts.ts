// Pure agenda conflict engine + day-grid bucketing (no DB, no React, no env).
//
// Two sessions conflict when their time ranges INTERSECT and they either share
// a room or share a participant speaker. Intervals are half-open [start, end):
// a talk ending at 10:00 and the next one starting at 10:00 are back-to-back,
// not a conflict. Rows without a full schedule (null room/start/end) are never
// conflicting — an unplaced session cannot double-book anything.
//
// TIMEZONE RULE: the agenda renders in `event.timezone`, but epochs are stored
// as UTC ms. Every conversion goes through zonedEpoch/toZonedSlot below, which
// use Intl with an EXPLICIT timeZone. Call them on the SERVER (loaders/actions)
// and hand the client plain numbers/strings; a hydrating component must never
// re-derive a zoned value, or SSR and the browser can disagree. The pure
// string helpers (minutesToLabel, formatDayLabel) are safe on both sides.
//
// DST: zonedEpoch resolves the UTC offset in two passes (guess with the naive
// offset, then re-resolve at the guessed instant). That is correct on both
// sides of a transition. The one case it cannot fix is a wall clock that does
// not exist (the spring-forward gap) — it lands on the instant right after the
// jump, which is the least surprising behavior for a schedule editor.

export type ConflictReason = 'ROOM' | 'SPEAKER'

/**
 * View model the agenda/sessions loaders emit and the client pages render.
 * It lives here (pure module) so the loader in app.tsx and the 'use client'
 * pages share ONE definition: renaming a field breaks tsc on both sides.
 * Every time field is already resolved to the event timezone by the loader.
 */
export type AgendaSessionRow = {
  id: string
  kind: 'CONTENT' | 'SERVICE'
  status: string
  title: string
  visibility: 'PUBLIC' | 'PRIVATE'
  roomId: string | null
  roomName: string | null
  trackName: string | null
  trackColor: string | null
  formatName: string | null
  defaultDurationMinutes: number | null
  startsAt: number | null
  endsAt: number | null
  /** Local day of the start instant, `YYYY-MM-DD`. */
  dayKey: string | null
  startMinute: number | null
  /** Clamped to 1440 when the block runs past local midnight. */
  endMinute: number | null
  /** "09:00 – 09:45". */
  timeLabel: string | null
  speakerNames: string[]
}

/** One conflicting pair, resolved to display strings by the agenda loader. */
export type AgendaConflictRow = {
  aId: string
  bId: string
  aTitle: string
  bTitle: string
  aKind: 'CONTENT' | 'SERVICE'
  bKind: 'CONTENT' | 'SERVICE'
  reason: ConflictReason
  /** Room name, or the shared speaker names. */
  detail: string
  dayKey: string | null
  timeLabel: string
}

/** The minimum shape the engine needs. Loaders map DB rows to this. */
export type ConflictSession = {
  id: string
  roomId: string | null
  startsAt: number | null
  endsAt: number | null
  speakerIds: string[]
}

export type Conflict = {
  aId: string
  bId: string
  reason: ConflictReason
  /** Set when reason is ROOM. */
  roomId?: string
  /** Set when reason is SPEAKER — every speaker shared by the pair. */
  speakerIds?: string[]
}

export type TimeRange = { startsAt: number | null; endsAt: number | null }

/** A row is schedulable-on-the-grid only when it has a real, positive range. */
function isScheduledRange(range: TimeRange): range is { startsAt: number; endsAt: number } {
  return (
    range.startsAt != null
    && range.endsAt != null
    && Number.isFinite(range.startsAt)
    && Number.isFinite(range.endsAt)
    && range.endsAt > range.startsAt
  )
}

/** Half-open intersection: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅. */
export function sessionsOverlap(a: TimeRange, b: TimeRange): boolean {
  if (!isScheduledRange(a) || !isScheduledRange(b)) return false
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt
}

function sharedSpeakers(a: ConflictSession, b: ConflictSession): string[] {
  if (a.speakerIds.length === 0 || b.speakerIds.length === 0) return []
  const other = new Set(b.speakerIds)
  return [...new Set(a.speakerIds.filter((id) => other.has(id)))]
}

/**
 * Every conflicting pair, ordered by start time then id so the Conflicts view
 * is stable across renders. A pair that shares BOTH a room and a speaker
 * yields two entries (one per reason) — organizers need to see both causes.
 */
export function findConflicts(sessions: ConflictSession[]): Conflict[] {
  const scheduled = sessions
    .filter((row) => isScheduledRange(row) && row.roomId != null)
    .sort((a, b) => (a.startsAt! - b.startsAt!) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const out: Conflict[] = []
  for (let i = 0; i < scheduled.length; i += 1) {
    for (let j = i + 1; j < scheduled.length; j += 1) {
      const a = scheduled[i]!
      const b = scheduled[j]!
      if (!sessionsOverlap(a, b)) continue
      if (a.roomId && a.roomId === b.roomId) {
        out.push({ aId: a.id, bId: b.id, reason: 'ROOM', roomId: a.roomId })
      }
      const speakerIds = sharedSpeakers(a, b)
      if (speakerIds.length > 0) {
        out.push({ aId: a.id, bId: b.id, reason: 'SPEAKER', speakerIds })
      }
    }
  }
  return out
}

/** Session ids involved in at least one conflict — the grid badges read this. */
export function conflictSessionIds(conflicts: Conflict[]): Set<string> {
  const ids = new Set<string>()
  for (const conflict of conflicts) {
    ids.add(conflict.aId)
    ids.add(conflict.bId)
  }
  return ids
}

/**
 * Conflicts a candidate placement WOULD create, ignoring the candidate's own
 * current row. Placement warns with this and still lets the organizer through:
 * a real schedule sometimes needs a temporary overlap.
 */
export function conflictsForPlacement({
  candidate,
  others,
}: {
  candidate: ConflictSession
  others: ConflictSession[]
}): Conflict[] {
  const pool = others.filter((row) => row.id !== candidate.id)
  return findConflicts([candidate, ...pool]).filter(
    (conflict) => conflict.aId === candidate.id || conflict.bId === candidate.id,
  )
}

// ── Timezone conversion ─────────────────────────────────────────────

export const MINUTES_IN_DAY = 24 * 60
export const DEFAULT_SLOT_MINUTES = 15
const DAY_MS = 86_400_000

function zonedParts(epochMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs))
  const map: Record<string, string> = {}
  for (const part of parts) map[part.type] = part.value
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Some engines emit "24" for midnight under h23; normalize defensively.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  }
}

/** UTC offset (ms) in force at `epochMs` for `timeZone`. */
function offsetAt(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - epochMs
}

export type ZonedSlot = {
  /** Local calendar day, `YYYY-MM-DD`. */
  dayKey: string
  /** Minutes since local midnight. */
  minutes: number
}

/** Epoch ms → local day + minutes in the event timezone. */
export function toZonedSlot(epochMs: number, timeZone: string): ZonedSlot {
  const p = zonedParts(epochMs, timeZone)
  return {
    dayKey: `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
    minutes: p.hour * 60 + p.minute,
  }
}

/** Local day + minutes in the event timezone → epoch ms. */
export function zonedEpoch(dayKey: string, minutes: number, timeZone: string): number {
  const [year, month, day] = dayKey.split('-').map(Number)
  if (!year || !month || !day) throw new Error(`Invalid day key: ${dayKey}`)
  const naive = Date.UTC(year, month - 1, day) + minutes * 60_000
  // Pass 1 guesses with the offset that applies at the naive instant; pass 2
  // re-resolves at the guess so a DST change between them is honored.
  const guess = naive - offsetAt(naive, timeZone)
  return naive - offsetAt(guess, timeZone)
}

/** Every local calendar day the event spans, inclusive of both ends. */
export function eventDayKeys(startsAt: number, endsAt: number, timeZone: string): string[] {
  const first = toZonedSlot(startsAt, timeZone).dayKey
  const last = toZonedSlot(Math.max(endsAt, startsAt), timeZone).dayKey
  const days: string[] = [first]
  // Step in the plain calendar space (noon UTC avoids any DST edge), so the
  // loop is independent of the zone's offset changes.
  let cursor = Date.parse(`${first}T12:00:00Z`)
  const lastCursor = Date.parse(`${last}T12:00:00Z`)
  // Hard cap: a malformed range must not spin forever.
  while (cursor < lastCursor && days.length < 400) {
    cursor += DAY_MS
    days.push(new Date(cursor).toISOString().slice(0, 10))
  }
  return days
}

// ── Deterministic labels (safe in hydrating components) ─────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** "Mon, Oct 12" from a `YYYY-MM-DD` key. Pure string/UTC math, no Intl. */
export function formatDayLabel(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00Z`)
  return `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
}

/** "09:45" from minutes since midnight. */
export function minutesToLabel(minutes: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_IN_DAY, Math.round(minutes)))
  const h = Math.floor(clamped / 60) % 24
  const m = clamped % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** "09:00 – 09:45" for a placed block. */
export function formatSlotRange(startMinute: number, endMinute: number): string {
  return `${minutesToLabel(startMinute)} – ${minutesToLabel(endMinute)}`
}

// ── Day grid bucketing ──────────────────────────────────────────────

/** Default visible window when the day has no early/late sessions. */
const DEFAULT_START_MINUTE = 8 * 60
const DEFAULT_END_MINUTE = 18 * 60

export type GridRoom = { id: string; name: string }

export type DayGridItem<T> = {
  session: T
  /** 0-based row index inside `slots`. */
  startRow: number
  rowSpan: number
  startMinute: number
  endMinute: number
  /** Side-by-side column inside the room, 0-based. Overlapping blocks in the
   *  same room MUST NOT be painted on top of each other — a double-booked room
   *  is exactly the case the organizer needs to read. */
  lane: number
  /** Number of lanes in this block's overlap cluster (its share of the width). */
  laneCount: number
}

export type DayGridColumn<T> = {
  roomId: string
  roomName: string
  items: DayGridItem<T>[]
}

export type DayGrid<T> = {
  dayKey: string
  slotMinutes: number
  startMinute: number
  endMinute: number
  /** Minute offset of every row, top to bottom. */
  slots: number[]
  columns: DayGridColumn<T>[]
}

type GridSession = { id: string; roomId: string | null; startsAt: number | null; endsAt: number | null }

/** A session already resolved to the event-timezone wall clock. */
export type ZonedPlacement<T> = {
  session: T
  roomId: string
  startMinute: number
  endMinute: number
}

/**
 * Bucket one local day into a room × time matrix. Sessions on another day, in
 * an unknown room, or unscheduled are left out; a session running past midnight
 * is clamped to the end of the day so it never spills into the next column set.
 *
 * Server-side entry point: it does the Intl timezone conversion. Client code
 * must call layoutDayColumns with minutes precomputed by a loader instead.
 */
export function buildDayGrid<T extends GridSession>({
  dayKey,
  timezone,
  rooms,
  sessions,
  slotMinutes = DEFAULT_SLOT_MINUTES,
}: {
  dayKey: string
  timezone: string
  rooms: GridRoom[]
  sessions: T[]
  slotMinutes?: number
}): DayGrid<T> {
  const roomIds = new Set(rooms.map((room) => room.id))
  const placements: ZonedPlacement<T>[] = []

  for (const session of sessions) {
    if (!session.roomId || !roomIds.has(session.roomId)) continue
    if (!isScheduledRange(session)) continue
    const start = toZonedSlot(session.startsAt!, timezone)
    if (start.dayKey !== dayKey) continue
    const end = toZonedSlot(session.endsAt!, timezone)
    placements.push({
      session,
      roomId: session.roomId,
      startMinute: start.minutes,
      endMinute: end.dayKey === dayKey ? end.minutes : MINUTES_IN_DAY,
    })
  }

  return layoutDayColumns({ dayKey, rooms, placements, slotMinutes })
}

/**
 * The pure half of the day grid: given placements already expressed in the
 * event's wall clock, compute the visible window, the row list, and the per-room
 * blocks. Safe to run in a hydrating client component because it touches no
 * Intl and no Date parsing.
 */
export function layoutDayColumns<T>({
  dayKey,
  rooms,
  placements,
  slotMinutes = DEFAULT_SLOT_MINUTES,
}: {
  dayKey: string
  rooms: GridRoom[]
  placements: ZonedPlacement<T>[]
  slotMinutes?: number
}): DayGrid<T> {
  const roomIds = new Set(rooms.map((room) => room.id))
  const placed = placements
    .filter((row) => roomIds.has(row.roomId))
    .map((row) => ({
      ...row,
      endMinute: Math.max(row.endMinute, row.startMinute + slotMinutes),
    }))

  const earliest = placed.reduce((min, row) => Math.min(min, row.startMinute), DEFAULT_START_MINUTE)
  const latest = placed.reduce((max, row) => Math.max(max, row.endMinute), DEFAULT_END_MINUTE)
  const startMinute = Math.max(0, Math.floor(earliest / 60) * 60)
  const endMinute = Math.min(MINUTES_IN_DAY, Math.ceil(latest / 60) * 60)

  const slots: number[] = []
  for (let minute = startMinute; minute < endMinute; minute += slotMinutes) slots.push(minute)

  const columns: DayGridColumn<T>[] = rooms.map((room) => {
    const inRoom = placed
      .filter((row) => row.roomId === room.id)
      .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute)
    const lanes = assignLanes(inRoom)
    return {
      roomId: room.id,
      roomName: room.name,
      items: inRoom.map((row, index) => ({
        session: row.session,
        startRow: Math.max(0, Math.round((row.startMinute - startMinute) / slotMinutes)),
        rowSpan: Math.max(1, Math.round((row.endMinute - row.startMinute) / slotMinutes)),
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        lane: lanes[index]!.lane,
        laneCount: lanes[index]!.laneCount,
      })),
    }
  })

  return { dayKey, slotMinutes, startMinute, endMinute, slots, columns }
}

/**
 * Classic calendar lane packing: walk start-ordered blocks, close a cluster
 * whenever a block starts after everything before it ended, and give every
 * block in a cluster the same laneCount so the widths line up.
 */
function assignLanes(
  rows: Array<{ startMinute: number; endMinute: number }>,
): Array<{ lane: number; laneCount: number }> {
  const out: Array<{ lane: number; laneCount: number }> = rows.map(() => ({ lane: 0, laneCount: 1 }))
  let clusterStartIndex = 0
  let clusterEnd = -1
  let laneEnds: number[] = []

  const closeCluster = (endIndex: number) => {
    for (let i = clusterStartIndex; i < endIndex; i += 1) out[i]!.laneCount = laneEnds.length || 1
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    if (row.startMinute >= clusterEnd) {
      closeCluster(index)
      clusterStartIndex = index
      laneEnds = []
      clusterEnd = -1
    }
    let lane = laneEnds.findIndex((end) => end <= row.startMinute)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(row.endMinute)
    } else {
      laneEnds[lane] = row.endMinute
    }
    out[index]!.lane = lane
    clusterEnd = Math.max(clusterEnd, row.endMinute)
  }
  closeCluster(rows.length)
  return out
}
