// Schema for the OpenSession D1 database — an open-source SessionBoard clone
// (CFP forms, speaker portal, deliverables, review, agenda, embeds).
//
// Design source of truth: /schema.prisma (23 models). This file is the 1:1
// drizzle translation. Auth + org tables are ported unchanged from the akarso
// project (BetterAuth on D1 via drizzle, personal-org invariant, secret invite
// links). Domain enums are UPPERCASE text enums with CHECK constraints
// (SQLite text enums are TypeScript-only, so CHECKs enforce them at DB level).
//
// Tenant boundary: every event-scoped parent exposes UNIQUE(id, event_id) so
// children can carry composite FKs (col, event_id) → parent(id, event_id).
// For NULLABLE dimension columns (session.track/format/room, task form) the
// composite FK uses the default NO ACTION — ON DELETE SET NULL is impossible
// on a composite key (SQLite would null event_id too). App code must detach
// children (UPDATE ... SET col = NULL) before deleting library rows.

import * as orm from 'drizzle-orm'
import * as s from 'drizzle-orm/sqlite-core'
import { ulid } from 'ulid'

// Integer column that stores epoch milliseconds as a plain number.
// Accepts Date objects in toDriver so BetterAuth's internal Date params
// don't crash D1's .bind() which only accepts string | number | null | ArrayBuffer.
export const epochMs = s.customType<{ data: number; driverParam: number }>({
  dataType() {
    return 'integer'
  },
  toDriver(value: unknown): number {
    if (value instanceof Date) return value.getTime()
    return value as number
  },
  fromDriver(value: unknown): number {
    return value as number
  },
})

// ── BetterAuth core tables ──────────────────────────────────────────

export const user = s.sqliteTable('user', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: s.text('name').notNull(),
  email: s.text('email').notNull().unique(),
  emailVerified: s.integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: s.text('image'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
})

// BetterAuth owns the physical `session` table, so the DOMAIN session entity
// below lives in `event_session`.
export const session = s.sqliteTable('session', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  userId: s.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  token: s.text('token').notNull().unique(),
  expiresAt: epochMs('expires_at').notNull(),
  ipAddress: s.text('ip_address'),
  userAgent: s.text('user_agent'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('session_user_id_idx').on(table.userId),
])

export const account = s.sqliteTable('account', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  userId: s.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: s.text('account_id').notNull(),
  providerId: s.text('provider_id').notNull(),
  accessToken: s.text('access_token'),
  refreshToken: s.text('refresh_token'),
  accessTokenExpiresAt: epochMs('access_token_expires_at'),
  refreshTokenExpiresAt: epochMs('refresh_token_expires_at'),
  scope: s.text('scope'),
  idToken: s.text('id_token'),
  password: s.text('password'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('account_user_id_idx').on(table.userId),
  s.uniqueIndex('account_provider_account_unique').on(table.providerId, table.accountId),
])

export const verification = s.sqliteTable('verification', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  identifier: s.text('identifier').notNull(),
  value: s.text('value').notNull(),
  expiresAt: epochMs('expires_at').notNull(),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('verification_identifier_idx').on(table.identifier),
])

// ── Org tables (akarso/sigillo semantics) ───────────────────────────
// Every user has exactly one 'personal' org (their default), enforced by the
// partial unique index on (ownerUserId) WHERE kind = 'personal'. That index
// makes first-visit auto-creation race-safe: two concurrent creates collide
// and the loser re-reads the winner's row. The owner can never leave or be
// removed from their personal org, so a deterministic default org always
// exists. 'team' orgs are created explicitly from the org switcher.
// Authorization is org-level for organizers. Evaluation reviewers use the
// event/form-scoped evaluationReviewer relation and never become org members.

export const org = s.sqliteTable('org', {
  orgId: s.text('org_id').primaryKey().notNull().$defaultFn(() => ulid()),
  /** Creator and (for personal orgs) permanent owner. */
  ownerUserId: s.text('owner_user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  kind: s.text('kind', { enum: ['personal', 'team'] }).notNull().default('personal'),
  /** Display name shown in the dashboard org switcher. Defaults to the
   *  owner's name on creation; editable later. */
  name: s.text('name'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('org_owner_user_id_idx').on(table.ownerUserId),
  // One personal org per user; the backbone of race-safe auto-creation
  // and deterministic default-org resolution.
  s.uniqueIndex('org_owner_personal_unique').on(table.ownerUserId).where(orm.sql`kind = 'personal'`),
  s.check('org_kind_check', orm.sql`kind IN ('personal', 'team')`),
])

export const orgMember = s.sqliteTable('org_member', {
  memberId: s.text('member_id').primaryKey().notNull().$defaultFn(() => ulid()),
  orgId: s.text('org_id').notNull().references(() => org.orgId, { onDelete: 'cascade' }),
  userId: s.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: s.text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('org_member_org_id_idx').on(table.orgId),
  s.index('org_member_user_id_idx').on(table.userId),
  // Makes invite acceptance idempotent via onConflictDoNothing.
  s.uniqueIndex('org_member_org_id_user_id_unique').on(table.orgId, table.userId),
  s.check('org_member_role_check', orm.sql`role IN ('admin', 'member')`),
])

// ── Event ───────────────────────────────────────────────────────────

export const event = s.sqliteTable('event', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  orgId: s.text('org_id').notNull().references(() => org.orgId, { onDelete: 'cascade' }),
  name: s.text('name').notNull(),
  /** Public CFP/portal/embed URLs use this slug. Globally unique. */
  slug: s.text('slug').notNull().unique(),
  status: s.text('status', { enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'] }).notNull().default('DRAFT'),
  websiteUrl: s.text('website_url'),
  location: s.text('location'),
  /** IANA timezone, e.g. "America/Los_Angeles" — agenda renders in this tz. */
  timezone: s.text('timezone').notNull(),
  startsAt: epochMs('starts_at').notNull(),
  endsAt: epochMs('ends_at').notNull(),
  description: s.text('description'),
  /** Null while the agenda is private. Set when the organizer publishes the program. */
  programPublishedAt: epochMs('program_published_at'),
  /** Reply-To for every outbound email of this event. Seeded from the
   *  creator's account email so speaker replies reach a real human; editable
   *  in Settings → Details. NULL falls back to the platform sender. */
  contactEmail: s.text('contact_email'),
  logoFileId: s.text('logo_file_id').unique().references((): s.AnySQLiteColumn => file.id, { onDelete: 'set null' }),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('event_org_id_idx').on(table.orgId),
  s.uniqueIndex('event_id_org_unique').on(table.id, table.orgId),
  s.check('event_status_check', orm.sql`status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')`),
])

// ── Event library (Settings > Library): tracks, formats, rooms ──────

export const track = s.sqliteTable('track', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  eventId: s.text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  name: s.text('name').notNull(),
  /** Hex color used by agenda + embeds. */
  color: s.text('color').notNull(),
  sortOrder: s.integer('sort_order', { mode: 'number' }).notNull().default(0),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('track_event_id_idx').on(table.eventId),
  s.uniqueIndex('track_event_name_unique').on(table.eventId, table.name),
  // Target for composite tenant-boundary FKs.
  s.uniqueIndex('track_id_event_unique').on(table.id, table.eventId),
])

export const format = s.sqliteTable('format', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  eventId: s.text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  /** "Talk", "Workshop", "Panel", "Keynote", "Lightning". */
  name: s.text('name').notNull(),
  /** Sessionize-style: agenda builder pre-fills endsAt from startsAt + duration. */
  defaultDurationMinutes: s.integer('default_duration_minutes', { mode: 'number' }),
  sortOrder: s.integer('sort_order', { mode: 'number' }).notNull().default(0),
}, (table) => [
  s.index('format_event_id_idx').on(table.eventId),
  s.uniqueIndex('format_event_name_unique').on(table.eventId, table.name),
  s.uniqueIndex('format_id_event_unique').on(table.id, table.eventId),
])

export const room = s.sqliteTable('room', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  eventId: s.text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  /** "Main Stage", "Hall A". */
  name: s.text('name').notNull(),
  sortOrder: s.integer('sort_order', { mode: 'number' }).notNull().default(0),
}, (table) => [
  s.index('room_event_id_idx').on(table.eventId),
  s.uniqueIndex('room_event_name_unique').on(table.eventId, table.name),
  s.uniqueIndex('room_id_event_unique').on(table.id, table.eventId),
])

// ── Forms — MDX documents rendered with safe-mdx ────────────────────
// There is NO form builder and NO structural tables: the whole form (copy,
// layout, field components, conditional logic) is one MDX source per
// FormVersion. The `name` prop on field components is the data contract:
// well-known names ("title", "track", "speaker.bio", ...) are copied to
// typed entity columns on submit; every other name stays as FormFieldValue
// KV rows. Server-side validation re-renders the response's pinned
// FormVersion.mdxSource with the submitted values in scope and collects the
// VISIBLE field components + props.

export const form = s.sqliteTable('form', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  eventId: s.text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  /** CFP = public call-for-speakers form (creates a Session).
   *  PORTAL = assigned to speakers via tasks. */
  purpose: s.text('purpose', { enum: ['CFP', 'PORTAL', 'EVALUATION'] }).notNull(),
  /** SUBMISSION = portal form about a specific session; SPEAKER = about the speaker. */
  target: s.text('target', { enum: ['SUBMISSION', 'SPEAKER'] }).notNull().default('SUBMISSION'),
  /** Admin-facing name; the public title lives in the MDX. */
  name: s.text('name').notNull(),
  /** Public URL: /submit/{event.slug}/{form.slug}. Per-event unique. */
  slug: s.text('slug').notNull(),
  status: s.text('status', { enum: ['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'] }).notNull().default('DRAFT'),
  // The live MDX is DERIVED: the newest FormVersion (ORDER BY createdAt DESC
  // LIMIT 1). No stored pointer to keep in sync.
  /** Hard-coded draft reminders fire 3 days and 1 day before this. */
  opensAt: epochMs('opens_at'),
  closesAt: epochMs('closes_at'),
  /** EVALUATION only: remove participant identity from reviewer loaders. */
  blind: s.integer('blind', { mode: 'boolean' }).notNull().default(false),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('form_event_id_idx').on(table.eventId),
  s.uniqueIndex('form_event_slug_unique').on(table.eventId, table.slug),
  s.uniqueIndex('form_id_event_unique').on(table.id, table.eventId),
  s.check('form_purpose_check', orm.sql`purpose IN ('CFP', 'PORTAL', 'EVALUATION')`),
  s.check('form_target_check', orm.sql`target IN ('SUBMISSION', 'SPEAKER')`),
  s.check('form_status_check', orm.sql`status IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED')`),
])

// One invitation owner with two outcomes. Org-member invitations stay
// shareable; reviewer invitations are email-bound and point at one evaluation
// form. eventId + orgId and formId + eventId composite FKs prevent cross-event
// or cross-organization reviewer invitations.
export const orgInvitation = s.sqliteTable('org_invitation', {
  invitationId: s.text('invitation_id').primaryKey().notNull().$defaultFn(() => ulid()),
  orgId: s.text('org_id').notNull().references(() => org.orgId, { onDelete: 'cascade' }),
  purpose: s.text('purpose', { enum: ['ORG_MEMBER', 'EVALUATION_REVIEWER'] }).notNull().default('ORG_MEMBER'),
  role: s.text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  invitedEmail: s.text('invited_email'),
  eventId: s.text('event_id'),
  formId: s.text('form_id'),
  createdBy: s.text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: epochMs('expires_at').notNull(),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('org_invitation_org_id_idx').on(table.orgId),
  s.index('org_invitation_form_idx').on(table.formId),
  s.foreignKey({ columns: [table.eventId, table.orgId], foreignColumns: [event.id, event.orgId], name: 'org_invitation_event_org_fk' }).onDelete('cascade'),
  s.foreignKey({ columns: [table.formId, table.eventId], foreignColumns: [form.id, form.eventId], name: 'org_invitation_form_event_fk' }).onDelete('cascade'),
  s.check('org_invitation_purpose_check', orm.sql`purpose IN ('ORG_MEMBER', 'EVALUATION_REVIEWER')`),
  s.check('org_invitation_owner_check', orm.sql`(purpose = 'ORG_MEMBER' AND invited_email IS NULL AND event_id IS NULL AND form_id IS NULL) OR (purpose = 'EVALUATION_REVIEWER' AND invited_email IS NOT NULL AND event_id IS NOT NULL AND form_id IS NOT NULL)`),
])

// Reviewer pool and authorization relation. A user can review one round
// without receiving any organizer membership or organizer data.
export const evaluationReviewer = s.sqliteTable('evaluation_reviewer', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  eventId: s.text('event_id').notNull(),
  formId: s.text('form_id').notNull(),
  userId: s.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.uniqueIndex('evaluation_reviewer_form_user_unique').on(table.formId, table.userId),
  s.uniqueIndex('evaluation_reviewer_event_form_user_unique').on(table.eventId, table.formId, table.userId),
  s.index('evaluation_reviewer_user_idx').on(table.userId),
  s.index('evaluation_reviewer_event_idx').on(table.eventId),
  s.foreignKey({ columns: [table.formId, table.eventId], foreignColumns: [form.id, form.eventId], name: 'evaluation_reviewer_form_event_fk' }).onDelete('cascade'),
])

// Immutable MDX snapshot, created on every save from the editor. Each
// response keeps pointing at the exact MDX it was filled against, so
// renaming a `name` prop never corrupts old data.
export const formVersion = s.sqliteTable('form_version', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  formId: s.text('form_id').notNull().references(() => form.id, { onDelete: 'cascade' }),
  /** The whole form: structure, copy, field props, conditional logic. */
  mdxSource: s.text('mdx_source').notNull(),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('form_version_form_created_idx').on(table.formId, table.createdAt),
  s.uniqueIndex('form_version_id_form_unique').on(table.id, table.formId),
])

// ── Speakers — event-scoped people ──────────────────────────────────
// userId nullable: co-speakers added by email link to a User when that
// person first signs into the portal (matched by verified email). Speakers
// with submitted history are anonymized, never hard-deleted.

export const speaker = s.sqliteTable('speaker', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  eventId: s.text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  userId: s.text('user_id').references(() => user.id, { onDelete: 'set null' }),
  email: s.text('email').notNull(),
  status: s.text('status', { enum: ['PENDING', 'INVITED', 'CONFIRMED', 'DECLINED'] }).notNull().default('PENDING'),
  firstName: s.text('first_name').notNull(),
  lastName: s.text('last_name').notNull(),
  // System profile fields (portal "Profile" page). Anything else (dietary
  // preferences, t-shirt size, ...) is a custom MDX field → FormFieldValue.
  /** Rich text, <=5000 chars app-enforced. */
  bio: s.text('bio'),
  jobTitle: s.text('job_title'),
  companyName: s.text('company_name'),
  pronouns: s.text('pronouns'),
  websiteUrl: s.text('website_url'),
  linkedinUrl: s.text('linkedin_url'),
  twitterUrl: s.text('twitter_url'),
  headshotFileId: s.text('headshot_file_id').unique().references((): s.AnySQLiteColumn => file.id, { onDelete: 'set null' }),
  /** Google profile image URL when the speaker has no uploaded headshot. */
  avatarUrl: s.text('avatar_url'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('speaker_event_id_idx').on(table.eventId),
  s.index('speaker_user_id_idx').on(table.userId),
  s.uniqueIndex('speaker_event_email_unique').on(table.eventId, table.email),
  s.uniqueIndex('speaker_id_event_unique').on(table.id, table.eventId),
  // One linked speaker identity per user per event. Partial: unlinked
  // (userId NULL) co-speakers can coexist.
  s.uniqueIndex('speaker_event_user_unique').on(table.eventId, table.userId).where(orm.sql`user_id IS NOT NULL`),
  s.check('speaker_status_check', orm.sql`status IN ('PENDING', 'INVITED', 'CONFIRMED', 'DECLINED')`),
])

// ── Sessions / submissions — one table for the whole lifecycle ──────
// Mirrors the real SessionBoard API where a Session has is_abstract. status
// is the single lifecycle dimension: ACCEPTED sessions are schedulable
// agenda items. CONTENT sessions carry speakers/CFP/evaluation; SERVICE
// sessions (breaks, lunch, registration) only use rooms/times/visibility.
// The live schedule is edited directly on roomId/startsAt/endsAt — no draft
// workspaces; conflicts are computed, never stored.

export const eventSession = s.sqliteTable('event_session', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  eventId: s.text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  /** Who submitted it (portal User reachable via Speaker.userId).
   *  Null = created by an admin. The creating form is derivable via
   *  FormResponse (sessionId + formId). */
  submitterSpeakerId: s.text('submitter_speaker_id'),
  kind: s.text('kind', { enum: ['CONTENT', 'SERVICE'] }).notNull().default('CONTENT'),
  status: s.text('status', {
    enum: ['DRAFT', 'PENDING', 'ACCEPT_QUEUE', 'ACCEPTED', 'DECLINE_QUEUE', 'DECLINED', 'WITHDRAWN'],
  }).notNull().default('DRAFT'),
  /** Nullable so autosaved drafts can exist before the Title question is
   *  answered. CHECK: non-DRAFT rows must have a non-empty title. */
  title: s.text('title'),
  /** Rich text. */
  description: s.text('description'),
  /** PUBLIC sessions appear in embeds and public agenda/feeds. */
  visibility: s.text('visibility', { enum: ['PUBLIC', 'PRIVATE'] }).notNull().default('PRIVATE'),
  /** Public cover image the speaker can set from the portal. */
  coverImageFileId: s.text('cover_image_file_id').unique().references((): s.AnySQLiteColumn => file.id, { onDelete: 'set null' }),
  trackId: s.text('track_id'),
  formatId: s.text('format_id'),
  // Live schedule (null until placed in the agenda).
  roomId: s.text('room_id'),
  startsAt: epochMs('starts_at'),
  endsAt: epochMs('ends_at'),
  // Lifecycle timestamps.
  submittedAt: epochMs('submitted_at'),
  decidedAt: epochMs('decided_at'),
  /** Decision email sent ("Notified" column). */
  notifiedAt: epochMs('notified_at'),
  withdrawnAt: epochMs('withdrawn_at'),
  /** ICS SEQUENCE counter — bump on every schedule change to update invites. */
  icsSequence: s.integer('ics_sequence', { mode: 'number' }).notNull().default(0),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.uniqueIndex('event_session_id_event_unique').on(table.id, table.eventId),
  s.index('event_session_event_status_idx').on(table.eventId, table.status),
  s.index('event_session_event_starts_idx').on(table.eventId, table.startsAt),
  s.index('event_session_event_room_starts_idx').on(table.eventId, table.roomId, table.startsAt),
  s.index('event_session_submitter_idx').on(table.submitterSpeakerId),
  s.index('event_session_track_idx').on(table.trackId),
  // Tenant-boundary composite FKs for nullable dimensions. NO ACTION on
  // delete: app code detaches (SET col = NULL) before deleting library rows.
  s.foreignKey({ columns: [table.trackId, table.eventId], foreignColumns: [track.id, track.eventId], name: 'event_session_track_event_fk' }),
  s.foreignKey({ columns: [table.formatId, table.eventId], foreignColumns: [format.id, format.eventId], name: 'event_session_format_event_fk' }),
  s.foreignKey({ columns: [table.roomId, table.eventId], foreignColumns: [room.id, room.eventId], name: 'event_session_room_event_fk' }),
  s.foreignKey({ columns: [table.submitterSpeakerId, table.eventId], foreignColumns: [speaker.id, speaker.eventId], name: 'event_session_submitter_event_fk' }),
  s.check('event_session_kind_check', orm.sql`kind IN ('CONTENT', 'SERVICE')`),
  s.check('event_session_status_check', orm.sql`status IN ('DRAFT', 'PENDING', 'ACCEPT_QUEUE', 'ACCEPTED', 'DECLINE_QUEUE', 'DECLINED', 'WITHDRAWN')`),
  s.check('event_session_visibility_check', orm.sql`visibility IN ('PUBLIC', 'PRIVATE')`),
  s.check('event_session_title_check', orm.sql`status = 'DRAFT' OR (title IS NOT NULL AND length(trim(title)) > 0)`),
  s.check('event_session_time_check', orm.sql`(starts_at IS NULL AND ends_at IS NULL) OR ends_at > starts_at`),
])

// Speakers/moderators on a session, with role, display order, and
// per-participation confirmation (a speaker can confirm talk A, decline B).
// Roster status is stored on Speaker; per-session confirmation stays here.
export const sessionParticipant = s.sqliteTable('session_participant', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  /** Denormalized: session and speaker must share the event. */
  eventId: s.text('event_id').notNull(),
  sessionId: s.text('session_id').notNull(),
  speakerId: s.text('speaker_id').notNull(),
  role: s.text('role', { enum: ['SPEAKER', 'MODERATOR'] }).notNull().default('SPEAKER'),
  confirmationStatus: s.text('confirmation_status', { enum: ['PENDING', 'CONFIRMED', 'DECLINED'] }).notNull().default('PENDING'),
  confirmedAt: epochMs('confirmed_at'),
  declinedAt: epochMs('declined_at'),
  sortOrder: s.integer('sort_order', { mode: 'number' }).notNull().default(0),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.uniqueIndex('session_participant_session_speaker_unique').on(table.sessionId, table.speakerId),
  s.index('session_participant_speaker_idx').on(table.speakerId),
  s.foreignKey({ columns: [table.sessionId, table.eventId], foreignColumns: [eventSession.id, eventSession.eventId], name: 'session_participant_session_fk' }).onDelete('cascade'),
  s.foreignKey({ columns: [table.speakerId, table.eventId], foreignColumns: [speaker.id, speaker.eventId], name: 'session_participant_speaker_fk' }).onDelete('cascade'),
  s.check('session_participant_role_check', orm.sql`role IN ('SPEAKER', 'MODERATOR')`),
  s.check('session_participant_confirmation_check', orm.sql`confirmation_status IN ('PENDING', 'CONFIRMED', 'DECLINED')`),
])

// ── Evaluation assignments ──────────────────────────────────────────
// A review row is one assignment in one evaluation round. Its state is
// derived from recusal or its optional FormResponse, never duplicated here.

export const review = s.sqliteTable('review', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  eventId: s.text('event_id').notNull(),
  formId: s.text('form_id').notNull(),
  sessionId: s.text('session_id').notNull(),
  reviewerId: s.text('reviewer_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  recusedAt: epochMs('recused_at'),
  recusalReason: s.text('recusal_reason'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.uniqueIndex('review_form_session_reviewer_unique').on(table.formId, table.sessionId, table.reviewerId),
  s.uniqueIndex('review_id_form_event_unique').on(table.id, table.formId, table.eventId),
  s.index('review_reviewer_idx').on(table.reviewerId),
  s.index('review_event_form_idx').on(table.eventId, table.formId),
  s.index('review_session_idx').on(table.sessionId),
  s.foreignKey({ columns: [table.sessionId, table.eventId], foreignColumns: [eventSession.id, eventSession.eventId], name: 'review_session_fk' }).onDelete('cascade'),
  s.foreignKey({ columns: [table.formId, table.eventId], foreignColumns: [form.id, form.eventId], name: 'review_form_event_fk' }).onDelete('cascade'),
  s.foreignKey({ columns: [table.eventId, table.formId, table.reviewerId], foreignColumns: [evaluationReviewer.eventId, evaluationReviewer.formId, evaluationReviewer.userId], name: 'review_pool_fk' }).onDelete('cascade'),
  s.check('review_recusal_check', orm.sql`(recused_at IS NULL AND recusal_reason IS NULL) OR (recused_at IS NOT NULL AND recusal_reason IS NOT NULL AND length(trim(recusal_reason)) > 0)`),
])

// ── Form responses — the immutable record of a form fill ────────────
// CFP responses create a Session; portal responses complete a
// TaskAssignment. On submit, well-known names are copied to typed entity
// columns; every other name stays here as FormFieldValue KV rows (the latest
// submitted response is the source of truth for custom fields).

export const formResponse = s.sqliteTable('form_response', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  eventId: s.text('event_id').notNull(),
  /** Restrict: forms with responses are archived, never deleted. */
  formId: s.text('form_id').notNull().references(() => form.id, { onDelete: 'restrict' }),
  /** The exact MDX snapshot this response was filled against. Validation and
   *  rendering of past responses always use this version, never the live one. */
  formVersionId: s.text('form_version_id').notNull().references(() => formVersion.id, { onDelete: 'restrict' }),
  /** Respondent. Restrict: anonymize speakers instead of deleting. */
  speakerId: s.text('speaker_id').references(() => speaker.id, { onDelete: 'restrict' }),
  /** Evaluation response owner. Exactly one of speakerId/reviewId is set. */
  reviewId: s.text('review_id').unique(),
  /** CFP: the Session created by this response. Portal SUBMISSION forms: the
   *  session the response is about. Portal SPEAKER forms: null. */
  sessionId: s.text('session_id').references(() => eventSession.id, { onDelete: 'cascade' }),
  /** Portal responses opened from a task. */
  taskAssignmentId: s.text('task_assignment_id').unique().references((): s.AnySQLiteColumn => taskAssignment.id, { onDelete: 'set null' }),
  status: s.text('status', { enum: ['DRAFT', 'SUBMITTED'] }).notNull().default('DRAFT'),
  submittedAt: epochMs('submitted_at'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('form_response_form_status_idx').on(table.formId, table.status),
  s.index('form_response_version_idx').on(table.formVersionId),
  s.index('form_response_speaker_idx').on(table.speakerId),
  s.index('form_response_event_idx').on(table.eventId),
  s.index('form_response_session_idx').on(table.sessionId),
  // One editable draft per form and speaker. Once submitted, the row no
  // longer matches this index and the speaker may start another response.
  s.uniqueIndex('form_response_active_draft_unique')
    .on(table.formId, table.speakerId)
    .where(orm.sql`status = 'DRAFT' AND speaker_id IS NOT NULL`),
  s.foreignKey({ columns: [table.formId, table.eventId], foreignColumns: [form.id, form.eventId], name: 'form_response_form_event_fk' }).onDelete('restrict'),
  s.foreignKey({ columns: [table.formVersionId, table.formId], foreignColumns: [formVersion.id, formVersion.formId], name: 'form_response_version_form_fk' }).onDelete('restrict'),
  s.foreignKey({ columns: [table.reviewId, table.formId, table.eventId], foreignColumns: [review.id, review.formId, review.eventId], name: 'form_response_review_form_event_fk' }).onDelete('cascade'),
  s.check('form_response_owner_check', orm.sql`(speaker_id IS NOT NULL AND review_id IS NULL) OR (speaker_id IS NULL AND review_id IS NOT NULL)`),
  s.check('form_response_status_check', orm.sql`status IN ('DRAFT', 'SUBMITTED')`),
])

// One row per submitted field value. `name` is the component's name prop —
// the data contract between the MDX and the database. Multi-select =
// multiple rows with the same name, one per selected value. Library choices
// like "track" store the library row id as value and resolve through
// Session.trackId (the typed column is the FK-checked copy).
export const formFieldValue = s.sqliteTable('form_field_value', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  responseId: s.text('response_id').notNull().references(() => formResponse.id, { onDelete: 'cascade' }),
  /** "title", "track", "speaker.bio", "gpuNeeds", ... */
  name: s.text('name').notNull(),
  value: s.text('value').notNull(),
  /** File-upload fields also link the uploaded File row. */
  fileId: s.text('file_id').references((): s.AnySQLiteColumn => file.id, { onDelete: 'set null' }),
  /** For fields inside <Participants>: which participant this value
   *  describes. App-validated. Restrict: anonymize speakers, never destroy
   *  response history. */
  subjectSpeakerId: s.text('subject_speaker_id').references(() => speaker.id, { onDelete: 'restrict' }),
}, (table) => [
  s.index('form_field_value_response_name_idx').on(table.responseId, table.name),
  s.index('form_field_value_subject_idx').on(table.subjectSpeakerId),
  s.index('form_field_value_file_idx').on(table.fileId),
  // Uniqueness via TWO partial indexes — a plain composite unique fails in
  // SQLite because NULL subjectSpeakerId rows are always considered distinct.
  s.uniqueIndex('form_field_value_plain_unique').on(table.responseId, table.name, table.value).where(orm.sql`subject_speaker_id IS NULL`),
  s.uniqueIndex('form_field_value_subject_unique').on(table.responseId, table.name, table.value, table.subjectSpeakerId).where(orm.sql`subject_speaker_id IS NOT NULL`),
])

// ── Speaker portal tasks ────────────────────────────────────────────
// File-request tasks are just FORM tasks whose MDX contains a <FileUpload>
// field. ALL_ACCEPTED expands on acceptance; SELECTED keeps only explicit
// assignments created with the definition.

export const taskDefinition = s.sqliteTable('task_definition', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  eventId: s.text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  title: s.text('title').notNull(),
  instructionsHtml: s.text('instructions_html'),
  /** SPEAKER = one assignment per speaker ("confirm participation");
   *  SUBMISSION = one per accepted session ("upload slides"). */
  target: s.text('target', { enum: ['SPEAKER', 'SUBMISSION'] }).notNull(),
  /** MANUAL = checkbox task; FORM = completing the linked portal Form
   *  completes the task (form.target must match the task target). */
  source: s.text('source', { enum: ['MANUAL', 'FORM'] }).notNull().default('MANUAL'),
  /** SELECTED never expands later. ALL_ACCEPTED backfills current accepted
   *  participants and applies when future sessions are accepted. */
  assignmentPolicy: s.text('assignment_policy', { enum: ['SELECTED', 'ALL_ACCEPTED'] }).notNull().default('ALL_ACCEPTED'),
  formId: s.text('form_id'),
  /** Default for NEW assignments (snapshotted per assignment). */
  dueAt: epochMs('due_at'),
  sortOrder: s.integer('sort_order', { mode: 'number' }).notNull().default(0),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.uniqueIndex('task_definition_id_event_unique').on(table.id, table.eventId),
  s.index('task_definition_event_idx').on(table.eventId),
  s.index('task_definition_form_idx').on(table.formId),
  // Tenant-boundary composite FK; NO ACTION — app detaches before form delete.
  s.foreignKey({ columns: [table.formId, table.eventId], foreignColumns: [form.id, form.eventId], name: 'task_definition_form_event_fk' }),
  s.check('task_definition_target_check', orm.sql`target IN ('SPEAKER', 'SUBMISSION')`),
  s.check('task_definition_source_check', orm.sql`source IN ('MANUAL', 'FORM')`),
  s.check('task_definition_assignment_policy_check', orm.sql`assignment_policy IN ('SELECTED', 'ALL_ACCEPTED')`),
  s.check('task_definition_source_form_check', orm.sql`(source = 'MANUAL' AND form_id IS NULL) OR (source = 'FORM' AND form_id IS NOT NULL)`),
])

// The per-speaker (or per-session) instance of a task. This table IS the
// "outstanding onboarding tasks" dashboard.
export const taskAssignment = s.sqliteTable('task_assignment', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  /** Denormalized: definition, speaker, session share the event. */
  eventId: s.text('event_id').notNull(),
  taskDefinitionId: s.text('task_definition_id').notNull(),
  speakerId: s.text('speaker_id').notNull(),
  /** Set when target = SUBMISSION. */
  sessionId: s.text('session_id'),
  status: s.text('status', { enum: ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'] }).notNull().default('NOT_STARTED'),
  /** Snapshot of TaskDefinition.dueAt at assignment time — later definition
   *  edits don't silently move deadlines for already-assigned speakers. */
  dueAt: epochMs('due_at'),
  completedAt: epochMs('completed_at'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.uniqueIndex('task_assignment_id_event_unique').on(table.id, table.eventId),
  s.index('task_assignment_definition_status_idx').on(table.taskDefinitionId, table.status),
  s.index('task_assignment_speaker_status_idx').on(table.speakerId, table.status),
  s.index('task_assignment_session_idx').on(table.sessionId),
  s.foreignKey({ columns: [table.taskDefinitionId, table.eventId], foreignColumns: [taskDefinition.id, taskDefinition.eventId], name: 'task_assignment_definition_fk' }).onDelete('cascade'),
  s.foreignKey({ columns: [table.speakerId, table.eventId], foreignColumns: [speaker.id, speaker.eventId], name: 'task_assignment_speaker_fk' }).onDelete('cascade'),
  s.foreignKey({ columns: [table.sessionId, table.eventId], foreignColumns: [eventSession.id, eventSession.eventId], name: 'task_assignment_session_fk' }).onDelete('cascade'),
  // Uniqueness via TWO partial indexes — a plain composite unique fails for
  // speaker tasks because sessionId is NULL and SQLite treats NULLs as
  // distinct. Assignment creation on acceptance is idempotent
  // (ON CONFLICT DO NOTHING against these indexes).
  s.uniqueIndex('task_assignment_speaker_unique').on(table.taskDefinitionId, table.speakerId).where(orm.sql`session_id IS NULL`),
  s.uniqueIndex('task_assignment_session_unique').on(table.taskDefinitionId, table.speakerId, table.sessionId).where(orm.sql`session_id IS NOT NULL`),
  s.check('task_assignment_status_check', orm.sql`status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED')`),
])

// Persistent speaker-organizer discussion for one file field on one task.
export const taskComment = s.sqliteTable('task_comment', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  taskAssignmentId: s.text('task_assignment_id').notNull().references(() => taskAssignment.id, { onDelete: 'cascade' }),
  fieldName: s.text('field_name').notNull(),
  authorUserId: s.text('author_user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  body: s.text('body').notNull(),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('task_comment_assignment_field_created_idx').on(table.taskAssignmentId, table.fieldName, table.createdAt),
  s.index('task_comment_author_idx').on(table.authorUserId),
  s.check('task_comment_field_check', orm.sql`length(trim(field_name)) > 0`),
  s.check('task_comment_body_check', orm.sql`length(trim(body)) > 0`),
])

// Immutable typed snapshots created after every organizer session edit.
export const sessionRevision = s.sqliteTable('session_revision', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  eventId: s.text('event_id').notNull(),
  sessionId: s.text('session_id').notNull(),
  title: s.text('title'),
  description: s.text('description'),
  trackId: s.text('track_id'),
  formatId: s.text('format_id'),
  coverImageFileId: s.text('cover_image_file_id'),
  editorUserId: s.text('editor_user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  restoredFromRevisionId: s.text('restored_from_revision_id').references((): s.AnySQLiteColumn => sessionRevision.id),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('session_revision_session_created_idx').on(table.sessionId, table.createdAt),
  s.index('session_revision_editor_idx').on(table.editorUserId),
  s.foreignKey({
    columns: [table.sessionId, table.eventId],
    foreignColumns: [eventSession.id, eventSession.eventId],
    name: 'session_revision_session_event_fk',
  }).onDelete('cascade'),
])

// ── Files — metadata rows; bytes live in R2 ─────────────────────────
// The EVENT owns every file (deleting the event deletes its files + storage
// bytes). A file is referenced from exactly one usage point:
// Event.logoFileId, Speaker.headshotFileId, Session.coverImageFileId, or
// FormFieldValue.fileId. Detaching is SetNull; a background job garbage-
// collects rows with no remaining references.

export const file = s.sqliteTable('file', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  eventId: s.text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  kind: s.text('kind', { enum: ['HEADSHOT', 'SLIDES', 'DOCUMENT', 'IMAGE', 'OTHER'] }).notNull().default('OTHER'),
  fileName: s.text('file_name').notNull(),
  mimeType: s.text('mime_type').notNull(),
  sizeBytes: s.integer('size_bytes', { mode: 'number' }).notNull(),
  /** Object-storage key (R2): {eventId}/{ulid}/{fileName}. */
  storageKey: s.text('storage_key').notNull().unique(),
  uploadedBySpeakerId: s.text('uploaded_by_speaker_id').references(() => speaker.id, { onDelete: 'set null' }),
  /** Uploads attach to their logical task slot before form submission. */
  taskAssignmentId: s.text('task_assignment_id').references(() => taskAssignment.id, { onDelete: 'set null' }),
  fieldName: s.text('field_name'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('file_event_id_idx').on(table.eventId),
  s.index('file_uploaded_by_idx').on(table.uploadedBySpeakerId),
  s.index('file_task_slot_created_idx').on(table.taskAssignmentId, table.fieldName, table.createdAt),
  s.check('file_kind_check', orm.sql`kind IN ('HEADSHOT', 'SLIDES', 'DOCUMENT', 'IMAGE', 'OTHER')`),
])

// ── Emails — transactional outbox + send log ────────────────────────
// Templates and reminder schedules are HARD-CODED IN THE APP (no
// EmailTemplate / ReminderRule tables). Each EmailKind maps to a template
// function; reminders run on fixed offsets (task due: 3 days + 1 day before,
// then overdue; CFP draft: 3 days + 1 day before Form.closesAt). Calendar
// invites are ICS attachments; the calendar UID is stable and derived
// ("session-{sessionId}@{appDomain}"), Session.icsSequence handles updates.
// A failed message is retried on the SAME row (attemptCount), never
// re-inserted.

export const emailMessage = s.sqliteTable('email_message', {
  id: s.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  eventId: s.text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  kind: s.text('kind', {
    enum: [
      'SUBMISSION_CONFIRMATION',
      'DECISION_ACCEPTED',
      'DECISION_DECLINED',
      'TASK_ASSIGNED',
      'TASK_REMINDER',
      'DRAFT_REMINDER',
      'SCHEDULE_INVITE',
      'SCHEDULE_UPDATE',
      'SCHEDULE_CANCEL',
      'REVIEWER_INVITE',
      'REVIEW_REMINDER',
      'SPEAKER_INVITE',
      'CUSTOM',
    ],
  }).notNull(),
  /** Idempotency: unique insert is the dedupe mechanism. Examples:
   *  "reminder:{kind}:{taskAssignmentId}:{yyyy-mm-dd}"
   *  "decision:{sessionId}:{speakerId}"
   *  "ics:{sessionId}:{speakerId}:{icsSequence}"
   *  Two concurrent cron workers cannot double-send. */
  dedupeKey: s.text('dedupe_key').notNull().unique(),
  /** Shared by per-recipient CUSTOM snapshots from one organizer send. */
  batchId: s.text('batch_id'),
  toEmail: s.text('to_email').notNull(),
  speakerId: s.text('speaker_id').references(() => speaker.id, { onDelete: 'set null' }),
  sessionId: s.text('session_id').references(() => eventSession.id, { onDelete: 'set null' }),
  subject: s.text('subject').notNull(),
  /** Rendered snapshot. */
  bodyHtml: s.text('body_html').notNull(),
  /** Plain-text alternative, snapshotted alongside bodyHtml. */
  bodyText: s.text('body_text'),
  /** ICS attachment (null = plain email). REQUEST = invite or update. */
  icsMethod: s.text('ics_method', { enum: ['REQUEST', 'CANCEL'] }),
  /** Snapshotted from Session.icsSequence at enqueue time. */
  icsSequence: s.integer('ics_sequence', { mode: 'number' }),
  /** Rendered iCalendar snapshot. The outbox row must be self-contained: a
   *  retry days later has to send the EXACT invite that was enqueued, because
   *  it carries the SEQUENCE that was snapshotted with it. Regenerating from
   *  the live session would ship changed times under an old SEQUENCE, which
   *  calendar clients silently drop. */
  icsBody: s.text('ics_body'),
  status: s.text('status', { enum: ['QUEUED', 'SENT', 'FAILED'] }).notNull().default('QUEUED'),
  attemptCount: s.integer('attempt_count', { mode: 'number' }).notNull().default(0),
  lastAttemptAt: epochMs('last_attempt_at'),
  errorMessage: s.text('error_message'),
  sentAt: epochMs('sent_at'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  s.index('email_message_event_status_idx').on(table.eventId, table.status),
  s.index('email_message_speaker_idx').on(table.speakerId),
  s.index('email_message_session_idx').on(table.sessionId),
  s.index('email_message_batch_idx').on(table.batchId),
  s.check('email_message_kind_check', orm.sql`kind IN ('SUBMISSION_CONFIRMATION', 'DECISION_ACCEPTED', 'DECISION_DECLINED', 'TASK_ASSIGNED', 'TASK_REMINDER', 'DRAFT_REMINDER', 'SCHEDULE_INVITE', 'SCHEDULE_UPDATE', 'SCHEDULE_CANCEL', 'REVIEWER_INVITE', 'REVIEW_REMINDER', 'SPEAKER_INVITE', 'CUSTOM')`),
  s.check('email_message_status_check', orm.sql`status IN ('QUEUED', 'SENT', 'FAILED')`),
  s.check('email_message_ics_method_check', orm.sql`ics_method IS NULL OR ics_method IN ('REQUEST', 'CANCEL')`),
])

// ── Relations (v2 API) ──────────────────────────────────────────────

export const relations = orm.defineRelations(
  {
    user, session, account, verification, org, orgMember, orgInvitation,
    event, track, format, room, form, evaluationReviewer, formVersion, speaker, eventSession,
    sessionParticipant, formResponse, formFieldValue, review, taskDefinition,
    taskAssignment, taskComment, sessionRevision, file, emailMessage,
  },
  (r) => ({
    user: {
      sessions: r.many.session(),
      accounts: r.many.account(),
      memberships: r.many.orgMember(),
      orgs: r.many.org({
        from: r.user.id.through(r.orgMember.userId),
        to: r.org.orgId.through(r.orgMember.orgId),
      }),
      speakerIdentities: r.many.speaker(),
      reviews: r.many.review(),
      evaluationMemberships: r.many.evaluationReviewer(),
      taskComments: r.many.taskComment(),
      sessionRevisions: r.many.sessionRevision(),
    },
    session: {
      user: r.one.user({ from: r.session.userId, to: r.user.id }),
    },
    account: {
      user: r.one.user({ from: r.account.userId, to: r.user.id }),
    },
    verification: {},
    org: {
      owner: r.one.user({ from: r.org.ownerUserId, to: r.user.id }),
      members: r.many.orgMember(),
      invitations: r.many.orgInvitation(),
      users: r.many.user({
        from: r.org.orgId.through(r.orgMember.orgId),
        to: r.user.id.through(r.orgMember.userId),
      }),
      events: r.many.event(),
    },
    orgMember: {
      org: r.one.org({ from: r.orgMember.orgId, to: r.org.orgId }),
      user: r.one.user({ from: r.orgMember.userId, to: r.user.id }),
    },
    orgInvitation: {
      org: r.one.org({ from: r.orgInvitation.orgId, to: r.org.orgId }),
      creator: r.one.user({ from: r.orgInvitation.createdBy, to: r.user.id }),
      event: r.one.event({ from: r.orgInvitation.eventId, to: r.event.id }),
      form: r.one.form({ from: r.orgInvitation.formId, to: r.form.id }),
    },
    event: {
      org: r.one.org({ from: r.event.orgId, to: r.org.orgId }),
      logoFile: r.one.file({ from: r.event.logoFileId, to: r.file.id }),
      tracks: r.many.track(),
      formats: r.many.format(),
      rooms: r.many.room(),
      forms: r.many.form(),
      speakers: r.many.speaker(),
      sessions: r.many.eventSession(),
      taskDefinitions: r.many.taskDefinition(),
      files: r.many.file({ from: r.event.id, to: r.file.eventId }),
      emailMessages: r.many.emailMessage(),
      evaluationReviewers: r.many.evaluationReviewer(),
    },
    track: {
      event: r.one.event({ from: r.track.eventId, to: r.event.id }),
      sessions: r.many.eventSession({ from: r.track.id, to: r.eventSession.trackId }),
    },
    format: {
      event: r.one.event({ from: r.format.eventId, to: r.event.id }),
      sessions: r.many.eventSession({ from: r.format.id, to: r.eventSession.formatId }),
    },
    room: {
      event: r.one.event({ from: r.room.eventId, to: r.event.id }),
      sessions: r.many.eventSession({ from: r.room.id, to: r.eventSession.roomId }),
    },
    form: {
      event: r.one.event({ from: r.form.eventId, to: r.event.id }),
      versions: r.many.formVersion(),
      responses: r.many.formResponse(),
      taskDefinitions: r.many.taskDefinition({ from: r.form.id, to: r.taskDefinition.formId }),
      evaluationReviewers: r.many.evaluationReviewer(),
      reviewAssignments: r.many.review(),
      invitations: r.many.orgInvitation(),
    },
    evaluationReviewer: {
      event: r.one.event({ from: r.evaluationReviewer.eventId, to: r.event.id }),
      form: r.one.form({ from: r.evaluationReviewer.formId, to: r.form.id }),
      user: r.one.user({ from: r.evaluationReviewer.userId, to: r.user.id }),
      assignments: r.many.review(),
    },
    formVersion: {
      form: r.one.form({ from: r.formVersion.formId, to: r.form.id }),
      responses: r.many.formResponse(),
    },
    speaker: {
      event: r.one.event({ from: r.speaker.eventId, to: r.event.id }),
      user: r.one.user({ from: r.speaker.userId, to: r.user.id }),
      headshotFile: r.one.file({ from: r.speaker.headshotFileId, to: r.file.id }),
      participations: r.many.sessionParticipant(),
      submittedSessions: r.many.eventSession({ from: r.speaker.id, to: r.eventSession.submitterSpeakerId }),
      taskAssignments: r.many.taskAssignment({ from: r.speaker.id, to: r.taskAssignment.speakerId }),
      formResponses: r.many.formResponse(),
      subjectFieldValues: r.many.formFieldValue({ from: r.speaker.id, to: r.formFieldValue.subjectSpeakerId }),
      emailMessages: r.many.emailMessage(),
      uploadedFiles: r.many.file({ from: r.speaker.id, to: r.file.uploadedBySpeakerId }),
    },
    eventSession: {
      event: r.one.event({ from: r.eventSession.eventId, to: r.event.id }),
      submitterSpeaker: r.one.speaker({ from: r.eventSession.submitterSpeakerId, to: r.speaker.id }),
      coverImageFile: r.one.file({ from: r.eventSession.coverImageFileId, to: r.file.id }),
      track: r.one.track({ from: r.eventSession.trackId, to: r.track.id }),
      format: r.one.format({ from: r.eventSession.formatId, to: r.format.id }),
      room: r.one.room({ from: r.eventSession.roomId, to: r.room.id }),
      participants: r.many.sessionParticipant({ from: r.eventSession.id, to: r.sessionParticipant.sessionId }),
      formResponses: r.many.formResponse({ from: r.eventSession.id, to: r.formResponse.sessionId }),
      reviews: r.many.review({ from: r.eventSession.id, to: r.review.sessionId }),
      taskAssignments: r.many.taskAssignment({ from: r.eventSession.id, to: r.taskAssignment.sessionId }),
      emailMessages: r.many.emailMessage({ from: r.eventSession.id, to: r.emailMessage.sessionId }),
      revisions: r.many.sessionRevision(),
    },
    sessionParticipant: {
      session: r.one.eventSession({ from: r.sessionParticipant.sessionId, to: r.eventSession.id }),
      speaker: r.one.speaker({ from: r.sessionParticipant.speakerId, to: r.speaker.id }),
    },
    formResponse: {
      form: r.one.form({ from: r.formResponse.formId, to: r.form.id }),
      formVersion: r.one.formVersion({ from: r.formResponse.formVersionId, to: r.formVersion.id }),
      speaker: r.one.speaker({ from: r.formResponse.speakerId, to: r.speaker.id }),
      session: r.one.eventSession({ from: r.formResponse.sessionId, to: r.eventSession.id }),
      taskAssignment: r.one.taskAssignment({ from: r.formResponse.taskAssignmentId, to: r.taskAssignment.id }),
      review: r.one.review({ from: r.formResponse.reviewId, to: r.review.id }),
      fieldValues: r.many.formFieldValue(),
    },
    formFieldValue: {
      response: r.one.formResponse({ from: r.formFieldValue.responseId, to: r.formResponse.id }),
      file: r.one.file({ from: r.formFieldValue.fileId, to: r.file.id }),
      subjectSpeaker: r.one.speaker({ from: r.formFieldValue.subjectSpeakerId, to: r.speaker.id }),
    },
    review: {
      session: r.one.eventSession({ from: r.review.sessionId, to: r.eventSession.id }),
      reviewer: r.one.user({ from: r.review.reviewerId, to: r.user.id }),
      form: r.one.form({ from: r.review.formId, to: r.form.id }),
      poolMembership: r.one.evaluationReviewer({
        from: [r.review.eventId, r.review.formId, r.review.reviewerId],
        to: [r.evaluationReviewer.eventId, r.evaluationReviewer.formId, r.evaluationReviewer.userId],
      }),
      response: r.one.formResponse({ from: r.review.id, to: r.formResponse.reviewId }),
    },
    taskDefinition: {
      event: r.one.event({ from: r.taskDefinition.eventId, to: r.event.id }),
      form: r.one.form({ from: r.taskDefinition.formId, to: r.form.id }),
      assignments: r.many.taskAssignment({ from: r.taskDefinition.id, to: r.taskAssignment.taskDefinitionId }),
    },
    taskAssignment: {
      taskDefinition: r.one.taskDefinition({ from: r.taskAssignment.taskDefinitionId, to: r.taskDefinition.id }),
      speaker: r.one.speaker({ from: r.taskAssignment.speakerId, to: r.speaker.id }),
      session: r.one.eventSession({ from: r.taskAssignment.sessionId, to: r.eventSession.id }),
      formResponse: r.one.formResponse({ from: r.taskAssignment.id, to: r.formResponse.taskAssignmentId }),
      files: r.many.file(),
      comments: r.many.taskComment(),
    },
    taskComment: {
      taskAssignment: r.one.taskAssignment({ from: r.taskComment.taskAssignmentId, to: r.taskAssignment.id }),
      author: r.one.user({ from: r.taskComment.authorUserId, to: r.user.id }),
    },
    sessionRevision: {
      session: r.one.eventSession({ from: r.sessionRevision.sessionId, to: r.eventSession.id }),
      editor: r.one.user({ from: r.sessionRevision.editorUserId, to: r.user.id }),
      restoredFrom: r.one.sessionRevision({
        from: r.sessionRevision.restoredFromRevisionId,
        to: r.sessionRevision.id,
        alias: 'restoredFrom',
      }),
      restores: r.many.sessionRevision({ alias: 'restoredFrom' }),
    },
    file: {
      event: r.one.event({ from: r.file.eventId, to: r.event.id }),
      uploadedBySpeaker: r.one.speaker({ from: r.file.uploadedBySpeakerId, to: r.speaker.id }),
      formFieldValues: r.many.formFieldValue({ from: r.file.id, to: r.formFieldValue.fileId }),
      taskAssignment: r.one.taskAssignment({ from: r.file.taskAssignmentId, to: r.taskAssignment.id }),
    },
    emailMessage: {
      event: r.one.event({ from: r.emailMessage.eventId, to: r.event.id }),
      speaker: r.one.speaker({ from: r.emailMessage.speakerId, to: r.speaker.id }),
      session: r.one.eventSession({ from: r.emailMessage.sessionId, to: r.eventSession.id }),
    },
  }),
)
