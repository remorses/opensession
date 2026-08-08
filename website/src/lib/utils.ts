import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ── Deterministic UTC date formatting ───────────────────────────────
// Event dates are stored as UTC start/end-of-day epochs, so UTC getters
// recover the intended calendar dates. Never use toLocaleDateString for
// SSR'd dates — workerd and browsers format locales differently, causing
// hydration mismatches.

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** "Oct 12, 2026" */
export function formatDateUTC(epochMs: number): string {
  const d = new Date(epochMs)
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
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
