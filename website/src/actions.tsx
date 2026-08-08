// Server actions for the OpenSession website.
// Org management (create, rename, invites, member roles) is ported from
// akarso/sigillo's access implementation. Event actions are OpenSession's.
//
// SECURITY: server actions are public POST endpoints — every action
// authenticates via getActionRequest() + requireSession/requireOrgAccess.
'use server'

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
import { starterCfpTemplate, starterPortalTemplate } from './forms/starter-template.ts'
import { cfpSubmissionSchema, saveCfpDraft, submitCfpResponse } from './lib/cfp-server.ts'
import { normalizeReviewInput } from './lib/reviews.ts'
import {
  applyTransition,
  planBulkStatusUpdate,
  planNotifyQueue,
  type SessionStatus,
} from './lib/submissions.ts'
import {
  assertTaskDefinitionShape,
  buildAssignmentsForAcceptance,
  defaultManualTaskDefinitions,
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
  // onConflictDoNothing handles the already-member case (unique index on
  // org_id + user_id prevents duplicates).
  await db
    .insert(schema.orgMember)
    .values({ orgId: invite.orgId, userId: session.userId, role: invite.role })
    .onConflictDoNothing({ target: [schema.orgMember.orgId, schema.orgMember.userId] })
  throw redirect(`/org/${invite.orgId}`)
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

const createEventSchema = z.object({
  orgId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(SLUG_RE).max(60).optional(),
  timezone: z.string().min(1).max(60),
  /** Epoch ms. */
  startsAt: z.number().int().positive(),
  endsAt: z.number().int().positive(),
})

/** Create an event in the org and redirect to it. Any member can create
 *  events (org-level authz, no per-event roles). */
export async function createEvent(input: {
  orgId: string
  name: string
  slug?: string
  timezone: string
  startsAt: number
  endsAt: number
}) {
  const actionRequest = getActionRequest()
  const parsed = createEventSchema.parse(input)
  await requireOrgAccess(actionRequest, parsed.orgId)
  if (parsed.endsAt <= parsed.startsAt) {
    throw new Error('The event must end after it starts')
  }
  // Validate the timezone against the runtime's IANA database.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: parsed.timezone })
  } catch {
    throw new Error(`Unknown timezone: ${parsed.timezone}`)
  }

  const slug = parsed.slug || slugify(parsed.name)
  if (!SLUG_RE.test(slug)) throw new Error('Could not derive a valid slug from the event name')

  const db = getDb()
  const eventId = ulid()
  const now = Date.now()
  const defaultTasks = defaultManualTaskDefinitions(eventId, now)
  try {
    // Event + default MANUAL onboarding tasks in one batch so a new event
    // always has profile/materials tasks ready for acceptance auto-assign.
    await db.batch([
      db.insert(schema.event).values({
        id: eventId,
        orgId: parsed.orgId,
        name: parsed.name,
        slug,
        timezone: parsed.timezone,
        startsAt: parsed.startsAt,
        endsAt: parsed.endsAt,
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
  /** Epoch ms. */
  startsAt: z.number().int().positive(),
  endsAt: z.number().int().positive(),
  description: z.string().trim().max(5000),
})

/** Update the event details (Settings > Details). Empty optional strings
 *  are stored as NULL. */
export async function updateEvent(input: z.input<typeof updateEventSchema>) {
  const actionRequest = getActionRequest()
  const parsed = updateEventSchema.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })
  if (parsed.endsAt <= parsed.startsAt) {
    throw new Error('The event must end after it starts')
  }
  validateTimezone(parsed.timezone)

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
        startsAt: parsed.startsAt,
        endsAt: parsed.endsAt,
        description: parsed.description || null,
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
  purpose: z.enum(['CFP', 'PORTAL']),
  /** Portal only; CFP forms are always about the submission. */
  target: z.enum(['SUBMISSION', 'SPEAKER']).optional(),
})

/** Create a form with its first FormVersion seeded from the matching
 *  starter template, then redirect to the editor. */
export async function createForm(input: z.input<typeof createFormSchema>) {
  const actionRequest = getActionRequest()
  const parsed = createFormSchema.parse(input)
  const { db } = await requireEventAccess({ actionRequest, orgId: parsed.orgId, eventId: parsed.eventId })

  const slug = parsed.slug || slugify(parsed.name)
  if (!SLUG_RE.test(slug)) throw new Error('Could not derive a valid slug from the form name')

  const formId = ulid()
  const template = parsed.purpose === 'CFP' ? starterCfpTemplate : starterPortalTemplate
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
})

/** Update form settings (name, slug, status, closesAt). Purpose and target
 *  are immutable after creation — they decide where responses land. */
export async function updateFormSettings(input: z.input<typeof updateFormSettingsSchema>) {
  const actionRequest = getActionRequest()
  const parsed = updateFormSettingsSchema.parse(input)
  const { db } = await requireFormAccess({
    actionRequest, orgId: parsed.orgId, eventId: parsed.eventId, formId: parsed.formId,
  })
  try {
    await db
      .update(schema.form)
      .set({
        name: parsed.name,
        slug: parsed.slug,
        status: parsed.status,
        closesAt: parsed.closesAt,
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
  const listSegment = form.purpose === 'PORTAL' ? 'portal-forms' : 'forms'
  throw redirect(`/org/${parsed.orgId}/e/${parsed.eventId}/${listSegment}`)
}

// ── Public CFP actions ───────────────────────────────────────────────

const cfpActionSchema = z.object({
  eventId: z.string().min(1),
  formId: z.string().min(1),
  responseId: z.string().min(1),
  submission: cfpSubmissionSchema,
})

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
 *  auto-assign on accept, enqueue DECISION_* EmailMessage rows (QUEUED).
 *  notifiedAt stays null until Task 7 marks the outbox SENT. */
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
  const taskDefs =
    parsed.queue === 'accept'
      ? await db.query.taskDefinition.findMany({ where: { eventId: parsed.eventId } })
      : []

  for (const patch of planned) {
    const row = rows.find((item) => item.id === patch.id)
    if (!row) continue
    if (patch.status === 'ACCEPTED' && taskDefs.length > 0) {
      await insertAssignmentsIdempotent({
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
    }
    const kind = patch.status === 'ACCEPTED' ? 'DECISION_ACCEPTED' : 'DECISION_DECLINED'
    const title = row.title?.trim() || 'your submission'
    for (const part of row.participants) {
      const speaker = part.speaker
      if (!speaker?.email) continue
      const dedupeKey = `decision:${row.id}:${speaker.id}`
      const subject =
        kind === 'DECISION_ACCEPTED'
          ? `Accepted: ${title} — ${event.name}`
          : `Update on ${title} — ${event.name}`
      const bodyHtml =
        kind === 'DECISION_ACCEPTED'
          ? `<p>Your submission <strong>${escapeHtml(title)}</strong> was accepted for ${escapeHtml(event.name)}.</p>`
          : `<p>Your submission <strong>${escapeHtml(title)}</strong> was not selected for ${escapeHtml(event.name)}.</p>`
      try {
        await db
          .insert(schema.emailMessage)
          .values({
            eventId: parsed.eventId,
            kind,
            dedupeKey,
            toEmail: speaker.email,
            speakerId: speaker.id,
            sessionId: row.id,
            subject,
            bodyHtml,
            status: 'QUEUED',
          })
          .onConflictDoNothing({ target: schema.emailMessage.dedupeKey })
        emailsQueued += 1
      } catch {
        // Dedupe races or missing email constraints — skip, status still updated.
      }
    }
  }
  return { updated: planned.length, emailsQueued }
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
}) {
  if (rows.length === 0) return
  // Partial unique indexes (speaker-only vs session×speaker) make plain
  // target arrays awkward — bare onConflictDoNothing lets SQLite match
  // whichever partial unique fires.
  const statements = rows.map((row) =>
    db.insert(schema.taskAssignment).values(row).onConflictDoNothing(),
  )
  // Cap batch size to avoid huge transactions on multi-speaker events.
  const CHUNK = 40
  for (let i = 0; i < statements.length; i += CHUNK) {
    const chunk = statements.slice(i, i + CHUNK)
    if (chunk.length === 0) continue
    await db.batch(chunk as [any, ...any[]])
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const upsertReviewSchema = z.object({
  orgId: z.string().min(1),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  vote: z.enum(['YES', 'MAYBE', 'NO']),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  comment: z.string().max(5000).nullable().optional(),
})

/** Upsert the caller's review for a session (unique sessionId+reviewerId). */
export async function upsertReview(input: z.input<typeof upsertReviewSchema>) {
  const actionRequest = getActionRequest()
  const { session } = await requireOrgAccess(actionRequest, input.orgId)
  const parsed = upsertReviewSchema.parse(input)
  const { db } = await requireEventAccess({
    actionRequest,
    orgId: parsed.orgId,
    eventId: parsed.eventId,
  })
  const row = await db.query.eventSession.findFirst({
    where: { id: parsed.sessionId, eventId: parsed.eventId },
    columns: { id: true, kind: true },
  })
  if (!row || row.kind !== 'CONTENT') throw new Error('Session not found')

  const normalized = normalizeReviewInput({
    vote: parsed.vote,
    rating: parsed.rating ?? null,
    comment: parsed.comment ?? null,
  })
  const now = Date.now()
  const reviewId = ulid()
  await db
    .insert(schema.review)
    .values({
      id: reviewId,
      eventId: parsed.eventId,
      sessionId: parsed.sessionId,
      reviewerId: session.userId,
      vote: normalized.vote,
      rating: normalized.rating,
      comment: normalized.comment,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.review.sessionId, schema.review.reviewerId],
      set: {
        vote: normalized.vote,
        rating: normalized.rating,
        comment: normalized.comment,
        updatedAt: now,
      },
    })
  return { sessionId: parsed.sessionId, vote: normalized.vote }
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
