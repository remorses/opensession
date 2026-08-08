import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ── Deterministic date formatting ───────────────────────────────────

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** "Oct 12, 2026" */
export function formatDateUTC(epochMs: number): string {
  const d = new Date(epochMs)
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

function dateParts(epochMs: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    timeZone: timezone,
  }).formatToParts(epochMs)
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
  return { day: value('day'), month: value('month') - 1, year: value('year') }
}

/** Formats an event's start and closing calendar days in its own timezone. */
export function formatDateRange({ startMs, endMs, timezone }: {
  startMs: number
  endMs: number
  timezone: string
}): string {
  const a = dateParts(startMs, timezone)
  const b = dateParts(endMs, timezone)
  const full = (date: typeof a) => `${MONTHS_SHORT[date.month]} ${date.day}, ${date.year}`
  if (a.year !== b.year) return `${full(a)} – ${full(b)}`
  if (a.month !== b.month) return `${MONTHS_SHORT[a.month]} ${a.day} – ${MONTHS_SHORT[b.month]} ${b.day}, ${b.year}`
  if (a.day !== b.day) return `${MONTHS_SHORT[a.month]} ${a.day} – ${b.day}, ${b.year}`
  return full(a)
}

/** "Oct 12 – 14, 2026", "Oct 30 – Nov 2, 2026", or "Dec 30, 2026 – Jan 2, 2027" */
export function formatDateRangeUTC(startMs: number, endMs: number): string {
  const a = new Date(startMs)
  const b = new Date(endMs)
  if (a.getUTCFullYear() !== b.getUTCFullYear()) {
    return `${formatDateUTC(startMs)} – ${formatDateUTC(endMs)}`
  }
  if (a.getUTCMonth() !== b.getUTCMonth()) {
    return `${MONTHS_SHORT[a.getUTCMonth()]} ${a.getUTCDate()} – ${MONTHS_SHORT[b.getUTCMonth()]} ${b.getUTCDate()}, ${b.getUTCFullYear()}`
  }
  if (a.getUTCDate() !== b.getUTCDate()) {
    return `${MONTHS_SHORT[a.getUTCMonth()]} ${a.getUTCDate()} – ${b.getUTCDate()}, ${b.getUTCFullYear()}`
  }
  return formatDateUTC(startMs)
}

/** "Oct 12, 2026 14:30 UTC" — deadline display (closesAt). */
export function formatDateTimeUTC(epochMs: number): string {
  const d = new Date(epochMs)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${formatDateUTC(epochMs)} ${hh}:${mm} UTC`
}

/** "2026-10-12" — the value format of <input type="date">. */
export function epochToDateInputUTC(epochMs: number): string {
  const d = new Date(epochMs)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
