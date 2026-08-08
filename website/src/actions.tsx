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
  try {
    await db.insert(schema.event).values({
      id: eventId,
      orgId: parsed.orgId,
      name: parsed.name,
      slug,
      timezone: parsed.timezone,
      startsAt: parsed.startsAt,
      endsAt: parsed.endsAt,
    })
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
