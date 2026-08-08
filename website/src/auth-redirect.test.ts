// Pure unit tests for the login-redirect normalizer (no worker runtime).
import { describe, expect, test } from 'vitest'
import { normalizeAuthRedirectPath } from './auth-redirect.ts'

describe('normalizeAuthRedirectPath', () => {
  test('rejects non-path values', () => {
    expect(
      [undefined, '', 'https://evil.com', '//evil.com', 'dashboard'].map((value) =>
        normalizeAuthRedirectPath(value),
      ),
    ).toMatchInlineSnapshot(`
      [
        "/dashboard",
        "/dashboard",
        "/dashboard",
        "/dashboard",
        "/dashboard",
      ]
    `)
  })

  test('strips rsc transport artifacts', () => {
    expect(
      [
        '/invite/01ABC',
        '/org/01ORG/members.rsc?__rsc=1',
        '/index.rsc',
      ].map((value) => normalizeAuthRedirectPath(value)),
    ).toMatchInlineSnapshot(`
      [
        "/invite/01ABC",
        "/org/01ORG/members",
        "/",
      ]
    `)
  })
})
