// OpenSessions website: Cloudflare Worker serving the holocron landing page,
// user auth (better-auth Google login), and the org dashboard. Built on the
// akarso skeleton — auth flow, org resolution, and shell chrome are ported.
import './globals.css'

import { Spiceflow, redirect, json } from 'spiceflow'
import { Head, Link, ProgressBar, router } from 'spiceflow/react'
import { z } from 'zod'
import { app as holocronApp } from '@holocron.so/vite/app'
import {
  getAuth,
  getSession,
  ensurePersonalOrg,
  lookupOrgMember,
  getOrgPageData,
  getOrgAccessData,
  getInvitation,
} from './db.ts'
import { cn } from './lib/utils.ts'
import { normalizeAuthRedirectPath } from './auth-redirect.ts'
import { OpenSessionsLogo } from './components/auth-page.tsx'

// ── Schemas ─────────────────────────────────────────────────────────

const loginQuerySchema = z.object({ callbackURL: z.string().optional() })

// ── OAuth redirect helper ───────────────────────────────────────────

async function createGoogleSignInRedirect(request: Pick<Request, 'headers'>, callbackURL: string) {
  const auth = getAuth()
  const { response, headers } = await auth.api.signInSocial({
    body: { provider: 'google', callbackURL },
    headers: request.headers,
    returnHeaders: true,
  })
  if (!response?.url) {
    throw json({ error: 'failed to start google sign-in' }, { status: 500 })
  }
  const redirectResponse = new Response(null, {
    status: 302,
    headers: { Location: response.url },
  })
  for (const cookie of headers.getSetCookie()) {
    redirectResponse.headers.append('Set-Cookie', cookie)
  }
  return redirectResponse
}

// ── Personal-org resolution ─────────────────────────────────────────
//
// Every auth/bounce redirect must land DIRECTLY on the final dashboard
// path in one hop — never on /dashboard, which would 302 again (redirect
// chains double the latency, and each extra hop re-runs getSession +
// ensurePersonalOrg against D1). /dashboard exists only as the stable
// entry point for external links where the org id can't be known upfront.

async function personalOrgPath(session: { userId: string; user: { name: string | null } }) {
  const org = await ensurePersonalOrg(session.userId, { name: session.user.name ?? undefined })
  return `/org/${org.orgId}`
}

// ── Main app ────────────────────────────────────────────────────────

export const app = new Spiceflow()

  // Auth middleware: intercept /api/auth/* and forward to better-auth
  .use(async ({ request }, next) => {
    if (request.parsedUrl.pathname.startsWith('/api/auth')) {
      const auth = getAuth()
      const res = await auth.handler(request)
      if (res.ok || res.status !== 404) return res
    }
    return next()
  })

  // ── Login page ────────────────────────────────────────────────────

  .page({
    path: '/login',
    query: loginQuerySchema,
    handler: async ({ request, query }) => {
      const session = await getSession(request)
      if (session) {
        // Already signed in: go straight to the destination. The
        // '/dashboard' default resolves to the personal org here so the
        // browser never bounces /login → /dashboard → /org/… .
        const target = normalizeAuthRedirectPath(query.callbackURL)
        throw redirect(target === '/dashboard' ? await personalOrgPath(session) : target)
      }
      const callbackURL = normalizeAuthRedirectPath(query.callbackURL)
      const { SignInButton } = await import('./components/login-button.tsx')
      const { AuthPage } = await import('./components/auth-page.tsx')
      return (
        <AuthPage
          title=""
          description="Sign in to manage your events, submissions, and speakers."
          footer={
            <SignInButton href={router.href('/login/google', { callbackURL })}>
              Sign in with Google
            </SignInButton>
          }
        />
      )
    },
  })

  .route({
    method: 'GET',
    path: '/login/google',
    query: loginQuerySchema,
    // Internal browser route: keep out of any public API document
    detail: { hide: true },
    async handler({ request, query }) {
      return createGoogleSignInRedirect(request, normalizeAuthRedirectPath(query.callbackURL))
    },
  })

  // ── Invite links (/invite/:invitationId) ──────────────────────────
  // Secret-link invites, sigillo-style: anyone with the link can join
  // the org after signing in, until the link expires.

  .page('/invite/:invitationId', async ({ params, request }) => {
    const { AuthPage } = await import('./components/auth-page.tsx')
    const invitation = await getInvitation(params.invitationId)

    if (!invitation || invitation.expiresAt < Date.now()) {
      return (
        <AuthPage
          title="Invalid invitation"
          description="This invite link is invalid or has expired. Ask an admin of the organization to send you a new one."
        />
      )
    }

    const session = await getSession(request)
    if (!session) {
      throw redirect(
        router.href('/login', {
          callbackURL: normalizeAuthRedirectPath(request.parsedUrl.pathname),
        }),
      )
    }

    const orgName = invitation.org?.name ?? 'this organization'
    const existing = await lookupOrgMember(session.userId, invitation.orgId)
    const { AcceptInviteButton } = await import('./components/access-tab.tsx')
    return (
      <AuthPage
        title={`Join ${orgName}`}
        description={
          existing
            ? 'You are already a member of this organization.'
            : `${invitation.creator?.name ?? 'An admin'} invited you to join this organization.`
        }
        footer={
          <AcceptInviteButton
            invitationId={invitation.invitationId}
            orgId={invitation.orgId}
            alreadyMember={Boolean(existing)}
          />
        }
      />
    )
  })

  // ── Dashboard resolver ────────────────────────────────────────────
  // /dashboard is the stable entry point (docs, emails, OAuth
  // callbackURL default): it authenticates, ensures the personal org
  // exists, and redirects into it in ONE hop.

  .get(
    '/dashboard',
    async ({ request }) => {
      const session = await getSession(request)
      if (!session) throw redirect('/login')
      throw redirect(await personalOrgPath(session))
    },
    { detail: { hide: true } },
  )

  // ── Org dashboard (/org/:orgId/*) ─────────────────────────────────
  // The org id lives in the URL. The wildcard loader guards auth +
  // membership and provides shell data (org switcher, user menu) plus
  // the org's events in ONE D1 batch round-trip.

  .loader('/org/:orgId/*', async ({ request, params }) => {
    const session = await getSession(request)
    if (!session) throw redirect('/login')

    const data = await getOrgPageData(session.userId, params.orgId)
    if (!data.currentOrg) {
      // Stale link or an org the user is not a member of: land on the
      // personal org DIRECTLY (single hop).
      throw redirect(await personalOrgPath(session))
    }

    const fallbackName = session.user.name ?? 'Personal'
    return {
      pathname: request.parsedUrl.pathname,
      user: session.user,
      orgName: data.currentOrg.name ?? fallbackName,
      currentOrgId: data.currentOrg.orgId,
      role: data.role,
      orgs: data.orgs.map((org) => ({
        orgId: org.orgId,
        name: org.name ?? (org.kind === 'personal' ? fallbackName : 'Team'),
      })),
      events: data.events,
    }
  })

  .layout('/org/:orgId/*', async ({ children, request, loaderData }) => {
    const { OrgSwitch, UserMenu, ThemeSelect } = await import('./components/dashboard-shell.tsx')
    return (
      <AppShell request={request}>
        <DashboardNavbar
          orgId={loaderData.currentOrgId}
          orgSlot={<OrgSwitch />}
          userSlot={<UserMenu />}
        />
        <div className="border-t border-border" />
        <DashboardTabBar pathname={loaderData.pathname} orgId={loaderData.currentOrgId} />
        <div className="border-t border-border" />
        <ContentFrame className="isolate grow relative">
          <GridDot position="tl" />
          <GridDot position="tr" />
          <main className="p-4 sm:p-6 overflow-x-hidden min-w-0">{children}</main>
        </ContentFrame>
        <DashboardFooter themeSlot={<ThemeSelect />} />
      </AppShell>
    )
  })

  // ── Events page (org index) ───────────────────────────────────────

  .page('/org/:orgId', async () => {
    const { EventsTab } = await import('./components/events-tab.tsx')
    return <EventsTab />
  })

  // ── Members page (org members + invite links) ─────────────────────

  .loader('/org/:orgId/members', async ({ request, params }) => {
    const session = await getSession(request)
    if (!session) throw redirect('/login')
    // One D1 read: members with users + org; caller membership derived
    // from the same result set.
    const data = await getOrgAccessData(session.userId, params.orgId)
    if (!data) throw redirect(await personalOrgPath(session))
    return {
      role: data.role,
      currentUserId: session.userId,
      orgKind: data.org.kind,
      ownerUserId: data.org.ownerUserId,
      members: data.members.map((row) => ({
        memberId: row.memberId,
        role: row.role,
        createdAt: row.createdAt,
        userId: row.userId,
        user: row.user
          ? { name: row.user.name, email: row.user.email, image: row.user.image }
          : null,
      })),
    }
  })

  .page('/org/:orgId/members', async () => {
    const { AccessTab } = await import('./components/access-tab.tsx')
    return <AccessTab />
  })

  // Mount holocron last — it serves the landing page and docs pages
  .use(holocronApp)

// ── Dashboard shell (sigillo-style chrome) ──────────────────────────
// HTML shell + navbar + tab bar + footer with the same decorative
// border-x/GridDot construction as sigillo/akarso. No aside: the org
// switcher lives in the header right after the logo, the user menu is a
// circle avatar on the right.

const appThemeScript = `(function(){var d=document.documentElement;var m=document.cookie.match(/(?:^|;\\s*)color-theme=(light|dark)(?:;|$)/);var t=m?m[1]:null;if(!t)t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';if(t==='dark')d.classList.add('dark');else d.classList.remove('dark')})()`

function getInitialThemeClass(request: Request) {
  const cookie = request.headers.get('cookie') ?? ''
  return /(?:^|;\s*)color-theme=dark(?:;|$)/.test(cookie) ? 'dark' : undefined
}

function AppShell({ children, request }: { children: React.ReactNode; request: Request }) {
  return (
    <html lang="en" className={getInitialThemeClass(request)} data-default-theme="system" suppressHydrationWarning>
      <Head>
        <Head.Meta charSet="UTF-8" />
        <Head.Meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <Head.Title>OpenSessions Dashboard</Head.Title>
      </Head>
      <body className="relative flex flex-col min-h-screen bg-background font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: appThemeScript }} />
        <ProgressBar color="var(--primary)" />
        {children}
      </body>
    </html>
  )
}

/** Decorative dot placed at border intersections. Must be inside a relative container.
    Outer circle masks the border crossing with the page bg, inner dot marks the joint. */
const gridDotPosition = {
  tl: 'top-0 left-0 -translate-x-1/2 -translate-y-1/2',
  tr: 'top-0 right-0 translate-x-1/2 -translate-y-1/2',
  bl: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2',
  br: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2',
} as const

function GridDot({ position }: { position: keyof typeof gridDotPosition }) {
  return (
    <div
      aria-hidden
      className={cn(
        'absolute z-20 size-5 rounded-full bg-background pointer-events-none',
        'after:content-[""] after:block after:size-[2px] after:rounded-full after:bg-foreground/40 after:m-auto',
        'flex items-center justify-center',
        gridDotPosition[position],
      )}
    />
  )
}

function ContentFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('max-w-(--content-max-width) mx-auto w-full border-x border-border', className)}>
      {children}
    </div>
  )
}

function DashboardNavbar({ orgId, orgSlot, userSlot }: {
  orgId: string
  orgSlot: React.ReactNode
  userSlot: React.ReactNode
}) {
  return (
    <nav className="sticky top-0 z-50 w-full bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="relative max-w-(--content-max-width) mx-auto border-x border-border">
        <GridDot position="bl" />
        <GridDot position="br" />
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            {/* Link straight to the current org — /dashboard would 302 and
                re-run session + org resolution on every logo click. */}
            <Link href={`/org/${orgId}`} className="hover:opacity-80 transition-opacity">
              <OpenSessionsLogo />
            </Link>
            {orgSlot}
          </div>
          <div className="flex items-center gap-4">
            <Link
              // @ts-ignore -- '/' is served by the mounted holocron app,
              // not a registered app route, so router.href can't type it.
              href="/"
              className="hidden sm:block text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Home
            </Link>
            {userSlot}
          </div>
        </div>
      </div>
    </nav>
  )
}

function DashboardTabBar({ pathname, orgId }: { pathname: string; orgId: string }) {
  const tabs = [
    { label: 'Events', href: `/org/${orgId}` },
    { label: 'Members', href: `/org/${orgId}/members` },
  ] as const

  return (
    <div className="relative max-w-(--content-max-width) mx-auto w-full border-x border-border">
      <GridDot position="bl" />
      <GridDot position="br" />
      <div className="flex h-10 items-stretch gap-4 sm:gap-6 px-4 sm:px-6 overflow-x-auto scrollbar-hide">
        {tabs.map((tab) => {
          const active =
            tab.label === 'Events'
              ? pathname === tab.href
              : pathname === tab.href || pathname.startsWith(`${tab.href}/`)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                'relative flex items-center shrink-0 whitespace-nowrap text-sm no-underline transition-colors duration-150',
                active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
              {active && <div className="absolute bottom-0 left-0 w-full h-[2.5px] bg-primary rounded-sm" />}
            </Link>
          )
        })}
      </div>
    </div>
  )
}

function DashboardFooter({ themeSlot }: { themeSlot: React.ReactNode }) {
  return (
    <footer className="flex flex-col">
      <div className="border-t border-border" />
      <div className="relative max-w-(--content-max-width) grow mx-auto w-full border-x border-border">
        <GridDot position="tl" />
        <GridDot position="tr" />
        <div className="flex flex-wrap items-center justify-end gap-4 px-6 py-5">
          {themeSlot}
          <span className="text-xs text-muted-foreground">© {new Date().getFullYear()} OpenSessions</span>
        </div>
      </div>
    </footer>
  )
}

export type App = typeof app

declare module 'spiceflow/react' {
  interface SpiceflowRegister {
    app: typeof app
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    return app.handle(request)
  },
} satisfies ExportedHandler<Env>
