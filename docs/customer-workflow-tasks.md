---
title: Customer workflow implementation tasks
description: >
  Large sequential tasks that complete customer workflows by reusing the existing
  OpenSession schema before adding new models.
---

# Customer workflow tasks

This plan has **seven large vertical tasks**. Each task should use most of one agent
context window while leaving enough space for tests, browser validation, debugging, and
diff review.

The source evaluation suite is https://forge.smol.ai/swyx/killmysaas-evals. Read the
matching specification, fixture data, and rubric before each task.

## Reuse-first schema rule

OpenSession already has the main workflow owners:

| Existing model | Continue using it for |
| --- | --- |
| `user` | One global BetterAuth identity |
| `orgMember` | Organizer access |
| `orgInvitation` | Secret invitation links and acceptance flow |
| `speaker` | Event-specific speaker profile and optional user link |
| `sessionParticipant` | Speaker or moderator participation and confirmation |
| `form`, `formVersion` | CFP, portal forms, and evaluation scorecard definitions |
| `formResponse`, `formFieldValue` | Submitted answers, custom data, and uploaded files |
| `review` | Review assignment and completion record |
| `taskDefinition`, `taskAssignment` | Onboarding requests and per-speaker progress |
| `file` | Immutable R2 object metadata and upload version order |
| `emailMessage` | Outbox, rendered message snapshot, retry, and history |
| `eventSession.status` | Submission decision lifecycle |
| `eventSession.visibility` | Content approval and public eligibility |
| `event.status` | Existing event and CFP lifecycle |

Do not add a table for a filter, computed status, current version, aggregate, embed
configuration, personal schedule, or generated ZIP. Derive those values from existing
rows or keep browser-only state in localStorage.

## New tables allowed by this plan

The required workflows need only these new tables:

1. `evaluation_reviewer`, because a user can review one evaluation form without joining
   the org.
2. `task_comment`, because no current model owns a persistent speaker-organizer thread.
3. `session_revision`, because immutable session edit history cannot be reconstructed
   from the mutable `eventSession` row.

The optional CRM task may add five CRM-owned tables. Do not create them before the
required workflows pass.

The required workflows extend existing tables with a small number of columns:

| Existing table | Extension |
| --- | --- |
| `orgInvitation` | purpose, invited email, optional evaluation form |
| `form` | EVALUATION purpose, opensAt, blind |
| `formResponse` | nullable speaker owner, optional review owner |
| `review` | evaluation form, recusal timestamp and reason |
| `speaker` | editable roster status |
| `taskDefinition` | SELECTED or ALL_ACCEPTED assignment policy |
| `file` | optional task assignment and field name for version grouping |
| `emailMessage` | new kinds and optional batch ID |
| `event` | nullable program publication timestamp |

## Task execution prompt

> Read `AGENTS.md` and the named task in `docs/customer-workflow-tasks.md`. Load all
> mandatory skills. Read the matching Kill My SaaS specification and fixture data.
> Inspect the current implementation, dependencies, and dependents. Reuse existing
> schema models first. Implement the complete vertical workflow. Add only meaningful
> tests. Run the validation gate and the real Playwriter journey. Review the final diff,
> then commit only this task's changes with a detailed message and the current session ID
> as the final line. Return the commit hash, test results, browser evidence, rubric IDs,
> edited files, and a critique diff URL for the commit.

# Validation strategy

## Pure Vitest

Use `website/vitest.config.ts` for authorization decisions, projections, assignment
planning, weighted review aggregation, CSV parsing, file version selection, agenda
placement, merge fields, and CRM merge planning. Prefer inline snapshots.

## Spiceflow inside workerd

Use real D1 migrations and Miniflare bindings with
`@cloudflare/vitest-pool-workers`. Call the real Spiceflow app with
`createSpiceflowFetch(app)` or `app.handle()`.

Test route authorization, D1 constraints, grouped writes, loader results, R2 behavior,
and anonymous feeds. Do not mock D1, R2, BetterAuth, email, or application modules.
Google OAuth remains a Playwriter test.

## Playwriter

Run the dev server through `kimaki tunnel`. Use `http://localhost:8788` for Playwriter
and share the tunnel URL with the user. For each action, print the URL, a fresh snapshot,
and `getLatestLogs({ sinceLastCall: true })`. Capture final rubric screenshots.

## Completion gate

1. Typecheck `db/` when schema changed.
2. Typecheck `website/`.
3. Run pure Vitest.
4. Run workerd tests for D1, R2, route, or action changes.
5. Run `lintcn lint` in each edited package.
6. Complete the Playwriter journey.
7. Follow the matching evaluation scenario and record rubric IDs.
8. Produce a filtered critique diff.

# Task 1: Cloudflare test foundation

**Goal:** Add one real integration-test path before more stateful workflows are built.

## Changes

- Add `@cloudflare/vitest-pool-workers` to `website`.
- Keep the existing pure-test configuration fast and separate.
- Load `wrangler.jsonc`, nested D1 migrations, and a test-only `TEST_MIGRATIONS` binding.
- Apply migrations in workerd setup without editing generated Wrangler types.
- Prove through the real app that D1 fixture rows reach a route, R2 stores and returns an
  object, anonymous rendering works, and test files have isolated storage.

## Review boundary

Testing infrastructure only. No product schema or behavior.

# Task 2: Complete abstract evaluation

**Goal:** Add restricted reviewers, rounds, assignments, configurable scorecards, review
completion, progress, reminders, and results by extending existing models.

## Reuse

- Generalize `orgInvitation` instead of adding another invitation table:
  - add invitation purpose `ORG_MEMBER | EVALUATION_REVIEWER`
  - add nullable evaluation `formId` and `invitedEmail`
  - keep the existing secret-link page and acceptance action
  - org invitations still create `orgMember`; reviewer invitations create
    `evaluationReviewer`
- Use `form` itself as the evaluation round and `formVersion` as its scorecard definition.
  Add form purpose `EVALUATION` plus nullable `opensAt` and `blind` settings. Existing
  `name`, `status`, `closesAt`, `createdAt`, and versions already provide the rest of the
  round lifecycle. NUMBER, SELECT, and TEXT are form field components, not scorecard
  tables.
- Use `formResponse` and `formFieldValue` for review answers. Make `speakerId` nullable,
  add nullable unique `reviewId`, and enforce that a response belongs to either a speaker
  workflow or a review.
- Convert `review` into the assignment row. Keep its event, session, and reviewer links;
  add evaluation `formId` and nullable `recusedAt` and `recusalReason`. Remove the fixed
  vote, rating, and comment columns.
- Derive review state instead of storing it: no response is ASSIGNED, a DRAFT response is
  IN_PROGRESS, a SUBMITTED response is COMPLETED, and `recusedAt` is RECUSED. Do not add
  review status or completion columns that can disagree with `formResponse`.
- Use existing `emailMessage` for reviewer invitations, reminders, and history by adding
  email kinds and dedupe-key builders.

## New table

### `evaluation_reviewer`

Needed because a BetterAuth user can belong to one evaluation form without becoming an
organization member. This row is both the reviewer pool and authorization relation.

No `evaluation_round`, `event_user_role`, `event_invitation`, `scorecard_field`,
`scorecard_option`, `round_reviewer`, `review_assignment`, or `review_value` table is
needed.

## Workflow

- Organizer creates EVALUATION forms and edits their scorecards with the existing form
  engine. The UI calls them rounds.
- Organizer invites users into an evaluation form and assigns sessions by creating
  `review` rows.
- Reviewer shell loads only their `evaluationReviewer` rounds and assigned `review` rows.
- Blind projection removes speaker identity before serialization.
- Review form saves through existing response and field-value persistence.
- Organizer sees progress, coverage, weighted results, sorting, reminders, and CSV.
- Old quick-review code is removed rather than supported in parallel.

## Validation

- Pure: invitation decisions, blind projection, scorecard validation, weighted results,
  progress, and result ordering.
- Workerd: existing org invites still work; reviewer invite email and expiry checks;
  assignment isolation; review save/update/recusal; progress; export; email dedupe.
- Playwriter: create two rounds, invite Sam, assign two of three submissions, sign in as
  Sam, prove the third is inaccessible, complete reviews, and inspect organizer results.

**Evaluation:** `CFP-10`, `CFP-11`, and `ABS-01` through `ABS-14`.

# Task 3: Speaker operations, tasks, and communications

**Goal:** Complete organizer speaker operations from import through portal tasks and
message history without adding speaker, assignment-mode, template, or broadcast tables.

## Reuse

- Use `speaker` as the roster row. Keep `userId` nullable.
- Add `speaker.status`: PENDING, INVITED, CONFIRMED, or DECLINED. This is the organizer's
  event roster workflow and is independently editable and filterable. Keep
  `sessionParticipant.confirmationStatus` for per-session confirmation.
- Use `sessionParticipant` for speaker/moderator assignment, order, and confirmation.
- Use existing `taskDefinition` and `taskAssignment`. Add only
  `taskDefinition.assignmentPolicy`: SELECTED or ALL_ACCEPTED. SELECTED creates only the
  chosen assignments; ALL_ACCEPTED backfills current accepted speakers and auto-assigns
  future accepted speakers. This prevents a selected task from silently reaching future
  unrelated speakers.
- Use `form` tasks for profile and file requests.
- Use `emailMessage` directly for custom speaker messages. Add `CUSTOM` and
  `SPEAKER_INVITE` kinds plus an optional `batchId` for grouped history. Do not add
  template or broadcast tables.

## Workflow

- Replace the Speakers placeholder with searchable roster and detail pages.
- Add manual create/edit, portal invite, profile, sessions, tasks, files, and message
  history.
- Add CSV mapping, validation preview, event-email dedupe, and result summary.
- Add participant attach/create/detach/reorder/role/confirmation controls.
- Add task assignee selection, immediate assignment creation, task matrix, due-date
  override, filters, and bulk reminders.
- Add selected-recipient message composition, explicit merge fields, preview, send, and
  grouped outbox history.

## Validation

- Pure: real fixture CSV, assignment plans, merge fields, and speaker status transitions.
- Workerd: event isolation, import idempotency, participant changes, immediate and future
  assignments, email grouping, and dedupe.
- Run a real skipped-otherwise email test when Cloudflare Email credentials are present.
- Playwriter: import speakers, edit one, assign sessions, create three tasks for two
  accepted speakers, complete portal tasks, send a message, and verify progress/history.

**Evaluation:** `SPK-01` through `SPK-16`, plus task-related `CNT` items.

# Task 4: Deliverables and approved content

**Goal:** Complete file versions, comments, organizer file operations, session history,
and content approval with only two new tables.

## Reuse

- Use `formResponse` as the logical task submission.
- Add nullable `file.taskAssignmentId` and `file.fieldName` so an upload is attached to
  its logical task slot as soon as R2 accepts it, before final form submission. All files
  for the same assignment and field are versions.
- Use `file.createdAt` to order immutable R2 versions. The newest slot file is current;
  no current-version column is needed. `formFieldValue.fileId` continues to identify the
  version selected when the form response is submitted.
- Use `taskAssignment.status` for requested, in-progress, and completed state.
- Query the Files page through file → field value → response → task assignment.
- Use `eventSession.visibility`: PRIVATE means not approved for public output, PUBLIC
  means approved. Do not add `contentStatus`.
- Generate ZIP output dynamically from selected latest file values.

## New tables

### `task_comment`

Stores a persistent thread on `(taskAssignmentId, fieldName)` with `authorUserId`, body,
and timestamp. The field name is required because one task form can request several
files. No current table owns comments between speakers and organizers.

### `session_revision`

Stores immutable typed title, description, track, format, and cover-image snapshots with
editor, timestamp, and optional restored-from revision. The mutable session row cannot
provide history after an edit.

No deliverable, deliverable-version, deliverable-comment, or content-status table is
needed.

## Workflow

- Keep each re-upload and expose ordered versions and current version.
- Add task comments visible to authorized speaker and organizer.
- Replace Files placeholder with filters, incomplete view, bulk reminders, and current
  version ZIP.
- Add organizer session editor, history, restore, and Approve for public action, which
  sets visibility PUBLIC.
- Centralize the public-eligibility predicate.

## Validation

- Pure: latest file value, public eligibility, and ZIP selection.
- Workerd with real D1/R2: two versions remain downloadable; comments are role-safe;
  Files queries and ZIP are tenant-safe; revisions restore; visibility gates output.
- Playwriter: upload twice, comment from both roles, filter Files, download ZIP, edit
  twice, restore an older revision, and approve content.

**Evaluation:** `CNT-03` through `CNT-17`.

# Task 5: Agenda publication and public program

**Goal:** Complete automatic scheduling, publication, anonymous pages, feeds, personal
schedules, and embeds without new tables.

## Reuse

- Keep `event.status` for the existing event and CFP lifecycle. Add one nullable
  `event.programPublishedAt` column because an ACTIVE event can collect CFP submissions
  before its program is public. This is publication state, not a new table.
- Use `eventSession.visibility` as the content approval gate.
- Use existing room, time, participant, track, and format rows for scheduling.
- Compute automatic placement with existing conflict helpers. Do not store plans.
- Generate JSON and ICS from current rows. Do not store feed snapshots.
- Encode embed configuration in validated query parameters. Do not add an embed table.
- Store personal schedules in localStorage. Do not add attendee tables.

## Workflow

- Add deterministic automatic placement preview/apply and show unplaced sessions.
- Add Publish and Unpublish actions by setting or clearing `event.programPublishedAt`.
- Add one shared anonymous projection for ACTIVE events with a published program and
  ACCEPTED, PUBLIC, scheduled sessions.
- Add session JSON, speaker JSON, and schedule ICS feeds.
- Add public Sessions, Speakers, Agenda, Itinerary, and Gallery surfaces.
- Add search, filters, details, day navigation, fallback photos, personal schedule, and
  personal ICS export.
- Add organizer embed builder, generated iframe URLs, snippets, feed links, and previews.

## Validation

- Pure: placement, no-solution behavior, projection, and cross-feed consistency.
- Workerd: apply placement; publish/unpublish; anonymous feeds; private-row exclusion;
  iframe query validation and headers.
- Playwriter: run all AIA and EMB scenarios, including logged-out browsing, personal
  schedule persistence, ICS export, and a cross-origin iframe.

**Evaluation:** `AIA-01` through `AIA-08` and `EMB-01` through `EMB-16`.

# Task 6: Optional organization speaker CRM

**Goal:** Add the optional CRM only after every required workflow passes.

The current schema deliberately excludes CRM. Cross-event canonical contacts, persistent
contact notes, tags, saved segments, and stage history have no existing owner. These five
tables are justified only for this optional workflow:

1. `org_contact`: canonical reusable profile; event `speaker` rows link through
   nullable `contactId`.
2. `contact_tag`: organization tag catalog.
3. `contact_tag_link`: many-to-many contact tags.
4. `contact_segment`: named filter with explicit nullable company, title, and tag
   criteria; no opaque JSON criteria.
5. `contact_activity`: notes, pipeline transitions, and outreach activity.

Keep one fixed organization pipeline in application code. Store current stage, score, and
rationale on `org_contact`; use `contactActivity` for timestamped transitions. Do not add
pipeline, stage, card, pipeline-note, segment-membership, campaign, or analytics tables.

## Workflow

- Migrate event speakers into contacts by normalized organization email.
- Add directory, profile, search, filters, CSV import, notes, tags, and connection history.
- Add dynamic saved segments from explicit supported criteria.
- Add duplicate preview and merge that reassigns speaker, tag, activity, and email links.
- Add fixed-stage sourcing board, transition history, score, rationale, and notes.
- Add contact to event, selected-contact outreach through `emailMessage`, and derived
  dashboard metrics.

## Validation

- Pure: import, segment matching, merge planning, and metrics.
- Workerd: migration/dedupe, org isolation, add-to-event, segments, merge integrity,
  transitions, notes, outreach, and metrics.
- Playwriter: run CRM-S1 and CRM-S2 completely.

**Evaluation:** `CRM-01` through `CRM-12`.

# Task 7: Full acceptance and focused fixes

Run the complete evaluation against preview in stateful order. Record every rubric result,
screenshot, route, worker log, and blocker. Do not accumulate unrelated fixes. Create one
focused fix task for each evidenced defect, validate its diff, then resume acceptance.

The final report must show required and optional scores separately and link all browser
evidence and fix diffs.
