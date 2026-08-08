// OpenSession website: Cloudflare Worker serving the holocron landing page,
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
  getDb,
} from './db.ts'
import { cn, formatDateRangeUTC } from './lib/utils.ts'
import { Badge } from './components/ui/primitives.tsx'
import { normalizeAuthRedirectPath } from './auth-redirect.ts'
import { OpenSessionLogo } from './components/auth-page.tsx'

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
    const { EventSwitch } = await import('./components/event-switch.tsx')
    // Event pages get the EventSidebar (nested event layout) instead of the
    // org tab bar, and the main area drops its padding so the sidebar can
    // span full height — the event layout pads its own content.
    const isEventPage = loaderData.pathname.includes('/e/')
    return (
      <AppShell request={request}>
        <DashboardNavbar
          orgId={loaderData.currentOrgId}
          orgSlot={<OrgSwitch />}
          eventSlot={<EventSwitch />}
          userSlot={<UserMenu />}
        />
        <div className="border-t border-border" />
        {!isEventPage && (
          <>
            <DashboardTabBar pathname={loaderData.pathname} orgId={loaderData.currentOrgId} />
            <div className="border-t border-border" />
          </>
        )}
        <ContentFrame className="isolate grow relative flex flex-col">
          <GridDot position="tl" />
          <GridDot position="tr" />
          <main
            className={cn(
              'overflow-x-hidden min-w-0 grow',
              isEventPage ? 'flex' : 'p-4 sm:p-6',
            )}
          >
            {children}
          </main>
        </ContentFrame>
        <DashboardFooter themeSlot={<ThemeSelect />} />
      </AppShell>
    )
  })

  // ── Org index: land on the first event ────────────────────────────
  // No events list page — the navbar event switcher covers navigation.
  // The org index redirects to the newest event, or shows the create-
  // your-first-event empty state when the org has none.

  .page('/org/:orgId', async ({ params, loaderData }) => {
    const [first] = loaderData.events
    if (first) throw redirect(`/org/${params.orgId}/e/${first.id}`)
    const { NoEventsPage } = await import('./components/event-switch.tsx')
    return <NoEventsPage />
  })

  // ── Event shell (/org/:orgId/e/:eventId/*) ────────────────────────
  // Auth + org membership is guarded by the /org/:orgId/* loader above;
  // this level owns event resolution only: the event with its library
  // (tracks/formats/rooms) in ONE db.query. Events from other orgs (or
  // stale ids) bounce back to the org index.

  .loader('/org/:orgId/e/:eventId/*', async ({ params }) => {
    const db = getDb()
    const found = await db.query.event.findFirst({
      where: { id: params.eventId, orgId: params.orgId },
      with: {
        tracks: { orderBy: { sortOrder: 'asc', name: 'asc' } },
        formats: { orderBy: { sortOrder: 'asc', name: 'asc' } },
        rooms: { orderBy: { sortOrder: 'asc', name: 'asc' } },
      },
    })
    if (!found) throw redirect(`/org/${params.orgId}`)
    const { tracks, formats, rooms, ...event } = found
    return { event, tracks, formats, rooms }
  })

  .layout('/org/:orgId/e/:eventId/*', async ({ children }) => {
    const { EventSidebar } = await import('./components/event-shell.tsx')
    return (
      <div className="flex w-full min-w-0 grow">
        <EventSidebar />
        <div className="min-w-0 grow p-4 sm:p-6">{children}</div>
      </div>
    )
  })

  // ── Event dashboard (index) ───────────────────────────────────────
  // Simple overview for now: name, dates, status, count row. The full
  // KPI dashboard (per-form progress, nudges) is a later task.

  .page('/org/:orgId/e/:eventId', async ({ loaderData }) => {
    const { event } = loaderData
    const db = getDb()
    const [sessions, speakers, forms] = await db.batch([
      db.query.eventSession.findMany({ where: { eventId: event.id }, columns: { id: true } }),
      db.query.speaker.findMany({ where: { eventId: event.id }, columns: { id: true } }),
      db.query.form.findMany({ where: { eventId: event.id }, columns: { id: true } }),
    ] as const)
    const stats = [
      { label: 'Sessions', value: sessions.length },
      { label: 'Speakers', value: speakers.length },
      { label: 'Forms', value: forms.length },
    ]
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{event.name}</h1>
            <EventStatusBadge status={event.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {formatDateRangeUTC(event.startsAt, event.endsAt)}
            {' · '}
            {event.timezone}
            {event.location ? ` · ${event.location}` : ''}
          </p>
        </div>
        <div className="flex gap-10">
          {stats.map((stat) => (
            <div key={stat.label} className="flex flex-col gap-0.5">
              <span className="text-2xl font-semibold tabular-nums">{stat.value}</span>
              <span className="text-sm text-muted-foreground">{stat.label}</span>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          Publish a CFP form to start collecting submissions, then review abstracts and build the agenda.
        </p>
      </div>
    )
  })

  // ── Event sections (placeholders until their tasks land) ──────────
  // Every sidebar item is a registered page so navigation never 404s.

  .page('/org/:orgId/e/:eventId/abstracts', async () => (
    <ComingSoonPage
      title="Abstracts"
      description="Review submissions, move them through accept and decline queues, and notify speakers."
    />
  ))
  .page('/org/:orgId/e/:eventId/sessions', async () => (
    <ComingSoonPage
      title="Sessions"
      description="Accepted and service sessions with times, rooms, tracks, and visibility."
    />
  ))
  .page('/org/:orgId/e/:eventId/files', async () => (
    <ComingSoonPage
      title="Files"
      description="Every file uploaded to this event: headshots, slides, cover images, and logos."
    />
  ))
  // TEMPORARY demo — replaced by task 3 (real forms list + MDX editor).
  .page('/org/:orgId/e/:eventId/forms', async () => {
    const { FormsDemoPage } = await import('./forms/form-demo.tsx')
    return <FormsDemoPage />
  })
  .page('/org/:orgId/e/:eventId/evaluation', async () => (
    <ComingSoonPage
      title="Evaluation"
      description="Vote, rate, and comment on pending submissions; track review coverage."
    />
  ))
  .page('/org/:orgId/e/:eventId/agenda', async () => (
    <ComingSoonPage
      title="Agenda"
      description="Schedule sessions across days and rooms, and spot room or speaker conflicts."
    />
  ))
  .page('/org/:orgId/e/:eventId/tasks', async () => (
    <ComingSoonPage
      title="Tasks"
      description="Speaker and submission tasks with per-assignment progress and due dates."
    />
  ))
  .page('/org/:orgId/e/:eventId/portal-forms', async () => (
    <ComingSoonPage
      title="Portal Forms"
      description="Forms speakers fill from the portal, linkable from tasks."
    />
  ))
  .page('/org/:orgId/e/:eventId/speakers', async () => (
    <ComingSoonPage
      title="Speakers"
      description="Event speakers with profiles, confirmations, and outstanding tasks."
    />
  ))
  .page('/org/:orgId/e/:eventId/emails', async () => (
    <ComingSoonPage
      title="Emails"
      description="Outbox of every email sent for this event, with retries and reminder schedules."
    />
  ))

  // ── Event settings (?tab=details|tracks|formats|rooms|team) ───────

  .page({
    path: '/org/:orgId/e/:eventId/settings',
    query: z.object({
      // NOTE: spiceflow query validation does not apply zod .default() to the
      // parsed handler value — normalize undefined in the handler instead.
      tab: z.enum(['details', 'tracks', 'formats', 'rooms', 'team']).optional(),
    }),
    handler: async ({ query }) => {
      const { EventSettings } = await import('./components/event-settings.tsx')
      return <EventSettings tab={query.tab ?? 'details'} />
    },
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

// ── Event page helpers ──────────────────────────────────────────────

function EventStatusBadge({ status }: { status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' }) {
  const variant = status === 'ACTIVE' ? 'success' : status === 'ARCHIVED' ? 'outline' : 'secondary'
  return (
    <Badge variant={variant} className="px-1.5 capitalize">
      {status.toLowerCase()}
    </Badge>
  )
}

/** Consistent placeholder for event sections that later tasks implement.
    Registered as real pages so sidebar navigation never 404s. */
function ComingSoonPage({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Badge variant="outline" className="w-fit px-1.5">Coming soon</Badge>
    </div>
  )
}

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
        <Head.Title>OpenSession Dashboard</Head.Title>
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

function DashboardNavbar({ orgId, orgSlot, eventSlot, userSlot }: {
  orgId: string
  orgSlot: React.ReactNode
  eventSlot: React.ReactNode
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
            {/* self-end: the logo is shorter than the org/event switcher
                buttons, so bottom-align it with their baseline row. */}
            <Link href={`/org/${orgId}`} className="self-end hover:opacity-80 transition-opacity">
              <OpenSessionLogo />
            </Link>
            {orgSlot}
            <span className="text-muted-foreground/50 select-none">/</span>
            {eventSlot}
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
    { label: 'Overview', href: `/org/${orgId}` },
    { label: 'Members', href: `/org/${orgId}/members` },
  ] as const

  return (
    <div className="relative max-w-(--content-max-width) mx-auto w-full border-x border-border">
      <GridDot position="bl" />
      <GridDot position="br" />
      <div className="flex h-10 items-stretch gap-4 sm:gap-6 px-4 sm:px-6 overflow-x-auto scrollbar-hide">
        {tabs.map((tab) => {
          const active =
            tab.label === 'Overview'
              ? pathname === tab.href || pathname.includes('/e/')
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
          <span className="text-xs text-muted-foreground">© {new Date().getFullYear()} OpenSession</span>
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
