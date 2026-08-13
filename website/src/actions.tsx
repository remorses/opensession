'use server'

// Server actions for the OpenSession website.
// Org management (create, rename, invites, member roles) is ported from
// akarso/sigillo's access implementation. Event actions are OpenSession's.
//
// SECURITY: server actions are public POST endpoints — every action
// authenticates via getActionRequest() + requireSession/requireOrgAccess.

import { env } from 'cloudflare:workers'
import { getActionRequest, redirect } from 'spiceflow'
import { router } from 'spiceflow/react'
import { z } from 'zod'
import * as orm from 'drizzle-orm'
import * as schema from 'db/schema'
import { ulid } from 'ulid'
import type { BatchItem } from 'drizzle-orm/batch'
import {
  requireSession,
  requireOrgAccess,
  requireAdminRole,
  requireVerifiedEmail,
  ensurePersonalOrg,
  generateApiKeySecret,
  getDb,
  hashApiKeySecret,
} from './db.ts'
import { API_SCOPES, ApiScopeSchema } from './api-schemas.ts'
import { collectFields } from './forms/collect-fields.ts'
import {
  starterCfpTemplate,
  starterEvaluationTemplate,
  starterPortalTemplate,
  starterSessionMaterialsTemplate,
  starterSpeakerProfileTemplate,
} from './forms/starter-template.ts'
import { validateSubmission } from './forms/validate.ts'
import { flattenSubmissionValues, formScheduleBlock, formScheduleBlockMessage } from './lib/cfp-submission.ts'
import {
  applyAutoPlacementPlan,
  clearSessionSlot,
  loadAgendaSessions,
  scheduleSessionSlot,
  MAX_SLOT_MINUTES,
} from './lib/agenda-server.ts'
import {
  cfpSubmissionSchema,
  getOrCreateCfpDraft,
  getPublicCfp,
  linkSpeakerToOrgContact,
  resetCfpDraft,
  saveCfpDraft,
  submitCfpResponse,
} from './lib/cfp-server.ts'
import {
  completeManualTaskAssignment as completeManualTaskAssignmentServer,
  saveOrganizerSpeakerProfile as saveOrganizerSpeakerProfileServer,
  savePortalProfile as savePortalProfileServer,
  savePortalSubmission as savePortalSubmissionServer,
  submitPortalFormTask as submitPortalFormTaskServer,
  withdrawPortalSubmission as withdrawPortalSubmissionServer,
} from './lib/portal-server.ts'
import {
  dedupeKeys,
  dayBucket,
  enqueueAndSend,
  replyToFor,
  sendEmailMessage,
} from './lib/emails/send.ts'
import { eventDayKeys, toZonedSlot, zonedEpoch } from './lib/conflicts.ts'
import { autoPlaceSessions, summarizeProgramPublication } from './lib/public-program.ts'
import { invitationAcceptanceDecision } from './lib/reviews.ts'
import {
  applyTransition,
  planBulkStatusUpdate,
  planNotifyQueue,
  type SessionStatus,
} from './lib/submissions.ts'
import {
  assertTaskDefinitionShape,
  buildAssignmentsForAcceptance,
  defaultFormTaskDefinitions,
  type PlannedTaskAssignment,
} from './lib/tasks.ts'
import {
  applySpeakerMergeFields,
  normalizeSpeakerEmail,
  planParticipantChange,
  prepareSpeakerImport,
  type SpeakerCsvRow,
} from './lib/speaker-operations.ts'
import {
  CONTACT_STAGES,
  planContactMerge,
  prepareContactImport,
  type ContactCsvRow,
} from './lib/contact-crm.ts'

// ── Org actions (multi-org + team access) ───────────────────────────
//
// No switchOrg action: the org id lives in the URL (/org/:orgId/*), so
// switching orgs is a plain client-side navigation in the org switcher.

const MAX_ORGS_PER_USER = 20

const createOrgSchema = z.object({ name: z.string().trim().min(1).max(60) })

/** Create a team org with the caller as admin and redirect to its
 *  events page (client-side navigation). */
export async function createOrg(input: { name: string }) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  requireVerifiedEmail(session)
  const { name } = createOrgSchema.parse(input)

  // Ensure the personal org exists BEFORE counting, so the cap always
  // means "personal + team orgs combined" even when this action is the
  // user's very first write. The count check is best-effort against
  // concurrent calls — the cap is anti-abuse, not an invariant.
  await ensurePersonalOrg(session.userId, { name: session.user.name })

  const db = getDb()
  const owned = await db.query.org.findMany({
    where: { ownerUserId: session.userId },
    columns: { orgId: true },
  })
  if (owned.length >= MAX_ORGS_PER_USER) {
    throw new Error(`You can create at most ${MAX_ORGS_PER_USER} organizations`)
  }

  // Pre-generate the ULID so org + admin membership go in one atomic batch.
  const orgId = ulid()
  await db.batch([
    db.insert(schema.org).values({ orgId, ownerUserId: session.userId, kind: 'team', name }),
    db.insert(schema.orgMember).values({ orgId, userId: session.userId, role: 'admin' }),
  ] as const)
  throw redirect(router.href('/org/:orgId', { orgId }))
}

const renameOrgSchema = z.object({
  orgId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
})

/** Rename an org. Admin-only. */
export async function renameOrg(input: { orgId: string; name: string }) {
  const actionRequest = getActionRequest()
  const { orgId, name } = renameOrgSchema.parse(input)
  const { session } = await requireOrgAccess(actionRequest, orgId)
  await requireAdminRole(session.userId, orgId)
  const db = getDb()
  const updated = await db
    .update(schema.org)
    .set({ name })
    .where(orm.eq(schema.org.orgId, orgId))
    .limit(1)
    .returning({ orgId: schema.org.orgId })
  if (updated.length === 0) throw new Error('Organization not found')
  return { orgId, name }
}

// ── Invite links (secret links, sigillo-style) ──────────────────────

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const createInviteSchema = z.object({ orgId: z.string().min(1) })

/** Generate a secret invite link for an org the caller administers.
 *  Anyone with the link can join as a member after signing in, until it
 *  expires. */
export async function createInvite(input: { orgId: string }) {
  const actionRequest = getActionRequest()
  const { orgId } = createInviteSchema.parse(input)
  const { session, org, role } = await requireOrgAccess(actionRequest, orgId)
  if (role !== 'admin') throw new Error('Only admins can create invites')
  const db = getDb()
  const [invite] = await db
    .insert(schema.orgInvitation)
    .values({
      orgId: org.orgId,
      createdBy: session.userId,
      expiresAt: Date.now() + INVITE_EXPIRY_MS,
    })
    .returning({ invitationId: schema.orgInvitation.invitationId })
  return { invitationId: invite!.invitationId }
}

const acceptInviteSchema = z.object({ invitationId: z.string().min(1) })

/** Join the org behind an invite link. Looks the invite up WITHOUT
 *  deleting it — the row stays valid until it expires, so a page
 *  re-render after accept doesn't show "invalid invitation". */
export async function acceptInvite(input: { invitationId: string }) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  requireVerifiedEmail(session)
  const { invitationId } = acceptInviteSchema.parse(input)
  const db = getDb()
  const invite = await db.query.orgInvitation.findFirst({ where: { invitationId } })
  if (!invite || invite.expiresAt < Date.now()) {
    throw new Error('Invitation not found or expired')
  }
  if (invite.purpose === 'EVALUATION_REVIEWER') {
    const decision = invitationAcceptanceDecision({
      now: Date.now(),
      expiresAt: invite.expiresAt,
      invitedEmail: invite.invitedEmail ?? '',
      userEmail: session.user.email,
      emailVerified: session.user.emailVerified,
    })
    if (!decision.ok) throw new Error(decision.message)
    if (!invite.eventId || !invite.formId) throw new Error('Reviewer invitation is invalid')
    await db.insert(schema.evaluationReviewer).values({
      eventId: invite.eventId,
      formId: invite.formId,
      userId: session.userId,
    }).onConflictDoNothing({ target: [schema.evaluationReviewer.formId, schema.evaluationReviewer.userId] })
    throw redirect(router.href('/review/:formId', { formId: invite.formId }))
  }
  // onConflictDoNothing handles the already-member case (unique index on
  // org_id + user_id prevents duplicates).
  await db
    .insert(schema.orgMember)
    .values({ orgId: invite.orgId, userId: session.userId, role: invite.role })
    .onConflictDoNothing({ target: [schema.orgMember.orgId, schema.orgMember.userId] })
  throw redirect(router.href('/org/:orgId', { orgId: invite.orgId }))
}

const inviteReviewerSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  formId: z.string().min(1),
  email: z.string().trim().toLowerCase().email(),
})

export async function inviteEvaluationReviewer(input: z.input<typeof inviteReviewerSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = inviteReviewerSchema.parse(input)
  const { db, event } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  const form = await db.query.form.findFirst({
    where: { id: parsed.formId, eventId: parsed.eventId, purpose: 'EVALUATION' },
  })
  if (!form) throw new Error('Evaluation round not found')
  const invitationId = ulid()
  const now = Date.now()
  await db.insert(schema.orgInvitation).values({
    invitationId,
    orgId: parsed.orgId,
    purpose: 'EVALUATION_REVIEWER',
    invitedEmail: parsed.email,
    eventId: parsed.eventId,
    formId: parsed.formId,
    createdBy: session.userId,
    expiresAt: now + INVITE_EXPIRY_MS,
  })
  const inviteUrl = new URL(`/invite/${invitationId}`, env.APP_URL).href
  await enqueueAndSend({
    db,
    eventId: event.id,
    toEmail: parsed.email,
    dedupeKey: dedupeKeys.reviewerInvite(invitationId),
    replyTo: replyToFor(event.contactEmail),
    now,
    payload: {
      kind: 'REVIEWER_INVITE',
      context: {
        eventName: event.name,
        eventSlug: event.slug,
        appUrl: env.APP_URL,
        timezone: event.timezone,
      },
      data: { roundName: form.name, inviteUrl },
    },
  })
  return { invitationId, inviteUrl }
}


// ── Member management ───────────────────────────────────────────────

async function loadManagedMember(actionRequest: Request, memberId: string) {
  const session = await requireSession(actionRequest)
  const db = getDb()
  const member = await db.query.orgMember.findFirst({
    where: { memberId },
    with: { org: true },
  })
  if (!member?.org) throw new Error('Member not found')
  await requireAdminRole(session.userId, member.orgId)
  return { db, member, org: member.org }
}

async function ensureAnotherAdminExists(orgId: string, userId: string) {
  const db = getDb()
  const admins = await db.query.orgMember.findMany({
    where: { orgId, role: 'admin' },
    columns: { userId: true },
  })
  if (admins.length === 1 && admins[0]?.userId === userId) {
    throw new Error('This organization needs at least one admin')
  }
}

const memberRoleSchema = z.object({
  memberId: z.string().min(1),
  role: z.enum(['admin', 'member']),
})

export async function updateMemberRole(input: { memberId: string; role: 'admin' | 'member' }) {
  const actionRequest = getActionRequest()
  const { memberId, role } = memberRoleSchema.parse(input)
  const { db, member, org } = await loadManagedMember(actionRequest, memberId)

  if (member.role === role) return { memberId, role }

  if (member.role === 'admin' && role !== 'admin') {
    // The owner of a personal org is its permanent admin — the personal
    // org must always exist as the user's working default.
    if (org.kind === 'personal' && member.userId === org.ownerUserId) {
      throw new Error('The owner of a personal organization is always an admin')
    }
    await ensureAnotherAdminExists(member.orgId, member.userId)
  }

  await db
    .update(schema.orgMember)
    .set({ role })
    .where(orm.eq(schema.orgMember.memberId, memberId))
    .limit(1)
  return { memberId, role }
}

const memberIdSchema = z.object({ memberId: z.string().min(1) })

export async function removeMember(input: { memberId: string }) {
  const actionRequest = getActionRequest()
  const { memberId } = memberIdSchema.parse(input)
  const { db, member, org } = await loadManagedMember(actionRequest, memberId)

  // The personal org owner can never be removed: the personal org is the
  // deterministic default, so it must keep its owner.
  if (org.kind === 'personal' && member.userId === org.ownerUserId) {
    throw new Error('The owner cannot be removed from their personal organization')
  }
  if (member.role === 'admin') {
    await ensureAnotherAdminExists(member.orgId, member.userId)
  }

  await db
    .delete(schema.orgMember)
    .where(orm.eq(schema.orgMember.memberId, memberId))
    .limit(1)
  return { memberId }
}

// ── Event actions ───────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** Date-only inputs stay day keys until the event timezone is known. */
const DAY_KEY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * Resolve the event's date-only bounds to instants THROUGH the event timezone.
 *
 * Storing `T00:00:00Z` / `T23:59:59Z` and re-reading them in the event timezone
 * is off by the zone's offset, which pushes the last day into the next one for
 * any positive-offset event and drops the first day for a negative one. The
 * agenda then shows a phantom day the conference does not run on.
 */
function resolveEventBounds({
  startsAt,
  endsAt,
  timezone,
}: {
  startsAt: string
  endsAt: string
  timezone: string
}): { startsAt: number; endsAt: number } {
  const start = zonedEpoch(startsAt, 0, timezone)
  // 23:59 local on the closing day, so the whole last day is inside the range.
  const end = zonedEpoch(endsAt, 23 * 60 + 59, timezone)
  if (end <= start) throw new Error('The event must end after it starts')
  return { startsAt: start, endsAt: end }
}

const createEventSchema = z.object({
  orgId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(SLUG_RE).max(60).optional(),
  timezone: z.string().min(1).max(60),
  /** Local calendar day, `YYYY-MM-DD`. Resolved to an instant through the
   *  event timezone, NOT UTC — see resolveEventBounds. */
  startsAt: DAY_KEY,
  endsAt: DAY_KEY,
})

/** Create an event in the org and redirect to it. Any member can create
 *  events (org-level authz, no per-event roles). */
export async function createEvent(input: z.input<typeof createEventSchema>) {
  const actionRequest = getActionRequest()
  const parsed = createEventSchema.parse(input)
  const { session } = await requireOrgAccess(actionRequest, parsed.orgId)
  validateTimezone(parsed.timezone)
  const bounds = resolveEventBounds(parsed)

  const slug = parsed.slug || slugify(parsed.name)
  if (!SLUG_RE.test(slug)) throw new Error('Could not derive a valid slug from the event name')

  const db = getDb()
  const eventId = ulid()
  const now = Date.now()
  const cfpFormId = ulid()
  const speakerFormId = ulid()
  const materialsFormId = ulid()
  const trackId = ulid()
  const formatId = ulid()
  const defaultTasks = defaultFormTaskDefinitions({
    eventId,
    now,
    speakerProfileFormId: speakerFormId,
    sessionMaterialsFormId: materialsFormId,
  })
  try {
    // Event + default OPEN forms (CFP, speaker profile, materials) + FORM
    // tasks + a starter track/format so CFP selects work immediately.
    // Event ACTIVE + CFP OPEN on create so the public share link works without
    // a second settings pass.
    await db.batch([
      db.insert(schema.event).values({
        id: eventId,
        orgId: parsed.orgId,
        name: parsed.name,
        slug,
        status: 'ACTIVE',
        timezone: parsed.timezone,
        startsAt: bounds.startsAt,
        endsAt: bounds.endsAt,
        // Reply-To for every mail this event sends. Seeded from the creator so
        // speaker replies land in a real inbox from day one; editable later in
        // Settings → Details.
        contactEmail: session.user.email,
      }),
      db.insert(schema.track).values({
        id: trackId,
        eventId,
        name: 'General',
        color: '#6366f1',
        sortOrder: 0,
      }),
      db.insert(schema.format).values({
        id: formatId,
        eventId,
        name: 'Talk',
        defaultDurationMinutes: 30,
        sortOrder: 0,
      }),
      db.insert(schema.form).values({
        id: cfpFormId,
        eventId,
        purpose: 'CFP',
        target: 'SUBMISSION',
        name: 'Call for speakers',
        slug: 'cfp',
        status: 'OPEN',
      }),
      db.insert(schema.formVersion).values({ formId: cfpFormId, mdxSource: starterCfpTemplate }),
      db.insert(schema.form).values({
        id: speakerFormId,
        eventId,
        purpose: 'PORTAL',
        target: 'SPEAKER',
        name: 'Speaker profile',
        slug: 'speaker-profile',
        status: 'OPEN',
      }),
      db.insert(schema.formVersion).values({
        formId: speakerFormId,
        mdxSource: starterSpeakerProfileTemplate,
      }),
      db.insert(schema.form).values({
        id: materialsFormId,
        eventId,
        purpose: 'PORTAL',
        target: 'SUBMISSION',
        name: 'Session materials',
        slug: 'session-materials',
        status: 'OPEN',
      }),
      db.insert(schema.formVersion).values({
        formId: materialsFormId,
        mdxSource: starterSessionMaterialsTemplate,
      }),
      ...defaultTasks.map((task) => db.insert(schema.taskDefinition).values(task)),
    ] as [any, ...any[]])
  } catch {
    // Global unique slug — the most likely failure mode.
    throw new Error(`The slug "${slug}" is already taken. Pick another one.`)
  }
  throw redirect(router.href('/org/:orgId/e/:eventId', { orgId: parsed.orgId, eventId }))
}

// ── Event settings actions ──────────────────────────────────────────

function validateTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    throw new Error(`Unknown timezone: ${timezone}`)
  }
}

/** Auth + tenancy check shared by every event-scoped action: the caller
 *  must be a member of the org AND the event must belong to that org.
 *  Never trust the eventId alone — it comes from the client. */
async function requireEventAccess({ actionRequest, orgId, eventId }: {
  actionRequest: Request
  orgId: string
  eventId: string
}) {
  const access = await requireOrgAccess(actionRequest, orgId)
  const db = getDb()
  const event = await db.query.event.findFirst({ where: { id: eventId, orgId } })
  if (!event) throw new Error('Event not found')
  return { db, event, session: access.session }
}

const updateEventSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(SLUG_RE).max(60),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
  websiteUrl: z.string().trim().max(500),
  location: z.string().trim().max(200),
  timezone: z.string().min(1).max(60),
  /** Local calendar day, `YYYY-MM-DD`. */
  startsAt: DAY_KEY,
  endsAt: DAY_KEY,
  description: z.string().trim().max(5000),
  /** Reply-To for every outbound email of this event. Empty clears it and
   *  falls back to the platform sender. */
  contactEmail: z.union([z.literal(''), z.email().max(320)]),
})

/** Update the event details (Settings > Details). Empty optional strings
 *  are stored as NULL. */
export async function updateEvent(input: z.input<typeof updateEventSchema>) {
  const actionRequest = getActionRequest()
  const parsed = updateEventSchema.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  validateTimezone(parsed.timezone)
  const bounds = resolveEventBounds(parsed)

  try {
    await db
      .update(schema.event)
      .set({
        name: parsed.name,
        slug: parsed.slug,
        status: parsed.status,
        websiteUrl: parsed.websiteUrl || null,
        location: parsed.location || null,
        timezone: parsed.timezone,
        startsAt: bounds.startsAt,
        endsAt: bounds.endsAt,
        description: parsed.description || null,
        contactEmail: parsed.contactEmail.trim() || null,
        updatedAt: Date.now(),
      })
      .where(orm.eq(schema.event.id, parsed.eventId))
      .limit(1)
  } catch {
    // Global unique slug — the most likely failure mode.
    throw new Error(`The slug "${parsed.slug}" is already taken. Pick another one.`)
  }
  return { eventId: parsed.eventId }
}

const createApiKeySchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  scopes: z.array(ApiScopeSchema).min(1).max(API_SCOPES.length),
})

export async function createApiKey(input: z.input<typeof createApiKeySchema>) {
  const actionRequest = getActionRequest()
  const parsed = createApiKeySchema.parse(input)
  const { db, session } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  await requireAdminRole(session.userId, parsed.orgId)
  const secret = generateApiKeySecret()
  const id = ulid()
  const createdAt = Date.now()
  await db.batch([
    db.insert(schema.apiKey).values({
      id,
      orgId: parsed.orgId,
      eventId: parsed.eventId,
      name: parsed.name,
      keyHash: await hashApiKeySecret(secret),
      keyPrefix: secret.slice(0, 12),
      createdByUserId: session.userId,
      createdAt,
    }),
    ...parsed.scopes.map((scope) => db.insert(schema.apiKeyScope).values({ apiKeyId: id, scope })),
  ] as [any, ...any[]])
  return { id, name: parsed.name, secret, scopes: parsed.scopes, createdAt }
}

const revokeApiKeySchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  apiKeyId: z.string().min(1),
})

export async function revokeApiKey(input: z.input<typeof revokeApiKeySchema>) {
  const actionRequest = getActionRequest()
  const parsed = revokeApiKeySchema.parse(input)
  const { db, session } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  await requireAdminRole(session.userId, parsed.orgId)
  const key = await db.query.apiKey.findFirst({
    where: { id: parsed.apiKeyId, eventId: parsed.eventId, orgId: parsed.orgId },
  })
  if (!key) throw new Error('API key not found')
  await db.update(schema.apiKey)
    .set({ revokedAt: Date.now() })
    .where(orm.eq(schema.apiKey.id, parsed.apiKeyId))
    .limit(1)
  return { apiKeyId: parsed.apiKeyId }
}

// ── Library: tracks / formats / rooms ───────────────────────────────
//
// Deletes must detach sessions FIRST: the session→track/format/room
// composite FKs are NO ACTION (see db/src/schema.ts), so deleting a
// referenced library row would fail. Detach + delete go in one atomic
// db.batch.

const createTrackSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  /** Hex color, e.g. "#6366f1". */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
})

export async function createTrack(input: z.input<typeof createTrackSchema>) {
  const actionRequest = getActionRequest()
  const parsed = createTrackSchema.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  try {
    await db.insert(schema.track).values({
      eventId: parsed.eventId,
      name: parsed.name,
      color: parsed.color,
    })
  } catch {
    throw new Error(`A track named "${parsed.name}" already exists`)
  }
  return { name: parsed.name }
}

const deleteTrackSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  trackId: z.string().min(1),
})

export async function deleteTrack(input: z.input<typeof deleteTrackSchema>) {
  const actionRequest = getActionRequest()
  const parsed = deleteTrackSchema.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  const row = await db.query.track.findFirst({ where: { id: parsed.trackId, eventId: parsed.eventId } })
  if (!row) throw new Error('Track not found')
  await db.batch([
    db
      .update(schema.eventSession)
      .set({ trackId: null })
      .where(orm.eq(schema.eventSession.trackId, parsed.trackId)),
    db.delete(schema.track).where(orm.eq(schema.track.id, parsed.trackId)).limit(1),
  ] as const)
  return { trackId: parsed.trackId }
}

const createFormatSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  defaultDurationMinutes: z.number().int().min(1).max(24 * 60).nullable(),
})

export async function createFormat(input: z.input<typeof createFormatSchema>) {
  const actionRequest = getActionRequest()
  const parsed = createFormatSchema.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  try {
    await db.insert(schema.format).values({
      eventId: parsed.eventId,
      name: parsed.name,
      defaultDurationMinutes: parsed.defaultDurationMinutes,
    })
  } catch {
    throw new Error(`A format named "${parsed.name}" already exists`)
  }
  return { name: parsed.name }
}

const deleteFormatSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  formatId: z.string().min(1),
})

export async function deleteFormat(input: z.input<typeof deleteFormatSchema>) {
  const actionRequest = getActionRequest()
  const parsed = deleteFormatSchema.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  const row = await db.query.format.findFirst({ where: { id: parsed.formatId, eventId: parsed.eventId } })
  if (!row) throw new Error('Format not found')
  await db.batch([
    db
      .update(schema.eventSession)
      .set({ formatId: null })
      .where(orm.eq(schema.eventSession.formatId, parsed.formatId)),
    db.delete(schema.format).where(orm.eq(schema.format.id, parsed.formatId)).limit(1),
  ] as const)
  return { formatId: parsed.formatId }
}

const createRoomSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
})

export async function createRoom(input: z.input<typeof createRoomSchema>) {
  const actionRequest = getActionRequest()
  const parsed = createRoomSchema.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  try {
    await db.insert(schema.room).values({ eventId: parsed.eventId, name: parsed.name })
  } catch {
    throw new Error(`A room named "${parsed.name}" already exists`)
  }
  return { name: parsed.name }
}

const deleteRoomSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  roomId: z.string().min(1),
})

export async function deleteRoom(input: z.input<typeof deleteRoomSchema>) {
  const actionRequest = getActionRequest()
  const parsed = deleteRoomSchema.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  const row = await db.query.room.findFirst({ where: { id: parsed.roomId, eventId: parsed.eventId } })
  if (!row) throw new Error('Room not found')
  await db.batch([
    db
      .update(schema.eventSession)
      .set({ roomId: null })
      .where(orm.eq(schema.eventSession.roomId, parsed.roomId)),
    db.delete(schema.room).where(orm.eq(schema.room.id, parsed.roomId)).limit(1),
  ] as const)
  return { roomId: parsed.roomId }
}

// ── Form actions (forms list + MDX editor) ──────────────────────────
//
// The live MDX of a form is DERIVED: the newest FormVersion. Versions are
// immutable — "save" always inserts a new row, never updates one, so every
// FormResponse keeps pointing at the exact MDX it was filled against.

const MDX_SOURCE_MAX = 100_000

/** requireEventAccess + the form must belong to that event. Never trust
 *  the formId alone — it comes from the client. */
async function requireFormAccess({ actionRequest, orgId, eventId, formId }: {
  actionRequest: Request
  orgId: string
  eventId: string
  formId: string
}) {
  const { db, event } = await requireEventAccess({ actionRequest, orgId, eventId })
  const form = await db.query.form.findFirst({ where: { id: formId, eventId } })
  if (!form) throw new Error('Form not found')
  return { db, event, form }
}

const createFormSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  name: z.string().trim().min(1, 'Form name is required').max(120, 'Form name must be 120 characters or less'),
  slug: z.string().trim().toLowerCase().regex(SLUG_RE).max(60).optional(),
  purpose: z.enum(['CFP', 'PORTAL', 'EVALUATION']),
  /** Portal only; CFP forms are always about the submission. */
  target: z.enum(['SUBMISSION', 'SPEAKER']).optional(),
  opensAt: z.number().int('Open date is invalid').positive('Open date is invalid').nullable().optional(),
  closesAt: z.number().int('Close date is invalid').positive('Close date is invalid').nullable().optional(),
  blind: z.boolean().optional(),
})

/** Create a form with its first FormVersion seeded from the matching
 *  starter template, then redirect to the editor. */
export async function createForm(input: z.input<typeof createFormSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = createFormSchema.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  if (parsed.opensAt != null && parsed.closesAt != null && parsed.opensAt >= parsed.closesAt) {
    throw new Error('The open date must be before the close date')
  }

  const slug = parsed.slug || slugify(parsed.name)
  if (!SLUG_RE.test(slug)) throw new Error('Could not derive a valid slug from the form name')

  const duplicateError = (existing: { name: string; purpose: string }) => {
    if (parsed.purpose === 'EVALUATION' && existing.purpose === 'EVALUATION') {
      return new Error(`An evaluation round named "${existing.name}" already exists. Open "${existing.name}" to edit it.`)
    }
    return new Error(`The slug "${slug}" is already used by "${existing.name}" in this event`)
  }
  const existing = await db.query.form.findFirst({ where: { eventId: parsed.eventId, slug } })
  if (existing) throw duplicateError(existing)

  const formId = ulid()
  const template =
    parsed.purpose === 'CFP'
      ? starterCfpTemplate
      : parsed.purpose === 'EVALUATION'
        ? starterEvaluationTemplate
      : parsed.target === 'SPEAKER'
        ? starterSpeakerProfileTemplate
        : starterPortalTemplate
  try {
    // Form + first version in one atomic batch (versions FK the form).
    await db.batch([
      db.insert(schema.form).values({
        id: formId,
        eventId: parsed.eventId,
        purpose: parsed.purpose,
        target: parsed.purpose === 'PORTAL' ? (parsed.target ?? 'SUBMISSION') : 'SUBMISSION',
        name: parsed.name,
        slug,
        status: 'OPEN',
        opensAt: parsed.opensAt ?? null,
        closesAt: parsed.closesAt ?? null,
        blind: parsed.purpose === 'EVALUATION' ? (parsed.blind ?? false) : false,
      }),
      db.insert(schema.formVersion).values({ formId, mdxSource: template }),
    ] as const)
  } catch (cause) {
    // A concurrent create can pass the pre-read. Only translate the failure
    // when the conflicting row now exists; preserve every other DB error.
    const raced = await db.query.form.findFirst({ where: { eventId: parsed.eventId, slug } })
    if (raced) throw duplicateError(raced)
    throw cause
  }
  if (parsed.purpose === 'EVALUATION') return { id: formId, name: parsed.name, slug }
  throw redirect(router.href('/org/:orgId/e/:eventId/forms/:formId', {
    orgId: parsed.orgId,
    eventId: parsed.eventId,
    formId,
  }))
}

const saveFormVersionSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  formId: z.string().min(1),
  mdxSource: z.string().min(1).max(MDX_SOURCE_MAX),
})

/** Collect every field name reachable with an empty values scope. Fields
 *  behind <Show> conditionals that reference values are excluded on BOTH
 *  sides of the version diff, so the removed-names comparison stays
 *  consistent. Empty option arrays: names don't depend on options. */
function collectFieldNames(mdxSource: string): Set<string> {
  const collected = collectFields({ mdxSource, scope: { values: {}, tracks: [], formats: [] } })
  return new Set([...collected.fields, ...collected.participantFields].map((field) => field.name))
}

/** Insert a NEW immutable FormVersion. When field names disappear compared
 *  to the previous version AND the form already has responses, the version
 *  still saves but `removedFields` warns the admin (old responses keep
 *  values under those names). */
export async function saveFormVersion(input: z.input<typeof saveFormVersionSchema>) {
  const actionRequest = getActionRequest()
  const parsed = saveFormVersionSchema.parse(input)
  const { db } = await requireFormAccess({
    actionRequest, orgId: parsed.orgId, eventId: parsed.eventId, formId: parsed.formId,
  })

  const [previous, responses] = await db.batch([
    db.query.formVersion.findFirst({
      where: { formId: parsed.formId },
      orderBy: { createdAt: 'desc', id: 'desc' },
    }),
    db.query.formResponse.findMany({ where: { formId: parsed.formId }, columns: { id: true } }),
  ] as const)

  let removedFields: string[] = []
  if (previous && responses.length > 0) {
    const oldNames = collectFieldNames(previous.mdxSource)
    const newNames = collectFieldNames(parsed.mdxSource)
    removedFields = [...oldNames].filter((name) => !newNames.has(name))
  }

  const [version] = await db
    .insert(schema.formVersion)
    .values({ formId: parsed.formId, mdxSource: parsed.mdxSource })
    .returning({ id: schema.formVersion.id })
  return { versionId: version!.id, removedFields }
}

const updateFormSettingsSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  formId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(SLUG_RE).max(60),
  status: z.enum(['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED']),
  /** Epoch ms; null clears the deadline. */
  closesAt: z.number().int().positive().nullable(),
  opensAt: z.number().int().positive().nullable().optional(),
  blind: z.boolean().optional(),
})

/** Update form settings (name, slug, status, closesAt). Purpose and target
 *  are immutable after creation — they decide where responses land. */
export async function updateFormSettings(input: z.input<typeof updateFormSettingsSchema>) {
  const actionRequest = getActionRequest()
  const parsed = updateFormSettingsSchema.parse(input)
  const { db, form } = await requireFormAccess({
    actionRequest, orgId: parsed.orgId, eventId: parsed.eventId, formId: parsed.formId,
  })
  const opensAt = parsed.opensAt === undefined ? form.opensAt : parsed.opensAt
  if (opensAt != null && parsed.closesAt != null && opensAt >= parsed.closesAt) {
    throw new Error('The open date must be before the close date')
  }
  try {
    await db
      .update(schema.form)
      .set({
        name: parsed.name,
        slug: parsed.slug,
        status: parsed.status,
        closesAt: parsed.closesAt,
        ...(parsed.opensAt !== undefined ? { opensAt: parsed.opensAt } : {}),
        ...(parsed.blind !== undefined ? { blind: parsed.blind } : {}),
        updatedAt: Date.now(),
      })
      .where(orm.eq(schema.form.id, parsed.formId))
      .limit(1)
  } catch {
    // Per-event unique slug — the most likely failure mode.
    throw new Error(`The slug "${parsed.slug}" is already used by another form of this event`)
  }
  return { formId: parsed.formId }
}

const deleteFormSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  formId: z.string().min(1),
})

/** Delete a form (cascade removes its versions). Only allowed while the
 *  form has ZERO responses — the formResponse→form FK is RESTRICT, forms
 *  with history are archived instead. Redirects to the owning list. */
export async function deleteForm(input: z.input<typeof deleteFormSchema>) {
  const actionRequest = getActionRequest()
  const parsed = deleteFormSchema.parse(input)
  const { db, form } = await requireFormAccess({
    actionRequest, orgId: parsed.orgId, eventId: parsed.eventId, formId: parsed.formId,
  })
  const responses = await db.query.formResponse.findMany({
    where: { formId: parsed.formId },
    columns: { id: true },
  })
  if (responses.length > 0) {
    throw new Error('This form has responses and cannot be deleted. Archive it instead.')
  }
  await db.delete(schema.form).where(orm.eq(schema.form.id, parsed.formId)).limit(1)
  throw redirect(router.href('/org/:orgId/e/:eventId/forms', {
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  }))
}

// ── Public CFP actions ───────────────────────────────────────────────

const cfpActionSchema = z.object({
  eventId: z.string().min(1),
  formId: z.string().min(1),
  responseId: z.string().min(1),
  submission: cfpSubmissionSchema,
})

const startPublicCfpSchema = z.object({
  eventSlug: z.string().min(1),
  formSlug: z.string().min(1),
})

export async function startPublicCfpSubmission(input: z.input<typeof startPublicCfpSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = startPublicCfpSchema.parse(input)
  const cfp = await getPublicCfp(parsed.eventSlug, parsed.formSlug)
  if (!cfp) throw new Error('This CFP is not open')
  const draft = await getOrCreateCfpDraft({ cfp, session, explicitlyRequested: true })
  if (!draft) throw new Error('Could not start a submission')
  throw redirect(router.href('/submit/:eventSlug/:formSlug', {
    eventSlug: parsed.eventSlug,
    formSlug: parsed.formSlug,
  }))
}

export async function resetPublicCfpDraft(input: z.input<typeof startPublicCfpSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = startPublicCfpSchema.parse(input)
  const cfp = await getPublicCfp(parsed.eventSlug, parsed.formSlug)
  if (!cfp) throw new Error('This CFP is not open')
  return resetCfpDraft({ cfp, session })
}

/** Save an incomplete CFP response. Authentication happens before parsing
 * any caller-controlled identifiers because server actions are public. */
export async function savePublicCfpDraft(input: z.input<typeof cfpActionSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = cfpActionSchema.parse(input)
  const result = await saveCfpDraft({ ...parsed, session })
  throw redirect(router.href('/portal/:eventSlug/submissions', { eventSlug: result.eventSlug }))
}

/** Validate and submit the response against its immutable pinned version. */
export async function submitPublicCfp(input: z.input<typeof cfpActionSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = cfpActionSchema.parse(input)
  const result = await submitCfpResponse({ ...parsed, session })
  throw redirect(router.href('/portal/:eventSlug/submissions', { eventSlug: result.eventSlug }))
}

// ── Speaker portal actions (speaker-owned, not org-admin) ───────────

const portalSessionActionSchema = z.object({
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
})

export async function withdrawPortalSubmission(input: z.input<typeof portalSessionActionSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = portalSessionActionSchema.parse(input)
  const result = await withdrawPortalSubmissionServer({ ...parsed, session })
  throw redirect(router.href('/portal/:eventSlug/submissions', { eventSlug: result.eventSlug }))
}

const savePortalSubmissionSchema = portalSessionActionSchema.extend({
  submission: cfpSubmissionSchema,
  submit: z.boolean().default(true),
})

export async function savePortalSubmission(input: z.input<typeof savePortalSubmissionSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = savePortalSubmissionSchema.parse(input)
  const result = await savePortalSubmissionServer({ ...parsed, session })
  throw redirect(router.href('/portal/:eventSlug/submissions', { eventSlug: result.eventSlug }))
}

const savePortalProfileSchema = z.object({
  eventId: z.string().min(1),
  formId: z.string().min(1),
  submission: cfpSubmissionSchema,
})

export async function savePortalProfile(input: z.input<typeof savePortalProfileSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = savePortalProfileSchema.parse(input)
  return savePortalProfileServer({ ...parsed, session })
}

const saveOrganizerSpeakerProfileSchema = savePortalProfileSchema.extend({
  orgId: z.string().min(1),
  speakerId: z.string().min(1),
})

export async function saveOrganizerSpeakerProfile(
  input: z.input<typeof saveOrganizerSpeakerProfileSchema>,
) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = saveOrganizerSpeakerProfileSchema.parse(input)
  await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  return saveOrganizerSpeakerProfileServer(parsed)
}

const portalAssignmentActionSchema = z.object({
  eventId: z.string().min(1),
  assignmentId: z.string().min(1),
})

export async function completeManualTaskAssignment(
  input: z.input<typeof portalAssignmentActionSchema>,
) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = portalAssignmentActionSchema.parse(input)
  return completeManualTaskAssignmentServer({ ...parsed, session })
}

const submitPortalFormTaskSchema = portalAssignmentActionSchema.extend({
  submission: cfpSubmissionSchema,
})

export async function submitPortalFormTask(input: z.input<typeof submitPortalFormTaskSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = submitPortalFormTaskSchema.parse(input)
  return submitPortalFormTaskServer({ ...parsed, session })
}

// ── Abstracts / evaluation / tasks ──────────────────────────────────

const sessionStatusSchema = z.enum([
  'DRAFT',
  'PENDING',
  'ACCEPT_QUEUE',
  'ACCEPTED',
  'DECLINE_QUEUE',
  'DECLINED',
  'WITHDRAWN',
])

async function loadEventSession({
  db,
  eventId,
  sessionId,
}: {
  db: ReturnType<typeof getDb>
  eventId: string
  sessionId: string
}) {
  const row = await db.query.eventSession.findFirst({
    where: { id: sessionId, eventId },
    with: {
      participants: { columns: { speakerId: true } },
    },
  })
  if (!row) throw new Error('Session not found')
  return row
}

const updateSessionStatusSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  status: sessionStatusSchema,
})

/** Single-session guarded status change (queues, withdraw, unqueue, etc.). */
export async function updateSessionStatus(input: z.input<typeof updateSessionStatusSchema>) {
  const actionRequest = getActionRequest()
  const parsed = updateSessionStatusSchema.parse(input)
  const { db } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const row = await loadEventSession({
    db,
    eventId: parsed.eventId,
    sessionId: parsed.sessionId,
  })
  const now = Date.now()
  const patch = applyTransition(
    {
      status: row.status,
      title: row.title,
      submittedAt: row.submittedAt,
      decidedAt: row.decidedAt,
      withdrawnAt: row.withdrawnAt,
      notifiedAt: row.notifiedAt,
    },
    parsed.status,
    now,
  )
  await db
    .update(schema.eventSession)
    .set(patch)
    .where(
      orm.and(
        orm.eq(schema.eventSession.id, parsed.sessionId),
        orm.eq(schema.eventSession.eventId, parsed.eventId),
      ),
    )
    .limit(1)

  if (patch.status === 'ACCEPTED') {
    await assignTasksForAcceptedSession({
      db,
      eventId: parsed.eventId,
      sessionId: parsed.sessionId,
      participants: row.participants,
      now,
    })
  }
  return { sessionId: parsed.sessionId, status: patch.status }
}

const bulkUpdateSessionStatusSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  sessionIds: z.array(z.string().min(1)).min(1).max(500),
  status: sessionStatusSchema,
})

/** Bulk move selected abstracts (typically into queues). Illegal edges skip. */
export async function bulkUpdateSessionStatus(
  input: z.input<typeof bulkUpdateSessionStatusSchema>,
) {
  const actionRequest = getActionRequest()
  const parsed = bulkUpdateSessionStatusSchema.parse(input)
  const { db } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const rows = await db.query.eventSession.findMany({
    where: { eventId: parsed.eventId, id: { in: parsed.sessionIds } },
  })
  if (rows.length !== parsed.sessionIds.length) throw new Error('Some selected sessions no longer exist')
  const now = Date.now()
  const planned = planBulkStatusUpdate(
    rows.map((row) => ({
      id: row.id,
      status: row.status,
      title: row.title,
      submittedAt: row.submittedAt,
      decidedAt: row.decidedAt,
      withdrawnAt: row.withdrawnAt,
      notifiedAt: row.notifiedAt,
    })),
    parsed.status,
    now,
  )
  if (planned.length === 0) return { updated: 0 }

  const statements = planned.map((patch) =>
    db
      .update(schema.eventSession)
      .set({
        status: patch.status,
        ...(patch.title != null ? { title: patch.title } : {}),
        submittedAt: patch.submittedAt,
        decidedAt: patch.decidedAt,
        withdrawnAt: patch.withdrawnAt,
        ...(patch.notifiedAt !== undefined ? { notifiedAt: patch.notifiedAt } : {}),
        updatedAt: patch.updatedAt,
      })
      .where(
        orm.and(
          orm.eq(schema.eventSession.id, patch.id),
          orm.eq(schema.eventSession.eventId, parsed.eventId),
        ),
      )
      .limit(1),
  )
  await db.batch(statements as [any, ...any[]])

  // Bulk ACCEPT_QUEUE→ACCEPTED is rare (notifyQueue is the normal path) but
  // still assign tasks when the target is ACCEPTED.
  if (parsed.status === 'ACCEPTED') {
    for (const patch of planned) {
      const full = rows.find((row) => row.id === patch.id)
      if (!full) continue
      const withParts = await loadEventSession({
        db,
        eventId: parsed.eventId,
        sessionId: patch.id,
      })
      await assignTasksForAcceptedSession({
        db,
        eventId: parsed.eventId,
        sessionId: patch.id,
        participants: withParts.participants,
        now,
      })
    }
  }
  return { updated: planned.length }
}

const notifyQueueSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  queue: z.enum(['accept', 'decline']),
  /** Optional subset; default = every session currently in that queue. */
  sessionIds: z.array(z.string().min(1)).max(500).optional(),
})

/** Finalise accept or decline queue: status → ACCEPTED/DECLINED, task
 *  auto-assign on accept, and send the DECISION_* mail through the outbox.
 *  notifiedAt is stamped only for sessions whose decision mail reached SENT,
 *  so the Abstracts "Notified" column never lies about delivery. */
export async function notifyQueue(input: z.input<typeof notifyQueueSchema>) {
  const actionRequest = getActionRequest()
  const parsed = notifyQueueSchema.parse(input)
  const { db, event } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const fromStatus: SessionStatus =
    parsed.queue === 'accept' ? 'ACCEPT_QUEUE' : 'DECLINE_QUEUE'
  const rows = await db.query.eventSession.findMany({
    where: {
      eventId: parsed.eventId,
      status: fromStatus,
      ...(parsed.sessionIds?.length ? { id: { in: parsed.sessionIds } } : {}),
    },
    with: {
      participants: {
        with: { speaker: true },
      },
    },
  })
  const now = Date.now()
  const planned = planNotifyQueue(
    rows.map((row) => ({
      id: row.id,
      status: row.status,
      title: row.title,
      submittedAt: row.submittedAt,
      decidedAt: row.decidedAt,
      withdrawnAt: row.withdrawnAt,
      notifiedAt: row.notifiedAt,
    })),
    parsed.queue,
    now,
  )
  if (planned.length === 0) return { updated: 0, emailsQueued: 0, emailsSent: 0 }

  const updates = planned.map((patch) =>
    db
      .update(schema.eventSession)
      .set({
        status: patch.status,
        ...(patch.title != null ? { title: patch.title } : {}),
        submittedAt: patch.submittedAt,
        decidedAt: patch.decidedAt,
        withdrawnAt: patch.withdrawnAt,
        ...(patch.notifiedAt !== undefined ? { notifiedAt: patch.notifiedAt } : {}),
        updatedAt: patch.updatedAt,
      })
      .where(
        orm.and(
          orm.eq(schema.eventSession.id, patch.id),
          orm.eq(schema.eventSession.eventId, parsed.eventId),
          orm.eq(schema.eventSession.status, patch.from),
        ),
      )
      .limit(1),
  )
  await db.batch(updates as [any, ...any[]])
  const finalizedRows = await db.query.eventSession.findMany({
    where: { eventId: parsed.eventId, id: { in: planned.map((patch) => patch.id) } },
  })
  const finalizedIds = new Set(finalizedRows
    .filter((row) => planned.some((patch) =>
      patch.id === row.id
      && patch.status === row.status
      && patch.decidedAt === row.decidedAt,
    ))
    .map((row) => row.id))
  const finalized = planned.filter((patch) => finalizedIds.has(patch.id))

  let emailsQueued = 0
  let emailsSent = 0
  const taskDefs =
    parsed.queue === 'accept'
      ? await db.query.taskDefinition.findMany({ where: { eventId: parsed.eventId } })
      : []
  const taskDefById = new Map(taskDefs.map((def) => [def.id, def]))
  const replyTo = replyToFor(event.contactEmail)
  const context = {
    eventName: event.name,
    eventSlug: event.slug,
    appUrl: env.APP_URL,
    timezone: event.timezone,
  }
  /** notifiedAt means "the speaker actually heard from us", so it is stamped
   *  only for sessions whose decision mail reached SENT — never at enqueue. */
  const notifiedSessionIds: string[] = []

  for (const patch of finalized) {
    const row = rows.find((item) => item.id === patch.id)
    if (!row) continue
    const title = row.title?.trim() || 'your submission'

    if (patch.status === 'ACCEPTED' && taskDefs.length > 0) {
      const created = await insertAssignmentsIdempotent({
        db,
        rows: buildAssignmentsForAcceptance({
          taskDefs: taskDefs.map((def) => ({
            id: def.id,
            eventId: def.eventId,
            target: def.target,
            dueAt: def.dueAt,
            assignmentPolicy: def.assignmentPolicy,
          })),
          participants: row.participants.map((p) => ({ speakerId: p.speakerId })),
          sessionId: row.id,
          now,
        }),
      })
      // Only assignments this call actually created get a "new task" mail;
      // re-running Notify must not re-notify already-assigned speakers.
      for (const assignment of created) {
        const speaker = row.participants.find(
          (part) => part.speakerId === assignment.speakerId,
        )?.speaker
        const definition = taskDefById.get(assignment.taskDefinitionId)
        if (!speaker?.email || !definition) continue
        const queued = await enqueueAndSend({
          db,
          eventId: parsed.eventId,
          toEmail: speaker.email,
          speakerId: speaker.id,
          sessionId: assignment.sessionId ?? null,
          dedupeKey: dedupeKeys.taskAssigned(assignment.id),
          replyTo,
          now,
          payload: {
            kind: 'TASK_ASSIGNED',
            context: { ...context, recipientName: speaker.firstName },
            data: {
              assignmentId: assignment.id,
              taskTitle: definition.title,
              dueAt: assignment.dueAt ?? null,
              sessionTitle: assignment.sessionId ? title : null,
            },
          },
        })
        if (queued.inserted) emailsQueued += 1
        if (queued.sent) emailsSent += 1
      }
    }

    const kind = patch.status === 'ACCEPTED' ? 'DECISION_ACCEPTED' : 'DECISION_DECLINED'
    if (patch.decidedAt == null) throw new Error('Final decision is missing its timestamp')
    let decisionDelivered = false
    for (const part of row.participants) {
      const speaker = part.speaker
      if (!speaker?.email) continue
      const outcome = await enqueueAndSend({
        db,
        eventId: parsed.eventId,
        toEmail: speaker.email,
        speakerId: speaker.id,
        sessionId: row.id,
        dedupeKey: dedupeKeys.decision(row.id, speaker.id, patch.decidedAt),
        replyTo,
        now,
        payload: {
          kind,
          context: { ...context, recipientName: speaker.firstName },
          data: { sessionId: row.id, sessionTitle: title },
        },
      })
      if (outcome.inserted) emailsQueued += 1
      if (outcome.sent) {
        emailsSent += 1
        decisionDelivered = true
      }
    }
    if (decisionDelivered) notifiedSessionIds.push(row.id)
  }

  if (notifiedSessionIds.length > 0) {
    await db
      .update(schema.eventSession)
      .set({ notifiedAt: now, updatedAt: now })
      .where(
        orm.and(
          orm.inArray(schema.eventSession.id, notifiedSessionIds),
          orm.eq(schema.eventSession.eventId, parsed.eventId),
        ),
      )
  }

  return { updated: finalized.length, emailsQueued, emailsSent }
}

// ── Agenda: sessions list + schedule placement ──────────────────────
//
// The client sends a WALL CLOCK ({ dayKey, startMinute, durationMinutes }) and
// never an epoch: the conversion to UTC ms happens in agenda-server.ts with the
// event's timezone, so a speaker's browser tz can never shift the schedule.

const scheduleSessionSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  roomId: z.string().min(1),
  /** Local calendar day in the event timezone, `YYYY-MM-DD`. */
  dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Minutes since local midnight. */
  startMinute: z.number().int().min(0).max(24 * 60 - 1),
  durationMinutes: z.number().int().min(5).max(MAX_SLOT_MINUTES),
  /** Second call after the organizer accepted the conflict warning. */
  confirmConflicts: z.boolean().optional(),
})

/** Place or move a session on the agenda. Overlaps warn (returns
 *  `scheduled: false` + the conflicts) instead of blocking; calling again with
 *  confirmConflicts writes it. Bumps icsSequence and mails the invite/update. */
export async function scheduleSession(input: z.input<typeof scheduleSessionSchema>) {
  const actionRequest = getActionRequest()
  const parsed = scheduleSessionSchema.parse(input)
  const { db, event } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  return scheduleSessionSlot({
    db,
    event,
    sessionId: parsed.sessionId,
    roomId: parsed.roomId,
    dayKey: parsed.dayKey,
    startMinute: parsed.startMinute,
    durationMinutes: parsed.durationMinutes,
    confirmConflicts: parsed.confirmConflicts ?? false,
    now: Date.now(),
  })
}

const unscheduleSessionSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
})

/** Remove a session from the agenda and send the calendar cancellation. */
export async function unscheduleSession(input: z.input<typeof unscheduleSessionSchema>) {
  const actionRequest = getActionRequest()
  const parsed = unscheduleSessionSchema.parse(input)
  const { db, event } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  return clearSessionSlot({ db, event, sessionId: parsed.sessionId, now: Date.now() })
}

const agendaPlanSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
})

async function buildAgendaPlan({
  db,
  event,
}: {
  db: ReturnType<typeof getDb>
  event: typeof schema.event.$inferSelect
}) {
  const [sessions, rooms] = await Promise.all([
    loadAgendaSessions(db, event.id),
    db.query.room.findMany({ where: { eventId: event.id }, orderBy: { sortOrder: 'asc', name: 'asc' } }),
  ])
  const result = autoPlaceSessions({
    days: eventDayKeys(event.startsAt, event.endsAt, event.timezone),
    rooms,
    sessions: sessions.map((session) => {
      const start = session.startsAt == null ? null : toZonedSlot(session.startsAt, event.timezone)
      const end = session.endsAt == null ? null : toZonedSlot(session.endsAt, event.timezone)
      return {
        id: session.id,
        roomId: session.roomId,
        dayKey: start?.dayKey ?? null,
        startMinute: start?.minutes ?? null,
        endMinute: end ? (end.dayKey === start?.dayKey ? end.minutes : 24 * 60) : null,
        durationMinutes: session.format?.defaultDurationMinutes ?? 30,
        speakerIds: session.participants.map((participant) => participant.speakerId),
      }
    }),
  })
  const titleById = new Map(sessions.map((session) => [session.id, session.title?.trim() || 'Untitled']))
  const roomById = new Map(rooms.map((room) => [room.id, room.name]))
  return {
    placements: result.placements.map((placement) => ({
      ...placement,
      title: titleById.get(placement.sessionId) ?? 'Untitled',
      roomName: roomById.get(placement.roomId) ?? 'Room',
    })),
    unplaced: result.unplacedSessionIds.map((sessionId) => ({
      sessionId,
      title: titleById.get(sessionId) ?? 'Untitled',
    })),
  }
}

/** Compute a deterministic plan without writing schedule rows. */
export async function previewAutoPlace(input: z.input<typeof agendaPlanSchema>) {
  const actionRequest = getActionRequest()
  const parsed = agendaPlanSchema.parse(input)
  const { db, event } = await requireEventAccess({ actionRequest, ...parsed })
  return buildAgendaPlan({ db, event })
}

/** Recompute and apply the deterministic plan through the normal schedule writer. */
export async function applyAutoPlace(input: z.input<typeof agendaPlanSchema>) {
  const actionRequest = getActionRequest()
  const parsed = agendaPlanSchema.parse(input)
  const { db, event } = await requireEventAccess({ actionRequest, ...parsed })
  const plan = await buildAgendaPlan({ db, event })
  const result = await applyAutoPlacementPlan({
    db,
    event,
    placements: plan.placements,
    now: Date.now(),
  })
  return { ...plan, ...result }
}

const setProgramPublicationSchema = agendaPlanSchema.extend({ published: z.boolean() })

/** Publish or unpublish the attendee program without changing the event lifecycle. */
export async function setProgramPublication(input: z.input<typeof setProgramPublicationSchema>) {
  const actionRequest = getActionRequest()
  const parsed = setProgramPublicationSchema.parse(input)
  const { db } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const sessions = await db.query.eventSession.findMany({
    where: { eventId: parsed.eventId, status: 'ACCEPTED' },
  })
  const summary = summarizeProgramPublication(sessions)
  const programPublishedAt = parsed.published ? Date.now() : null
  await db.update(schema.event)
    .set({ programPublishedAt, updatedAt: Date.now() })
    .where(orm.eq(schema.event.id, parsed.eventId))
    .limit(1)
  return { published: parsed.published, programPublishedAt, ...summary }
}

const setSessionVisibilitySchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  visibility: z.enum(['PUBLIC', 'PRIVATE']),
})

/** PUBLIC sessions appear in the public agenda, feeds, and embeds. */
export async function setSessionVisibility(input: z.input<typeof setSessionVisibilitySchema>) {
  const actionRequest = getActionRequest()
  const parsed = setSessionVisibilitySchema.parse(input)
  const { db } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const updated = await db
    .update(schema.eventSession)
    .set({ visibility: parsed.visibility, updatedAt: Date.now() })
    .where(
      orm.and(
        orm.eq(schema.eventSession.id, parsed.sessionId),
        orm.eq(schema.eventSession.eventId, parsed.eventId),
      ),
    )
    .limit(1)
    .returning({ id: schema.eventSession.id })
  if (updated.length === 0) throw new Error('Session not found')
  return { sessionId: parsed.sessionId, visibility: parsed.visibility }
}

const createServiceSessionSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
})

/** Breaks, lunch, registration: agenda blocks with no speakers and no CFP.
 *  Created ACCEPTED so they are schedulable straight away. */
export async function createServiceSession(input: z.input<typeof createServiceSessionSchema>) {
  const actionRequest = getActionRequest()
  const parsed = createServiceSessionSchema.parse(input)
  const { db } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const now = Date.now()
  const [row] = await db
    .insert(schema.eventSession)
    .values({
      eventId: parsed.eventId,
      kind: 'SERVICE',
      status: 'ACCEPTED',
      title: parsed.title,
      description: parsed.description || null,
      // Breaks and lunch are what attendees look for on a public agenda, so
      // service blocks default to PUBLIC (content sessions default PRIVATE).
      visibility: parsed.visibility ?? 'PUBLIC',
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.eventSession.id })
  return { sessionId: row?.id ?? null }
}

const deleteServiceSessionSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
})

/** Only SERVICE blocks can be deleted; submitted abstracts are withdrawn. */
export async function deleteServiceSession(input: z.input<typeof deleteServiceSessionSchema>) {
  const actionRequest = getActionRequest()
  const parsed = deleteServiceSessionSchema.parse(input)
  const { db } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const row = await db.query.eventSession.findFirst({
    where: { id: parsed.sessionId, eventId: parsed.eventId },
    columns: { id: true, kind: true },
  })
  if (!row) throw new Error('Session not found')
  if (row.kind !== 'SERVICE') throw new Error('Only service sessions can be deleted')
  await db
    .delete(schema.eventSession)
    .where(
      orm.and(
        orm.eq(schema.eventSession.id, parsed.sessionId),
        orm.eq(schema.eventSession.eventId, parsed.eventId),
      ),
    )
    .limit(1)
  return { sessionId: parsed.sessionId }
}

const retryEmailSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  emailId: z.string().min(1),
})

/** Requeue one FAILED outbox row and attempt it immediately (Emails > Failed).
 *  The attempt counter is reset because a human decided the cause is fixed. */
export async function retryEmail(input: z.input<typeof retryEmailSchema>) {
  const actionRequest = getActionRequest()
  const parsed = retryEmailSchema.parse(input)
  const { db, event } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  // Tenancy: the row must belong to THIS event, not just exist.
  const row = await db.query.emailMessage.findFirst({
    where: { id: parsed.emailId, eventId: parsed.eventId },
  })
  if (!row) throw new Error('Email not found')
  if (row.status === 'SENT') return { retried: false, sent: true }

  // Send this exact row rather than draining the queue: the organizer clicked
  // retry on one message and expects feedback about that one.
  const outcome = await sendEmailMessage({
    db,
    row: { ...row, attemptCount: 0 },
    replyTo: replyToFor(event.contactEmail),
    now: Date.now(),
  })
  return { retried: true, sent: outcome.status === 'SENT' }
}

async function assignTasksForAcceptedSession({
  db,
  eventId,
  sessionId,
  participants,
  now,
}: {
  db: ReturnType<typeof getDb>
  eventId: string
  sessionId: string
  participants: Array<{ speakerId: string }>
  now: number
}) {
  const taskDefs = await db.query.taskDefinition.findMany({ where: { eventId } })
  if (taskDefs.length === 0 || participants.length === 0) return
  await insertAssignmentsIdempotent({
    db,
    rows: buildAssignmentsForAcceptance({
      taskDefs: taskDefs.map((def) => ({
        id: def.id,
        eventId: def.eventId,
        target: def.target,
        dueAt: def.dueAt,
        assignmentPolicy: def.assignmentPolicy,
      })),
      participants,
      sessionId,
      now,
    }),
  })
}

async function insertAssignmentsIdempotent({
  db,
  rows,
}: {
  db: ReturnType<typeof getDb>
  rows: PlannedTaskAssignment[]
}): Promise<Array<typeof schema.taskAssignment.$inferSelect>> {
  if (rows.length === 0) return []
  // Partial unique indexes (speaker-only vs session×speaker) make plain
  // target arrays awkward — bare onConflictDoNothing lets SQLite match
  // whichever partial unique fires. `returning()` yields ONLY the rows this
  // call inserted, which is how the caller knows who to email.
  const statements = rows.map((row) =>
    db.insert(schema.taskAssignment).values(row).onConflictDoNothing().returning(),
  )
  // Cap batch size to avoid huge transactions on multi-speaker events.
  const CHUNK = 40
  const created: Array<typeof schema.taskAssignment.$inferSelect> = []
  for (let i = 0; i < statements.length; i += CHUNK) {
    const chunk = statements.slice(i, i + CHUNK)
    if (chunk.length === 0) continue
    const results = await db.batch(chunk as [any, ...any[]])
    for (const result of results) {
      if (Array.isArray(result)) created.push(...result)
    }
  }
  return created
}



const assignReviewsSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  formId: z.string().min(1),
  reviewerId: z.string().min(1),
  sessionIds: z.array(z.string().min(1)).min(1).max(100),
  trackId: z.string().min(1).nullable().optional(),
  limit: z.number().int().min(1).max(100),
})

export async function assignEvaluationReviews(input: z.input<typeof assignReviewsSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = assignReviewsSchema.parse(input)
  const { db } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const pool = await db.query.evaluationReviewer.findFirst({
    where: { eventId: parsed.eventId, formId: parsed.formId, userId: parsed.reviewerId },
  })
  if (!pool) throw new Error('Reviewer is not in this round')
  const form = await db.query.form.findFirst({
    where: { id: parsed.formId, eventId: parsed.eventId, purpose: 'EVALUATION' },
  })
  if (!form) throw new Error('Evaluation round not found')
  const sessions = await db.query.eventSession.findMany({
    where: {
      id: { in: [...new Set(parsed.sessionIds)] },
      eventId: parsed.eventId,
      kind: 'CONTENT',
      status: { in: ['PENDING', 'ACCEPT_QUEUE', 'ACCEPTED', 'DECLINE_QUEUE', 'DECLINED'] },
      ...(parsed.trackId ? { trackId: parsed.trackId } : {}),
    },
  })
  const selected = sessions.slice(0, parsed.limit)
  if (selected.length === 0) throw new Error('No matching submissions selected')
  const now = Date.now()
  const statements = selected.map((row) => db.insert(schema.review).values({
    eventId: parsed.eventId,
    formId: parsed.formId,
    sessionId: row.id,
    reviewerId: parsed.reviewerId,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning({ id: schema.review.id }))
  const inserted = await db.batch(statements as [any, ...any[]])
  return { assigned: inserted.reduce((count, rows) => count + (Array.isArray(rows) ? rows.length : 0), 0) }
}

const reviewResponseSchema = z.object({
  reviewId: z.string().min(1),
  submission: cfpSubmissionSchema,
  submit: z.boolean(),
})

export async function saveEvaluationReview(input: z.input<typeof reviewResponseSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = reviewResponseSchema.parse(input)
  if (parsed.submission.participants.length > 0) throw new Error('Evaluation scorecards cannot contain participants')
  const db = getDb()
  const assignment = await db.query.review.findFirst({
    where: { id: parsed.reviewId, reviewerId: session.userId },
    with: { form: true, response: { with: { formVersion: true } } },
  })
  if (!assignment?.form || assignment.form.purpose !== 'EVALUATION') throw new Error('Review assignment not found')
  if (assignment.recusedAt != null) throw new Error('This review was recused')
  const now = Date.now()
  if (assignment.form.status !== 'OPEN'
    || (assignment.form.opensAt != null && assignment.form.opensAt > now)
    || (assignment.form.closesAt != null && assignment.form.closesAt <= now)) {
    throw new Error('This evaluation round is not open')
  }
  const version = assignment.response?.formVersion ?? await db.query.formVersion.findFirst({
    where: { formId: assignment.formId },
    orderBy: { createdAt: 'desc', id: 'desc' },
  })
  if (!version) throw new Error('Scorecard version not found')
  const collected = collectFields({ mdxSource: version.mdxSource, scope: { values: parsed.submission.values } })
  const validation = validateSubmission({
    collected,
    ...parsed.submission,
    allowIncomplete: !parsed.submit,
  })
  if (!validation.ok) throw new Error(validation.errors.map((error) => error.message).join('\n'))

  const responseId = assignment.response?.id ?? ulid()
  const values = flattenSubmissionValues({
    responseId,
    submission: parsed.submission,
    participantSpeakerIds: [],
    fileFieldNames: new Set(),
  })
  const responseStatement = assignment.response
    ? db.update(schema.formResponse).set({
        status: parsed.submit ? 'SUBMITTED' : 'DRAFT',
        submittedAt: parsed.submit ? now : null,
        updatedAt: now,
      }).where(orm.eq(schema.formResponse.id, responseId)).limit(1)
    : db.insert(schema.formResponse).values({
        id: responseId,
        eventId: assignment.eventId,
        formId: assignment.formId,
        formVersionId: version.id,
        speakerId: null,
        reviewId: assignment.id,
        sessionId: assignment.sessionId,
        status: parsed.submit ? 'SUBMITTED' : 'DRAFT',
        submittedAt: parsed.submit ? now : null,
        createdAt: now,
        updatedAt: now,
    })
  const statements = [
    responseStatement,
    ...(assignment.response ? [db.delete(schema.formFieldValue).where(orm.eq(schema.formFieldValue.responseId, responseId))] : []),
    ...values.map((value) => db.insert(schema.formFieldValue).values(value)),
  ]
  await db.batch(statements as [any, ...any[]])
  return { reviewId: assignment.id, status: parsed.submit ? 'COMPLETED' as const : 'IN_PROGRESS' as const }
}

const recuseReviewSchema = z.object({ reviewId: z.string().min(1), reason: z.string().trim().min(3).max(1000) })

export async function recuseEvaluationReview(input: z.input<typeof recuseReviewSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = recuseReviewSchema.parse(input)
  const db = getDb()
  const assignment = await db.query.review.findFirst({
    where: { id: parsed.reviewId, reviewerId: session.userId },
    with: { response: true },
  })
  if (!assignment) throw new Error('Review assignment not found')
  if (assignment.response?.status === 'SUBMITTED') throw new Error('A completed review cannot be recused')
  const statements = [
    db.update(schema.review).set({ recusedAt: Date.now(), recusalReason: parsed.reason, updatedAt: Date.now() })
      .where(orm.eq(schema.review.id, assignment.id)).limit(1),
    ...(assignment.response
      ? [db.delete(schema.formResponse).where(orm.eq(schema.formResponse.id, assignment.response.id)).limit(1)]
      : []),
  ]
  await db.batch(statements as [any, ...any[]])
  return { reviewId: assignment.id, status: 'RECUSED' as const }
}

const remindReviewerSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  formId: z.string().min(1),
  reviewerIds: z.array(z.string().min(1)).min(1).max(100),
})

export async function remindEvaluationReviewers(input: z.input<typeof remindReviewerSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = remindReviewerSchema.parse(input)
  const { db, event } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  const reviewerIds = [...new Set(parsed.reviewerIds)]
  const pool = await db.query.evaluationReviewer.findMany({
    where: { eventId: parsed.eventId, formId: parsed.formId, userId: { in: reviewerIds } },
    with: { user: true, form: true, assignments: { with: { response: true } } },
  })
  if (pool.length !== reviewerIds.length || pool.some((row) => !row.user || !row.form)) {
    throw new Error('Reviewer not found')
  }
  const pending = pool.map((row) => ({
    row,
    pendingCount: row.assignments.filter((assignment) => assignment.recusedAt == null && assignment.response?.status !== 'SUBMITTED').length,
  })).filter((item) => item.pendingCount > 0)
  if (pending.length === 0) throw new Error('The selected reviewers have no outstanding reviews')
  const now = Date.now()
  for (const { row, pendingCount } of pending) {
    await enqueueAndSend({
      db,
      eventId: event.id,
      toEmail: row.user!.email,
      dedupeKey: dedupeKeys.reviewReminder(row.formId, row.userId, dayBucket(now, event.timezone)),
      replyTo: replyToFor(event.contactEmail),
      now,
      payload: {
        kind: 'REVIEW_REMINDER',
        context: { eventName: event.name, eventSlug: event.slug, appUrl: env.APP_URL, timezone: event.timezone, recipientName: row.user!.name },
        data: { roundName: row.form!.name, reviewUrl: new URL(`/review/${row.formId}`, env.APP_URL).href, pendingCount, closesAt: row.form!.closesAt },
      },
    })
  }
  return { reminded: pending.length, pendingCount: pending.reduce((sum, item) => sum + item.pendingCount, 0) }
}

// ── Speaker roster, participants, and communications ────────────────

const speakerProfileInput = z.object({
  orgId: z.string().min(1), eventId: z.string().min(1),
  speakerId: z.string().min(1).optional(),
  email: z.email().max(320), firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  status: z.enum(['PENDING', 'INVITED', 'CONFIRMED', 'DECLINED']).default('PENDING'),
  jobTitle: z.string().trim().max(160).nullable().optional(),
  companyName: z.string().trim().max(160).nullable().optional(),
  bio: z.string().trim().max(5000).nullable().optional(),
  pronouns: z.string().trim().max(80).nullable().optional(),
  websiteUrl: z.string().trim().max(500).nullable().optional(),
  linkedinUrl: z.string().trim().max(500).nullable().optional(),
  twitterUrl: z.string().trim().max(500).nullable().optional(),
  headshotFileId: z.string().min(1).nullable().optional(),
})

export async function saveSpeaker(input: z.input<typeof speakerProfileInput>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = speakerProfileInput.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  if (parsed.headshotFileId) {
    const headshot = await db.query.file.findFirst({
      where: { id: parsed.headshotFileId, eventId: parsed.eventId, kind: { in: ['HEADSHOT', 'IMAGE'] } },
    })
    if (!headshot) throw new Error('Headshot file not found in this event')
  }
  const values = {
    email: normalizeSpeakerEmail(parsed.email), firstName: parsed.firstName, lastName: parsed.lastName,
    status: parsed.status, jobTitle: parsed.jobTitle?.trim() || null,
    companyName: parsed.companyName?.trim() || null, bio: parsed.bio?.trim() || null,
    pronouns: parsed.pronouns?.trim() || null, websiteUrl: parsed.websiteUrl?.trim() || null,
    linkedinUrl: parsed.linkedinUrl?.trim() || null, twitterUrl: parsed.twitterUrl?.trim() || null,
    headshotFileId: parsed.headshotFileId ?? undefined,
    updatedAt: Date.now(),
  }
  try {
    if (parsed.speakerId) {
      const updated = await db.update(schema.speaker).set(values).where(orm.and(
        orm.eq(schema.speaker.id, parsed.speakerId), orm.eq(schema.speaker.eventId, parsed.eventId),
      )).limit(1).returning({ id: schema.speaker.id })
      if (!updated[0]) throw new Error('Speaker not found')
      await linkSpeakerToOrgContact(db, updated[0].id)
      return { speakerId: updated[0].id, created: false }
    }
    const [created] = await db.insert(schema.speaker).values({ eventId: parsed.eventId, ...values }).returning({ id: schema.speaker.id })
    await linkSpeakerToOrgContact(db, created!.id)
    return { speakerId: created!.id, created: true }
  } catch (error) {
    if (error instanceof Error && error.message === 'Speaker not found') throw error
    throw new Error(`A speaker with email ${values.email} already exists in this event`)
  }
}

const importSpeakersSchema = z.object({
  orgId: z.string().min(1), eventId: z.string().min(1),
  rows: z.array(z.object({
    firstName: z.string(), lastName: z.string(), email: z.string(),
    jobTitle: z.string().nullable(), companyName: z.string().nullable(), bio: z.string().nullable(),
  })).min(1).max(1000),
})

export async function importSpeakers(input: { orgId: string; eventId: string; rows: SpeakerCsvRow[] }) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = importSpeakersSchema.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  const existing = await db.query.speaker.findMany({ where: { eventId: parsed.eventId } })
  const plan = prepareSpeakerImport(parsed.rows, existing.map((row) => row.email))
  if (plan.errors.length > 0) return { inserted: 0, skipped: plan.skipped.length, errors: plan.errors }
  let inserted = 0
  if (plan.inserted.length > 0) {
    const now = Date.now()
    const statements = plan.inserted.map((row) => db.insert(schema.speaker).values({
      eventId: parsed.eventId, ...row, status: 'PENDING', createdAt: now, updatedAt: now,
    }).onConflictDoNothing().returning({ id: schema.speaker.id }))
    for (let index = 0; index < statements.length; index += 40) {
      const results = await db.batch(statements.slice(index, index + 40) as [any, ...any[]])
      inserted += results.reduce((count, rows) => count + (Array.isArray(rows) ? rows.length : 0), 0)
    }
    const imported = await db.query.speaker.findMany({
      where: { eventId: parsed.eventId, email: { in: plan.inserted.map((row) => row.email) } },
    })
    for (const speaker of imported) await linkSpeakerToOrgContact(db, speaker.id)
  }
  return { inserted, skipped: plan.skipped.length + plan.inserted.length - inserted, errors: [] }
}

const participantInput = z.object({
  orgId: z.string().min(1), eventId: z.string().min(1), sessionId: z.string().min(1),
  speakerId: z.string().min(1), role: z.enum(['SPEAKER', 'MODERATOR']),
  confirmationStatus: z.enum(['PENDING', 'CONFIRMED', 'DECLINED']),
  sortOrder: z.number().int().min(0).max(1000),
})

export async function saveSessionParticipant(input: z.input<typeof participantInput>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = participantInput.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  const [sessionRow, speakerRow] = await db.batch([
    db.query.eventSession.findFirst({ where: { id: parsed.sessionId, eventId: parsed.eventId } }),
    db.query.speaker.findFirst({ where: { id: parsed.speakerId, eventId: parsed.eventId } }),
  ] as const)
  if (!sessionRow || sessionRow.kind !== 'CONTENT') throw new Error('Content session not found')
  if (!speakerRow) throw new Error('Speaker not found')
  const now = Date.now()
  const patch = planParticipantChange(parsed, now)
  await db.insert(schema.sessionParticipant).values({
    eventId: parsed.eventId, sessionId: parsed.sessionId, speakerId: parsed.speakerId, ...patch,
  }).onConflictDoUpdate({
    target: [schema.sessionParticipant.sessionId, schema.sessionParticipant.speakerId], set: patch,
  })
  if (sessionRow.status === 'ACCEPTED') {
    await assignTasksForAcceptedSession({ db, eventId: parsed.eventId, sessionId: parsed.sessionId, participants: [{ speakerId: parsed.speakerId }], now })
  }
  return { speakerId: parsed.speakerId }
}

const removeParticipantSchema = participantInput.pick({ orgId: true, eventId: true, sessionId: true, speakerId: true })
export async function removeSessionParticipant(input: z.input<typeof removeParticipantSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = removeParticipantSchema.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  const sessionRow = await db.query.eventSession.findFirst({
    where: { id: parsed.sessionId, eventId: parsed.eventId, kind: 'CONTENT' },
  })
  if (!sessionRow) throw new Error('Content session not found')
  await db.delete(schema.sessionParticipant).where(orm.and(
    orm.eq(schema.sessionParticipant.eventId, parsed.eventId),
    orm.eq(schema.sessionParticipant.sessionId, parsed.sessionId),
    orm.eq(schema.sessionParticipant.speakerId, parsed.speakerId),
  )).limit(1)
  if (sessionRow.status === 'ACCEPTED') {
    const [automaticDefinitions, remainingAcceptedParticipations] = await db.batch([
      db.query.taskDefinition.findMany({
        where: { eventId: parsed.eventId, assignmentPolicy: 'ALL_ACCEPTED' },
      }),
      db.query.sessionParticipant.findMany({
        where: { eventId: parsed.eventId, speakerId: parsed.speakerId, session: { status: 'ACCEPTED' } },
      }),
    ] as const)
    const automaticIds = automaticDefinitions.map((definition) => definition.id)
    if (automaticIds.length > 0) {
      await db.delete(schema.taskAssignment).where(orm.and(
        orm.eq(schema.taskAssignment.eventId, parsed.eventId),
        orm.eq(schema.taskAssignment.speakerId, parsed.speakerId),
        orm.inArray(schema.taskAssignment.taskDefinitionId, automaticIds),
        remainingAcceptedParticipations.length === 0
          ? orm.or(orm.isNull(schema.taskAssignment.sessionId), orm.eq(schema.taskAssignment.sessionId, parsed.sessionId))
          : orm.eq(schema.taskAssignment.sessionId, parsed.sessionId),
      ))
    }
  }
  return { speakerId: parsed.speakerId }
}

const inviteSpeakerSchema = z.object({ orgId: z.string().min(1), eventId: z.string().min(1), speakerId: z.string().min(1) })
export async function inviteSpeakerToPortal(input: z.input<typeof inviteSpeakerSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = inviteSpeakerSchema.parse(input)
  const { db, event } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  const speaker = await db.query.speaker.findFirst({ where: { id: parsed.speakerId, eventId: parsed.eventId } })
  if (!speaker) throw new Error('Speaker not found')
  const now = Date.now()
  const outcome = await enqueueAndSend({
    db, eventId: event.id, speakerId: speaker.id, toEmail: speaker.email,
    dedupeKey: `speaker-invite:${speaker.id}:${now}`, replyTo: replyToFor(event.contactEmail), now,
    payload: {
      kind: 'SPEAKER_INVITE',
      context: { eventName: event.name, eventSlug: event.slug, appUrl: env.APP_URL, timezone: event.timezone, recipientName: speaker.firstName },
      data: { portalUrl: new URL(`/portal/${event.slug}`, env.APP_URL).href },
    },
  })
  await db.update(schema.speaker).set({ status: 'INVITED', updatedAt: now }).where(orm.eq(schema.speaker.id, speaker.id)).limit(1)
  return { queued: outcome.inserted, sent: outcome.sent }
}

const customCommunicationSchema = z.object({
  orgId: z.string().min(1), eventId: z.string().min(1),
  speakerIds: z.array(z.string().min(1)).min(1).max(500),
  subject: z.string().trim().min(1).max(998), body: z.string().trim().min(1).max(50_000),
})
export async function sendCustomSpeakerCommunication(input: z.input<typeof customCommunicationSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = customCommunicationSchema.parse(input)
  const { db, event } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  const speakerIds = [...new Set(parsed.speakerIds)]
  const speakers = await db.query.speaker.findMany({
    where: { eventId: parsed.eventId, id: { in: speakerIds } },
    with: { participations: { with: { session: true } } },
  })
  if (speakers.length !== speakerIds.length) throw new Error('One or more selected speakers were not found in this event')
  const batchId = ulid()
  const now = Date.now()
  let queued = 0
  let sent = 0
  for (const speaker of speakers) {
    const recipient = {
      firstName: speaker.firstName, lastName: speaker.lastName, email: speaker.email,
      eventName: event.name, portalUrl: new URL(`/portal/${event.slug}`, env.APP_URL).href,
      sessionTitles: speaker.participations.flatMap((row) => row.session?.title ? [row.session.title] : []),
    }
    const outcome = await enqueueAndSend({
      db, eventId: event.id, speakerId: speaker.id, batchId, toEmail: speaker.email,
      dedupeKey: `custom:${batchId}:${speaker.id}`, replyTo: replyToFor(event.contactEmail), now,
      payload: {
        kind: 'CUSTOM',
        context: { eventName: event.name, eventSlug: event.slug, appUrl: env.APP_URL, timezone: event.timezone, recipientName: speaker.firstName },
        data: { subject: applySpeakerMergeFields(parsed.subject, recipient), body: applySpeakerMergeFields(parsed.body, recipient) },
      },
    })
    if (outcome.inserted) queued += 1
    if (outcome.sent) sent += 1
  }
  return { batchId, queued, sent }
}

// ── Organization speaker CRM ────────────────────────────────────────

const contactProfileSchema = z.object({
  orgId: z.string().min(1), contactId: z.string().min(1).optional(),
  email: z.email().max(320), firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  jobTitle: z.string().trim().max(160).nullable().optional(),
  companyName: z.string().trim().max(160).nullable().optional(),
  bio: z.string().trim().max(5000).nullable().optional(),
})

export async function saveContact(input: z.input<typeof contactProfileSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = contactProfileSchema.parse(input)
  const { session } = await requireOrgAccess(actionRequest, parsed.orgId)
  const db = getDb()
  const now = Date.now()
  const email = normalizeSpeakerEmail(parsed.email)
  const values = {
    email, firstName: parsed.firstName, lastName: parsed.lastName,
    jobTitle: parsed.jobTitle?.trim() || null,
    companyName: parsed.companyName?.trim() || null,
    bio: parsed.bio?.trim() || null, updatedAt: now,
  }
  let contactId = parsed.contactId
  try {
    if (contactId) {
      const rows = await db.update(schema.orgContact).set(values).where(orm.and(
        orm.eq(schema.orgContact.id, contactId), orm.eq(schema.orgContact.orgId, parsed.orgId),
      )).limit(1).returning({ id: schema.orgContact.id })
      if (!rows[0]) throw new Error('Contact not found')
    } else {
      contactId = ulid()
      await db.insert(schema.orgContact).values({ id: contactId, orgId: parsed.orgId, ...values, createdAt: now })
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Contact not found') throw error
    throw new Error(`A contact with email ${email} already exists in this organization`)
  }
  const events = await db.query.event.findMany({ where: { orgId: parsed.orgId } })
  const eventIds = events.map((event) => event.id)
  if (eventIds.length > 0) {
    await db.update(schema.speaker).set({ contactId, updatedAt: now }).where(orm.and(
      orm.inArray(schema.speaker.eventId, eventIds),
      orm.eq(schema.speaker.email, email),
    ))
  }
  await db.insert(schema.contactActivity).values({
    orgId: parsed.orgId, contactId, actorUserId: session.userId,
    kind: 'NOTE', body: parsed.contactId ? 'Contact profile updated.' : 'Contact created.', createdAt: now,
  })
  return { contactId, created: !parsed.contactId }
}

const importContactsSchema = z.object({
  orgId: z.string().min(1),
  rows: z.array(z.object({
    firstName: z.string(), lastName: z.string(), email: z.string(),
    jobTitle: z.string().nullable(), companyName: z.string().nullable(), bio: z.string().nullable(),
  })).min(1).max(1000),
})

export async function importContacts(input: { orgId: string; rows: ContactCsvRow[] }) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = importContactsSchema.parse(input)
  await requireOrgAccess(actionRequest, parsed.orgId)
  const db = getDb()
  const [contacts, events] = await db.batch([
    db.query.orgContact.findMany({ where: { orgId: parsed.orgId } }),
    db.query.event.findMany({ where: { orgId: parsed.orgId } }),
  ] as const)
  const plan = prepareContactImport(parsed.rows, contacts.map((contact) => contact.email))
  if (plan.errors.length > 0) return { inserted: 0, skipped: plan.skipped.length, errors: plan.errors }
  const now = Date.now()
  const created = plan.inserted.map((row) => ({ id: ulid(), orgId: parsed.orgId, ...row, createdAt: now, updatedAt: now }))
  for (let index = 0; index < created.length; index += 40) {
    await db.insert(schema.orgContact).values(created.slice(index, index + 40)).onConflictDoNothing()
  }
  const eventIds = events.map((event) => event.id)
  if (eventIds.length > 0) {
    for (const contact of created) {
      await db.update(schema.speaker).set({ contactId: contact.id, updatedAt: now }).where(orm.and(
        orm.inArray(schema.speaker.eventId, eventIds), orm.eq(schema.speaker.email, contact.email),
      ))
    }
  }
  return { inserted: created.length, skipped: plan.skipped.length, errors: [] }
}

const contactTagSchema = z.object({
  orgId: z.string().min(1), contactId: z.string().min(1), name: z.string().trim().min(1).max(80),
})

export async function addContactTag(input: z.input<typeof contactTagSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = contactTagSchema.parse(input)
  await requireOrgAccess(actionRequest, parsed.orgId)
  const db = getDb()
  const contact = await db.query.orgContact.findFirst({ where: { id: parsed.contactId, orgId: parsed.orgId } })
  if (!contact) throw new Error('Contact not found')
  let tag = await db.query.contactTag.findFirst({ where: { orgId: parsed.orgId, name: parsed.name } })
  if (!tag) {
    const [created] = await db.insert(schema.contactTag).values({ orgId: parsed.orgId, name: parsed.name }).returning()
    tag = created
  }
  await db.insert(schema.contactTagLink).values({
    orgId: parsed.orgId, contactId: parsed.contactId, tagId: tag!.id,
  }).onConflictDoNothing()
  return { tagId: tag!.id }
}

const contactNoteSchema = z.object({
  orgId: z.string().min(1), contactId: z.string().min(1), body: z.string().trim().min(1).max(5000),
})

export async function addContactNote(input: z.input<typeof contactNoteSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = contactNoteSchema.parse(input)
  await requireOrgAccess(actionRequest, parsed.orgId)
  const db = getDb()
  const contact = await db.query.orgContact.findFirst({ where: { id: parsed.contactId, orgId: parsed.orgId } })
  if (!contact) throw new Error('Contact not found')
  const activityId = ulid()
  await db.insert(schema.contactActivity).values({
    id: activityId, orgId: parsed.orgId, contactId: parsed.contactId,
    actorUserId: session.userId, kind: 'NOTE', body: parsed.body,
  })
  return { activityId }
}

const contactStageSchema = z.object({
  orgId: z.string().min(1), contactId: z.string().min(1),
  stage: z.enum(CONTACT_STAGES), score: z.number().int().min(0).max(100).nullable().optional(),
  rationale: z.string().trim().max(2000).nullable().optional(),
})

export async function moveContactStage(input: z.input<typeof contactStageSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = contactStageSchema.parse(input)
  await requireOrgAccess(actionRequest, parsed.orgId)
  const db = getDb()
  const contact = await db.query.orgContact.findFirst({ where: { id: parsed.contactId, orgId: parsed.orgId } })
  if (!contact) throw new Error('Contact not found')
  if (contact.stage === parsed.stage && parsed.score === undefined && parsed.rationale === undefined) {
    return { contactId: contact.id, stage: contact.stage }
  }
  const now = Date.now()
  await db.batch([
    db.update(schema.orgContact).set({
      stage: parsed.stage,
      score: parsed.score === undefined ? contact.score : parsed.score,
      rationale: parsed.rationale === undefined ? contact.rationale : (parsed.rationale?.trim() || null),
      updatedAt: now,
    }).where(orm.and(orm.eq(schema.orgContact.id, contact.id), orm.eq(schema.orgContact.orgId, parsed.orgId))).limit(1),
    db.insert(schema.contactActivity).values({
      orgId: parsed.orgId, contactId: contact.id, actorUserId: session.userId,
      kind: 'STAGE_TRANSITION', fromStage: contact.stage, toStage: parsed.stage, createdAt: now,
    }),
  ] as const)
  return { contactId: contact.id, stage: parsed.stage }
}

const contactSegmentSchema = z.object({
  orgId: z.string().min(1), name: z.string().trim().min(1).max(100),
  companyName: z.string().trim().max(160).nullable().optional(),
  jobTitle: z.string().trim().max(160).nullable().optional(),
  tagId: z.string().min(1).nullable().optional(),
})

export async function saveContactSegment(input: z.input<typeof contactSegmentSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = contactSegmentSchema.parse(input)
  await requireOrgAccess(actionRequest, parsed.orgId)
  const companyName = parsed.companyName?.trim() || null
  const jobTitle = parsed.jobTitle?.trim() || null
  const tagId = parsed.tagId ?? null
  if (!companyName && !jobTitle && !tagId) throw new Error('Apply a company, title, or tag filter first')
  const db = getDb()
  if (tagId) {
    const tag = await db.query.contactTag.findFirst({ where: { id: tagId, orgId: parsed.orgId } })
    if (!tag) throw new Error('Tag not found')
  }
  const [segment] = await db.insert(schema.contactSegment).values({
    orgId: parsed.orgId, name: parsed.name, companyName, jobTitle, tagId,
  }).returning()
  return { segmentId: segment!.id }
}

const addContactToEventSchema = z.object({
  orgId: z.string().min(1), contactId: z.string().min(1), eventId: z.string().min(1),
})

export async function addContactToEvent(input: z.input<typeof addContactToEventSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = addContactToEventSchema.parse(input)
  await requireOrgAccess(actionRequest, parsed.orgId)
  const db = getDb()
  const [contact, event] = await db.batch([
    db.query.orgContact.findFirst({ where: { id: parsed.contactId, orgId: parsed.orgId } }),
    db.query.event.findFirst({ where: { id: parsed.eventId, orgId: parsed.orgId } }),
  ] as const)
  if (!contact || !event) throw new Error('Contact or event not found')
  const existing = await db.query.speaker.findFirst({ where: { eventId: event.id, email: contact.email } })
  const now = Date.now()
  const speakerId = existing?.id ?? ulid()
  await db.batch([
    existing
      ? db.update(schema.speaker).set({
        contactId: contact.id, firstName: contact.firstName, lastName: contact.lastName,
        jobTitle: contact.jobTitle, companyName: contact.companyName, bio: contact.bio, updatedAt: now,
      }).where(orm.eq(schema.speaker.id, existing.id)).limit(1)
      : db.insert(schema.speaker).values({
        id: speakerId, eventId: event.id, contactId: contact.id, email: contact.email,
        firstName: contact.firstName, lastName: contact.lastName, jobTitle: contact.jobTitle,
        companyName: contact.companyName, bio: contact.bio, createdAt: now, updatedAt: now,
      }),
    db.insert(schema.contactActivity).values({
      orgId: parsed.orgId, contactId: contact.id, actorUserId: session.userId,
      kind: 'EVENT_ADDED', body: `Added to ${event.name}.`, createdAt: now,
    }),
  ] as const)
  return { speakerId, eventId: event.id }
}

const mergeContactsSchema = z.object({
  orgId: z.string().min(1), primaryId: z.string().min(1), duplicateId: z.string().min(1),
})

export async function mergeContacts(input: z.input<typeof mergeContactsSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = mergeContactsSchema.parse(input)
  await requireOrgAccess(actionRequest, parsed.orgId)
  const db = getDb()
  const [primary, duplicate] = await db.batch([
    db.query.orgContact.findFirst({ where: { id: parsed.primaryId, orgId: parsed.orgId }, with: { tagLinks: true } }),
    db.query.orgContact.findFirst({ where: { id: parsed.duplicateId, orgId: parsed.orgId }, with: { tagLinks: true } }),
  ] as const)
  if (!primary || !duplicate) throw new Error('Contact not found')
  const plan = planContactMerge({
    primaryId: primary.id, duplicateId: duplicate.id,
    primaryTagIds: primary.tagLinks.map((link) => link.tagId),
    duplicateTagIds: duplicate.tagLinks.map((link) => link.tagId),
    primary, duplicate,
  })
  const now = Date.now()
  const statements: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    db.update(schema.orgContact).set({ ...plan.contactPatch, updatedAt: now }).where(orm.eq(schema.orgContact.id, primary.id)).limit(1),
    db.update(schema.speaker).set({ contactId: primary.id, updatedAt: now }).where(orm.eq(schema.speaker.contactId, duplicate.id)),
    db.update(schema.emailMessage).set({ contactId: primary.id }).where(orm.eq(schema.emailMessage.contactId, duplicate.id)),
    db.update(schema.contactActivity).set({ contactId: primary.id, orgId: parsed.orgId }).where(orm.eq(schema.contactActivity.contactId, duplicate.id)),
    db.delete(schema.contactTagLink).where(orm.eq(schema.contactTagLink.contactId, duplicate.id)),
    ...plan.tagIds.map((tagId) => db.insert(schema.contactTagLink).values({
      orgId: parsed.orgId, contactId: primary.id, tagId,
    }).onConflictDoNothing()),
    db.insert(schema.contactActivity).values({
      orgId: parsed.orgId, contactId: primary.id, actorUserId: session.userId,
      kind: 'MERGE', body: `Merged duplicate ${duplicate.firstName} ${duplicate.lastName} (${duplicate.email}).`, createdAt: now,
    }),
    db.delete(schema.orgContact).where(orm.eq(schema.orgContact.id, duplicate.id)).limit(1),
  ]
  await db.batch(statements)
  return { contactId: primary.id }
}

const contactOutreachSchema = z.object({
  orgId: z.string().min(1), eventId: z.string().min(1),
  contactIds: z.array(z.string().min(1)).min(1).max(500),
  subject: z.string().trim().min(1).max(998), body: z.string().trim().min(1).max(50_000),
})

export async function sendContactOutreach(input: z.input<typeof contactOutreachSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = contactOutreachSchema.parse(input)
  await requireOrgAccess(actionRequest, parsed.orgId)
  const db = getDb()
  const contactIds = [...new Set(parsed.contactIds)]
  const [event, contacts] = await db.batch([
    db.query.event.findFirst({ where: { id: parsed.eventId, orgId: parsed.orgId } }),
    db.query.orgContact.findMany({ where: { id: { in: contactIds }, orgId: parsed.orgId }, with: { speakers: { with: { participations: { with: { session: true } } } } } }),
  ] as const)
  if (!event || contacts.length !== contactIds.length) throw new Error('Event or selected contact not found')
  const batchId = ulid()
  const now = Date.now()
  let queued = 0
  for (const contact of contacts) {
    const eventSpeaker = contact.speakers.find((speaker) => speaker.eventId === event.id)
    const recipient = {
      firstName: contact.firstName, lastName: contact.lastName, email: contact.email,
      eventName: event.name, portalUrl: new URL(`/portal/${event.slug}`, env.APP_URL).href,
      sessionTitles: eventSpeaker?.participations.flatMap((row) => row.session?.title ? [row.session.title] : []) ?? [],
    }
    const outcome = await enqueueAndSend({
      db, eventId: event.id, speakerId: eventSpeaker?.id, contactId: contact.id,
      batchId, toEmail: contact.email, dedupeKey: `contact-outreach:${batchId}:${contact.id}`,
      replyTo: replyToFor(event.contactEmail), now,
      payload: {
        kind: 'CUSTOM',
        context: { eventName: event.name, eventSlug: event.slug, appUrl: env.APP_URL, timezone: event.timezone, recipientName: contact.firstName },
        data: { subject: applySpeakerMergeFields(parsed.subject, recipient), body: applySpeakerMergeFields(parsed.body, recipient) },
      },
    })
    if (outcome.inserted) {
      queued += 1
      await db.insert(schema.contactActivity).values({
        orgId: parsed.orgId, contactId: contact.id, actorUserId: session.userId,
        kind: 'OUTREACH', body: `Outreach queued for ${event.name}: ${applySpeakerMergeFields(parsed.subject, recipient)}`, createdAt: now,
      })
    }
  }
  return { batchId, queued }
}

const assignmentDueSchema = z.object({ orgId: z.string().min(1), eventId: z.string().min(1), assignmentId: z.string().min(1), dueAt: z.number().int().positive().nullable() })
export async function updateTaskAssignmentDue(input: z.input<typeof assignmentDueSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = assignmentDueSchema.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  const rows = await db.update(schema.taskAssignment).set({ dueAt: parsed.dueAt, updatedAt: Date.now() }).where(orm.and(
    orm.eq(schema.taskAssignment.id, parsed.assignmentId), orm.eq(schema.taskAssignment.eventId, parsed.eventId),
  )).limit(1).returning({ id: schema.taskAssignment.id })
  if (!rows[0]) throw new Error('Task assignment not found')
  return { assignmentId: rows[0].id }
}

const remindAssignmentsSchema = z.object({ orgId: z.string().min(1), eventId: z.string().min(1), assignmentIds: z.array(z.string().min(1)).min(1).max(500) })
export async function remindTaskAssignments(input: z.input<typeof remindAssignmentsSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = remindAssignmentsSchema.parse(input)
  const { db, event } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  const rows = await db.query.taskAssignment.findMany({
    where: { eventId: parsed.eventId, id: { in: [...new Set(parsed.assignmentIds)] }, status: { in: ['NOT_STARTED', 'IN_PROGRESS'] } },
    with: { speaker: true, taskDefinition: true, session: true },
  })
  const now = Date.now()
  let queued = 0
  for (const row of rows) {
    if (!row.speaker || !row.taskDefinition) continue
    const outcome = await enqueueAndSend({
      db, eventId: event.id, speakerId: row.speakerId, sessionId: row.sessionId,
      toEmail: row.speaker.email, dedupeKey: `manual-task-reminder:${row.id}:${now}`,
      replyTo: replyToFor(event.contactEmail), now,
      payload: {
        kind: 'TASK_REMINDER',
        context: { eventName: event.name, eventSlug: event.slug, appUrl: env.APP_URL, timezone: event.timezone, recipientName: row.speaker.firstName },
        data: { assignmentId: row.id, taskTitle: row.taskDefinition.title, dueAt: row.dueAt, sessionTitle: row.session?.title, daysUntilDue: row.dueAt == null ? 0 : Math.ceil((row.dueAt - now) / 86_400_000) },
      },
    })
    if (outcome.inserted) queued += 1
  }
  return { queued }
}

const taskCommentSchema = z.object({
  eventId: z.string().min(1),
  assignmentId: z.string().min(1),
  fieldName: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
})

export async function addTaskComment(input: z.input<typeof taskCommentSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = taskCommentSchema.parse(input)
  const db = getDb()
  const assignment = await db.query.taskAssignment.findFirst({
    where: { id: parsed.assignmentId, eventId: parsed.eventId },
    with: { speaker: true },
  })
  if (!assignment?.speaker) throw new Error('Task assignment not found')
  const event = await db.query.event.findFirst({ where: { id: parsed.eventId } })
  if (!event) throw new Error('Task assignment not found')
  const member = await db.query.orgMember.findFirst({
    where: { orgId: event.orgId, userId: session.userId },
  })
  if (assignment.speaker.userId !== session.userId && !member) {
    throw new Error('Task assignment not found')
  }
  const slot = await db.query.file.findFirst({
    where: {
      eventId: parsed.eventId,
      taskAssignmentId: parsed.assignmentId,
      fieldName: parsed.fieldName,
    },
  })
  if (!slot) throw new Error('Upload a file before starting a comment thread')
  const commentId = ulid()
  await db.insert(schema.taskComment).values({
    id: commentId,
    taskAssignmentId: parsed.assignmentId,
    fieldName: parsed.fieldName,
    authorUserId: session.userId,
    body: parsed.body,
  })
  return { commentId }
}

const sessionContentSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(20_000).nullable(),
  trackId: z.string().min(1).nullable(),
  formatId: z.string().min(1).nullable(),
  coverImageFileId: z.string().min(1).nullable(),
})

export async function saveSessionContent(input: z.input<typeof sessionContentSchema>) {
  const actionRequest = getActionRequest()
  const parsed = sessionContentSchema.parse(input)
  const { db, session } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const [current, track, format, cover] = await db.batch([
    db.query.eventSession.findFirst({
      where: { id: parsed.sessionId, eventId: parsed.eventId, kind: 'CONTENT' },
    }),
    db.query.track.findFirst({ where: { id: parsed.trackId ?? '__none__', eventId: parsed.eventId } }),
    db.query.format.findFirst({ where: { id: parsed.formatId ?? '__none__', eventId: parsed.eventId } }),
    db.query.file.findFirst({
      where: {
        id: parsed.coverImageFileId ?? '__none__',
        eventId: parsed.eventId,
        kind: { in: ['HEADSHOT', 'IMAGE'] },
      },
    }),
  ] as const)
  if (!current) throw new Error('Content session not found')
  if (parsed.trackId && !track) throw new Error('Track not found in this event')
  if (parsed.formatId && !format) throw new Error('Format not found in this event')
  if (parsed.coverImageFileId && !cover) throw new Error('Cover image not found in this event')
  if (current.status === 'DRAFT') throw new Error('Submit the abstract before editing program content')

  const revisionId = ulid()
  const now = Date.now()
  await db.batch([
    db.update(schema.eventSession).set({
      title: parsed.title,
      description: parsed.description?.trim() || null,
      trackId: parsed.trackId,
      formatId: parsed.formatId,
      coverImageFileId: parsed.coverImageFileId,
      updatedAt: now,
    }).where(orm.and(
      orm.eq(schema.eventSession.id, parsed.sessionId),
      orm.eq(schema.eventSession.eventId, parsed.eventId),
    )).limit(1),
    db.insert(schema.sessionRevision).values({
      id: revisionId,
      eventId: parsed.eventId,
      sessionId: parsed.sessionId,
      title: parsed.title,
      description: parsed.description?.trim() || null,
      trackId: parsed.trackId,
      formatId: parsed.formatId,
      coverImageFileId: parsed.coverImageFileId,
      editorUserId: session.userId,
      createdAt: now,
    }),
  ] as const)
  return { revisionId }
}

const restoreRevisionSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  revisionId: z.string().min(1),
})

export async function restoreSessionRevision(input: z.input<typeof restoreRevisionSchema>) {
  const actionRequest = getActionRequest()
  const parsed = restoreRevisionSchema.parse(input)
  const { db, session } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const revision = await db.query.sessionRevision.findFirst({
    where: { id: parsed.revisionId, eventId: parsed.eventId, sessionId: parsed.sessionId },
  })
  if (!revision) throw new Error('Session revision not found')
  const restoredRevisionId = ulid()
  const now = Date.now()
  await db.batch([
    db.update(schema.eventSession).set({
      title: revision.title,
      description: revision.description,
      trackId: revision.trackId,
      formatId: revision.formatId,
      coverImageFileId: revision.coverImageFileId,
      updatedAt: now,
    }).where(orm.and(
      orm.eq(schema.eventSession.id, parsed.sessionId),
      orm.eq(schema.eventSession.eventId, parsed.eventId),
    )).limit(1),
    db.insert(schema.sessionRevision).values({
      id: restoredRevisionId,
      eventId: parsed.eventId,
      sessionId: parsed.sessionId,
      title: revision.title,
      description: revision.description,
      trackId: revision.trackId,
      formatId: revision.formatId,
      coverImageFileId: revision.coverImageFileId,
      editorUserId: session.userId,
      restoredFromRevisionId: revision.id,
      createdAt: now,
    }),
  ] as const)
  return { revisionId: restoredRevisionId, restoredFromRevisionId: revision.id }
}

const createTaskDefinitionSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  instructionsHtml: z.string().trim().max(20_000).optional(),
  target: z.enum(['SPEAKER', 'SUBMISSION']),
  source: z.enum(['MANUAL', 'FORM']),
  formId: z.string().min(1).nullable().optional(),
  dueAt: z.number().int().positive().nullable().optional(),
  assignmentPolicy: z.enum(['SELECTED', 'ALL_ACCEPTED']).default('SELECTED'),
  speakerIds: z.array(z.string().min(1)).max(500).default([]),
  sessionIds: z.array(z.string().min(1)).max(500).default([]),
})

export async function createTaskDefinition(input: z.input<typeof createTaskDefinitionSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = createTaskDefinitionSchema.parse(input)
  const { db } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const formId = parsed.source === 'FORM' ? (parsed.formId ?? null) : null
  const form = formId
    ? await db.query.form.findFirst({ where: { id: formId, eventId: parsed.eventId, purpose: 'PORTAL' } })
    : null
  assertTaskDefinitionShape({
    source: parsed.source,
    target: parsed.target,
    formId,
    form: form?.purpose === 'PORTAL' ? { purpose: form.purpose, target: form.target } : null,
  })
  const existing = await db.query.taskDefinition.findMany({
    where: { eventId: parsed.eventId },
    columns: { sortOrder: true },
  })
  const sortOrder = existing.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1
  const taskDefinitionId = ulid()
  const now = Date.now()
  const [acceptedSessions, selectedSpeakers] = await db.batch([
    db.query.eventSession.findMany({
      where: {
        eventId: parsed.eventId,
        status: 'ACCEPTED',
        kind: 'CONTENT',
        ...(parsed.assignmentPolicy === 'SELECTED' && parsed.sessionIds.length
          ? { id: { in: parsed.sessionIds } }
          : {}),
      },
      with: { participants: true },
    }),
    db.query.speaker.findMany({
      where: { eventId: parsed.eventId, id: { in: parsed.speakerIds } },
    }),
  ] as const)
  const selectedSpeakerIds = new Set(selectedSpeakers.map((row) => row.id))
  if (parsed.assignmentPolicy === 'SELECTED' && selectedSpeakers.length !== new Set(parsed.speakerIds).size) {
    throw new Error('One or more selected speakers were not found in this event')
  }
  const selectedSessionCount = acceptedSessions.filter((session) => parsed.sessionIds.includes(session.id)).length
  if (parsed.assignmentPolicy === 'SELECTED' && selectedSessionCount !== new Set(parsed.sessionIds).size) {
    throw new Error('One or more selected sessions were not accepted in this event')
  }
  const participants = acceptedSessions.flatMap((session) =>
    session.participants
      .filter((participant) => parsed.assignmentPolicy === 'ALL_ACCEPTED' || selectedSpeakerIds.has(participant.speakerId) || parsed.sessionIds.includes(session.id))
      .map((participant) => ({ speakerId: participant.speakerId, sessionId: session.id })),
  )
  if (parsed.assignmentPolicy === 'SELECTED' && participants.length === 0 && selectedSpeakers.length === 0) {
    throw new Error('Select at least one speaker or accepted session')
  }
  const definitionInsert = db.insert(schema.taskDefinition).values({
      id: taskDefinitionId,
      eventId: parsed.eventId,
      title: parsed.title,
      instructionsHtml: parsed.instructionsHtml?.trim() || null,
      target: parsed.target,
      source: parsed.source,
      formId,
      dueAt: parsed.dueAt ?? null,
      assignmentPolicy: parsed.assignmentPolicy,
      sortOrder,
    })
  const assignmentRows = parsed.target === 'SPEAKER'
    ? [...new Set([...selectedSpeakers.map((row) => row.id), ...participants.map((row) => row.speakerId)])].map((speakerId) => ({ speakerId, sessionId: null }))
    : participants.map((row) => ({ speakerId: row.speakerId, sessionId: row.sessionId }))
  await db.batch([
    definitionInsert,
    ...assignmentRows.map((row) => db.insert(schema.taskAssignment).values({
      eventId: parsed.eventId,
      taskDefinitionId,
      speakerId: row.speakerId,
      sessionId: row.sessionId,
      dueAt: parsed.dueAt ?? null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing()),
  ] as [any, ...any[]])
  return { taskDefinitionId, assigned: assignmentRows.length }
}

const updateTaskDefinitionSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  taskDefinitionId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  instructionsHtml: z.string().trim().max(20_000).nullable().optional(),
  target: z.enum(['SPEAKER', 'SUBMISSION']),
  source: z.enum(['MANUAL', 'FORM']),
  formId: z.string().min(1).nullable().optional(),
  dueAt: z.number().int().positive().nullable().optional(),
})

export async function updateTaskDefinition(input: z.input<typeof updateTaskDefinitionSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = updateTaskDefinitionSchema.parse(input)
  const { db } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const existing = await db.query.taskDefinition.findFirst({
    where: { id: parsed.taskDefinitionId, eventId: parsed.eventId },
  })
  if (!existing) throw new Error('Task not found')
  if (existing.target !== parsed.target || existing.source !== parsed.source) {
    throw new Error('Task target and source cannot change after creation')
  }
  const formId = parsed.source === 'FORM' ? (parsed.formId ?? null) : null
  const form = formId
    ? await db.query.form.findFirst({ where: { id: formId, eventId: parsed.eventId, purpose: 'PORTAL' } })
    : null
  assertTaskDefinitionShape({
    source: parsed.source,
    target: parsed.target,
    formId,
    form: form?.purpose === 'PORTAL' ? { purpose: form.purpose, target: form.target } : null,
  })
  await db
    .update(schema.taskDefinition)
    .set({
      title: parsed.title,
      instructionsHtml:
        parsed.instructionsHtml === undefined
          ? existing.instructionsHtml
          : parsed.instructionsHtml?.trim() || null,
      target: parsed.target,
      source: parsed.source,
      formId,
      dueAt: parsed.dueAt === undefined ? existing.dueAt : parsed.dueAt,
    })
    .where(
      orm.and(
        orm.eq(schema.taskDefinition.id, parsed.taskDefinitionId),
        orm.eq(schema.taskDefinition.eventId, parsed.eventId),
      ),
    )
    .limit(1)
  return { taskDefinitionId: parsed.taskDefinitionId }
}

const deleteTaskDefinitionSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  taskDefinitionId: z.string().min(1),
})

export async function deleteTaskDefinition(input: z.input<typeof deleteTaskDefinitionSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = deleteTaskDefinitionSchema.parse(input)
  const { db } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const existing = await db.query.taskDefinition.findFirst({
    where: { id: parsed.taskDefinitionId, eventId: parsed.eventId },
    columns: { id: true },
  })
  if (!existing) throw new Error('Task not found')
  const assignments = await db.query.taskAssignment.findMany({
    where: { eventId: parsed.eventId, taskDefinitionId: parsed.taskDefinitionId },
  })
  const deleteDefinition = db.delete(schema.taskDefinition).where(orm.and(
    orm.eq(schema.taskDefinition.id, parsed.taskDefinitionId),
    orm.eq(schema.taskDefinition.eventId, parsed.eventId),
  )).limit(1)
  if (assignments.length === 0) await deleteDefinition
  else {
    await db.batch([
      db.update(schema.file).set({ taskAssignmentId: null, fieldName: null }).where(
        orm.inArray(schema.file.taskAssignmentId, assignments.map((row) => row.id)),
      ),
      deleteDefinition,
    ] as const)
  }
  return { taskDefinitionId: parsed.taskDefinitionId }
}
