// Hardcoded IANA timezone list for the event timezone picker (pure, no React).
//
// A curated list, not the full ~600-entry IANA database: organizers only ever
// pick the tz their conference physically runs in, and a short grouped list is
// far easier to scan in a native <select> than every zone alias ever shipped.
// Every entry here must be a real IANA id — timezones.test.ts asserts that with
// Intl, and the server re-validates on save (validateTimezone in actions.tsx).
//
// Labels are derived from the id (last path segment, underscores → spaces) so
// there is a single source of truth and no label/id drift.

export type TimezoneGroup = {
  label: string
  zones: string[]
}

export const timezoneGroups: TimezoneGroup[] = [
  {
    label: 'Universal',
    zones: ['UTC'],
  },
  {
    label: 'Americas',
    zones: [
      'America/Anchorage',
      'America/Los_Angeles',
      'America/Vancouver',
      'America/Denver',
      'America/Phoenix',
      'America/Chicago',
      'America/Mexico_City',
      'America/New_York',
      'America/Toronto',
      'America/Bogota',
      'America/Lima',
      'America/Halifax',
      'America/Santiago',
      'America/Sao_Paulo',
      'America/Argentina/Buenos_Aires',
    ],
  },
  {
    label: 'Europe & Africa',
    zones: [
      'Atlantic/Reykjavik',
      'Europe/Lisbon',
      'Europe/London',
      'Europe/Dublin',
      'Europe/Amsterdam',
      'Europe/Brussels',
      'Europe/Paris',
      'Europe/Madrid',
      'Europe/Berlin',
      'Europe/Zurich',
      'Europe/Rome',
      'Europe/Vienna',
      'Europe/Prague',
      'Europe/Warsaw',
      'Europe/Stockholm',
      'Europe/Oslo',
      'Europe/Copenhagen',
      'Europe/Helsinki',
      'Europe/Athens',
      'Europe/Bucharest',
      'Europe/Kyiv',
      'Europe/Istanbul',
      'Europe/Moscow',
      'Africa/Casablanca',
      'Africa/Lagos',
      'Africa/Cairo',
      'Africa/Nairobi',
      'Africa/Johannesburg',
    ],
  },
  {
    label: 'Asia',
    zones: [
      'Asia/Jerusalem',
      'Asia/Dubai',
      'Asia/Karachi',
      'Asia/Kolkata',
      'Asia/Kathmandu',
      'Asia/Dhaka',
      'Asia/Bangkok',
      'Asia/Jakarta',
      'Asia/Singapore',
      'Asia/Kuala_Lumpur',
      'Asia/Manila',
      'Asia/Hong_Kong',
      'Asia/Shanghai',
      'Asia/Taipei',
      'Asia/Seoul',
      'Asia/Tokyo',
    ],
  },
  {
    label: 'Oceania',
    zones: [
      'Australia/Perth',
      'Australia/Adelaide',
      'Australia/Brisbane',
      'Australia/Melbourne',
      'Australia/Sydney',
      'Pacific/Auckland',
      'Pacific/Fiji',
      'Pacific/Honolulu',
    ],
  },
]

const knownZones = new Set(timezoneGroups.flatMap((group) => group.zones))

/** True when `timezone` is one of the curated ids above. */
export function isKnownTimezone(timezone: string): boolean {
  return knownZones.has(timezone)
}

/** "America/Argentina/Buenos_Aires" → "Buenos Aires" */
export function timezoneLabel(timezone: string): string {
  const city = timezone.slice(timezone.lastIndexOf('/') + 1)
  return city.replaceAll('_', ' ')
}

/**
 * Groups to render in the picker for a given current value. Events created
 * before this list existed (or through the API) can hold a valid IANA id that
 * is not curated here; surface it as its own group so opening the settings
 * form never silently rewrites the event's timezone.
 */
export function timezoneGroupsWith(current: string | undefined | null): TimezoneGroup[] {
  if (!current || isKnownTimezone(current)) return timezoneGroups
  return [{ label: 'Current', zones: [current] }, ...timezoneGroups]
}

/**
 * The browser's timezone when it is in the curated list, else UTC. Safe to call
 * during SSR (Intl is missing in no-ICU builds, and the server's own zone is
 * not the organizer's).
 */
export function defaultTimezone(): string {
  if (typeof Intl === 'undefined') return 'UTC'
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  return resolved && isKnownTimezone(resolved) ? resolved : 'UTC'
}
