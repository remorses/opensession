---
title: OpenSession user wants and flow
description: >
  What AI Engineer / Sessionboard buyers need, the real organizer to speaker to
  agenda usage flow, and how OpenSession maps to those demands today.
---

# OpenSession user wants and flow

## Gist

- The customer is a **tech conference organizer** (specifically the AI Engineer / AIE team) running high-profile industry events like the AI Engineer World's Fair or AI Engineer NYC.
- They currently pay closed-source platforms like SessionBoard over **$40,000 per year** to handle abstract submissions, speaker portal tasks, evaluations, and agenda scheduling.
- They want an **open-source alternative** to take complete control of their event data, eliminate massive SaaS licensing costs, and operate with zero performance lag.
- They only need the **Program** module (submissions, reviews, schedule, portal); other suite modules like CRM, CMS websites, payment processors, and marketing pages are ignored.

## Who uses it

The platform serves three distinct user populations, each interacting with a separate slice of the event lifecycle:

1. **Organizer / Admin**: The power user. They set up the event parameters (dates, rooms, tracks, formats), build the CFP and portal forms, review incoming abstract proposals, manage acceptance and rejection queues, schedule slots on the agenda grid, and track speaker onboarding tasks.
2. **Reviewer / Committee Member**: Evaluators invited by organizers to score abstracts. They have restricted access to browse pending submissions, cast Yes/Maybe/No votes, leave comments, and rate talks without administrative control over event settings.
3. **Speaker / Submitter**: Potential presenters who submit talk abstracts via the public CFP. If accepted, they gain access to a personal, self-service portal to confirm their talks and complete onboarding tasks like uploading headshots, profiles, and slides.

## What they want (from the video + brief)

Based on the walkthrough video by swyx and the official competition brief, the team's needs are highly specific. The platform must offer the core mechanics of SessionBoard but stripped of enterprise bloat.

### 1. Custom Call-for-Speakers (CFP) Forms
- **Status**: **Must**
- **Details**: Organizers need to create custom forms with **conditional logic** to toggle questions dynamically, plus **category-based routing** to map submissions to tracks.
- **Walkthrough Context**: Swyx emphasized a robust, fast form builder where organizers toggle default fields (Title, Description, Track, Format) and configure speaker count limits.

### 2. Self-Service Speaker Portal
- **Status**: **Must**
- **Details**: A secure portal where speakers manage their personal profile, submit bios, upload square headshots, and upload final presentation slide files.
- **Walkthrough Context**: Swyx notes the speaker portal is an important milestone to ensure speakers submit materials on time, showing clear task progress.

### 3. Automated Onboarding Tasks
- **Status**: **Must**
- **Details**: On accepting an abstract, the system must automatically create outstanding tasks (e.g. "Complete Speaker Profile", "Upload Slides") for the speakers to fill out.
- **Walkthrough Context**: The video showed a clear list of pending tasks on the speaker's home page, which is essential to keep organizers from manually chasing speakers.

### 4. Templated Email & Calendar Communications
- **Status**: **Must**
- **Details**: The system must send automated reminders for approaching deadlines, draft submissions, and outstanding tasks, plus actual **calendar invites (ICS files)** on acceptance.
- **Walkthrough Context**: Swyx noted that email notifications must flow cleanly on key triggers (submit, accept, decline, reminders) so organizers do not rely on third-party mail clients.

### 5. Evaluation & Peer Review Workflows
- **Status**: **Must**
- **Details**: Reviewers need to browse abstracts and log scores. Swyx struck out multi-round AI scorecards in favor of simple, collaborative organizer evaluations.
- **Walkthrough Context**: The video demonstrated evaluation lists with quick scores, which are sufficient to build the collaborative shortlist.

### 6. Agenda Grid & Schedule Builder
- **Status**: **Must**
- **Details**: A calendar grid of rooms and times to schedule sessions. It must feature **automatic conflict detection** to flag room overlaps or speaker double-bookings.
- **Walkthrough Context**: Swyx showed placing accepted talks into rooms and times. It must warn organizers of overlapping conflicts but never block them.

### 7. Real-Time Onboarding Dashboard
- **Status**: **Must**
- **Details**: Organizers need quick metrics showing total submissions, accepted speakers, pending reviews, and an overview of outstanding speaker onboarding tasks.
- **Walkthrough Context**: Shown in Part 1 and 2 of the video, a high-level overview of event readiness is critical for weekly syncs.

### 8. Public Schedule Embeds & Feeds
- **Status**: **Nice**
- **Details**: The brief originally crossed out embeds, but in Part 2 of the video swyx walked through the CMS embeds page and stated, "it is very standard and we need this."
- **Walkthrough Context**: The system should generate embeddable iframe schedule widgets and expose public schedule feeds (JSON and ICS) for external marketing websites.

### 9. No Complex Rubric Scorecards
- **Status**: **Won't**
- **Details**: Schedulers do not need complex, multi-criteria rubrics. A simple collaborative score (votes/comments) is preferred.

### 10. No Payment Processing
- **Status**: **Won't**
- **Details**: Swyx explicitly stated in Part 2 of the video that organizers "do not care about payment" on forms, allowing this system complexity to be skipped entirely.

---

## End-to-end user flow

This diagram maps out the complete lifecycle of a conference program within OpenSession. The flow begins with organizer configuration and concludes with the public schedule embed.

```
  ┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
  │ 1. Event Setup  │ ─────►│ 2. Library/Tz   │ ─────►│ 3. Build CFP    │ ─────►│ 4. Speaker CFP  │
  └─────────────────┘       └─────────────────┘       └─────────────────┘       └─────────────────┘
                                                                                         │
                                                                                         ▼
  ┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
  │ 8. Task Onboard │◄──────│ 7. Email + ICS  │◄──────│ 6. Agenda Grid  │◄──────│ 5. Review & Acc │
  └─────────────────┘       └─────────────────┘       └─────────────────┘       └─────────────────┘
```

### Stage 1: Create Org & Event
- **Actor**: Organizer (Admin)
- **Goal**: Create the tenant workspace and initial event record.
- **Steps in product**:
  1. Organizer logs in with verified email credentials or Google.
  2. Navigate to `/org/:orgId` (an organization is auto-created on first login).
  3. Click "Create Event" and fill in event name, slug, timezone, startsAt, and endsAt.
- **Data created**: `event` row, `form` definition rows (default CFP, Profile, Materials), and initial `formVersion` MDX templates.
- **Success criteria**: Redirects to `/org/:orgId/e/:eventId`, displaying an empty event dashboard.

### Stage 2: Configure Library Settings
- **Actor**: Organizer (Admin)
- **Goal**: Establish the dimensions that structure the program and schedule.
- **Steps in product**:
  1. Navigate to `/org/:orgId/e/:eventId/settings`.
  2. Under "Tracks", add conference tracks with names and colors (e.g. "Generative AI", "AI UX").
  3. Under "Formats", define formats and durations (e.g. "Keynote" - 45m, "Lightning Talk" - 15m).
  4. Under "Rooms", create physical rooms with order indexes (e.g. "Main Hall", "Room B").
- **Data created**: `track`, `format`, and `room` rows bound to the `eventId`.
- **Success criteria**: Library settings list all custom entries with color and ordering properties.

### Stage 3: Customize & Publish CFP Form
- **Actor**: Organizer (Admin)
- **Goal**: Design the custom submission fields and open the Call for Papers.
- **Steps in product**:
  1. Navigate to `/org/:orgId/e/:eventId/forms`.
  2. Select the default Call for Papers form to open the Monaco MDX editor at `/forms/:formId`.
  3. Edit the Safe-MDX template to write custom welcome copy, add text fields, select dropdowns linked to tracks/formats, and specify co-speaker participant limits under `<Participants>`.
  4. Toggle the form status to `OPEN` in the settings dialog.
- **Data created**: A new immutable `formVersion` row pinning the updated safe-mdx layout, and updates the `form.status` to `OPEN`.
- **Success criteria**: The public Call for Papers URL `/submit/:eventSlug/:formSlug` becomes active.

### Stage 4: Public Speakers Submit Abstract
- **Actor**: Speaker (Submitter)
- **Goal**: Submit a talk proposal and capture co-speaker information.
- **Steps in product**:
  1. Speaker opens `/submit/:eventSlug/:formSlug`.
  2. Renders welcome copy; click Continue to sign in with email or Google.
  3. Enter session details (Title, Description, Track, Format). The form automatically autosaves draft entries in the background.
  4. If required, add co-speakers by entering their emails and bios in the `<Participants>` list.
  5. Review all details on the confirmation page and click Submit.
- **Data created**: `formResponse` (status: SUBMITTED), `formFieldValue` rows, `eventSession` (stage: ABSTRACT, status: PENDING), and unlinked `speaker` rows per participant.
- **Success criteria**: Displays the success page, claims the submitter's speaker record, and enqueues an automated `SUBMISSION_CONFIRMATION` email.

### Stage 5: Collaborative Peer Review
- **Actor**: Reviewer (Event Member)
- **Goal**: Evaluate submitted abstracts to select the best sessions.
- **Steps in product**:
  1. Navigates to `/org/:orgId/e/:eventId/evaluation`.
  2. Selects an unreviewed abstract to view details and custom form responses.
  3. Submits a vote (Yes, Maybe, or No), rates the talk (1-5), and leaves comments.
- **Data created**: `review` row unique per session and reviewer.
- **Success criteria**: Average score, vote distribution, and comments update immediately in the admin's Abstracts grid.

### Stage 6: Accept Queue & Promotion
- **Actor**: Organizer (Admin)
- **Goal**: Shortlist and promote accepted proposals to domain sessions.
- **Steps in product**:
  1. Navigates to `/org/:orgId/e/:eventId/abstracts`.
  2. Selects high-scoring pending abstracts, moves them to the `ACCEPT_QUEUE` (and rejected ones to `DECLINE_QUEUE`).
  3. Reviews the bulk shortlist and clicks "Notify".
- **Data created**: Updates `eventSession.status` to `ACCEPTED`, sets `eventSession.stage` to `SESSION` (promoting it to a schedulable program item), and auto-creates `taskAssignment` rows for speakers linked to the default Profile and Materials tasks.
- **Success criteria**: Decision timestamps (`decidedAt`, `notifiedAt`) are stamped; automated acceptance and rejection emails are enqueued in the outbox.

### Stage 7: Drag-and-Drop Scheduling
- **Actor**: Organizer (Admin)
- **Goal**: Position accepted sessions on the timeline and resolve conflicts.
- **Steps in product**:
  1. Navigates to `/org/:orgId/e/:eventId/agenda`.
  2. Displays physical rooms as columns and 15-minute time increments as rows. Unscheduled sessions sit in a sidebar rail.
  3. Place a session onto the grid.
  4. The engine automatically checks room availability and speaker schedules, immediately flagging overlapping blocks as warnings.
- **Data created**: Updates `eventSession.roomId`, `eventSession.startsAt`, `eventSession.endsAt`, and increments `eventSession.icsSequence`.
- **Success criteria**: Sessions are arranged across rooms and days with zero unresolved room overlaps or double-booked speakers.

### Stage 8: Calendar Invites & Reminders
- **Actor**: Automation (Cron / Outbox worker)
- **Goal**: Send calendar attachments to speakers and nudge outstanding tasks.
- **Steps in product**:
  1. The background worker processes queued schedule changes and creates raw MIME email messages attaching RFC 5545 `.ics` invite attachments.
  2. Nightly cron scans for incomplete `taskAssignment` rows nearing their deadlines and enqueues warning emails.
- **Data created**: `emailMessage` rows with unique `dedupeKey` constraints to prevent duplicate sends.
- **Success criteria**: Email is delivered; speakers receive calendar invitations that auto-update in Gmail, Outlook, or iCal.

### Stage 9: Speaker Portal Login
- **Actor**: Confirmed Speaker
- **Goal**: Claim the speaker profile and view pending requirements.
- **Steps in product**:
  1. Speaker clicks the magic link or portal URL at `/portal/:eventSlug`.
  2. Authenticates with email or Google. The system matches their verified email to existing unlinked speaker rows.
- **Data created**: Links `speaker.userId` to the logged-in User account.
- **Success criteria**: Enters the portal homepage, displaying the list of their accepted sessions and outstanding tasks.

### Stage 10: Complete Onboarding Tasks
- **Actor**: Confirmed Speaker
- **Goal**: Provide profile details and submit materials.
- **Steps in product**:
  1. Opens `/portal/:eventSlug/tasks`.
  2. Clicks "Complete Speaker Profile" to render the default speaker MDX form, uploads a square headshot file, and enters social links.
  3. Clicks "Upload Session Materials", uploads the final slide deck, and confirms final A/V requirements.
- **Data created**: `formResponse` (status: COMPLETED) for each task, `formFieldValue` rows, and `file` rows containing R2 storage pointers.
- **Success criteria**: Tasks mark as complete, the admin dashboard reflects progress, and file uploads are immediately available to organizers.

### Stage 11: Schedule Publication & Embeds
- **Actor**: Public Audience (Marketing Website)
- **Goal**: View the official conference schedule.
- **Steps in product**:
  1. The event website embeds the agenda iframe widget targeting `/embed/:eventSlug/agenda` or speaker list `/embed/:eventSlug/speakers`.
  2. Public users click a session block to view description popups, tracks, and speaker profiles.
- **Data created**: None (read-only projection).
- **Success criteria**: The public schedule renders dynamically, reflecting real-time agenda updates with zero manual export/import steps.

---

## Product map: OpenSession today vs demand

| Demand | Status | Evidence (file/route) | Notes |
| :--- | :--- | :--- | :--- |
| **Email/Google Auth & Orgs** | **Done** | `website/src/db.ts` | Uses BetterAuth with verified email/password and Google OAuth. Implements personal-org invariants. |
| **Event Settings** | **Done** | `website/src/components/event-settings.tsx` | Details, tracks, formats, rooms, and org member team tabs fully functional. |
| **MDX Form Builder** | **Done** | `website/src/components/form-editor.tsx` | Full Monaco editor with live previews, draft history, and versioning. |
| **Public CFP Form** | **Done** | `website/src/components/public-cfp-page.tsx` | Google-authed form with rich text, conditional logic, and multi-speaker fields. |
| **File Upload Storage** | **Done** | `website/src/forms/field-components.tsx` | Handles multi-part file uploads to Cloudflare R2 bucket. |
| **Abstracts Grid** | **Planned** | `website/src/app.tsx:554` | Currently returns a `ComingSoonPage` placeholder. |
| **Peer Evaluations** | **Planned** | `website/src/app.tsx:624` | Currently returns a `ComingSoonPage` placeholder. |
| **Agenda Builder** | **Planned** | `website/src/app.tsx:630` | Currently returns a `ComingSoonPage` placeholder. |
| **Onboarding Tasks** | **Planned** | `website/src/app.tsx:636` | Currently returns a `ComingSoonPage` placeholder. |
| **Speaker Portal Home** | **Partial** | `website/src/app.tsx:358` | Renders a minimal read-only list of submissions as a Task 6 preview. |
| **Email Outbox & ICS** | **Planned** | `website/src/app.tsx:670` | Currently returns a `ComingSoonPage` placeholder. |
| **Embeds & Feeds** | **Planned** | `website/src/app.tsx` | Embed pages and JSON/ICS routes are not yet registered. |

---

## Gaps that would block the AIE team

If the AI Engineer team tried to run a live event next week using the current build of OpenSession, they would face several critical blockers:

- **No Submission Discovery**: Organizers cannot view, filter, or search submitted abstracts. The submissions arrive in the database but cannot be surfaced in the UI because the Abstracts grid is a placeholder.
- **No Evaluation Mechanism**: Evaluators have no screen to vote on or rate submissions. Shortlisting is impossible without manual DB queries.
- **No Promotion Pipeline**: Organizers cannot accept or decline sessions. Abstracts cannot be promoted to scheduled sessions, and speaker portal tasks cannot be triggered or assigned.
- **No Agenda Assembly**: The organizer cannot drag sessions onto a calendar or assign rooms and times. There is no timeline rendering or conflict detection.
- **No Speaker Onboarding**: Speakers have no portal view to complete profile tasks or upload slides. The current portal is a read-only preview.
- **No Communication Channels**: No emails, reminders, or calendar invitations can be dispatched because the transactional outbox and email worker have not been implemented.

---

## Non-goals (do not build)

To deliver a lightweight, high-performance product, several heavy enterprise features from SessionBoard have been explicitly omitted:

- **No AI-Assisted Scorecards**: Evaluators score abstracts with quick votes (Yes/Maybe/No), average ratings, and direct text comments. Complex rubrics, scorecards, and multi-round AI filters are skipped.
- **No Accelevents API Sync**: Closed-source API integrations are omitted to prevent fragile third-party synchronization bugs. Organizers export registration data manually if needed.
- **No Portal Wiki Pages**: The speaker portal is restricted strictly to profile, submission, and slide task completions. Multi-page Wikis or resource directories are omitted.
- **No Payment Forms**: OpenSession is strictly a program management tool. It does not collect fees, handle sponsorships, or issue invoices.
- **No Multi-Abstract Merging**: Complex merge mechanics where multiple abstracts combine into a single session are dropped in favor of single-abstract promotions.

---

## Source notes

- **Walkthrough Videos**:
  - Part 1: `tmp/videos/kill-my-saas-part1.mp4` (0:00–5:00)
  - Part 2: `tmp/videos/kill-my-saas-part2.mp4` (5:00–end)
  - Full Walkthrough: `tmp/videos/kill-my-saas-sessionboard.mp4`
- **Competition Brief**: `$10,0000 Kill My SaaS - Competition Brief.md` (repo root)
- **Database Schema Plan**: `docs/database-schema-plan.md`
- **YouTube**: https://www.youtube.com/watch?v=vUuK4Knl7oc
- **Key Walkthrough Timestamps**:
  - `Part 1, 2:40`: Walkthrough of Event settings and Basic Info configurations.
  - `Part 1, 4:32`: Inside the SessionBoard Form Builder showcasing field toggles and participant boundaries.
  - `Part 2, 0:57`: Demonstrating the public-facing CFP form and multi-speaker `<Participants>` flow.
  - `Part 2, 1:52`: First look at the Speaker Portal Home with submissions, profile, and pending onboarding tasks.
  - `Part 2, 2:40`: Walkthrough of Evaluation summaries, plans, and reviewer ratings.
  - `Part 2, 3:08`: Demonstrating the Drag-and-Drop Agenda grid.
  - `Part 2, 3:25`: CMS Embed layout displaying the embedded schedule widget.
