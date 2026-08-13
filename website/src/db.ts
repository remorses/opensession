// Worker-level database client, auth, and session helpers.
//
// getDb() creates a drizzle-orm/sqlite-proxy client bound to env.DB.
// Uses sqlite-proxy instead of drizzle-orm/d1 to avoid the batch findFirst
// crash (drizzle-team/drizzle-orm#2721).
// getAuth() creates a BetterAuth instance with Google social login.
//
// Auth is NOT a singleton: Cloudflare Workers need per-request env, so getAuth()
// builds a fresh instance each time. BetterAuth's cookieCache keeps session
// resolution fast (no DB query on most requests).
//
// Org semantics (ported from akarso): every user has exactly one auto-created
// 'personal' org, enforced race-safe by the partial unique index on
// (owner_user_id) WHERE kind = 'personal'. Membership is NEVER cached —
// removing a member must apply immediately.

import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from 'db/schema'
import { betterAuth } from 'better-auth/minimal'
import { drizzleAdapter } from 'better-auth-drizzle-adapter'
import { json } from 'spiceflow'
import { ulid } from 'ulid'
import { sendAccountVerificationEmail } from './lib/emails/send.ts'

// ── Drizzle client via D1 (sqlite-proxy driver) ─────────────────────

function d1ToRawRows(results: Record<string, unknown>[]) {
  return results.map((row) => Object.keys(row).map((k) => row[k]))
}

export function getDb() {
  return drizzle(
    async (sql, params, method) => {
      const stmt = env.DB.prepare(sql).bind(...params)
      if (method === 'run') { await stmt.run(); return { rows: [] as any[] } }
      const rows = await stmt.raw()
      if (method === 'get') return { rows: rows[0] as any }
      return { rows: rows as any[] }
    },
    async (queries) => {
      const stmts = queries.map((q) => env.DB.prepare(q.sql).bind(...q.params))
      const results = await env.DB.batch(stmts)
      return results.map((r, i) => {
        const rows = d1ToRawRows(r.results as Record<string, unknown>[])
        if (queries[i]!.method === 'get') return { rows: rows[0] as any }
        return { rows: rows as any[] }
      })
    },
    { schema, relations: schema.relations },
  )
}

// ── BetterAuth ──────────────────────────────────────────────────────

export function getAuth() {
  const db = getDb()
  const auth = betterAuth({
    baseURL: getBaseUrl(),
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      async onExistingUserSignUp({ user }, request) {
        if (user.emailVerified) return
        await auth.api.sendVerificationEmail({
          body: { email: user.email },
          headers: request?.headers,
        })
      },
    },
    emailVerification: {
      autoSignInAfterVerification: true,
      sendOnSignIn: true,
      async sendVerificationEmail({ user, url }) {
        await sendAccountVerificationEmail({ email: user.email, url })
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 365, // 1 year
      updateAge: 60 * 60 * 24, // refresh expiry every 1 day of activity
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: 'select_account',
      },
    },
    // Surface auth failures (OAuth callbacks, adapter errors) in worker logs.
    // Without this, better-auth swallows errors into its own console logging
    // and they're easy to miss when debugging.
    onAPIError: {
      onError(error) {
        console.error('better-auth API error:', error)
      },
    },
  })
  return auth
}

export function getBaseUrl(): string {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL
  return env.APP_URL
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

export function generateApiKeySecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `osk_${base64Url(bytes)}`
}

export async function hashApiKeySecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return base64Url(new Uint8Array(digest))
}

// ── Session helpers ─────────────────────────────────────────────────

export type Session = {
  userId: string
  user: { id: string; name: string; email: string; emailVerified: boolean; image: string | null }
}

type RequestHeaders = Pick<Request, 'headers'>

export async function getSession(request: RequestHeaders): Promise<Session | null> {
  if (!request.headers.has('cookie')) return null

  const auth = getAuth()
  let session: Awaited<ReturnType<typeof auth.api.getSession>>
  try {
    session = await auth.api.getSession({ headers: request.headers })
  } catch (cause) {
    console.error('Failed to get auth session:', cause)
    return null
  }
  if (!session) return null
  return {
    userId: session.user.id,
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image ?? null,
    },
  }
}

export async function requireSession(request: RequestHeaders): Promise<Session> {
  const session = await getSession(request)
  if (!session) {
    throw json({ message: 'Not authenticated', code: 'unauthorized' }, { status: 401 })
  }
  return session
}

export function requireVerifiedEmail(session: Session): string {
  if (!session.user.emailVerified) {
    throw json({ message: 'Verify your email address to continue', code: 'email_not_verified' }, { status: 403 })
  }
  return session.user.email.trim().toLowerCase()
}

// ── Org helpers ─────────────────────────────────────────────────────

export type MemberRole = typeof schema.orgMember.$inferSelect.role

export type OrgInfo = {
  orgId: string
  ownerUserId: string
  kind: typeof schema.org.$inferSelect.kind
  /** Display name shown in the dashboard org switcher. Callers fall back
   *  to the owner's user name when null. */
  name: string | null
}

function toOrgInfo(row: typeof schema.org.$inferSelect): OrgInfo {
  return {
    orgId: row.orgId,
    ownerUserId: row.ownerUserId,
    kind: row.kind,
    name: row.name,
  }
}

/** Look up a user's membership in an org, org row included (one statement).
 *  Returns null when the user is not a member — never leaks whether the
 *  org exists. */
export async function lookupOrgMember(userId: string, orgId: string): Promise<{
  org: OrgInfo
  role: MemberRole
  memberId: string
} | null> {
  const db = getDb()
  const member = await db.query.orgMember.findFirst({
    where: { userId, orgId },
    with: { org: true },
  })
  if (!member?.org) return null
  return { org: toOrgInfo(member.org), role: member.role, memberId: member.memberId }
}

export async function requireOrgMember(userId: string, orgId: string) {
  const member = await lookupOrgMember(userId, orgId)
  if (!member) {
    throw json({ code: 'forbidden', message: 'You are not a member of this organization' }, { status: 403 })
  }
  return member
}

export async function requireAdminRole(userId: string, orgId: string) {
  const member = await requireOrgMember(userId, orgId)
  if (member.role !== 'admin') {
    throw json({ code: 'forbidden', message: 'Only admins can do this' }, { status: 403 })
  }
  return member
}

/** Get or create the user's personal org. Idempotent and race-safe:
 *  concurrent first-creates collide on the org_owner_personal_unique
 *  index; the loser's batch (org + admin membership) rolls back
 *  atomically and re-reads the winner's row. `name` is only used on
 *  first creation; existing orgs keep their stored name. */
export async function ensurePersonalOrg(userId: string, opts?: { name?: string }): Promise<OrgInfo> {
  const db = getDb()
  const existing = await db.query.org.findFirst({
    where: { ownerUserId: userId, kind: 'personal' },
  })
  if (existing) return toOrgInfo(existing)

  const orgId = ulid()
  const name = opts?.name ?? null
  try {
    await db.batch([
      db.insert(schema.org).values({ orgId, ownerUserId: userId, kind: 'personal', name }),
      db.insert(schema.orgMember).values({ orgId, userId, role: 'admin' }),
    ] as const)
    return { orgId, ownerUserId: userId, kind: 'personal', name }
  } catch (err) {
    // Race: another request created the personal org first.
    const winner = await db.query.org.findFirst({
      where: { ownerUserId: userId, kind: 'personal' },
    })
    if (winner) return toOrgInfo(winner)
    throw err
  }
}

/** Require session + membership in an explicitly selected org (from the
 *  /org/:orgId path param). No personal-org fallback: an orgId the user
 *  is not a member of is a 403 — callers on page routes convert that
 *  into a redirect to /dashboard, which re-resolves the personal org. */
export async function requireOrgAccess(request: RequestHeaders, orgId: string): Promise<{
  session: Session
  org: OrgInfo
  role: MemberRole
}> {
  const session = await requireSession(request)
  const { org, role } = await requireOrgMember(session.userId, orgId)
  return { session, org, role }
}

/** Members tab data in ONE D1 read: members with their users and org.
 *  The caller's own membership is derived from the same result set, so
 *  no separate lookupOrgMember read is needed. Returns null when the
 *  caller is not a member — never leaks a foreign org's member list. */
export async function getOrgAccessData(userId: string, orgId: string) {
  const db = getDb()
  const members = await db.query.orgMember.findMany({
    where: { orgId },
    orderBy: { createdAt: 'asc' },
    with: { user: true, org: true },
  })
  const me = members.find((row) => row.userId === userId)
  if (!me?.org) return null
  return {
    role: me.role,
    org: toOrgInfo(me.org),
    members,
  }
}

/** Invite link lookup for the /invite/:invitationId page. Callers must
 *  only surface org/creator display names. */
export async function getInvitation(invitationId: string) {
  const db = getDb()
  return db.query.orgInvitation.findFirst({
    where: { invitationId },
    with: { org: true, creator: true, form: true },
  })
}

// ── Org page data ───────────────────────────────────────────────────

/** Everything the org page + shell needs, in a single D1 batch round-trip:
 *  all memberships (for the org switcher) and the current org's events.
 *  The current org comes from the /org/:orgId path param. Returns
 *  currentOrg null when the user is not a member of that org. */
export async function getOrgPageData(userId: string, orgId: string): Promise<{
  orgs: { orgId: string; name: string | null; kind: OrgInfo['kind'] }[]
  currentOrg: OrgInfo | null
  role: MemberRole | null
  events: (typeof schema.event.$inferSelect)[]
}> {
  const db = getDb()
  const [memberships, events] = await db.batch([
    db.query.orgMember.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      with: { org: true },
    }),
    db.query.event.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
    }),
  ] as const)

  const current = memberships.find((m) => m.orgId === orgId)
  const currentOrg = current?.org ? toOrgInfo(current.org) : null

  return {
    orgs: memberships.flatMap((m) => (m.org ? [{
      orgId: m.org.orgId,
      name: m.org.name,
      kind: m.org.kind,
    }] : [])),
    currentOrg,
    role: current?.role ?? null,
    // Only expose events when the caller is a member of the org.
    events: currentOrg ? events : [],
  }
}
