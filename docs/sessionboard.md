---
title: SessionBoard dashboard reference
description: >
  Visual reference for the SessionBoard organizer dashboard, sidebar, major screens,
  and the parts OpenSession should copy or simplify.
---

# SessionBoard dashboard reference

## Gist

SessionBoard is a **dense enterprise event workspace**. One event stays selected while
the organizer moves through a deep left sidebar. The interface separates event content,
collection, portal operations, configuration, and suite-level products.

The best ideas for OpenSession are:

- a persistent **event context** with event name and dates
- grouped navigation based on the organizer's workflow
- count-bearing status tabs above tables
- dense tables with saved column, sort, and filter preferences
- dashboard alerts that link to unfinished work
- a separate, simple speaker portal

OpenSession should not copy SessionBoard's suite modules, nested settings navigation,
payment flow, or configurable dashboard system.

```text
Event setup ──► collect proposals ──► review decisions ──► build agenda ──► onboard speakers
     ▲                                                           │
     └─────────── dashboard warnings and progress metrics ◄──────┘
```

## 1. Source and certainty

This document is based on `images/doc-image-02.png` through
`images/doc-image-40.png`. The competition brief maps each screenshot to its feature
area.

Most screenshots do not show browser chrome. Therefore, this document records
**observed navigation labels and route concepts**, not invented SessionBoard URL paths.
The only visible public URL shape is the submission route in `doc-image-16.png`:

```text
/submit/{event-slug}/{form-id}
```

## 2. Organizer shell

SessionBoard uses three stable regions:

```text
┌──────────────────────┬──────────────────────────────────────────────────────────┐
│ Event and sidebar    │ Find or ask        View Portal  Help  User               │
│                      ├──────────────────────────────────────────────────────────┤
│ Dashboard            │ Page title                             Page actions      │
│ Program              │ Description                                              │
│ CRM                  │ Tabs, search, saved views, columns, sort, filter         │
│ Marketing            │                                                          │
│ CMS                  │ Table, cards, editor, grid, or dashboard widgets         │
│ Reports              │                                                          │
│ Studio               │                                                          │
│ History              │                                                          │
│ Event Team           │                                                          │
│ Preview              │                                                          │
│ Settings             │                                                          │
└──────────────────────┴──────────────────────────────────────────────────────────┘
```

### Event context

The sidebar begins with the **current event**, a small icon, and its date range. The
screens show `AI.Engineer Sandbox Event` and `Oct 12-14, 2026`. This keeps all work
clearly scoped to one event.

### Global top bar

The top bar contains:

- **Find or ask**, with the `⌘K` shortcut
- **View Portal**, which opens the participant-facing product
- notification and help controls
- the current user's avatar and menu

### Visual language

SessionBoard uses a light, restrained SaaS style:

- white and pale gray surfaces
- one blue accent for active routes and primary buttons
- compact sans-serif type
- thin borders and few shadows
- cards for independent records or dashboard widgets
- tables for operational lists
- drawers for create and edit flows
- colored pills for lifecycle states and taxonomy values

The desktop layout is information-dense. It favors fast scanning over spaciousness.

## 3. Sidebar and route concepts

The sidebar changes depth based on the selected suite module. The **Program** module is
the relevant reference for OpenSession.

| Group | Route label | What it is for | Evidence |
| --- | --- | --- | --- |
| Top | **Dashboard** | Event KPIs, alerts, pacing, review progress, speaker tasks, and custom dashboards | 34-40 |
| Program | **Overview** | High-level Program landing area | 05, 19, 24 |
| Submissions | **View All** | Combined submission records | 05, 19, 24 |
| Submissions | **Abstracts** | Review proposals and move them through decision states | 19-23 |
| Submissions | **Sessions** | Manage program sessions after selection | 05, 19, 24 |
| Submissions | **Files** | Files attached to submission records | 05, 19, 24 |
| Collect & Review | **Forms** | Build and manage CFP submission forms | 05-15 |
| Collect & Review | **Evaluation** | Configure plans and evaluate submissions | 05, 34-36 |
| Collect & Review | **Agenda** | Schedule sessions across dates and rooms | 24, 34-36 |
| Collect & Review | **Invoices** | Payment-related program records | 05, 19, 24 |
| Collect & Review | **Site** | Program-facing site configuration | 05, 19, 24 |
| Portals | **Portals** | Configure participant portal experiences | 05, 19, 24 |
| Portals | **Tasks** | Define onboarding work assigned through portals | 25 |
| Portals | **Forms** | Build forms used by portal tasks | 26-29 |
| Portals | **File Requests** | Request standalone files from participants | 30-31 |
| Portals | **Resources** | Portal reference material | 05, 19, 24 |
| Portals | **Files** | Browse portal-uploaded files | 05, 19, 24 |
| Configure | **Settings** | Event and Program configuration | 02-04 |

Outside Program, the sidebar exposes broader suite modules: **CRM**, **Marketing**,
**CMS**, **Reports**, **Studio**, and **History**. CMS contains **Overview** and
**Embeds**. Event-level utility routes include **Event Team**, **Preview**, and
**Settings**.

## 4. Dashboard tabs

The dashboard shown in screenshots 34-40 is not one fixed report. It is a collection of
top-level dashboard tabs and lower topic tabs.

### Top-level dashboards

| Tab | Purpose | Main content |
| --- | --- | --- |
| **Today** | Daily event command center | Date, days to event, KPIs, status counts, warnings, and submission pacing |
| **Review Progress** | Evaluation operations | Evaluation plans, evaluated count, reviews in progress, and most active plan |
| **Speaker Tracking** | Onboarding readiness | Accepted speakers, outstanding tasks, confirmation mix, and overdue ranking |
| **Submissions Pipeline** | CFP funnel health | Total submissions, pending review, submissions by form, and submissions by track |

The `+ Add Dashboard` flow offers a gallery, an AI prompt, or a manual builder.
Templates include Event Overview, Submissions Pipeline, Speaker Tracking, Review
Progress, Evaluation Plans by Tracks, and Schedule Health.

### Today topic tabs

Inside the Today dashboard, another row switches between:

- **Submission Forms**: pacing chart, per-form progress, and recent submissions
- **Participants**: role mix, status mix, and missing bio or headshot alerts
- **Evaluations**: review progress and plan metrics
- **Agenda**: scheduling readiness and unscheduled work

This two-level dashboard model is flexible but adds complexity. OpenSession should use
one curated overview before it considers user-built dashboards.

## 5. Key screens and tabs

### Event Settings

Screenshots 02-04 show a second sidebar inside **Event Settings**:

| Tab | Purpose |
| --- | --- |
| **Overview** | Cards that link to each settings area |
| **Event Details** | Name, slug, type, website, location, timezone, dates, description, logo, and background |
| **Library / Fields** | Custom fields shared by contacts, sessions, and submissions |
| **Library / Tags** | Reusable record labels |
| **Library / Personas** | Audience types used by broader suite features |
| **Record Settings** | Record layouts and field configuration |
| **Portals** | Portal appearance and behavior |
| **Submission Forms** | Submission form appearance and content |
| **Email Templates** | Transactional email content |
| **Email Themes** | Shared email branding |
| **Integrations** | External products such as Cvent, Swoogo, and Zoom |

The separate settings sidebar makes a large suite manageable. It is too deep for the
OpenSession MVP, where Details, Tracks, Formats, Rooms, and Team fit in one tab row.

### Submission Forms

The Forms index has **All**, **Open**, and **Closed** status tabs, search, sorting, form
cards, submission and draft counts, deadlines, version labels, and an Add menu with
**Create Form** and **Copy from**.

The SessionBoard form builder is a seven-step wizard:

1. **Submission Setup**: choose Abstracts or Sessions and enable participants.
2. **Welcome Screen**: external title, page heading, message, and terms.
3. **Abstract Information**: section copy and ordered session questions.
4. **Participant Information**: participant roles, min/max counts, and contact fields.
5. **Payments & Fees**: payment timing and fee setup.
6. **Form Settings**: close date, submission limit, draft policy, success page, and validation.
7. **Notifications**: admin alerts and submitter confirmation templates.

Questions are ordered rows with field type, limits, required toggle, lock state, drag
handle, and overflow menu. Built-in fields include Title, Description, Format, Tags,
Track, Level, First Name, Last Name, and Email.

### Abstracts

The Abstracts route is a dense operational table. Its status tabs are:

```text
All  │ Accepted  │ Accept Queue  │ Pending  │ Decline Queue
     │ Declined  │ Withdrawn     │ Drafts
```

The toolbar has search, Saved Views, Columns, Sort, and Filter. Columns can be selected,
reordered, and saved. Visible examples include Status, Source, Title, Client Session ID,
Description, Notified, Rating, Speaker, Track, Tags, Files, and Capacity.

The status cell opens an inline state picker. `Options` provides import, CSV/XLSX
export, and file bundle download. `Add Abstract` opens a right drawer with Details and
Participants tabs.

### Agenda

The Agenda toolbar offers **List**, **Day**, **Week**, **Month**, **Rooms**, and
**Conflicts** views. It also exposes search, saved views, columns, sort, filter, drafts,
options, and `+ Add Session`.

The screenshot shows an empty List view, not the drag grid itself. The navigation still
confirms that SessionBoard treats agenda display modes as views within one route.

### Portal Tasks and Forms

Tasks have **All Tasks**, **Contact Tasks**, **Group Tasks**, and **Submission Tasks**
tabs. Each task row identifies its mode and target. The Add menu supports creating or
copying a task.

Portal Forms have the same target tabs. Their three-step builder is Form Setup, Form
Questions, and Settings. A form can target Contacts, Groups, or Submissions. This is
separate from CFP Submission Forms.

File Requests are also target-specific, but uploaded files stay attached to the request
rather than a contact or session record.

### CMS Embeds

The Embeds route has **All**, **Enabled**, and **Disabled** tabs. The editor combines a
settings panel with a live desktop, tablet, or mobile preview. Styled HTML feeds include
Agenda, Session List, Schedule Itinerary, Speaker List, and Speaker Gallery.

### Speaker portal

The speaker product removes the admin sidebar and uses four centered pill tabs:

```text
Home  │  Submissions  │  Profile  │  Tasks
```

Home combines My Submissions, My Profile, and Tasks. Profile includes biography,
identity fields, pronouns, gender, and social links. The user menu includes **Back to
Admin Mode** when the user is also an organizer.

## 6. What OpenSession should copy

| SessionBoard pattern | OpenSession decision |
| --- | --- |
| Event identity stays visible | Keep the event name and date range in the event shell |
| Workflow-based sidebar groups | Keep Submissions, Collect & Review, Portal, Communications, Configure |
| Status counts are navigation | Keep counts in Abstracts and Forms tabs |
| Operational data uses tables | Keep `Frame` + `Table` for abstracts, speakers, files, emails, and assignments |
| Create and edit work uses drawers or focused editors | Keep dialogs for small records and a full page for MDX editing |
| Dashboard alerts link to corrective work | Add unscheduled, undecided, and incomplete-profile warnings |
| Speaker portal has separate chrome | Keep Home, Submissions, Profile, and Tasks without the admin sidebar |

## 7. What OpenSession should simplify

| SessionBoard feature | Reason to omit or simplify |
| --- | --- |
| CRM, Marketing, Reports, Studio, and broad CMS | Outside the conference Program scope |
| Invoices and Payments & Fees | Payments are an explicit non-goal |
| Nested Event Settings sidebar | Five query-param tabs are enough for the MVP |
| Enterprise evaluation configuration | Keep review rounds, scoped reviewers, and MDX scorecards without copying the full suite model |
| Contact, Group, and Submission portal abstractions | OpenSession only needs Speaker and Submission targets |
| Standalone File Requests | A portal form task with `FileUpload` preserves context |
| User-created dashboards and AI dashboard prompts | Start with one reliable, curated overview |
| Dozens of table preference controls | Search, useful defaults, and CSV export cover the first release |

## 8. OpenSession route mapping

OpenSession keeps SessionBoard's workflow but uses a smaller route map:

| SessionBoard concept | OpenSession route |
| --- | --- |
| Dashboard | `/org/:orgId/e/:eventId` |
| Abstracts | `/org/:orgId/e/:eventId/abstracts` |
| Sessions | `/org/:orgId/e/:eventId/sessions` |
| Files | `/org/:orgId/e/:eventId/files` |
| Submission Forms | `/org/:orgId/e/:eventId/forms` |
| Evaluation | `/org/:orgId/e/:eventId/evaluation` |
| Agenda | `/org/:orgId/e/:eventId/agenda` |
| Portal Tasks | `/org/:orgId/e/:eventId/tasks` |
| Portal Forms | `/org/:orgId/e/:eventId/portal-forms` |
| Speakers | `/org/:orgId/e/:eventId/speakers` |
| Communications | `/org/:orgId/e/:eventId/emails` |
| Event Settings | `/org/:orgId/e/:eventId/settings` |
| Public CFP | `/submit/:eventSlug/:formSlug` |
| Speaker portal | `/portal/:eventSlug` |
| Agenda embed | `/embed/:eventSlug/agenda` |
| Speaker embed | `/embed/:eventSlug/speakers` |

For the competing product comparison, see [`sessionize.md`](./sessionize.md).
