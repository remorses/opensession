---
title: SessionBoard clone — product research & database schema plan
description: >
  Research on sessionboard.com (use case, workflow, pricing, competitors, API entities)
  and the design plan for the normalized SQLite schema in ../schema.prisma.
---

# What SessionBoard is

SessionBoard (sessionboard.com) is a **speaker & event content management platform**. It is the
"program layer" of an event: it does NOT do registration/ticketing. It manages everything about
the **content** of a conference:

- **Call for papers (CFP)**: custom submission forms with conditional logic where potential
  speakers submit session ideas (abstracts)
- **Abstract management**: review queues, multi-round evaluation plans with scorecards,
  reviewer assignments, accept/decline workflows
- **Speaker management**: a self-service speaker portal where speakers maintain bios,
  headshots, slides, and complete onboarding tasks
- **Agenda building**: drag-and-drop scheduling into rooms/tracks/time slots with automatic
  conflict detection, draft workspaces, and commit-to-live
- **Communications**: templated emails, reminders, calendar invites
- **Embeds**: auto-updating agenda / speaker gallery widgets for the event website

## Primary use case & user workflow

Two user populations:

```
  ORGANIZER (admin)                                SUBMITTER / SPEAKER (portal)
  ─────────────────                                ────────────────────────────
  1. Create event (dates, tz, rooms,               1. Open public CFP link
     tracks, formats, tags)                        2. Create account (portal auth)
  2. Build submission form                         3. Fill multi-step form:
     (questions, conditional logic,                   Welcome → Account → Submission
      participant roles, deadlines)         ◄─────    → Participants → Review
  3. Publish CFP link                               4. Receive confirmation email
  4. Review abstracts arrive as "Pending"           5. Track status in speaker portal,
  5. Assign reviewers, run evaluation                  edit own submission, upload
     rounds, score with scorecards                     headshot, update bio
  6. Move to Accept Queue / Decline Queue           6. On acceptance: get decision
  7. Bulk accept → decision emails sent                email + calendar invite
     (notifiedAt stamped)                          7. Complete portal tasks
  8. Accepted abstracts become sessions                (upload slides, fill forms,
  9. Build agenda in a draft workspace:                confirm participation)
     place sessions in rooms/times,
     resolve conflicts, commit draft
 10. Dashboard: track which speakers
     still have outstanding tasks
 11. Embed agenda/speaker gallery on
     the event website
```

## Pricing

- **Professional**: from **$249/month** (speaker/sponsor/exhibitor management, email+SMS
  templates & tracking, AI tools, 15+ integrations, roles & permissions)
- **Enterprise**: custom pricing (SSO, custom portal/embed styling, custom email domain,
  document generation). Real-world enterprise contracts run **>$40k/year** (per the
  competition brief), priced by submission volume, committee seats, and tracks.

## Competitors

| Competitor | Positioning |
|---|---|
| **Sessionize** | Closest direct competitor. CFP + agenda for tech conferences. $499/event, free for community events |
| **Oxford Abstracts** | Abstract-only specialist, per-event pricing, free tier |
| **Cvent (Abstract Mgmt)** | Enterprise suite; SessionBoard positions as the deeper "program layer" beside Cvent registration |
| **Cadmium** | Enterprise abstract/education management for associations |
| **Ex Ordo** | Academic conference abstract management |
| **Sched** | Fast agenda/speaker-list publishing for community conferences |
| **OpenCFP / Papercall / EasyChair** | Simpler open-source or academic CFP tools |

## Primary features (from brief + screenshots)

1. Custom CFP submission forms with **conditional logic** and **category-based routing**
2. Self-service **speaker portal** (bios, headshots, slides, documents)
3. Automated templated **communications** incl. reminders and **calendar invites** (ICS)
4. Submission **evaluation & scoring** workflows (round-based plans, scorecards, reviewer pools)
5. Drag-and-drop **agenda building** with conflict detection (list/day/week/track/room views)
6. Real-time **dashboard** of outstanding speaker onboarding tasks
7. Embeddable **speaker gallery & schedule** widgets

## The public API — core entities

Base: `https://public-api.sessionboard.com` (API key or OAuth bearer, scoped:
`write:sessions`, `write:contacts`, `write:events`, ...). Key entities from the OpenAPI spec:

- **Event**: id, name, timezone, feature flags
- **Session**: THE central entity. One table for both abstracts and program sessions via
  `is_abstract: boolean`. Fields: title, description, `status` enum
  (`accepted | accept_queue | pending | decline_queue | declined`), custom_status,
  starts_at/ends_at, is_public, capacity, ceu_credits, client_session_id,
  `custom_fields[]`, speakers/chairpersons/moderators/participants, sponsors, exhibitors,
  tags, language, track, level, format, room, subsessions, composition (merged abstracts →
  session)
- **Contact** (= speaker): name, email, photo_url, company, title, about/bio, phones,
  address, social urls, honorific/salutation/pronouns/gender, speaker_score, speaker_fee,
  custom_fields
- **ParticipantRole**: per-event configurable roles with `core_role` enum
  (`speaker | chairperson | moderator`)
- **Event settings/library**: Field (custom field definitions per module:
  session/account/contact), Tag, Language, Format, Track (name, color, order), Level,
  Room (name, capacity, order), custom SessionStatus
- **Agenda planning**: AgendaDraft (`draft | committed`), DraftSession (placement =
  draft_id + session_id + starts_at/ends_at + room_id), changes preview, commit;
  EventRule (scheduling constraint, opaque config), Persona (attendee type for schedule
  evaluation)
- **CustomFieldValue**: id, internal_name, type, value (string) — attached to
  sessions/contacts/sponsors/exhibitors
- Not exposed in the public API (admin-app-only): Forms, Evaluations, Tasks, Emails,
  Portal — we reverse-engineered those from the app screenshots.

# Schema design decisions

The full schema is in [`../schema.prisma`](../schema.prisma). It is the **design source of
truth**; the implementation will translate it 1:1 to drizzle (SQLite text-enum columns),
since Prisma does not support native enums on SQLite.

## Scope

In scope: events, library (tracks/formats/levels/tags/rooms/roles/custom fields/schedule
slots), forms (builder + conditional logic + routing), submissions (abstracts→sessions,
transition audit log), evaluation (plans/rounds/reviewer pools/scorecards/reviews), agenda
(drafts/placements/rules/schedule revisions), speaker portal (speakers, availability,
tasks, file requests, files), emails (templates, reminder rules, outbox with dedupe, ICS),
embeds. Out of scope (per brief): CRM, CMS pages, payments, marketing,
transcriptions/recordings, sponsors/exhibitors.

## Key decisions

1. **Auth = BetterAuth for BOTH populations.** One `User` table serves organizers and
   submitters. Organizers get `OrgMember` rows (app-level org membership ported from
   akarso — NOT a BetterAuth plugin) and `EventMember` rows (per-event role incl.
   `REVIEWER`). Submitters get a `Speaker` row per event. `Speaker.userId` is nullable:
   a submitter can add co-speakers by email who have never logged in; when that person
   later signs in (magic link to the same email), the Speaker row links to their User.

2. **One `Session` table for abstract AND session** — mirrors the real API
   (`is_abstract`), modeled as `stage: ABSTRACT | SESSION`. Acceptance is a state
   transition, not a copy: `status → ACCEPTED`, then promotion `stage → SESSION`. This
   avoids duplicating the ~30 shared columns and keeps history (form answers, reviews)
   attached to a single row. Merge/composition of multiple abstracts is intentionally
   dropped (enterprise feature the brief does not need).

3. **Forms are MDX documents (safe-mdx), not structural tables.** The whole form —
   copy, layout, field components, conditional logic — is one MDX source stored in
   immutable `FormVersion` snapshots (`Form.currentVersionId` points at the live one).
   Field components carry a `name` prop (`<TextField name="title" required />`); options
   come from scope variables (`options={tracks}`); **conditional logic is plain MDX
   expressions** (`{values.format === 'workshop' && <TextField name="duration" />}`)
   evaluated by safe-mdx's safe AST interpreter (no eval, Workers-compatible). Editing
   is a Monaco editor with a starter template + live preview; saving creates a new
   version, so renaming a `name` never corrupts old responses. Server-side validation
   re-renders the response's version with the submitted values in scope, collects the
   VISIBLE fields + props, and validates — the same logic the user saw.
   **Category routing** collapsed to two columns: `Track.evaluationPlanId` (per-track
   override) and `Form.defaultEvaluationPlanId` (fallback); the track field itself
   writes `Session.trackId`.

4. **Two layers of value storage.**
   - `FormResponse` (pinned to its `FormVersion`) + `FormFieldValue` KV rows
     (`name`/`value`, multi-select = multiple rows, `subjectSpeakerId` for
     per-participant values, `fileId` for uploads) = the immutable record of what was
     submitted.
   - Well-known names are copied to typed entity columns on submit (`title` →
     `Session.title`, `track` → `Session.trackId`, `speaker.bio` → `Speaker.bio`...).
     Any other name IS the custom data — there is no field catalog and no separate
     entity field-value tables; the latest submitted response is the source of truth
     for custom fields, and admin tables derive custom columns from distinct names.

5. **Evaluation is one `Review` table** (MVP, Sessionize-style): every `EventMember`
   (ORGANIZER or REVIEWER) can review every submission — a Yes/Maybe/No `vote`, an
   optional 1–5 `rating`, and a `comment`, unique per (session, reviewer). The admin
   table sorts by vote counts and average rating; the organizer then moves submissions
   to the accept/decline queues. No plans, rounds, scorecards, pools, or assignments.

6. **Agenda = the live schedule on `Session`** (`roomId/startsAt/endsAt`), edited
   directly — no draft workspaces. Conflicts (speaker double-booked, room time overlap)
   are **computed, never stored**, by two hard-coded always-on checks; the UI warns and
   asks confirmation. `Format.defaultDurationMinutes` pre-fills `endsAt`.

7. **Portal work items**: `TaskDefinition` targets `SPEAKER` or `SUBMISSION`, source
   `MANUAL | FORM` (a file request is just a FORM task whose MDX has `<FileUpload>`).
   `TaskAssignment` is the per-speaker/per-session instance with status + snapshotted
   due date — this feeds the "outstanding onboarding tasks" dashboard directly.

8. **Emails**: templates and reminder schedules are **hard-coded in the app** (an
   `EmailKind` enum maps to React-email template functions; task reminders fire 3 days
   + 1 day before `dueAt`, draft reminders before `Form.closesAt`). Only `EmailMessage`
   persists — a transactional outbox with `dedupeKey @unique`, retry-on-same-row, and
   ICS method/sequence snapshots. `Session.icsSequence` supports `SEQUENCE` bumps.

9. **Enums over booleans and free strings everywhere** (statuses: form, submission,
   review vote, task, email; visibility; assignment mode; participant role).

## State machines

```
Submission (Session.status):

                  submitter          admin/routing            admin decision
  ┌───────┐ submit ┌─────────┐   ┌──────────────┐  accept  ┌──────────┐
  │ DRAFT │ ─────► │ PENDING │ ─►│ ACCEPT_QUEUE │ ───────► │ ACCEPTED │─► schedulable
  └───────┘        └─────────┘   └──────────────┘  (email, └──────────┘   in agenda
      │                 │  │                        notifiedAt)
      │                 │  └─────►┌───────────────┐ decline ┌──────────┐
      │                 │         │ DECLINE_QUEUE │ ──────► │ DECLINED │
      │                 │         └───────────────┘ (email) └──────────┘
      └────────────── speaker withdraws ──────────────────► WITHDRAWN

Form:  DRAFT → OPEN → CLOSED (auto at closesAt) → ARCHIVED; every save creates an
       immutable FormVersion, responses pin the version they were filled against
Task:  NOT_STARTED → IN_PROGRESS → SUBMITTED → COMPLETED (OVERDUE derived from dueAt)
Email: QUEUED → SENT | FAILED (retried on the same row, deduped by dedupeKey)

Every Session status change also appends a SessionTransition row (who/when/why)
in the same atomic batch — the full audit trail from submission to agenda.
```

## Gap-filling assumptions

- **Forms version instead of locking.** Every editor save creates an immutable
  `FormVersion`; responses pin their version, so editing the live MDX never changes the
  meaning of past submissions. Used forms get `ARCHIVED`, never deleted; historical
  references use `Restrict` so `FormResponse`/`FormFieldValue` rows stay immutable
  evidence. The MDX editor warns when a `name` prop disappears between versions.
- Conflict detection algorithm: two sessions conflict when they intersect in time AND
  share a room or share a participant. Hard-coded, always on, warnings only. Personas
  (attendee-type schedule scoring) are skipped — the brief crossed out AI review and
  doesn't need schedule scoring.
- File storage is object storage; the `File` row stores `storageKey`, never bytes. The
  event owns files; detaching (session delete, answer delete) is `SetNull` and a
  background job garbage-collects unreferenced rows + bytes.
- Decision emails: bulk "notify" action sends per-submission decision emails and stamps
  `Session.notifiedAt` **after** the message reaches `SENT` (matches the "Notified"
  column in the abstracts table).
- Submission limits: event-level default (`Event.submissionLimitPerUser`, default 3) with
  optional per-form override (`Form.submissionLimit`), counting drafts + submitted.
- `friendlyId` is allocated from the atomic `Event.nextSessionNumber` counter (never
  `SELECT max()+1`, which races under concurrent submissions).

# Design review round (oracle + Sessionize research)

An independent review pass (with sessionize.com research for implementation diversity)
drove these schema changes:

**Integrity / SQLite correctness**

- **Tenant boundaries in the database**: every event-scoped parent exposes
  `UNIQUE(id, eventId)`; cross-aggregate children (`SessionParticipant`, `RoundSession`,
  `ReviewAssignment`, `DraftPlacement`, `TaskAssignment`, `FormQuestion`…) carry a
  denormalized `eventId`/`formId`/`roundId` and use **composite FKs**, so a session can
  never reference a track, speaker, or plan from another event. Same-form composites for
  logic/answers, same-round composites for scores. Nullable refs (e.g. `Session.trackId`)
  get their composite FK in the drizzle migration (Prisma cannot mix required + optional
  relation fields); the header appendix in `schema.prisma` lists them.
- **Partial unique indexes** replace composite uniques that contain nullable columns
  (`TaskAssignment.sessionId`, `Answer.subjectSpeakerId`, `Speaker.userId`) — SQLite
  treats every NULL as distinct, so the plain uniques did not prevent duplicates.
- **CHECK constraints** (documented in the schema header) for exactly-one-reference
  tables (`AnswerOption`, `EmbedFilter`, routing match), time ranges, draft-title rule,
  and lifecycle enum values (drizzle text enums are TypeScript-only).
- `AnswerOption.libraryRefId` (unchecked string) replaced with **typed FKs** per library
  dimension; logic conditions and routing rules gained typed track/format/tag refs.
- BetterAuth tables are marked **generated** (`@better-auth/cli generate` is the source);
  added `AuthAccount UNIQUE(providerId, accountId)`.

**Model corrections**

- Speaker confirmation moved to `SessionParticipant` (a speaker can confirm talk A and
  decline talk B); event-level status is derived.
- One submitter source of truth: `Session.submitterSpeakerId` (removed the duplicate
  `Session.submitterId` User ref and `SessionParticipant.isSubmitter`).
- `Session.title` nullable for autosaved drafts (+ CHECK for non-drafts);
  `Session.coverImageFileId` for the portal-editable cover image;
  `Session.evaluationPlanId` records plan membership set by routing.
- `SessionTransition` append-only audit log for every stage/status change; round
  outcomes and COI declarations also carry audit fields.
- `EvaluationRoundReviewer` per-round reviewer pools; scorecards support `FILE` uploads.
- `TaskAssignment.dueAt` snapshots the deadline at assignment time.
- `Form.slug` unique per event (`/submit/{event}/cfp` everywhere), `EventMember` allows
  multiple roles per user, ~25 missing FK/query indexes added.
- Emails became a real **transactional outbox**: `dedupeKey @unique` (two cron workers
  cannot double-send), retry on the same row, provenance links, `IcsMethod`
  REQUEST/CANCEL + per-message `icsSequence`, `SCHEDULE_CANCEL` template, stable derived
  calendar UID.

**Sessionize-inspired product improvements**

- `Format.defaultDurationMinutes` — the agenda builder pre-fills `endsAt`.
- `ScheduleSlot` — reusable "day + time block" grid the organizer places sessions into
  (the customer wants "choose a day and spot"); workshops can still use free timestamps.
- `SessionKind: CONTENT | SERVICE` — breaks/lunch/registration live in the same grid
  without speakers or CFP baggage.
- `SpeakerAvailability` windows feed conflict detection.
- Evaluation presets (Quick vote Yes/Maybe/No, Stars, Weighted rubric) are documented as
  product presets over the existing scorecard primitives — no new tables.
- Public JSON + ICS feeds (`/public/events/{slug}/schedule.json|.ics`) will be the data
  source the embed widgets consume (application-level, no schema change).

**Dropped**: `ConflictWaiver` (wrong cardinality for unary/multi-session conflicts;
replaced by always-visible computed conflicts + explicit commit confirmation) and the
`FORM_CLOSING` reminder trigger (undefined recipient set).

# Alignment with the akarso project

This product is built on the **akarso** codebase (`~/.kimaki/projects/akarso`,
`db/src/schema.ts` — BetterAuth on Cloudflare D1 via drizzle), so shared concepts are
shaped IDENTICALLY for direct code porting:

| akarso table | Ported shape | Notes |
|---|---|---|
| `user` / `session` / `account` / `verification` | BetterAuth core, same physical table names (`@@map`) | plugins here: magic-link; akarso's `deviceCode`/mcp/`apikey` tables not ported |
| `org` | `orgId` PK, `ownerUserId` FK, `kind: personal \| team`, nullable `name` | billing (`stripeCustomerId`, `subscription`) omitted — payments out of scope |
| `org_member` | ULID `memberId` PK, unique `(orgId, userId)`, `role: admin \| member` (lowercase) | idempotent invite acceptance via `onConflictDoNothing` |
| `org_invitation` | secret-link invites: `invitationId`, `role`, `createdBy`, `expiresAt` | no email column, no status column — valid until expiry |

Conventions inherited from akarso: **ULID ids** (`$defaultFn(() => ulid())` — the
Prisma `cuid()` defaults are stand-ins), **epochMs timestamps** (epoch-ms integers whose
`toDriver` accepts Date — required for BetterAuth on D1), lowercase text enum values for
the org layer, and the **personal-org invariant**: every user gets exactly one
auto-created `personal` org, race-safe via the partial unique index
`org(owner_user_id) WHERE kind = 'personal'`; the owner can never leave it, so a
deterministic default org always exists. Team orgs are explicit.

Naming consequence: BetterAuth owns the physical `session` table, so the domain session
entity maps to the **`event_session`** table (Prisma model stays `Session`).
`Event.orgId` → `Org.orgId` hangs events off the org the way akarso hangs profiles.

# MDX forms simplification (round 3)

The normalized form builder (14 models + 9 enums: FieldDefinition, FieldOption,
FormSection, FormQuestion, FormParticipantRole, FormLogicRule/Condition,
FormRoutingRule, FormValidationRule(+Question), Answer, AnswerOption,
Session/SpeakerFieldValue(+Options)) was replaced by **MDX forms** rendered with
[safe-mdx](https://github.com/remorses/safe-mdx):

- The whole form is ONE MDX source per immutable `FormVersion`; conditional logic is
  MDX expressions with `{ values, tracks, formats, ... }` in scope (safe AST
  interpreter — no eval, works on Cloudflare Workers).
- Submitted data = `FormFieldValue` KV rows keyed by the component's `name` prop;
  well-known names copy to typed entity columns, everything else IS the custom data.
- Editing = Monaco with a starter template + live preview; server-side validation
  re-renders the pinned version with submitted values in scope and validates the
  visible fields.
- Routing = `Track.evaluationPlanId` override + `Form.defaultEvaluationPlanId`
  fallback (two columns instead of a rules engine).
- Enum sweep in the same pass: `Event.eventType` (EventType), `Session.visibility`
  (replaces isPublic), `RuleStatus` for scheduling/reminder rules (replaces enabled
  booleans), `TaskDefinition.assignmentMode` (replaces autoAssignOnAccept),
  `Form.draftPolicy` + `Form.afterSubmit` (replace the two form booleans).

Net: schema went from ~55 to ~40 models; the riskiest relational machinery (logic
rules, option references, question bindings) no longer exists.

# MVP cut (round 4)

Aggressive simplification for the MVP: **48 → 25 models**. Everything cut can come back
later; nothing cut loses data that the MVP workflows need.

| Cut | Replaced by |
|---|---|
| `Level`, `Language`, `Tag` + `SessionTag` | custom MDX fields (`FormFieldValue` KV) if an event wants them; `Track` + `Format` remain the agenda dimensions |
| `ParticipantRole` table | fixed `CoreRole` enum (`SPEAKER \| MODERATOR`) on `SessionParticipant` |
| `ScheduleSlot` | free `startsAt/endsAt` + `Format.defaultDurationMinutes` pre-fill |
| `SpeakerAvailability` | cut; conflict checks cover speaker/room overlap |
| `EvaluationPlan/Round/RoundReviewer/RoundSession/ScorecardField(+Option)/ReviewAssignment/ReviewScore` (8 models) | one `Review` table: Yes/Maybe/No vote + optional 1–5 rating + comment, unique per (session, reviewer); every EventMember reviews |
| `AgendaDraft`, `DraftPlacement`, `Event.scheduleRevision` | direct editing of the live schedule with computed conflict warnings |
| `SchedulingRule` | two hard-coded always-on checks (speaker overlap, room overlap) |
| `FileRequest` | FORM tasks whose MDX contains `<FileUpload>` |
| `EmailTemplate`, `ReminderRule` | hard-coded React-email templates keyed by `EmailKind` + fixed reminder offsets (3d + 1d before dueAt/closesAt); `EmailMessage` outbox stays |
| `Embed`, `EmbedFilter` | public routes `/embed/{slug}/agenda`, `/embed/{slug}/speakers`, `/public/{slug}/schedule.json\|.ics` with query-param config |
| `FormNotificationRecipient` | hard-coded: notify all event ORGANIZERs on new submission |
| `Session.stage` (ABSTRACT/SESSION) | derivable from status: ACCEPTED = agenda item |
| Field trims | Event: eventType, background image. Session: clientSessionId, capacity, ceuCredits. Speaker: salutation, honorific, gender, phone, facebookUrl. Form: per-form submissionLimit, draftPolicy, afterSubmit (hard-coded behavior) |

What deliberately STAYS despite MVP pressure: `FormVersion` (immutable response
evidence), `SessionTransition` (audit), `EmailMessage.dedupeKey` outbox (no double
sends), composite tenant-boundary FKs, partial unique indexes, ICS sequence handling —
these prevent corruption, not features.
