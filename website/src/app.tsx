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
import * as orm from 'drizzle-orm'
import { ulid } from 'ulid'
import { Zip, ZipPassThrough } from 'fflate'
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
import { collectFields, hasFileUploadField, libraryOptions, type FieldOption, type ValuesRecord } from './forms/collect-fields.ts'
import { loadAgendaSessions, speakerDisplayName } from './lib/agenda-server.ts'
import { canAccessFile, formScheduleBlock, restoreSubmissionValues } from './lib/cfp-submission.ts'
import {
  eventDayKeys,
  findConflicts,
  formatSlotRange,
  toZonedSlot,
  type AgendaConflictRow,
  type AgendaSessionRow,
} from './lib/conflicts.ts'
import {
  getOrCreateCfpDraft,
  lookupPublicCfp,
  publicCfpBlockMessage,
  type PublicCfpBlockReason,
  type PublicCfpForm,
} from './lib/cfp-server.ts'
import {
  aggregateEvaluationResults,
  coverageBySession,
  evaluationResultsToCsv,
  progressByReviewer,
  projectAssignedSession,
  reviewState,
} from './lib/reviews.ts'
import {
  draftValuesFromSpeaker,
  getPortalAssignment,
  getPortalSession,
  listPortalAssignments,
  listPortalSessions,
  loadOrganizerSpeakerDetail,
  loadSpeakerProfileForm,
  loadPortalContext,
  restoreCfpEditDraft,
} from './lib/portal-server.ts'
import { parsePortalTasksTab } from './lib/portal.ts'
import { runCron } from './lib/emails/cron.ts'
import {
  abstractsToCsv,
  countSessionsByTab,
  filterSessionsByTab,
  parseAbstractsStatusTab,
  sessionMatchesQuery,
} from './lib/submissions.ts'
import { summarizeAssignmentProgress } from './lib/tasks.ts'
import {
  latestTaskFileVersions,
  selectLatestZipEntries,
  taskFileSlotKey,
} from './lib/content-management.ts'
import { cn, formatDateRange } from './lib/utils.ts'
import { Badge } from './components/ui/primitives.tsx'
import { Toaster } from './components/ui/toast.tsx'
import { normalizeAuthRedirectPath } from './auth-redirect.ts'
import { OpenSessionLogo } from './components/auth-page.tsx'
import {
  buildPublicWidgetScript,
  filterPublicSessions,
  isPublicProgramSession,
  parsePublicWidgetFields,
  projectPublicProgram,
  renderPublicWidgetHtml,
  renderPublicWidgetXml,
  selectPublicWidgetData,
  type PublicProgram,
  type PublicProgramFilters,
} from './lib/public-program.ts'
import { buildIcsCalendar } from './lib/ics.ts'
import { contactMetrics } from './lib/contact-crm.ts'

// ── Schemas ─────────────────────────────────────────────────────────

const loginQuerySchema = z.object({ callbackURL: z.string().optional() })
const abstractsQuerySchema = z.object({
  status: z.enum([
    'all',
    'pending',
    'accept-queue',
    'accepted',
    'decline-queue',
    'declined',
    'withdrawn',
    'drafts',
  ]).optional(),
  q: z.string().optional(),
})
const publicProgramQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  track: z.string().trim().max(100).optional(),
  format: z.string().trim().max(100).optional(),
  room: z.string().trim().max(100).optional(),
})
const embedProgramQuerySchema = publicProgramQuerySchema.extend({
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  compact: z.enum(['0', '1']).optional(),
  fields: z.string().regex(/^(description|speakers|track|format|room|time|photo|jobTitle|company|bio|sessions)(,(description|speakers|track|format|room|time|photo|jobTitle|company|bio|sessions))*$/).optional(),
})
const publicWidgetViewSchema = z.enum(['sessions', 'speakers', 'agenda', 'itinerary', 'gallery'])
const widgetOutputQuerySchema = embedProgramQuerySchema.extend({ widget: publicWidgetViewSchema })
const personalIcsQuerySchema = z.object({ session: z.array(z.string().min(1).max(100)).min(1).max(100) })

type PortalSubmissionListRow = {
  id: string
  title: string | null
  status: typeof schema.eventSession.$inferSelect.status
  trackName: string | null
  formatName: string | null
}

type PortalAssignmentListRow = {
  id: string
  speakerId: string
  sessionId: string | null
  status: typeof schema.taskAssignment.$inferSelect.status
  target: 'SPEAKER' | 'SUBMISSION'
  source: 'MANUAL' | 'FORM'
  formId: string | null
  title: string
  sessionTitle: string | null
  dueAt: number | null
}

type PortalShellLoaderData = {
  portalMissing: boolean
  event: typeof schema.event.$inferSelect | null
  speaker: typeof schema.speaker.$inferSelect | null
  adminOrgPath: string | null
  userEmail: string
  userName: string
  submissions: PortalSubmissionListRow[]
  assignments: PortalAssignmentListRow[]
  openCfp: { slug: string; name: string } | null
}

type PortalTaskLoaderData = {
  assignment: {
    id: string
    title: string
    instructionsHtml: string | null
    source: 'MANUAL' | 'FORM'
    status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'
    sessionTitle: string | null
    dueAt: number | null
  } | null
  formMdx: string | null
  scope: { tracks: FieldOption[]; formats: FieldOption[] }
  initialValues: ValuesRecord
  initialParticipants: ValuesRecord[]
  deliverables: Array<{
    fieldName: string
    currentFileId: string
    versions: Array<{ id: string; fileName: string; sizeBytes: number; createdAt: number }>
    comments: Array<{ id: string; body: string; createdAt: number; authorName: string }>
  }>
}

function emptyPortalShell(userEmail: string, userName: string): PortalShellLoaderData {
  return {
    portalMissing: true,
    event: null,
    speaker: null,
    adminOrgPath: null,
    userEmail,
    userName,
    submissions: [],
    assignments: [],
    openCfp: null,
  }
}

// ── OAuth redirect helper ───────────────────────────────────────────

async function createGoogleSignInRedirect(request: Pick<Request, 'headers'>, callbackURL: string) {
  const auth = getAuth()
  const { response, headers } = await auth.api.signInSocial({
    body: { provider: 'google', callbackURL },
    headers: request.headers,
    returnHeaders: true,
  })
  if (!response?.url) {
    throw json({ message: 'Failed to start Google sign-in', code: 'sign_in_failed' }, { status: 500 })
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

  .layout('/login/*', rootLayout)
  .layout('/invite/*', rootLayout)
  .layout('/review/*', rootLayout)
  .layout('/submit/*', rootLayout)
  .layout('/portal/*', rootLayout)
  .layout('/embed/*', rootLayout)
  .layout('/public/*', rootLayout)
  .layout('/org/*', rootLayout)

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

    const reviewerInvite = invitation.purpose === 'EVALUATION_REVIEWER'
    const orgName = invitation.org?.name ?? 'this organization'
    const existing = reviewerInvite
      ? await getDb().query.evaluationReviewer.findFirst({ where: { formId: invitation.formId ?? '', userId: session.userId } })
      : await lookupOrgMember(session.userId, invitation.orgId)
    const { AcceptInviteButton } = await import('./components/access-tab.tsx')
    return (
      <AuthPage
        title={reviewerInvite ? `Review for ${invitation.form?.name ?? orgName}` : `Join ${orgName}`}
        description={
          existing
            ? reviewerInvite ? 'You already accepted this reviewer invitation.' : 'You are already a member of this organization.'
            : reviewerInvite
              ? `${invitation.creator?.name ?? 'An organizer'} invited you to review submissions. Sign in with ${invitation.invitedEmail}.`
              : `${invitation.creator?.name ?? 'An admin'} invited you to join this organization.`
        }
        footer={
          <AcceptInviteButton
            invitationId={invitation.invitationId}
            orgId={invitation.orgId}
            reviewFormId={reviewerInvite ? invitation.formId : null}
            alreadyMember={Boolean(existing)}
          />
        }
      />
    )
  })

  // Restricted reviewer routes do not load or serialize organizer data.
  .loader('/review/:formId', async ({ params, request }) => loadReviewerRound(request, params.formId))
  .page({
    path: '/review/:formId',
    query: z.object({ tab: z.enum(['to-review', 'my-reviews', 'progress']).optional() }),
    handler: async ({ query }) => {
      const { ReviewerDashboard } = await import('./components/reviewer-dashboard.tsx')
      return <ReviewerDashboard tab={query.tab ?? 'to-review'} />
    },
  })
  .loader('/review/:formId/:reviewId', async ({ params, request }) => {
    const data = await loadReviewerRound(request, params.formId)
    const assignment = data.assignments.find((row) => row.id === params.reviewId)
    if (!assignment) throw json({ message: 'Task assignment not found', code: 'not_found' }, { status: 404 })
    return { ...data, assignment }
  })
  .page('/review/:formId/:reviewId', async () => {
    const { ReviewerAssignmentPage } = await import('./components/reviewer-dashboard.tsx')
    return <ReviewerAssignmentPage />
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
    const assignmentId = String(body.get('taskAssignmentId') ?? '').trim()
    const responseId = String(body.get('formResponseId') ?? '').trim()
    const formId = String(body.get('formId') ?? '').trim()
    const fieldName = String(body.get('fieldName') ?? '').trim()
    if (!(uploaded instanceof File) || !eventId || !kindResult.success) {
      return json({ code: 'invalid_upload', message: 'File, eventId, and kind are required' }, { status: 400 })
    }
    if (uploaded.size > MAX_UPLOAD_BYTES) {
      return json({ code: 'file_too_large', message: 'Files must be 100 MB or smaller' }, { status: 413 })
    }
    if (!isAllowedUpload(uploaded, kindResult.data)) {
      return json({ code: 'unsupported_file', message: 'This file type is not supported' }, { status: 415 })
    }

    const db = getDb()
    const event = await db.query.event.findFirst({ where: { id: eventId } })
    if (!event) return json({ code: 'not_found', message: 'Event not found' }, { status: 404 })
    const [member, speaker] = await db.batch([
      db.query.orgMember.findFirst({ where: { userId: session.userId, orgId: event.orgId } }),
      db.query.speaker.findFirst({ where: { eventId, userId: session.userId } }),
    ] as const)
    if (!member && !speaker) return json({ code: 'not_found', message: 'Event not found' }, { status: 404 })
    const contextCount = [assignmentId, responseId, formId].filter(Boolean).length
    if (fieldName.length > 200 || contextCount > 1 || (contextCount > 0) !== Boolean(fieldName)) {
      return json({ code: 'invalid_upload_slot', message: 'Choose one form-owned upload slot' }, { status: 400 })
    }
    const assignment = assignmentId
      ? await db.query.taskAssignment.findFirst({
        where: { id: assignmentId, eventId },
        with: { taskDefinition: true },
      }) ?? null
      : null
    if (assignmentId) {
      if (!speaker || !assignment || assignment.speakerId !== speaker.id
        || assignment.taskDefinition?.source !== 'FORM') {
        return json({ code: 'not_found', message: 'Task assignment not found' }, { status: 404 })
      }
    }

    if (speaker && !member) {
      let mdxSource: string | null = null
      if (assignment) {
        const assignedFormId = assignment.taskDefinition?.formId
        const version = assignedFormId
          ? await db.query.formVersion.findFirst({ where: { formId: assignedFormId }, orderBy: { createdAt: 'desc', id: 'desc' } })
          : null
        mdxSource = version?.mdxSource ?? null
      } else if (responseId) {
        const response = await db.query.formResponse.findFirst({
          where: { id: responseId, eventId, speakerId: speaker.id },
          with: { form: true, formVersion: true },
        })
        if (response?.form?.purpose === 'CFP' && response.form.status === 'OPEN'
          && response.status === 'DRAFT' && formScheduleBlock(response.form) == null) {
          mdxSource = response.formVersion?.mdxSource ?? null
        }
      } else if (formId) {
        const form = await db.query.form.findFirst({
          where: { id: formId, eventId, purpose: 'PORTAL', target: 'SPEAKER', status: 'OPEN' },
        })
        const version = form && formScheduleBlock(form) == null
          ? await db.query.formVersion.findFirst({ where: { formId }, orderBy: { createdAt: 'desc', id: 'desc' } })
          : null
        mdxSource = version?.mdxSource ?? null
      }
      if (!mdxSource || !hasFileUploadField(mdxSource, fieldName)) {
        return json({ code: 'invalid_upload_slot', message: 'This file field is not available' }, { status: 400 })
      }
      const existingFiles = await db.query.file.findMany({
        where: { eventId, uploadedBySpeakerId: speaker.id },
      })
      const usedBytes = existingFiles.reduce((total, file) => total + file.sizeBytes, 0)
      if (existingFiles.length >= MAX_SPEAKER_FILES || usedBytes + uploaded.size > MAX_SPEAKER_UPLOAD_BYTES) {
        return json({ code: 'upload_quota_exceeded', message: 'Speaker upload quota exceeded' }, { status: 413 })
      }
    }

    const fileId = ulid()
    const fileName = sanitizeFileName(uploaded.name)
    const storageKey = `${eventId}/${fileId}/${fileName}`
    await env.FILES.put(storageKey, uploaded.stream(), {
      httpMetadata: { contentType: uploaded.type },
    })
    try {
      const insertFile = db.insert(schema.file).values({
        id: fileId,
        eventId,
        kind: kindResult.data,
        fileName,
        mimeType: uploaded.type,
        sizeBytes: uploaded.size,
        storageKey,
        uploadedBySpeakerId: speaker?.id ?? null,
        taskAssignmentId: assignment?.id ?? null,
        fieldName: assignment ? fieldName : null,
      })
      if (assignment && assignment.status !== 'COMPLETED') {
        await db.batch([
          insertFile,
          db.update(schema.taskAssignment).set({ status: 'IN_PROGRESS', updatedAt: Date.now() })
            .where(orm.eq(schema.taskAssignment.id, assignment.id)).limit(1),
        ] as const)
      } else await insertFile
    } catch (cause) {
      await env.FILES.delete(storageKey)
      throw cause
    }
    const versions = assignment
      ? await db.query.file.findMany({
          where: { eventId, taskAssignmentId: assignment.id, fieldName },
          orderBy: { createdAt: 'desc', id: 'desc' },
        })
      : []
    return {
      fileId,
      fileName,
      sizeBytes: uploaded.size,
      versions: versions.map((file) => ({
        id: file.id,
        fileName: file.fileName,
        sizeBytes: file.sizeBytes,
        createdAt: file.createdAt,
      })),
    }
  })

  .get('/files/:fileId', async ({ params, request }) => {
    const db = getDb()
    const file = await db.query.file.findFirst({
      where: { id: params.fileId },
      with: {
        event: true,
        taskAssignment: { with: { speaker: true } },
        formFieldValues: { with: { response: { with: { session: true } } } },
      },
    })
    if (!file?.event) return fileNotFound()
    const fileEvent = file.event

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
    const publicHeadshot = headshotSpeakers.some((speaker) =>
      speaker.participations.some((participation) =>
        participation.session ? isPublicProgramSession(fileEvent, participation.session) : false,
      ),
    )
    const owningSpeaker = Boolean(linkedSpeaker && (
      file.uploadedBySpeakerId === linkedSpeaker.id
      || headshotSpeakers.some((speaker) => speaker.id === linkedSpeaker.id)
      || file.formFieldValues.some((value) =>
        value.subjectSpeakerId === linkedSpeaker.id || value.response?.speakerId === linkedSpeaker.id,
      )
      || file.taskAssignment?.speaker?.id === linkedSpeaker.id
    ))
    if (!canAccessFile({
      isOrgMember: Boolean(member),
      isOwningSpeaker: owningSpeaker,
      isPublicSessionCover: Boolean(coverSession && isPublicProgramSession(fileEvent, coverSession)),
      isPublicSpeakerHeadshot: publicHeadshot,
    })) return fileNotFound()

    const object = await env.FILES.get(file.storageKey)
    if (!object) return fileNotFound()
    const headers = new Headers({
      'content-type': file.mimeType,
      'content-length': String(file.sizeBytes),
      'content-disposition': `attachment; filename="${file.fileName.replace(/["\\\r\n]/g, '_').slice(0, 160) || 'download'}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': publicHeadshot || coverSession ? 'public, max-age=300' : 'private, no-store',
    })
    return new Response(object.body, { headers })
  })

  .route({
    method: 'GET',
    path: '/org/:orgId/e/:eventId/files.zip',
    query: z.object({ slot: z.array(z.string()).min(1).max(100) }),
    async handler({ params, query, request, waitUntil }) {
      const session = await requireSession(request)
      const member = await lookupOrgMember(session.userId, params.orgId)
      if (!member) return fileNotFound()
      const db = getDb()
      const event = await db.query.event.findFirst({ where: { id: params.eventId, orgId: params.orgId } })
      if (!event) return fileNotFound()
      const files = await loadZipFiles({ db, eventId: event.id, selectedSlots: new Set(query.slot) })
      if (files.length === 0) return fileNotFound()
      const archive = streamZip(files)
      waitUntil(archive.done)
      return new Response(archive.readable, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${sanitizeFileName(event.slug)}-files.zip"`,
          'cache-control': 'private, no-store',
        },
      })
    },
  })

  // ── Public CFP submission ─────────────────────────────────────────

  .loader('/submit/:eventSlug/:formSlug', async ({ params, request }): Promise<{
    cfp: PublicCfpForm | null
    unavailableReason: PublicCfpBlockReason | null
    draft: Awaited<ReturnType<typeof getOrCreateCfpDraft>> | null
    capReached: boolean
    accountEmail: string | null
    accountName: string | null
  }> => {
    const lookup = await lookupPublicCfp(params.eventSlug, params.formSlug)
    if (!lookup.ok) {
      return {
        cfp: null,
        unavailableReason: lookup.reason,
        draft: null,
        capReached: false,
        accountEmail: null,
        accountName: null,
      }
    }
    const cfp = lookup.cfp
    const session = await getSession(request)
    if (!session) {
      return {
        cfp,
        unavailableReason: null,
        draft: null,
        capReached: false,
        accountEmail: null,
        accountName: null,
      }
    }
    try {
      const draft = await getOrCreateCfpDraft({ cfp, session })
      return {
        cfp,
        unavailableReason: null,
        draft,
        capReached: false,
        accountEmail: session.user.email,
        accountName: session.user.name,
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes('at most 3 sessions')) {
        return {
          cfp,
          unavailableReason: null,
          draft: null,
          capReached: true,
          accountEmail: session.user.email,
          accountName: session.user.name,
        }
      }
      throw cause
    }
  })

  .page('/submit/:eventSlug/:formSlug', async ({ params, loaderData }) => {
    if (!loaderData.cfp) {
      return <PublicUnavailable eventSlug={params.eventSlug} reason={loaderData.unavailableReason} />
    }
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
        accountEmail={loaderData.accountEmail}
        accountName={loaderData.accountName}
      />
    )
  })

  // ── Speaker portal (same origin, speaker-owned) ───────────────────

  .loader('/portal/:eventSlug/*', async ({ params, request }): Promise<PortalShellLoaderData> => {
    const session = await getSession(request)
    if (!session) {
      throw redirect(`/login?callbackURL=${encodeURIComponent(`/portal/${params.eventSlug}`)}`)
    }
    const ctx = await loadPortalContext(params.eventSlug, session)
    if (!ctx) {
      return emptyPortalShell(session.user.email, session.user.name)
    }
    const openCfpForms = ctx.event.status === 'ACTIVE'
      ? await getDb().query.form.findMany({
        where: { eventId: ctx.event.id, purpose: 'CFP', status: 'OPEN' },
        with: { versions: { orderBy: { createdAt: 'desc', id: 'desc' }, limit: 1 } },
        orderBy: { createdAt: 'asc' },
        limit: 20,
      })
      : []
    const openCfp = openCfpForms.find((form) => form.versions.length > 0 && formScheduleBlock(form) == null)
    // No speaker row yet: show portal shell with empty lists (must CFP or be invited).
    const [sessionRows, assignmentRows] = ctx.speaker
      ? await Promise.all([
        listPortalSessions(ctx.event.id, ctx.speaker.id),
        listPortalAssignments(ctx.event.id, ctx.speaker.id),
      ])
      : [[], []] as const
    return {
      portalMissing: false,
      event: ctx.event,
      speaker: ctx.speaker,
      adminOrgPath: ctx.adminOrgPath,
      userEmail: ctx.userEmail,
      userName: ctx.userName,
      submissions: sessionRows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        trackName: row.track?.name ?? null,
        formatName: row.format?.name ?? null,
      })),
      assignments: assignmentRows.map((row) => ({
        id: row.id,
        speakerId: row.speakerId,
        sessionId: row.sessionId,
        status: row.status,
        target: row.portal.target,
        source: row.portal.source,
        formId: row.portal.formId,
        title: row.taskDefinition?.title ?? 'Task',
        sessionTitle: row.session?.title ?? null,
        dueAt: row.dueAt,
      })),
      openCfp: openCfp ? { slug: openCfp.slug, name: openCfp.name } : null,
    }
  })

  .page('/portal/:eventSlug', async () => {
    const { PortalHomePage } = await import('./components/portal-shell.tsx')
    return <PortalHomePage />
  })

  .page('/portal/:eventSlug/submissions', async () => {
    const { PortalSubmissionsPage } = await import('./components/portal-shell.tsx')
    return <PortalSubmissionsPage />
  })

  .loader('/portal/:eventSlug/submissions/:sessionId', async ({ params, request }) => {
    const session = await getSession(request)
    if (!session) {
      throw redirect(`/login?callbackURL=${encodeURIComponent(`/portal/${params.eventSlug}/submissions/${params.sessionId}`)}`)
    }
    const ctx = await loadPortalContext(params.eventSlug, session)
    if (!ctx?.speaker) {
      const scope: { tracks: FieldOption[]; formats: FieldOption[] } = { tracks: [], formats: [] }
      return {
        detail: null,
        draft: null,
        scope,
        canEdit: false,
        editBlockMessage: null,
        canWithdraw: false,
      }
    }
    const loaded = await getPortalSession(ctx.event.id, ctx.speaker.id, params.sessionId)
    if (!loaded) {
      const scope: { tracks: FieldOption[]; formats: FieldOption[] } = { tracks: [], formats: [] }
      return {
        detail: null,
        draft: null,
        scope,
        canEdit: false,
        editBlockMessage: null,
        canWithdraw: false,
      }
    }
    const db = getDb()
    const [tracks, formats] = await db.batch([
      db.query.track.findMany({ where: { eventId: ctx.event.id }, orderBy: { sortOrder: 'asc', name: 'asc' } }),
      db.query.format.findMany({ where: { eventId: ctx.event.id }, orderBy: { sortOrder: 'asc', name: 'asc' } }),
    ] as const)
    return {
      detail: {
        id: loaded.session.id,
        title: loaded.session.title,
        description: loaded.session.description,
        status: loaded.session.status,
        trackName: loaded.session.track?.name ?? null,
        formatName: loaded.session.format?.name ?? null,
        speakers: loaded.session.participants.flatMap((row) => {
          if (!row.speaker) return []
          return [{
            id: row.speaker.id,
            firstName: row.speaker.firstName,
            lastName: row.speaker.lastName,
            email: row.speaker.email,
            roleLabel: participantRoleLabel(row.role, row.sortOrder),
          }]
        }),
      },
      draft: restoreCfpEditDraft(loaded),
      scope: { tracks: libraryOptions(tracks), formats: libraryOptions(formats) },
      canEdit: loaded.canEdit,
      editBlockMessage: loaded.editBlockMessage,
      canWithdraw: loaded.canWithdraw,
    }
  })

  .page('/portal/:eventSlug/submissions/:sessionId', async () => {
    const { PortalSubmissionDetailPage } = await import('./components/portal-shell.tsx')
    return <PortalSubmissionDetailPage />
  })

  .loader('/portal/:eventSlug/profile', async ({ params, request }) => {
    const session = await getSession(request)
    if (!session) {
      throw redirect(`/login?callbackURL=${encodeURIComponent(`/portal/${params.eventSlug}/profile`)}`)
    }
    const ctx = await loadPortalContext(params.eventSlug, session)
    if (!ctx?.speaker) {
      const initialValues: Record<string, string> = {}
      return { profileForm: null, profileMdx: null, initialValues }
    }
    const profile = await loadSpeakerProfileForm(ctx.event.id, ctx.speaker)
    if (!profile) {
      const initialValues: Record<string, string> = {}
      return { profileForm: null, profileMdx: null, initialValues }
    }
    return {
      profileForm: { id: profile.form.id, name: profile.form.name },
      profileMdx: profile.version?.mdxSource ?? null,
      initialValues: profile.initialValues,
    }
  })

  .page('/portal/:eventSlug/profile', async () => {
    const { PortalProfilePage } = await import('./components/portal-shell.tsx')
    return <PortalProfilePage />
  })

  .page({
    path: '/portal/:eventSlug/tasks',
    query: z.object({
      tab: z.enum(['all', 'mine', 'submission']).optional(),
    }),
    handler: async ({ query }) => {
      const { PortalTasksPage } = await import('./components/portal-shell.tsx')
      return <PortalTasksPage tab={parsePortalTasksTab(query.tab)} />
    },
  })

  .loader('/portal/:eventSlug/tasks/:assignmentId', async ({ params, request }): Promise<PortalTaskLoaderData> => {
    const session = await getSession(request)
    if (!session) {
      throw redirect(`/login?callbackURL=${encodeURIComponent(`/portal/${params.eventSlug}/tasks/${params.assignmentId}`)}`)
    }
    const ctx = await loadPortalContext(params.eventSlug, session)
    if (!ctx?.speaker) {
      return {
        assignment: null,
        formMdx: null,
        scope: { tracks: [], formats: [] },
        initialValues: {},
        initialParticipants: [],
        deliverables: [],
      }
    }
    const loaded = await getPortalAssignment(ctx.event.id, ctx.speaker.id, params.assignmentId)
    if (!loaded) {
      return {
        assignment: null,
        formMdx: null,
        scope: { tracks: [], formats: [] },
        initialValues: {},
        initialParticipants: [],
        deliverables: [],
      }
    }
    const db = getDb()
    const [tracks, formats] = await db.batch([
      db.query.track.findMany({ where: { eventId: ctx.event.id }, orderBy: { sortOrder: 'asc', name: 'asc' } }),
      db.query.format.findMany({ where: { eventId: ctx.event.id }, orderBy: { sortOrder: 'asc', name: 'asc' } }),
    ] as const)
    const profileDraft = draftValuesFromSpeaker(ctx.speaker)
    const def = loaded.assignment.taskDefinition
    return {
      assignment: {
        id: loaded.assignment.id,
        title: def?.title ?? 'Task',
        instructionsHtml: def?.instructionsHtml ?? null,
        source: def?.source ?? 'MANUAL',
        status: loaded.assignment.status,
        sessionTitle: loaded.assignment.session?.title ?? null,
        dueAt: loaded.assignment.dueAt,
      },
      formMdx: loaded.formVersion?.mdxSource ?? null,
      scope: { tracks: libraryOptions(tracks), formats: libraryOptions(formats) },
      initialValues: {
        ...profileDraft.values,
        ...Object.fromEntries(
          latestTaskFileVersions(loaded.assignment.files).map((slot) => [slot.fieldName, slot.currentFileId]),
        ),
      },
      initialParticipants: [],
      deliverables: latestTaskFileVersions(loaded.assignment.files).map((slot) => ({
        fieldName: slot.fieldName,
        currentFileId: slot.currentFileId,
        versions: slot.versions.map((file) => ({
          id: file.id,
          fileName: file.fileName,
          sizeBytes: file.sizeBytes,
          createdAt: file.createdAt,
        })),
        comments: loaded.assignment.comments
          .filter((comment) => comment.fieldName === slot.fieldName)
          .map((comment) => ({
            id: comment.id,
            body: comment.body,
            createdAt: comment.createdAt,
            authorName: comment.author?.name ?? 'User',
          })),
      })),
    }
  })

  .page('/portal/:eventSlug/tasks/:assignmentId', async () => {
    const { PortalTaskDetailPage } = await import('./components/portal-shell.tsx')
    return <PortalTaskDetailPage />
  })

  // ── Published program, feeds, and iframe widgets ──────────────────
  // Both route families call loadPublicProgram(). This is the only anonymous
  // projection and therefore the only place publication and approval gates live.

  .loader('/public/:eventSlug/*', async ({ params, response }) => {
    response.headers.set('cache-control', 'no-store')
    return { program: await loadPublicProgram(params.eventSlug) }
  })
  .loader('/embed/:eventSlug/*', async ({ params, response }) => {
    response.headers.set('cache-control', 'no-store')
    return { program: await loadPublicProgram(params.eventSlug) }
  })
  .get('/public/:eventSlug', async ({ params }) => {
    throw redirect(`/public/${encodeURIComponent(params.eventSlug)}/sessions`)
  }, { detail: { hide: true } })
  .page({
    path: '/public/:eventSlug/sessions',
    query: publicProgramQuerySchema,
    handler: async ({ loaderData, query }) => renderPublicProgram({ program: loaderData.program, view: 'sessions', filters: query }),
  })
  .page({
    path: '/public/:eventSlug/speakers',
    query: publicProgramQuerySchema,
    handler: async ({ loaderData, query }) => renderPublicProgram({ program: loaderData.program, view: 'speakers', filters: query }),
  })
  .page({
    path: '/public/:eventSlug/agenda',
    query: publicProgramQuerySchema,
    handler: async ({ loaderData, query }) => renderPublicProgram({ program: loaderData.program, view: 'agenda', filters: query }),
  })
  .page({
    path: '/public/:eventSlug/itinerary',
    query: publicProgramQuerySchema,
    handler: async ({ loaderData, query }) => renderPublicProgram({ program: loaderData.program, view: 'itinerary', filters: query }),
  })
  .page({
    path: '/public/:eventSlug/gallery',
    query: publicProgramQuerySchema,
    handler: async ({ loaderData, query }) => renderPublicProgram({ program: loaderData.program, view: 'gallery', filters: query }),
  })
  .page({
    path: '/embed/:eventSlug/sessions',
    query: embedProgramQuerySchema,
    handler: async ({ loaderData, query, response }) => renderValidatedEmbedProgram({ program: loaderData.program, view: 'sessions', query, headers: response.headers }),
  })
  .page({
    path: '/embed/:eventSlug/speakers',
    query: embedProgramQuerySchema,
    handler: async ({ loaderData, query, response }) => renderValidatedEmbedProgram({ program: loaderData.program, view: 'speakers', query, headers: response.headers }),
  })
  .page({
    path: '/embed/:eventSlug/agenda',
    query: embedProgramQuerySchema,
    handler: async ({ loaderData, query, response }) => renderValidatedEmbedProgram({ program: loaderData.program, view: 'agenda', query, headers: response.headers }),
  })
  .page({
    path: '/embed/:eventSlug/itinerary',
    query: embedProgramQuerySchema,
    handler: async ({ loaderData, query, response }) => renderValidatedEmbedProgram({ program: loaderData.program, view: 'itinerary', query, headers: response.headers }),
  })
  .page({
    path: '/embed/:eventSlug/gallery',
    query: embedProgramQuerySchema,
    handler: async ({ loaderData, query, response }) => renderValidatedEmbedProgram({ program: loaderData.program, view: 'gallery', query, headers: response.headers }),
  })
  .get('/public/:eventSlug/schedule.json', async ({ params, query }) => {
      const program = await loadPublicProgram(params.eventSlug)
      if (!program) return json({ message: 'Program not found', code: 'not_found' }, { status: 404 })
      return json({ event: program.event, sessions: filterPublicSessions(program.sessions, query) }, { headers: publicFeedHeaders('application/json; charset=utf-8') })
    }, { query: publicProgramQuerySchema })
  .get('/public/:eventSlug/speakers.json', async ({ params }) => {
    const program = await loadPublicProgram(params.eventSlug)
    if (!program) return json({ message: 'Program not found', code: 'not_found' }, { status: 404 })
    return json({ event: program.event, speakers: program.speakers }, { headers: publicFeedHeaders('application/json; charset=utf-8') })
  })
  .get('/public/:eventSlug/widget.json', async ({ params, query }) => {
    const program = await loadPublicProgram(params.eventSlug)
    if (!program) return json({ message: 'Program not found', code: 'not_found' }, { status: 404 })
    const { widget, accent: _accent, compact: _compact, fields: _fields, ...filters } = query
    return json(selectPublicWidgetData({ program, view: widget, filters }), { headers: publicFeedHeaders('application/json; charset=utf-8') })
  }, { query: widgetOutputQuerySchema })
  .get('/public/:eventSlug/widget.xml', async ({ params, query }) => {
    const program = await loadPublicProgram(params.eventSlug)
    if (!program) return new Response('Not found', { status: 404, headers: publicFeedHeaders('text/plain; charset=utf-8') })
    const { widget, accent: _accent, compact: _compact, fields: _fields, ...filters } = query
    return new Response(renderPublicWidgetXml({ program, view: widget, filters }), { headers: publicFeedHeaders('application/xml; charset=utf-8') })
  }, { query: widgetOutputQuerySchema })
  .get('/public/:eventSlug/widget.html', async ({ params, query }) => {
    const program = await loadPublicProgram(params.eventSlug)
    if (!program) return new Response('Not found', { status: 404, headers: publicFeedHeaders('text/plain; charset=utf-8') })
    const { widget, accent: _accent, compact: _compact, fields, ...filters } = query
    return new Response(renderPublicWidgetHtml({ program, view: widget, filters, fields: parsePublicWidgetFields(fields) }), { headers: publicFeedHeaders('text/html; charset=utf-8') })
  }, { query: widgetOutputQuerySchema })
  .get('/public/:eventSlug/widget.js', async ({ params, query, request }) => {
    const program = await loadPublicProgram(params.eventSlug)
    if (!program) return new Response('Not found', { status: 404, headers: publicFeedHeaders('text/plain; charset=utf-8') })
    const { widget, ...embedQuery } = query
    const search = new URLSearchParams(Object.entries(embedQuery).flatMap(([key, value]) => value ? [[key, value]] : []))
    const suffix = search.size ? `?${search}` : ''
    const iframeUrl = new URL(`/embed/${encodeURIComponent(params.eventSlug)}/${widget}${suffix}`, request.url).href
    return new Response(buildPublicWidgetScript({ iframeUrl, title: `${program.event.name} ${widget}` }), { headers: publicFeedHeaders('text/javascript; charset=utf-8') })
  }, { query: widgetOutputQuerySchema })
  .get('/public/:eventSlug/schedule.ics', async ({ params, query }) => {
      const program = await loadPublicProgram(params.eventSlug)
      if (!program) return new Response('Not found', { status: 404 })
      return publicCalendarResponse({ program, sessions: filterPublicSessions(program.sessions, query), fileName: `${program.event.slug}-schedule.ics` })
    }, { query: publicProgramQuerySchema })
  .get('/public/:eventSlug/personal.ics', async ({ params, query }) => {
      const program = await loadPublicProgram(params.eventSlug)
      if (!program) return new Response('Not found', { status: 404 })
      const selected = new Set(query.session)
      return publicCalendarResponse({ program, sessions: program.sessions.filter((session) => selected.has(session.id)), fileName: `${program.event.slug}-my-schedule.ics` })
    }, { query: personalIcsQuerySchema })

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

  .layout('/org/:orgId/*', async ({ children, loaderData }) => {
    const { OrgSwitch, UserMenu, ThemeSelect } = await import('./components/dashboard-shell.tsx')
    const { EventSwitch } = await import('./components/event-switch.tsx')
    // Event pages get the EventSidebar (nested event layout) instead of the
    // org tab bar, and the main area drops its padding so the sidebar can
    // span full height — the event layout pads its own content.
    const isEventPage = loaderData.pathname.includes('/e/')
    return (
      <>
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
      </>
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

  // ── Organization speaker CRM ─────────────────────────────────────

  .loader('/org/:orgId/crm', async ({ params }) => {
    const db = getDb()
    const [contacts, tags, segments, events] = await db.batch([
      db.query.orgContact.findMany({
        where: { orgId: params.orgId },
        with: {
          tagLinks: { with: { tag: true } },
          speakers: {
            with: {
              event: true,
              participations: { with: { session: true } },
            },
          },
          activities: { with: { actor: true }, orderBy: { createdAt: 'desc', id: 'desc' }, limit: 100 },
          emailMessages: { orderBy: { createdAt: 'desc', id: 'desc' }, limit: 100 },
        },
        orderBy: { firstName: 'asc', lastName: 'asc' },
      }),
      db.query.contactTag.findMany({ where: { orgId: params.orgId }, orderBy: { name: 'asc' } }),
      db.query.contactSegment.findMany({ where: { orgId: params.orgId }, with: { tag: true }, orderBy: { name: 'asc' } }),
      db.query.event.findMany({ where: { orgId: params.orgId }, orderBy: { startsAt: 'desc' } }),
    ] as const)
    const rows = contacts.map((contact) => ({
      id: contact.id,
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      jobTitle: contact.jobTitle,
      companyName: contact.companyName,
      bio: contact.bio,
      stage: contact.stage,
      score: contact.score,
      rationale: contact.rationale,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      tags: contact.tagLinks.flatMap((link) => link.tag ? [{ id: link.tag.id, name: link.tag.name }] : []),
      tagIds: contact.tagLinks.map((link) => link.tagId),
      eventIds: [...new Set(contact.speakers.map((speaker) => speaker.eventId))],
      connections: contact.speakers.flatMap((speaker) => speaker.event ? [{
        speakerId: speaker.id,
        eventId: speaker.event.id,
        eventName: speaker.event.name,
        sessionTitles: speaker.participations.flatMap((part) => part.session?.title ? [part.session.title] : []),
      }] : []),
      activities: contact.activities.map((activity) => ({
        id: activity.id, kind: activity.kind, body: activity.body,
        fromStage: activity.fromStage, toStage: activity.toStage,
        createdAt: activity.createdAt, actorName: activity.actor?.name ?? 'Organizer',
      })),
      emailMessages: contact.emailMessages.map((message) => ({
        id: message.id, subject: message.subject, status: message.status,
        eventId: message.eventId, createdAt: message.createdAt,
      })),
    }))
    return {
      contacts: rows,
      tags,
      segments,
      events: events.map((event) => ({ id: event.id, name: event.name, slug: event.slug })),
      metrics: contactMetrics(rows, events.length),
    }
  })

  .page({
    path: '/org/:orgId/crm',
    query: z.object({
      view: z.enum(['directory', 'segments', 'pipeline', 'dashboard']).optional(),
      contact: z.string().optional(),
      segment: z.string().optional(),
    }),
    handler: async ({ query }) => {
      const { ContactCrmPage } = await import('./components/contact-crm-page.tsx')
      return <ContactCrmPage view={query.view ?? 'directory'} contactId={query.contact} segmentId={query.segment} />
    },
  })

  // ── Event shell (/org/:orgId/e/:eventId/*) ────────────────────────
  // Auth + org membership is guarded by the /org/:orgId/* loader above;
  // this level owns event resolution only: the event with its library
  // (tracks/formats/rooms) in ONE db.query. Events from other orgs (or
  // stale ids) bounce back to the org index.

  .loader('/org/:orgId/e/:eventId/*', async ({ params, request }) => {
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
    return { event, tracks, formats, rooms, appUrl: request.parsedUrl.origin }
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
  .page('/org/:orgId/e/:eventId', async ({ loaderData }) => {
    const { event, tracks, formats, rooms } = loaderData
    const db = getDb()
    const [sessions, forms, assignments] = await db.batch([
      db.query.eventSession.findMany({
        where: { eventId: event.id, kind: 'CONTENT' },
        with: {
          participants: true,
          reviews: { with: { response: true } },
        },
        orderBy: { createdAt: 'desc' },
        limit: 1000,
      }),
      db.query.form.findMany({
        where: { eventId: event.id },
        with: { versions: { orderBy: { createdAt: 'desc', id: 'desc' }, limit: 1 } },
        orderBy: { createdAt: 'desc' },
        limit: 100,
      }),
      db.query.taskAssignment.findMany({
        where: { eventId: event.id },
        orderBy: { createdAt: 'desc' },
        limit: 1000,
      }),
    ] as const)
    const now = Date.now()
    const libraryReady = tracks.length > 0 && formats.length > 0 && rooms.length > 0
    const missingLibraryItems = [
      tracks.length === 0 ? 'tracks' : null,
      formats.length === 0 ? 'formats' : null,
      rooms.length === 0 ? 'rooms' : null,
    ].filter(Boolean).join(', ')
    const cfpForms = forms.filter((form) => form.purpose === 'CFP' && form.versions.length > 0)
    const openCfp = event.status === 'ACTIVE'
      ? cfpForms.find((form) => formScheduleBlock(form, now) == null)
      : undefined
    const submitted = sessions.filter((session) => session.status !== 'DRAFT' && session.status !== 'WITHDRAWN')
    const collectionComplete = cfpForms.length > 0 && submitted.length > 0
    const reviews = submitted.flatMap((session) => session.reviews)
    const completedReviews = reviews.filter((review) => review.response?.status === 'SUBMITTED')
    const resolvedReviews = reviews.filter((review) => review.recusedAt != null || review.response?.status === 'SUBMITTED')
    const evaluationComplete = submitted.length > 0
      && reviews.length > 0
      && resolvedReviews.length === reviews.length
      && submitted.every((session) => session.reviews.some((review) => review.response?.status === 'SUBMITTED'))
    const decisionRows = submitted.filter((session) => session.status !== 'WITHDRAWN')
    const finalDecisions = decisionRows.filter((session) => session.status === 'ACCEPTED' || session.status === 'DECLINED')
    const queuedDecisions = decisionRows.filter((session) => session.status === 'ACCEPT_QUEUE' || session.status === 'DECLINE_QUEUE')
    const unnotifiedDecisions = finalDecisions.filter((session) => session.notifiedAt == null)
    const decisionsComplete = decisionRows.length > 0
      && finalDecisions.length === decisionRows.length
      && unnotifiedDecisions.length === 0
    const accepted = sessions.filter((session) => session.status === 'ACCEPTED')
    const acceptedSessionIds = new Set(accepted.map((session) => session.id))
    const acceptedSpeakerIds = new Set(accepted.flatMap((session) => session.participants.map((row) => row.speakerId)))
    const relevantAssignments = assignments.filter((assignment) => assignment.sessionId
      ? acceptedSessionIds.has(assignment.sessionId)
      : acceptedSpeakerIds.has(assignment.speakerId))
    const taskProgress = summarizeAssignmentProgress(relevantAssignments)
    const onboardingComplete = accepted.length > 0
      && taskProgress.total > 0
      && taskProgress.completed === taskProgress.total
    const approved = accepted.filter((session) => session.visibility === 'PUBLIC')
    const scheduled = accepted.filter((session) => session.roomId && session.startsAt != null && session.endsAt != null)
    const agendaReady = accepted.length > 0 && accepted.every((session) => (
      session.visibility === 'PUBLIC'
      && session.roomId != null
      && session.startsAt != null
      && session.endsAt != null
    ))
    const publicationComplete = event.status === 'ACTIVE'
      && event.programPublishedAt != null
      && agendaReady

    type LifecycleStatus = 'completed' | 'current' | 'blocked'
    const lifecycle: Array<{
      label: string
      detail: string
      status: LifecycleStatus
      href: string
      action: string
    }> = [
      {
        label: 'Set up the event library',
        detail: libraryReady
          ? `${tracks.length} track${tracks.length === 1 ? '' : 's'}, ${formats.length} format${formats.length === 1 ? '' : 's'}, and ${rooms.length} room${rooms.length === 1 ? '' : 's'} are ready.`
          : `Add ${missingLibraryItems} before opening collection.`,
        status: libraryReady ? 'completed' : 'current',
        href: router.href(`/org/${event.orgId}/e/${event.id}/settings`, { tab: 'tracks' }),
        action: 'Configure library',
      },
      {
        label: 'Open CFP collection',
        detail: collectionComplete
          ? `${submitted.length} submitted proposal${submitted.length === 1 ? '' : 's'} collected${openCfp ? '; the CFP is still open' : '; collection is now closed'}.`
          : openCfp
            ? 'The CFP is open. Share it and collect the first submitted proposal.'
            : 'Activate the event and open a versioned CFP form so speakers can submit.',
        status: !libraryReady ? 'blocked' : collectionComplete ? 'completed' : 'current',
        href: router.href('/org/:orgId/e/:eventId/forms', { orgId: event.orgId, eventId: event.id }),
        action: openCfp ? 'Manage CFP' : 'Open CFP',
      },
      {
        label: 'Complete evaluation',
        detail: submitted.length === 0
          ? 'Evaluation starts after the first submitted proposal.'
          : reviews.length === 0
            ? `${submitted.length} proposal${submitted.length === 1 ? '' : 's'} need reviewer assignments.`
            : `${completedReviews.length} of ${reviews.length} assigned review${reviews.length === 1 ? ' is' : 's are'} submitted; every proposal needs a completed review.`,
        status: !collectionComplete ? 'blocked' : evaluationComplete ? 'completed' : 'current',
        href: router.href(`/org/${event.orgId}/e/${event.id}/evaluation`),
        action: 'Open evaluation',
      },
      {
        label: 'Finalize and notify decisions',
        detail: decisionRows.length === 0
          ? 'No submitted proposals are ready for a decision.'
          : decisionsComplete
            ? `${finalDecisions.length} final decision${finalDecisions.length === 1 ? '' : 's'} sent to speakers.`
            : `${decisionRows.length - finalDecisions.length} awaiting a final decision, ${queuedDecisions.length} in decision queues, and ${unnotifiedDecisions.length} final but not notified.`,
        status: !evaluationComplete ? 'blocked' : decisionsComplete ? 'completed' : 'current',
        href: router.href(`/org/${event.orgId}/e/${event.id}/abstracts`, { status: 'all' }),
        action: 'Review decision queues',
      },
      {
        label: 'Complete speaker onboarding',
        detail: accepted.length === 0
          ? 'Speaker tasks start after at least one proposal is accepted.'
          : taskProgress.total === 0
            ? `${accepted.length} accepted session${accepted.length === 1 ? ' has' : 's have'} no speaker task assignments yet.`
            : `${taskProgress.completed} of ${taskProgress.total} speaker task${taskProgress.total === 1 ? ' is' : 's are'} complete.`,
        status: accepted.length === 0 ? 'blocked' : onboardingComplete ? 'completed' : 'current',
        href: router.href(`/org/${event.orgId}/e/${event.id}/tasks`),
        action: 'Track speaker tasks',
      },
      {
        label: 'Prepare the agenda',
        detail: accepted.length === 0
          ? 'The agenda needs accepted sessions.'
          : `${approved.length} of ${accepted.length} accepted session${accepted.length === 1 ? ' is' : 's are'} approved for public use; ${scheduled.length} ${scheduled.length === 1 ? 'is' : 'are'} scheduled.`,
        status: accepted.length === 0 ? 'blocked' : agendaReady ? 'completed' : 'current',
        href: router.href(`/org/${event.orgId}/e/${event.id}/agenda`),
        action: 'Prepare agenda',
      },
      {
        label: 'Publish the program',
        detail: publicationComplete
          ? `${accepted.length} approved and scheduled session${accepted.length === 1 ? ' is' : 's are'} available in the public program.`
          : event.programPublishedAt != null
            ? 'The publication flag is on, but accepted sessions still need public approval and schedule slots.'
            : 'Publish only after accepted content is public, scheduled, and ready for attendees.',
        status: !agendaReady ? 'blocked' : publicationComplete ? 'completed' : 'current',
        href: router.href(`/org/${event.orgId}/e/${event.id}/agenda`),
        action: 'Review publication',
      },
    ]
    const nextStepIndex = lifecycle.findIndex((step) => step.status === 'current')
    const stats = [
      { label: 'Submitted', value: submitted.length },
      { label: 'Reviews complete', value: `${completedReviews.length}/${reviews.length}` },
      { label: 'Accepted / public', value: `${accepted.length}/${approved.length}` },
      { label: 'Accepted scheduled', value: `${scheduled.length}/${accepted.length}` },
      { label: 'Open speaker tasks', value: taskProgress.total - taskProgress.completed },
    ]
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{event.name}</h1>
            <EventStatusBadge status={event.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {formatDateRange({ startMs: event.startsAt, endMs: event.endsAt, timezone: event.timezone })}
            {' · '}
            {event.timezone}
            {event.location ? ` · ${event.location}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-10 gap-y-4 border-y border-border py-4">
          {stats.map((stat) => (
            <div key={stat.label} className="flex flex-col gap-0.5">
              <span className="text-2xl font-semibold tabular-nums">{stat.value}</span>
              <span className="text-sm text-muted-foreground">{stat.label}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">Program lifecycle</h2>
            <p className="text-sm text-muted-foreground">Data from the event, CFP, reviews, decisions, speaker tasks, and agenda determines each state.</p>
          </div>
          <ol className="flex flex-col divide-y divide-border border-y border-border">
            {lifecycle.map((step, index) => {
              const next = index === nextStepIndex
              return (
                <li key={step.label} className={cn('flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between', next && 'bg-primary/5 px-4')}>
                  <div className="flex min-w-0 items-start gap-3">
                    <span className={cn(
                      'mt-1.5 size-2.5 shrink-0 rounded-full',
                      step.status === 'completed' && 'bg-success',
                      step.status === 'current' && 'bg-primary',
                      step.status === 'blocked' && 'bg-muted-foreground/30',
                    )} />
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{step.label}</span>
                        <Badge variant={step.status === 'completed' ? 'success' : step.status === 'current' ? 'default' : 'secondary'}>
                          {next ? 'Next' : step.status}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{step.detail}</p>
                    </div>
                  </div>
                  <Link href={step.href} className={cn('shrink-0 text-sm font-medium no-underline hover:underline', next ? 'text-primary' : 'text-foreground')}>
                    {step.action}
                  </Link>
                </li>
              )
            })}
          </ol>
        </div>
      </div>
    )
  })

  // ── Abstracts list + detail + CSV ─────────────────────────────────

  .loader('/org/:orgId/e/:eventId/abstracts', async ({ params, request }) => {
    const db = getDb()
    const statusTab = parseAbstractsStatusTab(request.parsedUrl.searchParams.get('status'))
    const q = request.parsedUrl.searchParams.get('q') ?? ''

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
        avgRating: null,
        yes: 0,
        maybe: 0,
        no: 0,
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
    query: abstractsQuerySchema,
    handler: async ({ query }) => {
      const { AbstractsPage } = await import('./components/abstracts-page.tsx')
      return (
        <AbstractsPage
          key={`${query.status ?? 'all'}:${query.q ?? ''}`}
          status={query.status ?? 'all'}
          q={query.q ?? ''}
        />
      )
    },
  })

  .loader('/org/:orgId/e/:eventId/abstracts/:sessionId', async ({ params }) => {
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
          with: { reviewer: true, form: true, response: { with: { fieldValues: true } } },
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
        revisions: {
          with: { editor: true },
          orderBy: { createdAt: 'desc', id: 'desc' },
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
      reviewerId: review.reviewerId,
      reviewerName: review.reviewer?.name?.trim() || review.reviewer?.email || 'Reviewer',
      reviewerEmail: review.reviewer?.email ?? '',
      roundName: review.form?.name ?? 'Evaluation',
      state: reviewState({ recusedAt: review.recusedAt, responseStatus: review.response?.status ?? null }),
      recusalReason: review.recusalReason,
      values: review.response?.fieldValues.map((value) => ({ name: value.name, value: value.value })) ?? [],
      updatedAt: review.updatedAt,
    }))

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
        visibility: found.visibility,
        trackId: found.trackId,
        formatId: found.formatId,
        coverImageFileId: found.coverImageFileId,
      },
      trackName: found.track?.name ?? null,
      formatName: found.format?.name ?? null,
      formName: latestResponse?.form?.name ?? null,
      participants: found.participants.map((p) => ({
        id: p.id,
        role: p.role,
        roleLabel: participantRoleLabel(p.role, p.sortOrder),
        firstName: p.speaker?.firstName ?? '',
        lastName: p.speaker?.lastName ?? '',
        email: p.speaker?.email ?? '',
        companyName: p.speaker?.companyName ?? null,
        jobTitle: p.speaker?.jobTitle ?? null,
      })),
      reviews,
      fieldValues,
      revisions: found.revisions.map((revision) => ({
        id: revision.id,
        title: revision.title,
        description: revision.description,
        trackId: revision.trackId,
        formatId: revision.formatId,
        coverImageFileId: revision.coverImageFileId,
        createdAt: revision.createdAt,
        editorName: revision.editor?.name ?? revision.editor?.email ?? 'Organizer',
        restoredFromRevisionId: revision.restoredFromRevisionId,
      })),
    }
  })

  .page('/org/:orgId/e/:eventId/abstracts/:sessionId', async () => {
    const { AbstractDetailPage } = await import('./components/abstract-detail.tsx')
    return <AbstractDetailPage />
  })

  .get('/org/:orgId/e/:eventId/abstracts.csv', async ({ params, query, request }) => {
    const sessionUser = await getSession(request)
    if (!sessionUser) return json({ message: 'Not authenticated' }, { status: 401 })
    const member = await lookupOrgMember(sessionUser.userId, params.orgId)
    if (!member) return json({ message: 'Not authorized' }, { status: 403 })
    const db = getDb()
    const event = await db.query.event.findFirst({
      where: { id: params.eventId, orgId: params.orgId },
      columns: { id: true },
    })
    if (!event) return json({ message: 'Event not found' }, { status: 404 })

    const statusTab = parseAbstractsStatusTab(query.status ?? null)
    const q = query.q ?? ''

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
        avgRating: null,
        yes: 0,
        maybe: 0,
        no: 0,
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
  }, { query: abstractsQuerySchema })

  // ── Sessions (ACCEPTED content + SERVICE blocks) ──────────────────
  // Times are converted to the event timezone HERE (server-side Intl) and
  // handed to the client as plain day keys + minute offsets, so nothing in a
  // hydrating component ever re-derives a zoned value.

  .loader('/org/:orgId/e/:eventId/sessions', async ({ params }) => {
    const db = getDb()
    const [event, rows] = await Promise.all([
      db.query.event.findFirst({
        where: { id: params.eventId, orgId: params.orgId },
        columns: { id: true, timezone: true },
      }),
      loadAgendaSessions(getDb(), params.eventId),
    ])
    if (!event) throw redirect(`/org/${params.orgId}`)
    return {
      sessions: rows.map((row) => toAgendaRow(row, event.timezone)),
      timezone: event.timezone,
    }
  })

  .page({
    path: '/org/:orgId/e/:eventId/sessions',
    query: z.object({
      // zod .default() is not applied by spiceflow query validation.
      tab: z.enum(['all', 'scheduled', 'unscheduled', 'service']).optional(),
    }),
    handler: async ({ query }) => {
      const { SessionsPage } = await import('./components/sessions-page.tsx')
      return <SessionsPage tab={query.tab ?? 'all'} />
    },
  })

  .loader('/org/:orgId/e/:eventId/files', async ({ params }) => {
    return loadFilesWorkspace(getDb(), params.eventId)
  })

  .page({
    path: '/org/:orgId/e/:eventId/files',
    query: z.object({
      status: z.enum(['all', 'incomplete', 'complete']).optional(),
      kind: z.enum(['all', 'slides', 'images', 'documents']).optional(),
    }),
    handler: async ({ query, loaderData }) => {
      const { FilesPage } = await import('./components/files-page.tsx')
      return (
        <FilesPage
          status={query.status ?? 'all'}
          kind={query.kind ?? 'all'}
          fileSlots={loaderData.fileSlots}
          otherFiles={loaderData.otherFiles}
        />
      )
    },
  })
  // ── Forms list (CFP + PORTAL) + MDX editor ────────────────────────
  // List counts come from
  // ONE db.query (responses relation aggregated in JS — form counts are
  // small). Legacy /portal-forms redirects here.

  .loader('/org/:orgId/e/:eventId/forms', async ({ params }) => {
    const db = getDb()
    const rows = await db.query.form.findMany({
      where: { eventId: params.eventId, purpose: { in: ['CFP', 'PORTAL'] } },
      with: { responses: { columns: { id: true, status: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return { forms: rows.map(toFormListRow) }
  })

  .page('/org/:orgId/e/:eventId/forms', async () => {
    const { FormsListPage } = await import('./components/forms-list.tsx')
    return <FormsListPage />
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
    const [rounds, sessions, assignments, invitations] = await db.batch([
      db.query.form.findMany({
        where: { eventId: params.eventId, purpose: 'EVALUATION' },
        with: {
          versions: { orderBy: { createdAt: 'desc', id: 'desc' } },
          evaluationReviewers: { with: { user: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      db.query.eventSession.findMany({
        where: {
          eventId: params.eventId,
          kind: 'CONTENT',
          status: { in: ['PENDING', 'ACCEPT_QUEUE', 'ACCEPTED', 'DECLINE_QUEUE', 'DECLINED'] },
        },
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
        with: { reviewer: true, response: { with: { fieldValues: true } } },
      }),
      db.query.orgInvitation.findMany({
        where: { eventId: params.eventId, purpose: 'EVALUATION_REVIEWER' },
        orderBy: { createdAt: 'desc' },
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

    return {
      sessions: sessionRows,
      rounds: rounds.map((round) => {
        const version = round.versions[0] ?? null
        const fields = version
          ? collectFields({ mdxSource: version.mdxSource, scope: { values: {} } }).fields
          : []
        const roundAssignments = assignments
          .filter((assignment) => assignment.formId === round.id)
          .map((assignment) => ({
            ...assignment,
            response: assignment.response
              ? {
                  status: assignment.response.status,
                  values: restoreSubmissionValues({ rows: assignment.response.fieldValues, participantSpeakerIds: [] }).values,
                }
              : null,
          }))
        return {
          id: round.id,
          name: round.name,
          status: round.status,
          opensAt: round.opensAt,
          closesAt: round.closesAt,
          blind: round.blind,
          mdxSource: version?.mdxSource ?? '',
          fields,
          reviewers: round.evaluationReviewers.flatMap((membership) => membership.user ? [{
            id: membership.userId,
            name: membership.user.name,
            email: membership.user.email,
          }] : []),
          invitations: invitations.filter((invitation) => invitation.formId === round.id).map((invitation) => ({
            id: invitation.invitationId,
            email: invitation.invitedEmail ?? '',
            expiresAt: invitation.expiresAt,
          })),
          assignments: roundAssignments.map((assignment) => ({
            id: assignment.id,
            sessionId: assignment.sessionId,
            reviewerId: assignment.reviewerId,
            state: reviewState({ recusedAt: assignment.recusedAt, responseStatus: assignment.response?.status ?? null }),
          })),
          progress: progressByReviewer(roundAssignments),
          coverage: coverageBySession(sessionRows, roundAssignments),
          results: aggregateEvaluationResults({ sessions: sessionRows, fields, assignments: roundAssignments }),
        }
      }),
    }
  })

  .page({
    path: '/org/:orgId/e/:eventId/evaluation',
    query: z.object({
      tab: z.enum(['rounds', 'reviewers', 'assignments', 'progress', 'results']).optional(),
    }),
    handler: async ({ query }) => {
      const { EvaluationPage } = await import('./components/evaluation-page.tsx')
      return <EvaluationPage tab={query.tab ?? 'rounds'} />
    },
  })

  .get('/org/:orgId/e/:eventId/evaluation/:formId/results.csv', async ({ params, request }) => {
    const sessionUser = await requireSession(request)
    const member = await lookupOrgMember(sessionUser.userId, params.orgId)
    if (!member) return json({ message: 'Not authorized' }, { status: 403 })
    const db = getDb()
    const [event, form, sessions, assignments] = await db.batch([
      db.query.event.findFirst({ where: { id: params.eventId, orgId: params.orgId } }),
      db.query.form.findFirst({ where: { id: params.formId, eventId: params.eventId, purpose: 'EVALUATION' }, with: { versions: { orderBy: { createdAt: 'desc', id: 'desc' } } } }),
      db.query.eventSession.findMany({ where: { eventId: params.eventId, kind: 'CONTENT' } }),
      db.query.review.findMany({ where: { eventId: params.eventId, formId: params.formId }, with: { reviewer: true, response: { with: { fieldValues: true } } } }),
    ] as const)
    if (!event || !form?.versions[0]) return json({ message: 'Evaluation not found' }, { status: 404 })
    const fields = collectFields({ mdxSource: form.versions[0].mdxSource, scope: { values: {} } }).fields
    const normalized = assignments.map((assignment) => ({
      ...assignment,
      response: assignment.response ? {
        status: assignment.response.status,
        values: restoreSubmissionValues({ rows: assignment.response.fieldValues, participantSpeakerIds: [] }).values,
      } : null,
    }))
    const csv = evaluationResultsToCsv(aggregateEvaluationResults({ sessions, fields, assignments: normalized }), fields)
    return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="evaluation-${params.formId}.csv"` } })
  })

  // ── Agenda (?view=list|week|rooms|conflicts) ──────────────────────

  .loader('/org/:orgId/e/:eventId/agenda', async ({ params }) => {
    const db = getDb()
    const [event, rows] = await Promise.all([
      db.query.event.findFirst({
        where: { id: params.eventId, orgId: params.orgId },
        columns: { id: true, timezone: true, startsAt: true, endsAt: true },
      }),
      loadAgendaSessions(getDb(), params.eventId),
    ])
    if (!event) throw redirect(`/org/${params.orgId}`)

    const sessions = rows.map((row) => toAgendaRow(row, event.timezone))
    const byId = new Map(sessions.map((row) => [row.id, row]))
    const days = eventDayKeys(event.startsAt, event.endsAt, event.timezone)

    const conflicts = findConflicts(
      rows.map((row) => ({
        id: row.id,
        roomId: row.roomId,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        speakerIds: row.participants.map((part) => part.speakerId),
      })),
    ).map((conflict): AgendaConflictRow => {
      const a = byId.get(conflict.aId)
      const b = byId.get(conflict.bId)
      const speakerNames = (conflict.speakerIds ?? []).map((speakerId) => {
        const part = rows
          .find((row) => row.id === conflict.aId)
          ?.participants.find((row) => row.speakerId === speakerId)
        return part?.speaker ? speakerDisplayName(part.speaker) : 'Speaker'
      })
      return {
        aId: conflict.aId,
        bId: conflict.bId,
        aTitle: a?.title ?? 'Untitled',
        bTitle: b?.title ?? 'Untitled',
        aKind: a?.kind ?? 'CONTENT',
        bKind: b?.kind ?? 'CONTENT',
        reason: conflict.reason,
        detail:
          conflict.reason === 'ROOM'
            ? (a?.roomName ?? 'Same room')
            : speakerNames.join(', ') || 'Shared speaker',
        dayKey: a?.dayKey ?? null,
        timeLabel: a?.timeLabel ?? '',
      }
    })

    return { sessions, days, conflicts, timezone: event.timezone }
  })

  .page({
    path: '/org/:orgId/e/:eventId/agenda',
    query: z.object({
      view: z.enum(['list', 'week', 'rooms', 'conflicts']).optional(),
    }),
    handler: async ({ query }) => {
      const { AgendaPage } = await import('./components/agenda-page.tsx')
      return <AgendaPage view={query.view ?? 'week'} />
    },
  })

  .page('/org/:orgId/e/:eventId/embeds', async () => {
    const { EmbedBuilder } = await import('./components/embed-builder.tsx')
    return <EmbedBuilder />
  })

  // ── Tasks ─────────────────────────────────────────────────────────

  .loader('/org/:orgId/e/:eventId/tasks', async ({ params }) => {
    const db = getDb()
    const [defs, portalForms, speakers, acceptedSessions] = await db.batch([
      db.query.taskDefinition.findMany({
        where: { eventId: params.eventId },
        with: {
          form: true,
           assignments: { with: { speaker: true, session: true } },
        },
        orderBy: { sortOrder: 'asc', createdAt: 'asc' },
      }),
      db.query.form.findMany({
        where: { eventId: params.eventId, purpose: 'PORTAL' },
        columns: { id: true, name: true, target: true },
        orderBy: { name: 'asc' },
      }),
      db.query.speaker.findMany({ where: { eventId: params.eventId }, orderBy: { firstName: 'asc', lastName: 'asc' } }),
      db.query.eventSession.findMany({
        where: { eventId: params.eventId, kind: 'CONTENT', status: 'ACCEPTED' },
        with: { participants: { with: { speaker: true } } },
        orderBy: { title: 'asc' },
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
        assignmentPolicy: def.assignmentPolicy,
        formId: def.formId,
        formName: def.form?.name ?? null,
        dueAt: def.dueAt,
        sortOrder: def.sortOrder,
        ...progress,
        assignments: def.assignments.map((assignment) => ({
          id: assignment.id,
          status: assignment.status,
          dueAt: assignment.dueAt,
          speakerId: assignment.speakerId,
          speakerName: assignment.speaker ? `${assignment.speaker.firstName} ${assignment.speaker.lastName}` : 'Removed speaker',
          sessionId: assignment.sessionId,
          sessionTitle: assignment.session?.title ?? null,
        })),
      }
    })
    return {
      tasks,
      portalForms,
      speakers: speakers.map((speaker) => ({ id: speaker.id, name: `${speaker.firstName} ${speaker.lastName}`, status: speaker.status })),
      acceptedSessions: acceptedSessions.map((session) => ({
        id: session.id,
        title: session.title ?? 'Untitled',
        speakerNames: session.participants.flatMap((row) => row.speaker ? [`${row.speaker.firstName} ${row.speaker.lastName}`] : []),
      })),
    }
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
  // Legacy Portal Forms route → unified Forms list.
  .page('/org/:orgId/e/:eventId/portal-forms', async ({ params }) => {
    throw redirect(`/org/${params.orgId}/e/${params.eventId}/forms`)
  })
  .loader('/org/:orgId/e/:eventId/speakers', async ({ params }) => {
    const db = getDb()
    const rows = await db.query.speaker.findMany({
      where: { eventId: params.eventId },
      with: {
        participations: { with: { session: true } },
        taskAssignments: true,
      },
      orderBy: { firstName: 'asc', lastName: 'asc' },
    })
    return { speakers: rows.map((speaker) => ({
      id: speaker.id, firstName: speaker.firstName, lastName: speaker.lastName,
      email: speaker.email, status: speaker.status, jobTitle: speaker.jobTitle,
      companyName: speaker.companyName, avatarUrl: speaker.avatarUrl,
      headshotFileId: speaker.headshotFileId,
      sessions: speaker.participations.length,
      sessionTitles: speaker.participations.flatMap((participation) =>
        participation.session?.title ? [participation.session.title] : [],
      ),
      outstandingTasks: speaker.taskAssignments.filter((row) => row.status !== 'COMPLETED').length,
    })), existingEmails: rows.map((speaker) => speaker.email) }
  })
  .page({
    path: '/org/:orgId/e/:eventId/speakers',
    query: z.object({ status: z.enum(['all', 'pending', 'invited', 'confirmed', 'declined']).optional() }),
    handler: async ({ query }) => {
      const { SpeakersPage } = await import('./components/speakers-page.tsx')
      return <SpeakersPage initialStatus={query.status ?? 'all'} />
    },
  })
  .loader('/org/:orgId/e/:eventId/speakers/:speakerId', async ({ params, response }) => {
    const detail = await loadOrganizerSpeakerDetail(params.eventId, params.speakerId)
    if (!detail.speaker) response.status = 404
    return detail
  })
  .page('/org/:orgId/e/:eventId/speakers/:speakerId', async () => {
    const { SpeakerDetailPage } = await import('./components/speakers-page.tsx')
    return <SpeakerDetailPage />
  })
  // ── Emails (?tab=all|queued|sent|failed|reminders) ────────────────

  .loader('/org/:orgId/e/:eventId/emails', async ({ params }) => {
    const db = getDb()
    const rows = await db.query.emailMessage.findMany({
      where: { eventId: params.eventId },
      orderBy: { createdAt: 'desc' },
      // The outbox grows forever; the admin log only ever needs the recent
      // tail. Older rows stay queryable in D1 for auditing.
      limit: 300,
    })
    const batchSizes = new Map<string, number>()
    for (const row of rows) {
      if (row.batchId) batchSizes.set(row.batchId, (batchSizes.get(row.batchId) ?? 0) + 1)
    }
    return {
      emails: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        toEmail: row.toEmail,
        subject: row.subject,
        status: row.status,
        attemptCount: row.attemptCount,
        icsMethod: row.icsMethod,
        errorMessage: row.errorMessage,
        createdAt: row.createdAt,
        sentAt: row.sentAt,
        bodyHtml: row.bodyHtml,
        bodyText: row.bodyText,
        batchId: row.batchId,
        batchRecipients: row.batchId ? (batchSizes.get(row.batchId) ?? 1) : null,
      })),
    }
  })

  .page({
    path: '/org/:orgId/e/:eventId/emails',
    query: z.object({
      tab: z.enum(['all', 'queued', 'sent', 'failed', 'reminders']).optional(),
    }),
    handler: async ({ query }) => {
      const { EmailsPage } = await import('./components/emails-page.tsx')
      return <EmailsPage tab={query.tab ?? 'all'} />
    },
  })

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

export async function loadPublicProgram(eventSlug: string): Promise<PublicProgram | null> {
  const found = await getDb().query.event.findFirst({
    where: { slug: eventSlug },
    with: {
      sessions: {
        with: {
          room: true,
          track: true,
          format: true,
          participants: {
            with: { speaker: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
        orderBy: { startsAt: 'asc', id: 'asc' },
      },
    },
  })
  if (!found) return null
  const { sessions, ...event } = found
  return projectPublicProgram({ event, sessions })
}

async function renderPublicProgram({ program, view, filters }: {
  program: PublicProgram | null,
  view: 'sessions' | 'speakers' | 'agenda' | 'itinerary' | 'gallery',
  filters: PublicProgramFilters,
}) {
  if (!program) return <PublicUnavailable />
  const { PublicProgramPage } = await import('./components/public-program-page.tsx')
  return <PublicProgramPage program={program} view={view} initialFilters={filters} />
}

async function renderEmbedProgram({ program, view, query, headers }: {
  program: PublicProgram | null,
  view: 'sessions' | 'speakers' | 'agenda' | 'itinerary' | 'gallery',
  query: PublicProgramFilters & { accent?: string; compact?: '0' | '1'; fields?: string },
  headers: Headers,
}) {
  headers.set('content-security-policy', 'frame-ancestors *')
  headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  headers.set('cache-control', 'no-store')
  headers.set('access-control-allow-origin', '*')
  if (!program) return <PublicUnavailable />
  const { accent, compact, fields, ...filters } = query
  const { PublicProgramPage } = await import('./components/public-program-page.tsx')
  return (
    <PublicProgramPage
      program={program}
      view={view}
      embed
      initialFilters={filters}
      accent={accent}
      compact={compact === '1'}
      visibleFields={parsePublicWidgetFields(fields)}
    />
  )
}

async function renderValidatedEmbedProgram({ program, view, query, headers }: {
  program: PublicProgram | null,
  view: 'sessions' | 'speakers' | 'agenda' | 'itinerary' | 'gallery',
  query: z.input<typeof embedProgramQuerySchema>,
  headers: Headers,
}) {
  const parsed = embedProgramQuerySchema.safeParse(query)
  if (!parsed.success) {
    return json({ message: 'Invalid embed options', code: 'invalid_embed_query' }, { status: 400 })
  }
  return renderEmbedProgram({ program, view, query: parsed.data, headers })
}

function publicFeedHeaders(contentType: string): HeadersInit {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
  }
}

function publicCalendarResponse({ program, sessions, fileName }: {
  program: PublicProgram,
  sessions: PublicProgram['sessions'],
  fileName: string,
}) {
  let appDomain = 'opensession.dev'
  try {
    appDomain = new URL(env.APP_URL).host
  } catch {}
  const body = buildIcsCalendar(sessions.map((session) => ({
    sessionId: session.id,
    appDomain,
    sequence: 0,
    title: session.title,
    description: session.description,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    roomName: session.room.name,
    location: program.event.location,
    url: new URL(`/public/${program.event.slug}/sessions`, env.APP_URL).href,
    organizerEmail: 'notifications@opensession.dev',
    organizerName: program.event.name,
    stamp: program.event.programPublishedAt ?? session.startsAt,
  })))
  return new Response(body, {
    headers: {
      ...Object.fromEntries(new Headers(publicFeedHeaders('text/calendar; charset=utf-8'))),
      'content-disposition': `attachment; filename="${fileName.replace(/[^a-zA-Z0-9._-]/g, '-')}"`,
    },
  })
}


/** Map a form row (with its responses relation) to the list-row shape the
 *  forms table renders: response rows collapse to counts. */
async function loadReviewerRound(request: Request, formId: string) {
  const sessionUser = await getSession(request)
  if (!sessionUser) {
    throw redirect(`/login?callbackURL=${encodeURIComponent(`/review/${formId}`)}`)
  }
  const db = getDb()
  const membership = await db.query.evaluationReviewer.findFirst({
    where: { formId, userId: sessionUser.userId },
  })
  if (!membership) throw json({ message: 'Organization not found', code: 'not_found' }, { status: 404 })
  const [form, rows] = await db.batch([
    db.query.form.findFirst({
      where: { id: formId, eventId: membership.eventId, purpose: 'EVALUATION' },
      with: { event: true, versions: { orderBy: { createdAt: 'desc', id: 'desc' } } },
    }),
    db.query.review.findMany({
      where: { eventId: membership.eventId, formId, reviewerId: sessionUser.userId },
      with: {
        response: { with: { fieldValues: true, formVersion: true } },
        session: {
          with: {
            track: true,
            format: true,
            participants: { with: { speaker: true }, orderBy: { sortOrder: 'asc' } },
            formResponses: {
              where: { status: 'SUBMITTED' },
              with: { fieldValues: true, form: true },
              orderBy: { submittedAt: 'desc', createdAt: 'desc' },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ] as const)
  if (!form?.event || !form.versions[0]) throw json({ message: 'Form not found', code: 'not_found' }, { status: 404 })
  const currentVersion = form.versions[0]
  const assignments = rows.flatMap((row) => {
    if (!row.session) return []
    const responseValues = row.response
      ? restoreSubmissionValues({ rows: row.response.fieldValues, participantSpeakerIds: [] }).values
      : {}
    const submission = row.session.formResponses.find((response) => response.form?.purpose === 'CFP')
      ?? row.session.formResponses[0]
    const projected = projectAssignedSession({
      id: row.session.id,
      title: row.session.title,
      description: row.session.description,
      trackName: row.session.track?.name ?? null,
      formatName: row.session.format?.name ?? null,
      participants: row.session.participants.flatMap((participant) => participant.speaker ? [{
        role: participant.role,
        roleLabel: participantRoleLabel(participant.role, participant.sortOrder),
        firstName: participant.speaker.firstName,
        lastName: participant.speaker.lastName,
        email: participant.speaker.email,
        companyName: participant.speaker.companyName,
        jobTitle: participant.speaker.jobTitle,
        headshotFileId: participant.speaker.headshotFileId,
      }] : []),
      fieldValues: submission?.fieldValues.map((value) => ({
        name: value.name,
        value: value.value,
        subjectSpeakerId: value.subjectSpeakerId,
      })) ?? [],
    }, form.blind)
    return [{
      id: row.id,
      session: projected,
      state: reviewState({ recusedAt: row.recusedAt, responseStatus: row.response?.status ?? null }),
      recusalReason: row.recusalReason,
      responseStatus: row.response?.status ?? null,
      values: responseValues,
      mdxSource: row.response?.formVersion?.mdxSource ?? currentVersion.mdxSource,
    }]
  })
  return {
    event: { name: form.event.name, slug: form.event.slug },
    round: {
      id: form.id,
      name: form.name,
      status: form.status,
      opensAt: form.opensAt,
      closesAt: form.closesAt,
      blind: form.blind,
    },
    assignments,
    progress: {
      assigned: assignments.length,
      completed: assignments.filter((row) => row.state === 'COMPLETED').length,
      recused: assignments.filter((row) => row.state === 'RECUSED').length,
    },
  }
}

function participantRoleLabel(role: 'SPEAKER' | 'MODERATOR', sortOrder: number) {
  if (role === 'MODERATOR') return 'Moderator'
  return sortOrder === 0 ? 'Primary speaker' : 'Co-speaker'
}

function toFormListRow<T extends { responses: { status: 'DRAFT' | 'SUBMITTED' }[] }>({ responses, ...form }: T) {
  return {
    ...form,
    submitted: responses.filter((row) => row.status === 'SUBMITTED').length,
    drafts: responses.filter((row) => row.status === 'DRAFT').length,
  }
}

/** Map one agenda DB row to the client row shape. Timezone conversion happens
 *  HERE (server-side Intl); the client only ever sees day keys and minutes. */
function toAgendaRow(
  row: Awaited<ReturnType<typeof loadAgendaSessions>>[number],
  timezone: string,
): AgendaSessionRow {
  const start = row.startsAt != null ? toZonedSlot(row.startsAt, timezone) : null
  const end = row.endsAt != null ? toZonedSlot(row.endsAt, timezone) : null
  // A block running past local midnight is clamped so the day grid stays inside
  // one column set; the list view shows the real end via endsAt.
  const endMinute = end ? (end.dayKey === start?.dayKey ? end.minutes : 24 * 60) : null
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title?.trim() || 'Untitled',
    visibility: row.visibility,
    roomId: row.roomId,
    roomName: row.room?.name ?? null,
    trackName: row.track?.name ?? null,
    trackColor: row.track?.color ?? null,
    formatName: row.format?.name ?? null,
    defaultDurationMinutes: row.format?.defaultDurationMinutes ?? null,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    dayKey: start?.dayKey ?? null,
    startMinute: start?.minutes ?? null,
    endMinute,
    timeLabel:
      start && endMinute != null ? formatSlotRange(start.minutes, endMinute) : null,
    speakerNames: row.participants.flatMap((part) =>
      part.speaker ? [speakerDisplayName(part.speaker)] : [],
    ),
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

function PublicUnavailable({ eventSlug, reason }: { eventSlug?: string; reason?: PublicCfpBlockReason | null }) {
  const detail = reason
    ? publicCfpBlockMessage(reason)
    : 'The event or form may be closed, archived, or no longer public.'
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="flex max-w-md flex-col items-center gap-5 text-center text-balance">
        <div className="flex items-center gap-4">
          <OpenSessionLogo imageClassName="h-8" />
          {eventSlug ? (
            <Link
              href={router.href('/portal/:eventSlug', { eventSlug })}
              className="text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
            >
              Speaker portal
            </Link>
          ) : null}
        </div>
        <h1 className="text-xl font-semibold">This page is not available</h1>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
    </main>
  )
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const MAX_SPEAKER_FILES = 100
const MAX_SPEAKER_UPLOAD_BYTES = 500 * 1024 * 1024
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

export async function loadFilesWorkspace(db: ReturnType<typeof getDb>, eventId: string) {
  const [assignments, files] = await db.batch([
    db.query.taskAssignment.findMany({
      where: { eventId },
      with: {
        speaker: true,
        session: true,
        files: { orderBy: { createdAt: 'desc', id: 'desc' } },
        comments: { with: { author: true }, orderBy: { createdAt: 'asc', id: 'asc' } },
        taskDefinition: {
          with: { form: { with: { versions: { orderBy: { createdAt: 'desc', id: 'desc' }, limit: 1 } } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    db.query.file.findMany({
      where: { eventId },
      with: { formFieldValues: { with: { response: { with: { taskAssignment: true } } } } },
      orderBy: { createdAt: 'desc', id: 'desc' },
    }),
  ] as const)

  const selectedFileIdsBySlot = new Map<string, Set<string>>()
  for (const file of files) {
    for (const value of file.formFieldValues) {
      const assignmentId = value.response?.taskAssignment?.id
      if (!assignmentId) continue
      const key = taskFileSlotKey(assignmentId, value.name)
      const selected = selectedFileIdsBySlot.get(key)
      if (selected) selected.add(file.id)
      else selectedFileIdsBySlot.set(key, new Set([file.id]))
    }
  }
  const fileSlots = assignments.flatMap((assignment) => {
    const formVersion = assignment.taskDefinition?.form?.versions[0]
    const collected = formVersion
      ? collectFields({ mdxSource: formVersion.mdxSource, scope: { values: {} } })
      : null
    const fieldNames = new Set([
      ...(collected?.fields ?? []),
      ...(collected?.participantFields ?? []),
    ].filter((field) => field.type === 'file').map((field) => field.name))
    for (const file of assignment.files) {
      if (file.fieldName) fieldNames.add(file.fieldName)
    }
    return [...fieldNames].sort().map((fieldName) => {
      const versions = assignment.files.filter((file) => file.fieldName === fieldName)
      const selectedFileIds = selectedFileIdsBySlot.get(taskFileSlotKey(assignment.id, fieldName)) ?? new Set()
      return {
        slotKey: taskFileSlotKey(assignment.id, fieldName),
        assignmentId: assignment.id,
        fieldName,
        taskTitle: assignment.taskDefinition?.title ?? 'Task',
        dueAt: assignment.dueAt,
        status: assignment.status,
        speakerName: assignment.speaker
          ? `${assignment.speaker.firstName} ${assignment.speaker.lastName}`
          : 'Removed speaker',
        sessionTitle: assignment.session?.title ?? null,
        versions: versions.map((file, index) => ({
          id: file.id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          createdAt: file.createdAt,
          current: index === 0,
          selectedOnSubmit: selectedFileIds.has(file.id),
        })),
        comments: assignment.comments.filter((comment) => comment.fieldName === fieldName).map((comment) => ({
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          authorName: comment.author?.name ?? 'User',
        })),
      }
    })
  })
  return {
    fileSlots,
    otherFiles: files.filter((file) => !file.taskAssignmentId).map((file) => ({
      id: file.id,
      fileName: file.fileName,
      kind: file.kind,
      createdAt: file.createdAt,
    })),
  }
}

export async function loadZipFiles({ db, eventId, selectedSlots }: {
  db: ReturnType<typeof getDb>
  eventId: string
  selectedSlots: ReadonlySet<string>
}): Promise<Array<{ archivePath: string; storageKey: string }>> {
  const rows = await db.query.file.findMany({
    where: { eventId, taskAssignmentId: { isNotNull: true } },
    with: { taskAssignment: { with: { speaker: true, session: true } } },
  })
  const entries = selectLatestZipEntries(rows.map((file) => ({
    ...file,
    speakerName: file.taskAssignment?.speaker
      ? `${file.taskAssignment.speaker.firstName} ${file.taskAssignment.speaker.lastName}`
      : 'Speaker',
    sessionTitle: file.taskAssignment?.session?.title ?? null,
  })), selectedSlots)
  const fileById = new Map(rows.map((file) => [file.id, file]))
  return entries.map((entry) => ({
    archivePath: entry.archivePath,
    storageKey: fileById.get(entry.fileId)!.storageKey,
  }))
}

export function streamZip(entries: Array<{ archivePath: string; storageKey: string }>): {
  readable: ReadableStream<Uint8Array>
  done: Promise<void>
} {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  let writes = Promise.resolve()
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      writes = writes.then(() => writer.abort(error))
      return
    }
    writes = writes.then(() => writer.write(chunk))
    if (final) writes = writes.then(() => writer.close())
  })
  const done = (async () => {
    try {
      for (const entry of entries) {
        const object = await env.FILES.get(entry.storageKey)
        if (!object) throw new Error(`Missing R2 object for ${entry.archivePath}`)
        const zipFile = new ZipPassThrough(entry.archivePath)
        zip.add(zipFile)
        const reader = object.body.getReader()
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          zipFile.push(chunk.value)
        }
        zipFile.push(new Uint8Array(), true)
      }
      zip.end()
      await writes
    } catch (error) {
      zip.terminate()
      await writer.abort(error)
      throw error
    }
  })()
  return { readable, done }
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

function RootLayout({ children, request }: { children: React.ReactNode; request: Request }) {
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
        <Toaster />
      </body>
    </html>
  )
}

function rootLayout({ children, request }: { children?: React.ReactNode; request: Request }) {
  return <RootLayout request={request}>{children}</RootLayout>
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
            <Link href={router.href('/org/:orgId', { orgId })} className="self-end hover:opacity-80 transition-opacity">
              <OpenSessionLogo />
            </Link>
            {orgSlot}
            <span className="text-muted-foreground/50 select-none">/</span>
            {eventSlot}
          </div>
          <div className="flex items-center gap-4">
            <Link
              href={router.href('/')}
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
    { label: 'Overview', href: router.href('/org/:orgId', { orgId }) },
    { label: 'Speaker CRM', href: router.href(`/org/${orgId}/crm`) },
    { label: 'Members', href: router.href('/org/:orgId/members', { orgId }) },
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
    knownPaths: '/' | '/#features'
  }
}

// spiceflow/cloudflare-entrypoint re-exports this default handler verbatim
// (`export default entry.default ?? { fetch: handler }`), so `scheduled` here
// is what Cloudflare invokes for the wrangler.jsonc cron trigger.
export default {
  async fetch(request: Request): Promise<Response> {
    return app.handle(request)
  },
  async scheduled(
    controller: ScheduledController,
    _env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runCron({ now: controller.scheduledTime }))
  },
} satisfies ExportedHandler<Env>
