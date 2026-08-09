---
title: Sessionize organizer dashboard reference
description: >
  Live inspection of the Sessionize organizer application and a comparison with
  SessionBoard and OpenSession.
---

# Sessionize organizer dashboard reference

## Gist

Sessionize is a **flatter, lifecycle-driven conference tool**. Its sidebar is one long
list of organizer jobs, not a deep enterprise suite. The dashboard's main feature is a
Smart Task List that tells the organizer what to do next.

```text
Create event ──► open CfS ──► receive sessions ──► evaluate ──► inform speakers
                                                                       │
                                    announce schedule ◄── build schedule ◄──┘
```

OpenSession should copy Sessionize's lifecycle clarity, simple sessions table, service
sessions, and direct publishing tools. It should keep SessionBoard's stronger portal
tasks and onboarding visibility.

## 1. Inspection scope

The [live organizer event](https://sessionize.com/app/organizer/event/25277) was
inspected with Playwriter on **August 8, 2026**.

The inspected event is a test event. Data, labels, routes, and paid feature behavior can
change. No settings were edited and no actions were submitted.

Pages inspected:

- Dashboard
- Edit Event
- Call for Speakers
- Sessions
- Speakers
- Evaluation
- Inform Speakers
- Speaker Dashboard
- Schedule Builder
- Rooms
- Group Mailing
- API / Embed
- Team

## 2. Organizer shell

Sessionize uses a dark slate sidebar, a thin white utility bar, and a pale gray content
background. Teal is the primary action color. Cards use white surfaces, thin borders,
and modest rounded corners.

```text
┌─────────────────────┬───────────────────────────────────────────────────────────┐
│ Organizer Speaker   │ Jump to...              Help & Support       User         │
│ Event switcher      ├───────────────────────────────────────────────────────────┤
│ Dashboard           │ Event title and status                    CfS / Events   │
│ Edit Event          │                                                           │
│ Call for Speakers   │ Page content                                              │
│ Sessions            │                                                           │
│ Speakers            │ Cards, forms, tables, or scheduling workspace            │
│ Evaluation          │                                                           │
│ Inform Speakers     │                                                           │
│ ...                 │                                                           │
└─────────────────────┴───────────────────────────────────────────────────────────┘
```

### Stable shell controls

- **Organizer / Speaker** switches between the two user modes.
- The **event switcher** keeps the current event visible and links to older events.
- **Jump to** is a global command-style search.
- **Help & Support** and the account menu stay in the top bar.
- The event header exposes the event name, date proximity, test status, CfS page, and
  all-events link.

Compared with SessionBoard, Sessionize looks older and denser. It uses stronger teal,
red, and status colors. SessionBoard has a more polished neutral palette and clearer
group headings.

## 3. Exact sidebar routes

The following routes were observed in the live sidebar.

| Sidebar label | Observed route | Purpose |
| --- | --- | --- |
| **Dashboard** | `/app/organizer/event/25277` | Event status, next steps, CfS metrics, and event facts |
| **Edit Event** | `/app/organizer/event/edit/25277` | Event, CfS, submission fields, additional fields, internal fields, and advanced settings |
| **Call for Speakers** | `/app/organizer/event/cfs/25277` | CfS status, dates, links, statistics, and recent submissions |
| **Sessions** | `/app/organizer/sessions/25277` | Search, filter, inspect, classify, and bulk-manage proposals |
| **Speakers** | `/app/organizer/speakers/25277` | Browse speaker records and session relationships |
| **Evaluation** | `/app/organizer/event/evaluation/25277` | Create evaluation plans, scopes, and evaluator assignments |
| **Inform Speakers** | `/app/organizer/sessions/inform/25277` | Send decisions and collect speaker confirmations |
| **Speaker Dashboard** | `/app/organizer/event/speaker-dashboard/25277` | Configure the accepted-speaker self-service experience |
| **Schedule Builder** | `/app/organizer/scheduleBuilder/25277` | Place sessions and service blocks on the agenda |
| **Rooms** | `/app/organizer/rooms/25277` | Define rooms and optional live-stream links by day |
| **Announce Schedule** | `/app/organizer/schedule/25277` | Publish the completed schedule |
| **Social Banners** | `/app/organizer/banners/25277` | Generate social artwork for speakers and sessions |
| **Group Mailing** | `/app/organizer/event/communication/25277` | Email selected event audiences |
| **App** | `/app/organizer/mobile-app/25277` | Configure Sessionize's attendee app experience |
| **API / Embed** | `/app/organizer/schedule/api/25277` | Create public schedule endpoints and embed integrations |
| **Feedback** | `/app/organizer/feedback/25277` | Collect attendee session feedback |
| **Export** | `/app/organizer/export/25277` | Export event, session, and speaker data |
| **Team** | `/app/organizer/event/contentteam/25277` | Manage the content team and evaluation access |
| **Changes History** | `/app/organizer/event/history/25277` | Review event changes |
| **Email History** | `/app/organizer/event/mails/25277` | Review sent email activity |

The sidebar also links to event and list management outside the current event, plus the
public Speakers Directory.

## 4. Dashboard

The dashboard is an **operational checklist**, not a configurable analytics canvas.

### Event status

A large red card makes test mode impossible to miss. It explains the submission limit
and gives an Activate / Buy Now action.

### Smart Task List

The central card shows a chronological checklist:

1. Create an event.
2. Set additional event properties.
3. Wait for Call for Speakers to open.
4. Call potential speakers to submit sessions.
5. Receive the first session.
6. Receive the tenth session.
7. Wait for Call for Speakers to close.
8. Build the content team.
9. Evaluate submissions.
10. Inform speakers.
11. Build a schedule.
12. Message accepted speakers.
13. Announce the schedule.

Completed steps use check marks. The next recommended step expands with an explanation
and direct action. This is a strong pattern for first-time organizers.

### Summary cards

The right column shows:

- session and unique-speaker counts
- sessions per speaker
- accepted, waitlist, in-process, and declined counts
- CfS dates and public or secret links
- speaker support email
- event dates, location, and timezone
- direct link to the speaker dashboard

SessionBoard's dashboard is better for weekly operational reporting. Sessionize's
dashboard is better for telling a new organizer what to do next.

## 5. Event and CFP setup

Edit Event uses one tabbed form with these tabs:

```text
Event  │  Call for Speakers  │  Submission fields  │  Additional fields
       │  Internal fields    │  Advanced settings
```

This is flatter than SessionBoard's nested Event Settings plus separate seven-step form
builder. Sessionize treats the CFP as one event capability rather than a library of many
independent CFP forms.

The Call for Speakers page shows CfS status, submission and speaker statistics, sessions
per speaker, and recent submissions. The dashboard and header link directly to the
public CfS page.

## 6. Sessions and decisions

The Sessions page is the main content workbench.

### Quick states

The inspected event showed counts for:

- Accepted
- Waitlisted
- Accept Queue
- Nominated
- Decline Queue
- Declined

### Workflow tabs

```text
All sessions  │  Pending decision  │  Informed / Confirmed  │  Scheduled
```

The table supports search, status filtering, missing-data filtering, sorting, custom
session-field filters, and custom speaker-field filters. Table columns can display
submission fields, additional fields, and built-in fields such as assigned evaluators
and team comments.

This is simpler than SessionBoard's highly configurable table preference modal, but it
still supports the filters that matter for conference selection.

**Inform Speakers** is a separate route. This makes the distinction between choosing a
status and notifying the speaker explicit. OpenSession has the same useful concept with
Accept Queue, Decline Queue, and Notify.

## 7. Evaluation

Evaluation separates two perspectives:

- **Organizer's perspective**: create evaluation plans, define scope, and assign team
  members.
- **Evaluator's perspective**: show the current user's assigned evaluations.

Sessionize allows unlimited plans per event. This is more flexible than OpenSession's
single shared review flow, but it also requires setup before reviewers can work.

OpenSession uses evaluation forms as rounds. This keeps separate reviewer pools and
scorecards without adding a parallel plan and criterion schema.

## 8. Schedule

Schedule is the only grouped sidebar item. It expands to:

```text
Schedule Builder  │  Rooms  │  Announce Schedule
```

### Schedule Builder

The builder is a dedicated full-width workspace. Its controls include:

- filter by visible session text
- **Add Service Session** for breaks, lunch, registration, and similar blocks
- Save changes and Close
- color sessions by format, track, level, or language
- zoom in, zoom out, toggle unscheduled list, and full screen
- one date tab per event day

The inspected test event had no rendered placements. The screen showed an empty teal
unscheduled rail and blank schedule canvas.

### Rooms

Rooms are an ordered table with room name and optional live-stream link. A setting can
reuse the same links for all event days.

### Announce Schedule

Publishing is a separate final step. This reinforces the lifecycle shown in the Smart
Task List: build first, announce when ready.

SessionBoard exposes more agenda views and draft controls in one route. Sessionize makes
the build and publish stages easier to understand.

## 9. Communications and publishing

Sessionize separates communication by intent:

- **Inform Speakers** for acceptance, waitlist, and decline decisions
- **Group Mailing** for later audience messages
- **Email History** for delivery history
- **Speaker Dashboard** for accepted-speaker self-service

Publishing tools are also separate:

- **Announce Schedule** publishes the schedule
- **API / Embed** creates public data access
- **App** configures the attendee app
- **Social Banners** creates promotional assets
- **Export** downloads event data

OpenSession can combine general communication into one Emails route because it has a
smaller scope. Decision actions should remain visible on Abstracts, while the outbox
provides one audit log.

## 10. Three-product comparison

| Area | SessionBoard | Sessionize | OpenSession direction |
| --- | --- | --- | --- |
| Product shape | Enterprise event content suite | Focused conference workflow | Focused open-source Program layer |
| Navigation | Deep grouped sidebar with suite modules | Flat lifecycle menu | Small grouped workflow sidebar |
| Dashboard | Rich metrics, alerts, tabs, custom widgets | Guided Smart Task List and summary cards | Curated KPIs, alerts, plus a small next-step list |
| Event setup | Nested settings workspace | One tabbed Edit Event page | Details, Tracks, Formats, Rooms, Team tabs |
| CFP model | Multiple sophisticated form builders | Event-centered CfS fields | Multiple MDX forms with immutable versions |
| Form editing | Visual seven-step field builder | Field lists inside event settings | Monaco MDX editor and live preview |
| Submission table | Very configurable columns and saved views | Practical filters and dynamic fields | Fixed useful columns, search, status tabs, CSV |
| Decisions | Accept and decline queues with notification state | Queues plus separate Inform Speakers route | Queues plus explicit Notify actions |
| Evaluation | Plans and scorecards | Plans, scopes, and assigned evaluators | Form-backed rounds, scoped reviewers, and MDX scorecards |
| Schedule | Many list and calendar views, draft controls | Dedicated builder, service sessions, announce step | Day and list views, service sessions, conflict warnings |
| Speaker onboarding | Strong portal tasks, forms, and files | Speaker Dashboard and organizer messaging | Strong task assignments and MDX portal forms |
| Communications | Templates, themes, alerts, portal mail | Inform Speakers, Group Mailing, history | Transactional outbox, reminders, and ICS |
| Public output | Styled embeds and speaker gallery | API, embeds, app, export | JSON, ICS, agenda embed, speaker embed |
| Main risk | Too much enterprise complexity | Features spread across many top-level routes | Shipping an incomplete end-to-end workflow |

### Current OpenSession coverage

This comparison is also grounded in the current `website/src/app.tsx`, not only the
implementation plan.

| OpenSession area | Current state |
| --- | --- |
| Event shell and settings | Implemented, including Tracks, Formats, Rooms, and Team |
| CFP forms and public submission | Implemented with MDX versions, drafts, validation, and uploads |
| Abstracts and evaluation | Implemented with status tabs, detail, reviews, queues, and CSV |
| Portal tasks and forms | Implemented with speaker and submission task targets |
| Speaker portal | Implemented for home, submissions, profile, and task completion |
| Dashboard | Basic event counts only, without SessionBoard-style warnings and pacing |
| Sessions, Files, Agenda, Speakers, Emails | Registered routes that still show placeholders |
| Embeds, public feeds, reminders, and ICS | Planned but not registered as finished screens |

## 11. Recommended OpenSession blend

```text
SessionBoard                        Sessionize
grouped operations                  lifecycle guidance
portal tasks                        service sessions
status tabs and alerts              explicit inform and announce steps
        └─────────────────┬──────────────────┘
                          │
                          ▼
                    OpenSession
        small grouped shell + clear next actions
```

Use these principles:

1. Keep **SessionBoard's grouped sidebar** because OpenSession has distinct organizer
   work areas.
2. Add **Sessionize-style next actions** to the dashboard, but do not create a long
   onboarding wizard.
3. Keep **SessionBoard-style status tabs** for Abstracts and Forms.
4. Keep **Sessionize's separate decision and notification concepts**.
5. Add **service sessions** and a clear schedule publish state when Agenda ships.
6. Keep OpenSession's **MDX forms**, immutable versions, and generic task assignments.
7. Avoid custom dashboards, payments, CRM, marketing, social banners, attendee apps,
   and evaluation plans until user demand proves they are needed.

For the screenshot-by-screenshot SessionBoard reference, see
[`sessionboard.md`](./sessionboard.md).
