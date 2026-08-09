// Server actions for the OpenSession website.
// Org management (create, rename, invites, member roles) is ported from
// akarso/sigillo's access implementation. Event actions are OpenSession's.
//
// SECURITY: server actions are public POST endpoints — every action
// authenticates via getActionRequest() + requireSession/requireOrgAccess.
'use server'

import { env } from 'cloudflare:workers'
import { getActionRequest, redirect } from 'spiceflow'
import { z } from 'zod'
import * as orm from 'drizzle-orm'
import * as schema from 'db/schema'
import { ulid } from 'ulid'
import {
  requireSession,
  requireOrgAccess,
  requireAdminRole,
  ensurePersonalOrg,
  getDb,
} from './db.ts'
import { collectFields } from './forms/collect-fields.ts'
import {
  starterCfpTemplate,
  starterEvaluationTemplate,
  starterPortalTemplate,
  starterSessionMaterialsTemplate,
  starterSpeakerProfileTemplate,
} from './forms/starter-template.ts'
import { validateSubmission } from './forms/validate.ts'
import { flattenSubmissionValues } from './lib/cfp-submission.ts'
import {
  clearSessionSlot,
  scheduleSessionSlot,
  MAX_SLOT_MINUTES,
} from './lib/agenda-server.ts'
import {
  cfpSubmissionSchema,
  getOrCreateCfpDraft,
  getPublicCfp,
  saveCfpDraft,
  submitCfpResponse,
} from './lib/cfp-server.ts'
import {
  completeManualTaskAssignment as completeManualTaskAssignmentServer,
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
import { zonedEpoch } from './lib/conflicts.ts'
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
  throw redirect(`/org/${orgId}`)
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
      purpose: 'ORG_MEMBER',
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
    throw redirect(`/review/${invite.formId}`)
  }
  // onConflictDoNothing handles the already-member case (unique index on
  // org_id + user_id prevents duplicates).
  await db
    .insert(schema.orgMember)
    .values({ orgId: invite.orgId, userId: session.userId, role: invite.role })
    .onConflictDoNothing({ target: [schema.orgMember.orgId, schema.orgMember.userId] })
  throw redirect(`/org/${invite.orgId}`)
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
    await db.batch([
      db.insert(schema.event).values({
        id: eventId,
        orgId: parsed.orgId,
        name: parsed.name,
        slug,
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
        // DRAFT until the organizer reviews and opens the CFP.
        status: 'DRAFT',
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
  throw redirect(`/org/${parsed.orgId}/e/${eventId}`)
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
  await requireOrgAccess(actionRequest, orgId)
  const db = getDb()
  const event = await db.query.event.findFirst({ where: { id: eventId, orgId } })
  if (!event) throw new Error('Event not found')
  return { db, event }
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
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(SLUG_RE).max(60).optional(),
  purpose: z.enum(['CFP', 'PORTAL', 'EVALUATION']),
  /** Portal only; CFP forms are always about the submission. */
  target: z.enum(['SUBMISSION', 'SPEAKER']).optional(),
  opensAt: z.number().int().positive().nullable().optional(),
  closesAt: z.number().int().positive().nullable().optional(),
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
        opensAt: parsed.opensAt ?? null,
        closesAt: parsed.closesAt ?? null,
        blind: parsed.purpose === 'EVALUATION' ? (parsed.blind ?? false) : false,
      }),
      db.insert(schema.formVersion).values({ formId, mdxSource: template }),
    ] as const)
  } catch {
    // Per-event unique slug — the most likely failure mode.
    throw new Error(`The slug "${slug}" is already used by another form of this event`)
  }
  throw redirect(`/org/${parsed.orgId}/e/${parsed.eventId}/forms/${formId}`)
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
  const listSegment = form.purpose === 'PORTAL' ? 'portal-forms' : form.purpose === 'EVALUATION' ? 'evaluation' : 'forms'
  throw redirect(`/org/${parsed.orgId}/e/${parsed.eventId}/${listSegment}`)
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
  throw redirect(`/submit/${parsed.eventSlug}/${parsed.formSlug}`)
}

/** Save an incomplete CFP response. Authentication happens before parsing
 * any caller-controlled identifiers because server actions are public. */
export async function savePublicCfpDraft(input: z.input<typeof cfpActionSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = cfpActionSchema.parse(input)
  return saveCfpDraft({ ...parsed, session })
}

/** Validate and submit the response against its immutable pinned version. */
export async function submitPublicCfp(input: z.input<typeof cfpActionSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = cfpActionSchema.parse(input)
  return submitCfpResponse({ ...parsed, session })
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
  return withdrawPortalSubmissionServer({ ...parsed, session })
}

const savePortalSubmissionSchema = portalSessionActionSchema.extend({
  submission: cfpSubmissionSchema,
  submit: z.boolean().default(true),
})

export async function savePortalSubmission(input: z.input<typeof savePortalSubmissionSchema>) {
  const actionRequest = getActionRequest()
  const session = await requireSession(actionRequest)
  const parsed = savePortalSubmissionSchema.parse(input)
  return savePortalSubmissionServer({ ...parsed, session })
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
  const now = Date.now()
  const planned = planBulkStatusUpdate(
    rows.map((row) => ({
      id: row.id,
      status: row.status,
      title: row.title,
      submittedAt: row.submittedAt,
      decidedAt: row.decidedAt,
      withdrawnAt: row.withdrawnAt,
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
    })),
    parsed.queue,
    now,
  )
  if (planned.length === 0) return { updated: 0, emailsQueued: 0 }

  const updates = planned.map((patch) =>
    db
      .update(schema.eventSession)
      .set({
        status: patch.status,
        ...(patch.title != null ? { title: patch.title } : {}),
        submittedAt: patch.submittedAt,
        decidedAt: patch.decidedAt,
        withdrawnAt: patch.withdrawnAt,
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
  await db.batch(updates as [any, ...any[]])

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

  for (const patch of planned) {
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
        dedupeKey: dedupeKeys.decision(row.id, speaker.id),
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

  return { updated: planned.length, emailsQueued, emailsSent }
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
  orgId: z.string().min(1), eventId: z.string().min(1), formId: z.string().min(1), reviewerId: z.string().min(1),
})

export async function remindEvaluationReviewer(input: z.input<typeof remindReviewerSchema>) {
  const actionRequest = getActionRequest()
  await requireSession(actionRequest)
  const parsed = remindReviewerSchema.parse(input)
  const { db, event } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  const pool = await db.query.evaluationReviewer.findFirst({
    where: { eventId: parsed.eventId, formId: parsed.formId, userId: parsed.reviewerId },
    with: { user: true, form: true, assignments: { with: { response: true } } },
  })
  if (!pool?.user || !pool.form) throw new Error('Reviewer not found')
  const pendingCount = pool.assignments.filter((row) => row.recusedAt == null && row.response?.status !== 'SUBMITTED').length
  if (pendingCount === 0) throw new Error('This reviewer has no outstanding reviews')
  const now = Date.now()
  await enqueueAndSend({
    db,
    eventId: event.id,
    toEmail: pool.user.email,
    dedupeKey: dedupeKeys.reviewReminder(pool.formId, pool.userId, dayBucket(now, event.timezone)),
    replyTo: replyToFor(event.contactEmail),
    now,
    payload: {
      kind: 'REVIEW_REMINDER',
      context: { eventName: event.name, eventSlug: event.slug, appUrl: env.APP_URL, timezone: event.timezone, recipientName: pool.user.name },
      data: { roundName: pool.form.name, reviewUrl: new URL(`/review/${pool.formId}`, env.APP_URL).href, pendingCount, closesAt: pool.form.closesAt },
    },
  })
  return { pendingCount }
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
})

export async function createTaskDefinition(input: z.input<typeof createTaskDefinitionSchema>) {
  const actionRequest = getActionRequest()
  const parsed = createTaskDefinitionSchema.parse(input)
  const { db } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const formId = parsed.source === 'FORM' ? (parsed.formId ?? null) : null
  const form = formId
    ? await db.query.form.findFirst({ where: { id: formId, eventId: parsed.eventId } })
    : null
  assertTaskDefinitionShape({
    source: parsed.source,
    target: parsed.target,
    formId,
    form: form ? { purpose: form.purpose, target: form.target } : null,
  })
  const existing = await db.query.taskDefinition.findMany({
    where: { eventId: parsed.eventId },
    columns: { sortOrder: true },
  })
  const sortOrder = existing.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1
  const [created] = await db
    .insert(schema.taskDefinition)
    .values({
      eventId: parsed.eventId,
      title: parsed.title,
      instructionsHtml: parsed.instructionsHtml?.trim() || null,
      target: parsed.target,
      source: parsed.source,
      formId,
      dueAt: parsed.dueAt ?? null,
      sortOrder,
    })
    .returning({ id: schema.taskDefinition.id })
  return { taskDefinitionId: created!.id }
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
  const formId = parsed.source === 'FORM' ? (parsed.formId ?? null) : null
  const form = formId
    ? await db.query.form.findFirst({ where: { id: formId, eventId: parsed.eventId } })
    : null
  assertTaskDefinitionShape({
    source: parsed.source,
    target: parsed.target,
    formId,
    form: form ? { purpose: form.purpose, target: form.target } : null,
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
  // Assignments cascade via FK.
  await db
    .delete(schema.taskDefinition)
    .where(
      orm.and(
        orm.eq(schema.taskDefinition.id, parsed.taskDefinitionId),
        orm.eq(schema.taskDefinition.eventId, parsed.eventId),
      ),
    )
    .limit(1)
  return { taskDefinitionId: parsed.taskDefinitionId }
}
