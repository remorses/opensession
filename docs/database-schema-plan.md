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

3. **Forms are fully normalized, no JSON.**
   - `FieldDefinition` is an event-level field library (system + custom fields targeting
     `SUBMISSION` or `SPEAKER`). Form questions **bind** to field definitions (exactly
     what the app does — the "+ Add Field" picker lists submission fields).
   - Dropdown options either come from a typed source (`optionSource: TRACKS | FORMATS |
     LEVELS | LANGUAGES | TAGS`) or from `FieldOption` rows (`CUSTOM`). This is how
     "Track" questions route into agenda tracks with zero duplication.
   - **Conditional logic**: `FormLogicRule` (target question, action `SHOW/HIDE/REQUIRE`,
     match ALL/ANY) + `FormLogicCondition` rows (source question, operator, compared
     value/option). Pure relational, evaluable client-side and server-side.
   - **Category routing**: `FormRoutingRule` — when a given option is selected on a given
     question, auto-assign track and/or evaluation plan to the created submission.
   - Cross-field combined character limits: `FormValidationRule` + join to questions.

4. **Two layers of answer storage.**
   - `FormResponse` + `Answer` (+ `AnswerOption` for selects) = the immutable record of
     what was submitted through which form. `Answer.subjectSpeakerId` distinguishes
     per-participant answers on multi-speaker submissions.
   - Canonical current values live on the entities: typed columns on `Session`/`Speaker`
     for system fields, `SessionFieldValue`/`SpeakerFieldValue` for custom fields.
     On submit, answers are copied to entity values; admins and portal edits then mutate
     entity values directly. This matches the app (Add Abstract drawer edits entity
     fields with no form).

5. **Evaluation is round-based** (matches "Evaluation 2.0"): `EvaluationPlan` →
   `EvaluationRound` (open/close dates, anonymization) → `ScorecardField` (rating with
   min/max/weight, text, dropdown, yes/no) → `ReviewAssignment` (reviewer × submission ×
   round, with COI status) → `ReviewScore` per scorecard field. `RoundSession` tracks
   which submissions advance between rounds.

6. **Agenda = live schedule on `Session` + draft workspaces.** `Session.roomId/
   scheduleSlotId/startsAt/endsAt` is the live schedule. `AgendaDraft` + `DraftPlacement`
   stage changes; commit copies placements onto sessions (exactly the public API model).
   Commits are guarded by **optimistic concurrency**: `Event.scheduleRevision` vs
   `AgendaDraft.baseScheduleRevision` — a stale draft must rebase, so two drafts can
   never silently overwrite each other. Conflicts (speaker double-booked, room overlap,
   speaker unavailable, rule violations) are **computed, never stored**; committing with
   open conflicts requires explicit confirmation (no waiver table — it cannot represent
   unary or multi-session conflicts correctly). `SchedulingRule` is a typed enum + scoped
   int value instead of SessionBoard's opaque JSON config.

7. **Portal work items**: `TaskDefinition` targets `SPEAKER` or `SUBMISSION` and can wrap
   a portal `Form` or a `FileRequest` (source enum `MANUAL | FORM | FILE_REQUEST`).
   `TaskAssignment` is the per-speaker/per-session instance with status + due date —
   this feeds the "outstanding onboarding tasks" dashboard directly.

8. **Emails**: `EmailTemplate` keyed by purpose enum (confirmation, decision accepted/
   declined, task reminder, draft reminder, schedule/ICS invite), `ReminderRule`
   (trigger + days offset), `EmailMessage` send log with status and entity links.
   `Session.icsSequence` supports ICS `SEQUENCE` bumps when a scheduled session moves.

9. **Enums over booleans everywhere** (statuses: form, submission, round, assignment,
   task, email, embed...). The few remaining booleans are true binary configuration
   toggles (e.g. `collectParticipants`).

## State machines

```
Submission (Session.status):

                  submitter          admin/routing            admin decision
  ┌───────┐ submit ┌─────────┐   ┌──────────────┐  accept  ┌──────────┐
  │ DRAFT │ ─────► │ PENDING │ ─►│ ACCEPT_QUEUE │ ───────► │ ACCEPTED │─► stage=SESSION
  └───────┘        └─────────┘   └──────────────┘  (email, └──────────┘   → schedulable
      │                 │  │                        notifiedAt)
      │                 │  └─────►┌───────────────┐ decline ┌──────────┐
      │                 │         │ DECLINE_QUEUE │ ──────► │ DECLINED │
      │                 │         └───────────────┘ (email) └──────────┘
      └────────────── speaker withdraws ──────────────────► WITHDRAWN

Form:        DRAFT → OPEN → CLOSED (auto at closesAt) → ARCHIVED; structure locks at
             first submitted response (clone to change)
AgendaDraft: OPEN → COMMITTED (placements copied to sessions, scheduleRevision bumped)
             | DISCARDED; stale baseScheduleRevision blocks commit until rebase
Round:       PENDING → OPEN → CLOSED; RoundSession outcome PENDING → ADVANCED | REJECTED
Assignment:  PENDING → IN_PROGRESS → COMPLETED (or DECLINED / CONFLICT_OF_INTEREST)
Task:        NOT_STARTED → IN_PROGRESS → SUBMITTED → COMPLETED (OVERDUE derived from dueAt)
Email:       QUEUED → SENT | FAILED (retried on the same row, deduped by dedupeKey)

Every Session stage/status change also appends a SessionTransition row (who/when/why)
in the same atomic batch — the full audit trail from submission to agenda.
```

## Gap-filling assumptions

- **Forms lock instead of versioning.** Once a form has its first submitted response, its
  structure (sections, questions, options) is locked; organizers clone the form to make a
  new version, and used forms/fields/options get `ARCHIVED`, never deleted. Historical
  references use `Restrict` so `FormResponse`/`Answer` rows stay immutable evidence.
- Conflict detection algorithm: overlap when two placements intersect in time AND share a
  room, or share a participant, or hit a `SpeakerAvailability` block, or violate an
  enabled `SchedulingRule`. Personas (attendee-type schedule scoring) are skipped — the
  brief crossed out AI review and doesn't need schedule scoring.
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
