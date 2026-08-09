# OpenSession — agent instructions

OpenSession is an open-source SessionBoard clone: CFP submission forms, abstract
review, agenda builder, speaker portal, reminder emails, embeds. One Cloudflare Worker
(`website/`), D1 + drizzle (`db/`), Spiceflow RSC, BetterAuth Google login, holocron
landing page, sigillo for secrets.

## Name and domain — always use these exact strings

The product is **OpenSession** (singular) and the domain is **opensession.dev**.

| Thing | Value |
| --- | --- |
| Product name | `OpenSession` |
| Slug / package prefix | `opensession` |
| Production domain | `opensession.dev` |
| Worker (prod) | `opensession-website` → `opensession.dev` custom domain |
| Worker (preview) | `opensession-website-preview` → `preview.opensession.dev` |
| D1 (prod / preview) | `opensession-db` / `opensession-preview-db` |
| GitHub repo | `remorses/opensession` |

Never write `opensessions`, `OpenSessions`, `opensession.com`, or any other domain.
The only legacy exceptions are the local checkout folder (`opensessions/`) and the
sigillo org name, which cannot be renamed from the CLI.

## Tracks and sessions

A **track** is an event topic lane (e.g. AI, Security). Tracks belong to the
**event** library (`track` table), not to a form. Same pattern as formats/rooms.

- One CFP form covers all tracks via `<Select name="track" options={tracks} />`.
- One submit = one session = one `event_session.trackId`. No multi-track session.
- Speakers submit again for another session/track. Cap: `MAX_CFP_RESPONSES` (3)
  non-draft responses per speaker per event (`website/src/lib/cfp-submission.ts`).
- Do not invent form-owned tracks or one-form-per-track unless product asks for it.

## Email sender and reply-to

| Thing | Value |
| --- | --- |
| From | `OpenSession <notifications@opensession.dev>` |
| Reply-To | `event.contactEmail` — seeded from the event creator's account email, editable in Settings → Details |
| Transport | Cloudflare Email Service `send_email` binding (`env.EMAIL`), raw MIME via `cloudflare:email` when an ICS part is attached |

Replies must reach the organizer, never a black hole. Every outbound email sets
`Reply-To` to the event's contact email so speakers can just hit reply. Never send
from a per-user address; the envelope sender is always `notifications@opensession.dev`
so SPF/DKIM stay aligned with the onboarded sending domain.

## NEVER hardcode secrets — this repo is public

`remorses/opensession` is a **public open-source repository**. Anything committed here
is visible to everyone, forever, including in git history. A leaked credential cannot be
un-leaked by a later commit; it must be rotated.

Rules, no exceptions:

- **Never write a secret value into any file.** No API keys, OAuth client secrets,
  auth secrets, database tokens, session cookies, bearer tokens, private keys, or
  passwords — not in source, not in config, not in tests, not in docs, not in comments,
  not in a commit message, not in a script you plan to delete.
- **Never paste a secret into a chat message or a PR/issue body.**
- **All secrets come from the environment.** Server code reads them from
  `import { env } from 'cloudflare:workers'` (worker) or `process.env` (node scripts).
  Declare each one in `wrangler.jsonc` under `secrets.required` so it is typed and the
  deploy fails loudly when it is missing. Values live in **sigillo** only.
- **Never read secret values.** Do not `cat` a `.env`, do not run `sigillo secrets get`,
  do not print `env.BETTER_AUTH_SECRET`. Run commands under `sigillo run -c dev -- ...`
  so the values are injected without you ever seeing them.
- **Never commit `.env`, `.dev.vars`, `*.pem`, or `*.key`.** They are gitignored; do not
  force-add them.
- **Placeholders in examples must be obviously fake**, like `GOOGLE_CLIENT_ID=""` or
  `sk-xxxxxxxx`. Never copy a real value "just for the example".
- Non-secret identifiers are fine to commit: D1 `database_id`, worker names, the
  Cloudflare account slug, public URLs. They are useless without a credential.

## MANDATORY: read these before writing any code

Context documents (in this repo):

- `docs/user-flow.md` — who the buyer is, what they want from SessionBoard, and the
  real end-to-end usage flow (setup → CFP → review → agenda → portal → emails).
  Read this first when deciding product behavior or prioritization.
- `docs/implementation-plan.md` — THE plan: routes, sidebar/tabs design, feature matrix
  per page, MDX form engine design, email/ICS design, milestones. Follow it.
- `docs/customer-workflow-tasks.md` — sequential, review-sized implementation tasks for
  the customer workflows covered by the Kill My SaaS evaluations. Work on one task at
  a time and complete its validation gate before starting the next task. For workflows
  named there, its reuse-first decisions supersede older MVP simplifications in the
  implementation and database plans. Each implementation task commits its own validated
  changes before the next task starts. A review task commits only when it makes fixes.
- `docs/database-schema-plan.md` — product research + schema rationale (23 models,
  4 simplification rounds; do not re-add removed features).
- `docs/sessionboard.md` — screenshot-derived reference for the SessionBoard organizer
  shell, sidebar, dashboard tabs, forms, abstracts, agenda, and speaker portal.
- `docs/sessionize.md` — live Sessionize organizer route map and the comparison between
  Sessionize, SessionBoard, and OpenSession.
- `schema.prisma` — design artifact for the schema. The live schema is
  `db/src/schema.ts` (1:1 drizzle translation). Never edit schema.prisma to change the
  DB; edit `db/src/schema.ts` + write a migration.
- `MEMORY.md` — environment gotchas (dev port 8788, sigillo project ids).
- `images/doc-image-01..40.png` — SessionBoard screenshots showing the UI to replicate.
  View the ones for your feature area (see the brief `$10,0000 Kill My SaaS -
  Competition Brief.md` for the image → feature mapping).

Skills (load with the Skill tool):

- **Before every customer-workflow task**, load `spiceflow`, `cloudflare-workers`,
  `better-auth`, `drizzle`, and `playwriter`. Read the Drizzle `cloudflare.md`
  companion and the full Spiceflow README and testing guide. These are mandatory even
  when the task appears to touch only one layer because each task crosses route, auth,
  D1, and browser behavior.
- `spiceflow` — REQUIRED for any route/page/action work. Fetch and read the FULL README
  and its testing guide, with no truncation.
- `tailwind` — REQUIRED before writing any styles or components.
- `drizzle` (+ its cloudflare.md companion) — REQUIRED before touching db code.
- `better-auth` — for anything auth/session related.
- `cloudflare-workers` — for wrangler.jsonc, bindings, cron, R2, tests-in-workerd.
- `transactional-email` — for any email template or send flow.
- `sigillo` — for secrets management.
- `playwriter` — REQUIRED: every UI feature must be validated in the browser (below).

Before adding a table, prove the workflow cannot be represented by the current schema.
Prefer extending the existing invitation, form/version/response/field-value, review,
task-assignment, file, email-outbox, lifecycle-status, and visibility models. Every new
table in `docs/customer-workflow-tasks.md` has a stated reason; do not add more tables
without updating the plan and explaining why an existing owner cannot hold the data.

Reference implementations (the products we clone; consult when unsure about behavior):

- SessionBoard API docs (full): https://sessionboard.mintlify.app/llms-full.txt
- Sessionize playbook (organizer docs): https://sessionize.com/playbook/
  Useful pages: /playbook/api, /playbook/schedule-builder, /playbook/evaluations,
  /playbook/speaker-dashboard, /playbook/allowing-speakers-to-edit-sessions,
  /playbook/collecting-and-sharing-presentations, /playbook/features-detailed
- Kill My SaaS evaluation suite: https://forge.smol.ai/swyx/killmysaas-evals
  This is executable customer acceptance criteria, not only a test harness. Clone it outside
  this public repo when needed; never vendor its fixture credentials, saved auth state, or
  generated evaluation artifacts into OpenSession.

### Kill My SaaS customer requirements

Use the evaluation suite to understand concrete examples of what the challenge customer
expects. Read its sources in this order before implementing or reviewing a matching workflow:

1. `docs/00-how-sessionboard-works.md` for the complete customer journey and module handoffs.
2. The matching `docs/0N-*.md` for product intent and populated-screen expectations.
3. The matching `specs/0N-*.yaml` for the executable scenarios, exact rubric pass criteria,
   evidence requirements, and feature ownership boundaries.
4. `fixtures/sample-data.json`, `fixtures/speakers.csv`, and the upload fixtures for the exact
   people, event, proposals, files, and sentinel values used to prove persistence.

The required evaluation has 18 stateful scenarios and 84 rubric items across six areas:
CFP (20%), abstract management (20%), speaker management (15%), content management (15%),
agenda (10%), and public widgets (20%). Speaker CRM is optional extra credit. Run required
areas in numeric order against one deployment: CFP submissions become reviewed abstracts,
accepted talks become sessions, sessions receive portal files and agenda slots, and the
published agenda feeds anonymous widgets. Do not replace this chain with isolated seeded
screens.

Pay special attention to the rubric item types that expose incomplete clones:

- `roundtrip`: data written by a speaker or reviewer persists and appears unchanged to the
  organizer.
- `scoping`: reviewers see only assignments, speakers see only their own portal data, and
  public pages do not leak private or unapproved records.
- `rule`: close dates lock submission and editing, file uploads create versions, and agenda
  room/speaker conflicts are enforced or visibly flagged.
- `handoff`: accepted proposal → session → agenda → public output requires no data re-entry.
- `bulk` and `side-effect`: CSV import, assignment/reminder operations, exports, ZIP files,
  emails, and calendar files work beyond a one-record demo.

The evaluator uses a browser agent on one origin and a separate evidence-only judge. Visible
controls, confirmation states, reload persistence, populated lists, role isolation, and
screenshots of completed states matter. A form that merely renders is not proof that its
submission, persistence, or downstream handoff works. Some email, export, calendar, and
third-party embed checks remain manual; validate those with real outputs, not mocks.

## Validation — required after EVERY feature

1. `pnpm typecheck` in `website/` and `pnpm typecheck` in `db/` when schema changed.
2. `pnpm exec vitest run --config vitest.config.ts` in `website/` for pure behavior.
3. Run the workerd integration suite for tasks that touch routes, actions, D1, R2, or
   anonymous feeds. It must use real Miniflare bindings and migrations, not module mocks.
4. `lintcn lint` in each edited package.
5. **Playwriter browser validation**: read `playwriter skill` in full, then run the dev
   server through `kimaki tunnel` in tuistory session `opensession-dev`. Use
   `http://localhost:8788` for Playwriter and share the tunnel URL with the user. Load
   every changed page and follow observe → act → observe. Print the URL, snapshot, and
   `getLatestLogs({ sinceLastCall: true })` after every action. Capture screenshots of
   the completed workflow. The user's Chrome is signed into Google, so auth must be
   tested end to end instead of replaced with a fake auth service.
6. Run or manually follow the matching scenario in `killmysaas-evals/specs/*.yaml`.
   Record which rubric IDs passed and any remaining blockers.

## Code patterns (copied from akarso — follow them exactly)

- **Routes** live in `website/src/app.tsx`: `.loader()` per route level (auth +
  membership at `/org/:orgId/*`, event data at `/org/:orgId/e/:eventId/*`), `.layout()`
  for shells, `.page()` with dynamic `import()` of client components.
- **Mutations** are server actions in `website/src/actions.tsx` (`'use server'`), typed
  input objects validated with zod, auth-checked via `getActionRequest()` +
  `requireSession`/`requireOrgAccess` FIRST. Actions redirect with `throw redirect(...)`.
- **Action errors must be visible.** Never call a server action from a click/change
  handler without a try/catch (or `runAction`). Surface failures with
  `toastActionError(err)` / `runAction(() => …)` from `website/src/components/ui/toast.tsx`
  so the user always gets a bottom-right toast. Optional: also set local inline error
  state near the control. Silent failures are a bug. Mount `<Toaster />` in every
  top-level shell (dashboard `AppShell`, portal shell, public CFP page) if you add a
  new shell. Do not use `router.refresh()` after actions (Spiceflow re-renders loaders).
- **Tables**: use `Frame` + `Table` components like `access-tab.tsx`. All list-like data
  is a table.
- **Tabs** = query params (`?status=`, `?tab=`, `?view=`) with zod `query` schemas on
  the page route; navigate with `router.push` / `Link`; type-safe hrefs via
  `router.href('/org/:orgId/...', { ... })`.
- **Client components** read route data with `useLoaderData('/org/:orgId/*')` (typed via
  `SpiceflowRegister`). Keep UI simple and minimal (Vercel-like, no card-grouping, gap
  spacing, semantic tokens; see the tailwind skill).
- **DB access** only through `getDb()` from `website/src/db.ts` (drizzle sqlite-proxy).
  Reads use `db.query.*` object-where; writes use `db.insert/update/delete` with
  `.where()` + `.limit(1)` for single rows; grouped writes use `db.batch`.
- Timestamps are epoch ms (`epochMs` custom type). IDs are ULIDs. Enums are UPPERCASE
  text enums with DB CHECKs.
- Format dates with deterministic UTC helpers (no `toLocaleDateString` — it causes SSR
  hydration mismatches).

## Dev commands

```bash
pnpm install                       # root
pnpm --filter db typecheck
cd website
pnpm db:migrate:local              # apply migrations to local miniflare D1
pnpm exec wrangler types           # after any wrangler.jsonc change
pnpm typecheck
```

Secrets come from sigillo (`sigillo run -c dev -- ...`); never read secret values or
`.env` files. Never commit; the orchestrating session reviews and commits.
