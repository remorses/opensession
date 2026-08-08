// Locks the curated timezone list: every id must be a real IANA zone (the
// server rejects unknown ids on save), ids must be unique, and the derived
// labels must stay unambiguous inside their group.
import { describe, expect, test } from 'vitest'
import { formatDateRange } from './utils.ts'
import {
  defaultTimezone,
  isKnownTimezone,
  timezoneGroups,
  timezoneGroupsWith,
  timezoneLabel,
} from './timezones.ts'

const allZones = timezoneGroups.flatMap((group) => group.zones)

describe('timezoneGroups', () => {
  test('every id is a valid IANA zone the runtime accepts', () => {
    const invalid = allZones.filter((zone) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone })
        return false
      } catch {
        return true
      }
    })
    expect(invalid).toEqual([])
  })

  // V8 canonicalizes a few modern ids back to their CLDR legacy names. The
  // zones still behave correctly and the ids round-trip through the DB
  // unchanged (we store the string, we never store resolvedOptions), so this
  // is documented rather than forbidden.
  test('documents the ids V8 rewrites to legacy CLDR names', () => {
    const aliased = allZones
      .map((zone) => [zone, new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone] as const)
      .filter(([zone, resolved]) => zone !== resolved)
    expect(Object.fromEntries(aliased)).toMatchInlineSnapshot(`
      {
        "America/Argentina/Buenos_Aires": "America/Buenos_Aires",
        "Asia/Kathmandu": "Asia/Katmandu",
        "Asia/Kolkata": "Asia/Calcutta",
        "Europe/Kyiv": "Europe/Kiev",
      }
    `)
  })

  test('ids are unique', () => {
    expect(new Set(allZones).size).toBe(allZones.length)
  })

  test('labels are unique within their group', () => {
    for (const group of timezoneGroups) {
      const labels = group.zones.map(timezoneLabel)
      expect(new Set(labels).size).toBe(labels.length)
    }
  })
})

describe('timezoneLabel', () => {
  test('takes the last path segment and unescapes underscores', () => {
    expect(timezoneLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires')
    expect(timezoneLabel('Europe/Paris')).toBe('Paris')
    expect(timezoneLabel('UTC')).toBe('UTC')
  })
})

describe('timezoneGroupsWith', () => {
  test('returns the curated groups unchanged for a known id', () => {
    expect(timezoneGroupsWith('Europe/Paris')).toBe(timezoneGroups)
    expect(timezoneGroupsWith(undefined)).toBe(timezoneGroups)
  })

  test('prepends a Current group for a non-curated id so it stays selectable', () => {
    expect(timezoneGroupsWith('Antarctica/Troll')[0]).toEqual({
      label: 'Current',
      zones: ['Antarctica/Troll'],
    })
  })
})

describe('defaultTimezone', () => {
  test('is always a curated id', () => {
    expect(isKnownTimezone(defaultTimezone())).toBe(true)
  })
})

describe('formatDateRange', () => {
  test('formats event bounds in the event timezone', () => {
    expect(formatDateRange({
      startMs: Date.parse('2027-06-15T07:00:00.000Z'),
      endMs: Date.parse('2027-06-18T06:59:00.000Z'),
      timezone: 'America/Los_Angeles',
    })).toBe('Jun 15 – 17, 2027')

    expect(formatDateRange({
      startMs: Date.parse('2027-06-14T22:00:00.000Z'),
      endMs: Date.parse('2027-06-17T21:59:00.000Z'),
      timezone: 'Europe/Rome',
    })).toBe('Jun 15 – 17, 2027')
  })
})
