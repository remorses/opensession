// Proves each workerd test file receives fresh D1 and R2 storage.
import { env } from 'cloudflare:workers'
import dedent from 'string-dedent'
import { expect, test } from 'vitest'

const userId = 'workerd-fixture-user'
const objectKey = 'workerd-fixture-object'

test('another test file cannot see or collide with storage writes', async () => {
  const existingUser = await env.DB.prepare('SELECT id FROM user WHERE id = ?')
    .bind(userId)
    .first()
  const existingObject = await env.FILES.get(objectKey)
  expect({ existingUser, existingObject }).toEqual({
    existingUser: null,
    existingObject: null,
  })

  const now = Date.UTC(2026, 7, 9)
  await env.DB.prepare(dedent`
    INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(userId, 'Isolated User', 'isolated@example.test', 1, now, now).run()
  await env.FILES.put(objectKey, 'isolated-body')

  expect(await env.DB.prepare('SELECT name FROM user WHERE id = ?').bind(userId).first())
    .toEqual({ name: 'Isolated User' })
  expect(await (await env.FILES.get(objectKey))?.text()).toBe('isolated-body')
})
