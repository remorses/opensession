// OpenSession website: Cloudflare Worker serving the holocron landing page,
// user auth (better-auth Google login), and the org dashboard. Built on the
// akarso skeleton — auth flow, org resolution, and shell chrome are ported.
import './globals.css'

import { Spiceflow, redirect, json } from 'spiceflow'
import { Head, Link, ProgressBar, router } from 'spiceflow/react'
import { z } from 'zod'
import { app as holocronApp } from '@holocron.so/vite/app'
import { env } from 'cloudflare:workers'
import * as schema from 'db/schema'
import { ulid } from 'ulid'
import {
  getAuth,
  getSession,
  ensurePersonalOrg,
  lookupOrgMember,
  getOrgPageData,
  getOrgAccessData,
  getInvitation,
  getDb,
  requireSession,
} from './db.ts'
import { libraryOptions } from './forms/collect-fields.ts'
import { canAccessFile } from './lib/cfp-submission.ts'
import { getOrCreateCfpDraft, getPublicCfp, type PublicCfpForm } from './lib/cfp-server.ts'
import {
  coverageBySession,
  progressByReviewer,
  sessionsToReview,
} from './lib/reviews.ts'
import { linkSpeakerIdentity } from './lib/speaker-link.ts'
import {
  abstractsToCsv,
  aggregateReviewStats,
  countSessionsByTab,
  filterSessionsByTab,
  parseAbstractsStatusTab,
  sessionMatchesQuery,
} from './lib/submissions.ts'
import { summarizeAssignmentProgress } from './lib/tasks.ts'
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

  // ── Authenticated file storage ────────────────────────────────────

  .post('/api/upload', async ({ request }) => {
    const session = await requireSession(request)
    const body = await request.formData()
    const uploaded = body.get('file')
    const eventId = String(body.get('eventId') ?? '')
    const kindResult = z.enum(['HEADSHOT', 'SLIDES', 'DOCUMENT', 'IMAGE', 'OTHER'])
      .safeParse(body.get('kind'))
    if (!(uploaded instanceof File) || !eventId || !kindResult.success) {
      return json({ error: 'invalid_upload', message: 'File, eventId, and kind are required' }, { status: 400 })
    }
    if (uploaded.size > MAX_UPLOAD_BYTES) {
      return json({ error: 'file_too_large', message: 'Files must be 100 MB or smaller' }, { status: 413 })
    }
    if (!isAllowedUpload(uploaded, kindResult.data)) {
      return json({ error: 'unsupported_file', message: 'This file type is not supported' }, { status: 415 })
    }

    const db = getDb()
    const event = await db.query.event.findFirst({ where: { id: eventId } })
    if (!event) return json({ error: 'not_found', message: 'Event not found' }, { status: 404 })
    const [member, speaker] = await db.batch([
      db.query.orgMember.findFirst({ where: { userId: session.userId, orgId: event.orgId } }),
      db.query.speaker.findFirst({ where: { eventId, userId: session.userId } }),
    ] as const)
    if (!member && !speaker) return json({ error: 'not_found', message: 'Event not found' }, { status: 404 })

    const fileId = ulid()
    const fileName = sanitizeFileName(uploaded.name)
    const storageKey = `${eventId}/${fileId}/${fileName}`
    await env.FILES.put(storageKey, uploaded.stream(), {
      httpMetadata: { contentType: uploaded.type },
    })
    try {
      await db.insert(schema.file).values({
        id: fileId,
        eventId,
        kind: kindResult.data,
        fileName,
        mimeType: uploaded.type,
        sizeBytes: uploaded.size,
        storageKey,
        uploadedBySpeakerId: speaker?.id ?? null,
      })
    } catch (cause) {
      await env.FILES.delete(storageKey)
      throw cause
    }
    return { fileId, fileName, sizeBytes: uploaded.size }
  })

  .get('/files/:fileId', async ({ params, request }) => {
    const db = getDb()
    const file = await db.query.file.findFirst({
      where: { id: params.fileId },
      with: { event: true, formFieldValues: { with: { response: { with: { session: true } } } } },
    })
    if (!file?.event) return fileNotFound()

    const session = await getSession(request)
    const [linkedSpeaker, member, coverSession, headshotSpeakers] = await db.batch([
      db.query.speaker.findFirst({ where: { eventId: file.eventId, userId: session?.userId ?? '__signed-out__' } }),
      db.query.orgMember.findFirst({ where: { userId: session?.userId ?? '__signed-out__', orgId: file.event.orgId } }),
      db.query.eventSession.findFirst({
        where: { eventId: file.eventId, coverImageFileId: file.id, status: 'ACCEPTED', visibility: 'PUBLIC' },
      }),
      db.query.speaker.findMany({
        where: { eventId: file.eventId, headshotFileId: file.id },
        with: { participations: { with: { session: true } } },
      }),
    ] as const)
    const publicFieldReference = file.formFieldValues.some((value) =>
      value.response?.session?.status === 'ACCEPTED' && value.response.session.visibility === 'PUBLIC',
    )
    const publicHeadshot = headshotSpeakers.some((speaker) =>
      speaker.participations.some((participation) =>
        participation.session?.status === 'ACCEPTED' && participation.session.visibility === 'PUBLIC',
      ),
    )
    const owningSpeaker = Boolean(linkedSpeaker && (
      file.uploadedBySpeakerId === linkedSpeaker.id
      || headshotSpeakers.some((speaker) => speaker.id === linkedSpeaker.id)
      || file.formFieldValues.some((value) =>
        value.subjectSpeakerId === linkedSpeaker.id || value.response?.speakerId === linkedSpeaker.id,
      )
    ))
    if (!canAccessFile({
      isOrgMember: Boolean(member),
      isOwningSpeaker: owningSpeaker,
      hasPublicSessionReference: Boolean(coverSession) || publicFieldReference,
      isPublicSpeakerHeadshot: publicHeadshot,
    })) return fileNotFound()

    const object = await env.FILES.get(file.storageKey)
    if (!object) return fileNotFound()
    const headers = new Headers({
      'content-type': file.mimeType,
      'content-length': String(file.sizeBytes),
      'content-disposition': `attachment; filename="${file.fileName.replace(/["\\\r\n]/g, '_').slice(0, 160) || 'download'}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': publicHeadshot || coverSession || publicFieldReference ? 'public, max-age=300' : 'private, no-store',
    })
    return new Response(object.body, { headers })
  })

  // ── Public CFP submission ─────────────────────────────────────────

  .loader('/submit/:eventSlug/:formSlug', async ({ params, request }): Promise<{
    cfp: PublicCfpForm | null
    draft: Awaited<ReturnType<typeof getOrCreateCfpDraft>> | null
    capReached: boolean
  }> => {
    const cfp = await getPublicCfp(params.eventSlug, params.formSlug)
    if (!cfp) return { cfp: null, draft: null, capReached: false }
    const session = await getSession(request)
    if (!session) return { cfp, draft: null, capReached: false }
    try {
      const draft = await getOrCreateCfpDraft(cfp, session)
      return { cfp, draft, capReached: false }
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes('at most 3 sessions')) {
        return { cfp, draft: null, capReached: true }
      }
      throw cause
    }
  })

  .page('/submit/:eventSlug/:formSlug', async ({ params, loaderData }) => {
    if (!loaderData.cfp) return <PublicUnavailable />
    const { PublicCfpPage } = await import('./components/public-cfp-page.tsx')
    const { event, form, tracks, formats } = loaderData.cfp
    const callbackURL = `/submit/${params.eventSlug}/${params.formSlug}`
    return (
      <PublicCfpPage
        event={event}
        form={form}
        scope={{ tracks: libraryOptions(tracks), formats: libraryOptions(formats) }}
        mdxSource={loaderData.cfp.version.mdxSource}
        draft={loaderData.draft}
        capReached={loaderData.capReached}
        signInHref={router.href('/login/google', { callbackURL })}
      />
    )
  })

  // Task 6 replaces this small portal summary with the full portal shell.
  .loader('/portal/:eventSlug', async ({ params, request }): Promise<{
    portalEvent: typeof schema.event.$inferSelect | null
    portalSpeaker: ((typeof schema.speaker.$inferSelect) & {
      submissions: Array<typeof schema.eventSession.$inferSelect>
    }) | null
  }> => {
    const session = await getSession(request)
    if (!session) throw redirect(router.href('/login', { callbackURL: `/portal/${params.eventSlug}` }))
    const db = getDb()
    const event = await db.query.event.findFirst({ where: { slug: params.eventSlug } })
    if (!event) return { portalEvent: null, portalSpeaker: null }
    const speaker = await linkSpeakerIdentity({ eventId: event.id, session })
    if (!speaker) return { portalEvent: event, portalSpeaker: null }
    const submissions = await db.query.eventSession.findMany({
      where: { eventId: event.id, submitterSpeakerId: speaker.id, kind: 'CONTENT' },
      orderBy: { createdAt: 'desc' },
    })
    return { portalEvent: event, portalSpeaker: { ...speaker, submissions } }
  })

  .page('/portal/:eventSlug', async ({ loaderData }) => {
    if (!loaderData.portalEvent) return <PublicUnavailable />
    return (
      <main className="min-h-screen bg-background px-4 py-8 sm:px-6 sm:py-12">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
          <OpenSessionLogo imageClassName="h-8" />
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">Speaker portal</h1>
            <p className="text-sm text-muted-foreground">{loaderData.portalEvent.name}</p>
          </div>
          <div className="flex items-center justify-between border-b border-border pb-3">
            <h2 className="font-medium">My submissions</h2>
            <Badge variant="outline" className="px-1.5">Task 6 preview</Badge>
          </div>
          {loaderData.portalSpeaker?.submissions.length ? (
            <div className="flex flex-col divide-y divide-border border-y border-border">
              {loaderData.portalSpeaker.submissions.map((submission) => (
                <div key={submission.id} className="flex items-center justify-between gap-4 py-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate font-medium">{submission.title || 'Untitled draft'}</span>
                    <span className="font-mono text-xs text-muted-foreground">{submission.id}</span>
                  </div>
                  <Badge variant={submission.status === 'PENDING' ? 'warning' : 'secondary'} className="px-1.5">
                    {submission.status.toLowerCase()}
                  </Badge>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-muted-foreground">No submissions yet.</p>}
        </div>
      </main>
    )
  })

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

  // ── Abstracts list + detail + CSV ─────────────────────────────────

  .loader('/org/:orgId/e/:eventId/abstracts', async ({ params, request }) => {
    const db = getDb()
    const url = new URL(request.url)
    const statusTab = parseAbstractsStatusTab(url.searchParams.get('status'))
    const q = url.searchParams.get('q') ?? ''

    const rows = await db.query.eventSession.findMany({
      where: { eventId: params.eventId, kind: 'CONTENT' },
      with: {
        track: true,
        format: true,
        participants: {
          with: { speaker: true },
          orderBy: { sortOrder: 'asc' },
        },
        reviews: true,
        formResponses: {
          with: { form: true },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { submittedAt: 'desc', createdAt: 'desc' },
    })

    const abstracts = rows.map((row) => {
      const stats = aggregateReviewStats(row.reviews)
      const speakerNames = row.participants.map((p) => {
        const name = [p.speaker?.firstName, p.speaker?.lastName].filter(Boolean).join(' ').trim()
        return name || p.speaker?.email || 'Speaker'
      })
      const submittedResponse = row.formResponses.find((r) => r.status === 'SUBMITTED')
        ?? row.formResponses[0]
      return {
        id: row.id,
        status: row.status,
        title: row.title,
        trackName: row.track?.name ?? null,
        formatName: row.format?.name ?? null,
        speakerNames,
        formName: submittedResponse?.form?.name ?? null,
        avgRating: stats.avgRating,
        yes: stats.yes,
        maybe: stats.maybe,
        no: stats.no,
        notifiedAt: row.notifiedAt,
        submittedAt: row.submittedAt,
      }
    })

    const counts = countSessionsByTab(abstracts)
    const filtered = filterSessionsByTab(abstracts, statusTab).filter((row) =>
      sessionMatchesQuery(row, q),
    )
    return { abstracts: filtered, counts, status: statusTab, q }
  })

  .page({
    path: '/org/:orgId/e/:eventId/abstracts',
    query: z.object({
      status: z
        .enum([
          'all',
          'pending',
          'accept-queue',
          'accepted',
          'decline-queue',
          'declined',
          'withdrawn',
          'drafts',
        ])
        .optional(),
      q: z.string().optional(),
    }),
    handler: async ({ query }) => {
      const { AbstractsPage } = await import('./components/abstracts-page.tsx')
      return (
        <AbstractsPage
          status={query.status ?? 'all'}
          q={query.q ?? ''}
        />
      )
    },
  })

  .loader('/org/:orgId/e/:eventId/abstracts/:sessionId', async ({ params, request }) => {
    const sessionUser = await getSession(request)
    const db = getDb()
    const found = await db.query.eventSession.findFirst({
      where: { id: params.sessionId, eventId: params.eventId, kind: 'CONTENT' },
      with: {
        track: true,
        format: true,
        participants: {
          with: { speaker: true },
          orderBy: { sortOrder: 'asc' },
        },
        reviews: {
          with: { reviewer: true },
          orderBy: { updatedAt: 'desc' },
        },
        formResponses: {
          where: { status: 'SUBMITTED' },
          with: {
            form: true,
            fieldValues: true,
          },
          orderBy: { submittedAt: 'desc', createdAt: 'desc' },
        },
      },
    })
    if (!found) throw redirect(`/org/${params.orgId}/e/${params.eventId}/abstracts`)

    const latestResponse = found.formResponses[0] ?? null
    const speakerById = new Map(
      found.participants
        .filter((p) => p.speaker)
        .map((p) => [p.speakerId, p.speaker!] as const),
    )
    const fieldValues = (latestResponse?.fieldValues ?? [])
      .filter((fv) => {
        // Skip well-known fields already shown as typed session/speaker columns.
        if (['title', 'description', 'track', 'format', 'coverImage'].includes(fv.name)) {
          return false
        }
        if (fv.name.startsWith('speaker.')) return false
        return true
      })
      .map((fv) => {
        const subject = fv.subjectSpeakerId ? speakerById.get(fv.subjectSpeakerId) : null
        const subjectLabel = subject
          ? [subject.firstName, subject.lastName].filter(Boolean).join(' ').trim() || subject.email
          : null
        return {
          name: fv.name,
          value: fv.value,
          subjectSpeakerId: fv.subjectSpeakerId,
          subjectLabel,
        }
      })

    const reviews = found.reviews.map((review) => ({
      id: review.id,
      vote: review.vote,
      rating: review.rating,
      comment: review.comment,
      reviewerId: review.reviewerId,
      reviewerName: review.reviewer?.name?.trim() || review.reviewer?.email || 'Reviewer',
      reviewerEmail: review.reviewer?.email ?? '',
      updatedAt: review.updatedAt,
    }))
    const myReviewRow = sessionUser
      ? found.reviews.find((r) => r.reviewerId === sessionUser.userId)
      : null

    return {
      session: {
        id: found.id,
        status: found.status,
        title: found.title,
        description: found.description,
        submittedAt: found.submittedAt,
        decidedAt: found.decidedAt,
        notifiedAt: found.notifiedAt,
        withdrawnAt: found.withdrawnAt,
      },
      trackName: found.track?.name ?? null,
      formatName: found.format?.name ?? null,
      formName: latestResponse?.form?.name ?? null,
      participants: found.participants.map((p) => ({
        id: p.id,
        role: p.role,
        firstName: p.speaker?.firstName ?? '',
        lastName: p.speaker?.lastName ?? '',
        email: p.speaker?.email ?? '',
        companyName: p.speaker?.companyName ?? null,
        jobTitle: p.speaker?.jobTitle ?? null,
      })),
      reviews,
      myReview: myReviewRow
        ? {
            vote: myReviewRow.vote,
            rating: myReviewRow.rating,
            comment: myReviewRow.comment,
          }
        : null,
      fieldValues,
    }
  })

  .page('/org/:orgId/e/:eventId/abstracts/:sessionId', async () => {
    const { AbstractDetailPage } = await import('./components/abstract-detail.tsx')
    return <AbstractDetailPage />
  })

  .get('/org/:orgId/e/:eventId/abstracts.csv', async ({ params, request }) => {
    const sessionUser = await getSession(request)
    if (!sessionUser) throw redirect('/login')
    const member = await lookupOrgMember(sessionUser.userId, params.orgId)
    if (!member) throw redirect('/login')
    const db = getDb()
    const event = await db.query.event.findFirst({
      where: { id: params.eventId, orgId: params.orgId },
      columns: { id: true },
    })
    if (!event) throw redirect(`/org/${params.orgId}`)

    const url = new URL(request.url)
    const statusTab = parseAbstractsStatusTab(url.searchParams.get('status'))
    const q = url.searchParams.get('q') ?? ''

    const rows = await db.query.eventSession.findMany({
      where: { eventId: params.eventId, kind: 'CONTENT' },
      with: {
        track: true,
        format: true,
        participants: { with: { speaker: true }, orderBy: { sortOrder: 'asc' } },
        reviews: true,
        formResponses: { with: { form: true }, orderBy: { createdAt: 'desc' } },
      },
      orderBy: { submittedAt: 'desc', createdAt: 'desc' },
    })
    const abstracts = rows.map((row) => {
      const stats = aggregateReviewStats(row.reviews)
      const speakerNames = row.participants.map((p) => {
        const name = [p.speaker?.firstName, p.speaker?.lastName].filter(Boolean).join(' ').trim()
        return name || p.speaker?.email || 'Speaker'
      })
      const submittedResponse = row.formResponses.find((r) => r.status === 'SUBMITTED')
        ?? row.formResponses[0]
      return {
        status: row.status,
        title: row.title,
        trackName: row.track?.name ?? null,
        formatName: row.format?.name ?? null,
        speakerNames,
        formName: submittedResponse?.form?.name ?? null,
        avgRating: stats.avgRating,
        yes: stats.yes,
        maybe: stats.maybe,
        no: stats.no,
        notifiedAt: row.notifiedAt,
        submittedAt: row.submittedAt,
      }
    })
    const filtered = filterSessionsByTab(abstracts, statusTab).filter((row) =>
      sessionMatchesQuery(row, q),
    )
    const csv = abstractsToCsv(filtered)
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="abstracts-${params.eventId}.csv"`,
      },
    })
  })

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
  // ── Forms (CFP) list + MDX editor ─────────────────────────────────
  // The live MDX of a form is the newest FormVersion. List counts come
  // from ONE db.query (responses relation aggregated in JS — form counts
  // are small).

  .loader('/org/:orgId/e/:eventId/forms', async ({ params }) => {
    const db = getDb()
    const rows = await db.query.form.findMany({
      where: { eventId: params.eventId, purpose: 'CFP' },
      with: { responses: { columns: { id: true, status: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return { forms: rows.map(toFormListRow) }
  })

  .page({
    path: '/org/:orgId/e/:eventId/forms',
    query: z.object({
      // NOTE: zod .default() is not applied by spiceflow query validation —
      // use .optional() and normalize in the handler.
      status: z.enum(['all', 'draft', 'open', 'closed', 'archived']).optional(),
    }),
    handler: async ({ query }) => {
      const { FormsListPage } = await import('./components/forms-list.tsx')
      return <FormsListPage status={query.status ?? 'all'} />
    },
  })

  .loader('/org/:orgId/e/:eventId/forms/:formId', async ({ params }) => {
    const db = getDb()
    const found = await db.query.form.findFirst({
      where: { id: params.formId, eventId: params.eventId },
      with: {
        versions: { orderBy: { createdAt: 'desc', id: 'desc' } },
        responses: { columns: { id: true, status: true } },
      },
    })
    // Wrong event / stale id → back to the forms list.
    if (!found) throw redirect(`/org/${params.orgId}/e/${params.eventId}/forms`)
    const { versions, responses, ...form } = found
    return {
      form,
      versions: versions.map(({ id, createdAt, mdxSource }) => ({ id, createdAt, mdxSource })),
      submitted: responses.filter((row) => row.status === 'SUBMITTED').length,
      drafts: responses.filter((row) => row.status === 'DRAFT').length,
    }
  })

  .page('/org/:orgId/e/:eventId/forms/:formId', async () => {
    const { FormEditorPage } = await import('./components/form-editor.tsx')
    return <FormEditorPage />
  })
  // ── Evaluation ────────────────────────────────────────────────────

  .loader('/org/:orgId/e/:eventId/evaluation', async ({ params, request }) => {
    const sessionUser = await getSession(request)
    if (!sessionUser) throw redirect('/login')
    const db = getDb()
    const [sessions, allReviews, myReviews] = await db.batch([
      db.query.eventSession.findMany({
        where: { eventId: params.eventId, kind: 'CONTENT' },
        with: {
          track: true,
          format: true,
          participants: {
            with: { speaker: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
        orderBy: { submittedAt: 'desc', createdAt: 'desc' },
      }),
      db.query.review.findMany({
        where: { eventId: params.eventId },
        with: { reviewer: true },
      }),
      db.query.review.findMany({
        where: { eventId: params.eventId, reviewerId: sessionUser.userId },
      }),
    ] as const)

    const sessionRows = sessions.map((row) => {
      const speakerNames = row.participants.map((p) => {
        const name = [p.speaker?.firstName, p.speaker?.lastName].filter(Boolean).join(' ').trim()
        return name || p.speaker?.email || 'Speaker'
      })
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        speakerNames,
        trackName: row.track?.name ?? null,
        formatName: row.format?.name ?? null,
      }
    })

    const myReviewedIds = new Set(myReviews.map((r) => r.sessionId))
    const toReview = sessionsToReview(sessionRows, myReviewedIds)
    const myReviewRows = []
    for (const review of myReviews) {
      const session = sessionRows.find((s) => s.id === review.sessionId)
      if (!session) continue
      myReviewRows.push({
        ...session,
        vote: review.vote,
        rating: review.rating,
        comment: review.comment,
      })
    }

    return {
      toReview,
      myReviews: myReviewRows,
      reviewerProgress: progressByReviewer(allReviews),
      sessionCoverage: coverageBySession(sessionRows, allReviews),
    }
  })

  .page({
    path: '/org/:orgId/e/:eventId/evaluation',
    query: z.object({
      tab: z.enum(['to-review', 'my-reviews', 'progress']).optional(),
    }),
    handler: async ({ query }) => {
      const { EvaluationPage } = await import('./components/evaluation-page.tsx')
      return <EvaluationPage tab={query.tab ?? 'to-review'} />
    },
  })

  .page('/org/:orgId/e/:eventId/agenda', async () => (
    <ComingSoonPage
      title="Agenda"
      description="Schedule sessions across days and rooms, and spot room or speaker conflicts."
    />
  ))

  // ── Tasks ─────────────────────────────────────────────────────────

  .loader('/org/:orgId/e/:eventId/tasks', async ({ params }) => {
    const db = getDb()
    const [defs, portalForms] = await db.batch([
      db.query.taskDefinition.findMany({
        where: { eventId: params.eventId },
        with: {
          form: true,
          assignments: { columns: { id: true, status: true } },
        },
        orderBy: { sortOrder: 'asc', createdAt: 'asc' },
      }),
      db.query.form.findMany({
        where: { eventId: params.eventId, purpose: 'PORTAL' },
        columns: { id: true, name: true, target: true },
        orderBy: { name: 'asc' },
      }),
    ] as const)

    const tasks = defs.map((def) => {
      const progress = summarizeAssignmentProgress(def.assignments)
      return {
        id: def.id,
        title: def.title,
        instructionsHtml: def.instructionsHtml,
        target: def.target,
        source: def.source,
        formId: def.formId,
        formName: def.form?.name ?? null,
        dueAt: def.dueAt,
        sortOrder: def.sortOrder,
        ...progress,
      }
    })
    return { tasks, portalForms }
  })

  .page({
    path: '/org/:orgId/e/:eventId/tasks',
    query: z.object({
      tab: z.enum(['all', 'speaker', 'submission']).optional(),
    }),
    handler: async ({ query }) => {
      const { TasksPage } = await import('./components/tasks-page.tsx')
      return <TasksPage tab={query.tab ?? 'all'} />
    },
  })
  // ── Portal forms (?tab=speaker|submission) — same editor route ────

  .loader('/org/:orgId/e/:eventId/portal-forms', async ({ params }) => {
    const db = getDb()
    const rows = await db.query.form.findMany({
      where: { eventId: params.eventId, purpose: 'PORTAL' },
      with: { responses: { columns: { id: true, status: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return { forms: rows.map(toFormListRow) }
  })

  .page({
    path: '/org/:orgId/e/:eventId/portal-forms',
    query: z.object({
      tab: z.enum(['speaker', 'submission']).optional(),
    }),
    handler: async ({ query }) => {
      const { PortalFormsPage } = await import('./components/forms-list.tsx')
      return <PortalFormsPage tab={query.tab ?? 'speaker'} />
    },
  })
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

/** Map a form row (with its responses relation) to the list-row shape the
 *  forms/portal-forms tables render: response rows collapse to counts. */
function toFormListRow<T extends { responses: { status: 'DRAFT' | 'SUBMITTED' }[] }>({ responses, ...form }: T) {
  return {
    ...form,
    submitted: responses.filter((row) => row.status === 'SUBMITTED').length,
    drafts: responses.filter((row) => row.status === 'DRAFT').length,
  }
}

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

function PublicUnavailable() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="flex max-w-sm flex-col items-center gap-5 text-center text-balance">
        <OpenSessionLogo imageClassName="h-8" />
        <h1 className="text-xl font-semibold">This page is not available</h1>
        <p className="text-sm text-muted-foreground">The event or form may be closed, archived, or no longer public.</p>
      </div>
    </main>
  )
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'webp'])
const DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'key', 'pdf', 'ppt', 'pptx'])
const IMAGE_MIME_TYPES = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'])
const DOCUMENT_MIME_TYPES = new Set([
  'application/msword',
  'application/pdf',
  'application/vnd.apple.keynote',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

function isAllowedUpload(
  file: File,
  kind: typeof schema.file.$inferInsert.kind,
): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  const isImage = IMAGE_EXTENSIONS.has(extension) && IMAGE_MIME_TYPES.has(file.type)
  const isDocument = DOCUMENT_EXTENSIONS.has(extension) && DOCUMENT_MIME_TYPES.has(file.type)
  if (kind === 'HEADSHOT' || kind === 'IMAGE') return isImage
  if (kind === 'SLIDES' || kind === 'DOCUMENT') return isDocument
  return isImage || isDocument
}

function sanitizeFileName(fileName: string): string {
  const leaf = fileName.split(/[\\/]/).pop() ?? 'upload'
  const sanitized = leaf
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160)
  return sanitized || 'upload'
}

function fileNotFound() {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })
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
