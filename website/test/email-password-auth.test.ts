// Workerd integration tests for production email/password auth and verified-email access.
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { describe, expect, test } from 'vitest'
import { app } from '../src/app.tsx'

const password = 'correct-horse-battery-staple'
const signUpResponseSchema = z.object({
  token: z.string().nullable(),
  user: z.object({
    email: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable(),
    name: z.string(),
  }),
})

async function authRequest(path: string, body: Record<string, unknown>) {
  return app.handle(new Request(`http://localhost/api/auth/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
    },
    body: JSON.stringify(body),
  }))
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.getSetCookie()
    .find((value) => value.startsWith('better-auth.session_token='))
  if (!cookie) throw new Error('sign-in did not set a session cookie')
  return cookie.split(';', 1)[0]!
}

describe('email and password authentication', () => {
  test('creates an unverified credential account without a session', async () => {
    const email = 'new-password-user@example.test'
    const response = await authRequest('sign-up/email', {
      callbackURL: '/portal/summit',
      email,
      name: 'New Password User',
      password,
    })
    const body = signUpResponseSchema.parse(await response.json())
    const account = await env.DB.prepare(`
      SELECT user.email_verified, account.provider_id, account.password
      FROM user
      JOIN account ON account.user_id = user.id
      WHERE user.email = ?
    `).bind(email).first<{
      email_verified: number
      provider_id: string
      password: string
    }>()

    expect({
      status: response.status,
      body: {
        token: body.token,
        user: {
          email: body.user.email,
          emailVerified: body.user.emailVerified,
          image: body.user.image,
          name: body.user.name,
        },
      },
      account: account && {
        emailVerified: account.email_verified,
        passwordIsHashed: account.password !== password,
        providerId: account.provider_id,
      },
      sessionCookie: response.headers.getSetCookie().some((value) =>
        value.startsWith('better-auth.session_token='),
      ),
    }).toMatchInlineSnapshot(`
      {
        "account": {
          "emailVerified": 0,
          "passwordIsHashed": true,
          "providerId": "credential",
        },
        "body": {
          "token": null,
          "user": {
            "email": "new-password-user@example.test",
            "emailVerified": false,
            "image": null,
            "name": "New Password User",
          },
        },
        "sessionCookie": false,
        "status": 200,
      }
    `)
  })

  test('rejects password login until the email is verified', async () => {
    const email = 'pending-password-user@example.test'
    await authRequest('sign-up/email', { email, name: 'Pending User', password })

    const response = await authRequest('sign-in/email', { email, password })
    expect({ status: response.status, body: await response.json() }).toMatchInlineSnapshot(`
      {
        "body": {
          "code": "EMAIL_NOT_VERIFIED",
          "message": "Email not verified",
        },
        "status": 403,
      }
    `)
  })

  test('a verified credential session reaches the requested account', async () => {
    const email = 'verified-password-user@example.test'
    await authRequest('sign-up/email', { email, name: 'Verified User', password })
    await env.DB.prepare('UPDATE user SET email_verified = 1 WHERE email = ?').bind(email).run()

    const signIn = await authRequest('sign-in/email', { email, password })
    const cookie = sessionCookie(signIn)
    const dashboard = await app.handle(new Request('http://localhost/dashboard', {
      headers: { cookie },
    }))
    const org = await env.DB.prepare(`
      SELECT org.kind, org_member.role
      FROM org
      JOIN org_member ON org_member.org_id = org.org_id
      JOIN user ON user.id = org_member.user_id
      WHERE user.email = ?
    `).bind(email).first()

    expect({
      signInStatus: signIn.status,
      dashboardStatus: dashboard.status,
      org,
    }).toMatchInlineSnapshot(`
      {
        "dashboardStatus": 307,
        "org": {
          "kind": "personal",
          "role": "admin",
        },
        "signInStatus": 200,
      }
    `)
    expect(dashboard.headers.get('location')).toMatch(/^\/org\/[0-9A-Z]+$/)
  })

  test('an unverified session cannot create or claim a personal organization', async () => {
    const email = 'revoked-verification@example.test'
    await authRequest('sign-up/email', { email, name: 'Revoked Verification', password })
    await env.DB.prepare('UPDATE user SET email_verified = 1 WHERE email = ?').bind(email).run()
    const signIn = await authRequest('sign-in/email', { email, password })
    const cookie = sessionCookie(signIn)
    await env.DB.prepare('UPDATE user SET email_verified = 0 WHERE email = ?').bind(email).run()

    const dashboard = await app.handle(new Request('http://localhost/dashboard', {
      headers: { cookie },
    }))
    const org = await env.DB.prepare(`
      SELECT org.org_id
      FROM org
      JOIN user ON user.id = org.owner_user_id
      WHERE user.email = ?
    `).bind(email).first()

    expect({
      status: dashboard.status,
      location: dashboard.headers.get('location'),
      body: await dashboard.text(),
      org,
    }).toMatchInlineSnapshot(`
      {
        "body": "",
        "location": "/login?verify=required&callbackURL=%2Fdashboard",
        "org": null,
        "status": 307,
      }
    `)
  })
})
