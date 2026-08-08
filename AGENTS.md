# OpenSession — agent instructions

OpenSession (repo `opensessions`) is an open-source SessionBoard clone: CFP submission
forms, abstract review, agenda builder, speaker portal, reminder emails, embeds. One
Cloudflare Worker (`website/`), D1 + drizzle (`db/`), Spiceflow RSC, BetterAuth Google
login, holocron landing page, sigillo for secrets.

## MANDATORY: read these before writing any code

Context documents (in this repo):

- `docs/implementation-plan.md` — THE plan: routes, sidebar/tabs design, feature matrix
  per page, MDX form engine design, email/ICS design, milestones. Follow it.
- `docs/database-schema-plan.md` — product research + schema rationale (23 models,
  4 simplification rounds; do not re-add removed features).
- `schema.prisma` — design artifact for the schema. The live schema is
  `db/src/schema.ts` (1:1 drizzle translation). Never edit schema.prisma to change the
  DB; edit `db/src/schema.ts` + write a migration.
- `MEMORY.md` — environment gotchas (dev port 8788, sigillo project ids).
- `images/doc-image-01..40.png` — SessionBoard screenshots showing the UI to replicate.
  View the ones for your feature area (see the brief `$10,0000 Kill My SaaS -
  Competition Brief.md` for the image → feature mapping).

Skills (load with the Skill tool; ALWAYS load the ones relevant to your task):

- `spiceflow` — REQUIRED for any route/page/action work. The skill makes you fetch the
  FULL README; do it, no truncation.
- `tailwind` — REQUIRED before writing any styles or components.
- `drizzle` (+ its cloudflare.md companion) — REQUIRED before touching db code.
- `better-auth` — for anything auth/session related.
- `cloudflare-workers` — for wrangler.jsonc, bindings, cron, R2, tests-in-workerd.
- `transactional-email` — for any email template or send flow.
- `sigillo` — for secrets management.
- `playwriter` — REQUIRED: every UI feature must be validated in the browser (below).

Reference implementations (the products we clone; consult when unsure about behavior):

- SessionBoard API docs (full): https://sessionboard.mintlify.app/llms-full.txt
- Sessionize playbook (organizer docs): https://sessionize.com/playbook/
  Useful pages: /playbook/api, /playbook/schedule-builder, /playbook/evaluations,
  /playbook/speaker-dashboard, /playbook/allowing-speakers-to-edit-sessions,
  /playbook/collecting-and-sharing-presentations, /playbook/features-detailed

## Validation — required after EVERY feature

1. `pnpm typecheck` in `website/` (and `db/` if you touched it).
2. `pnpm exec vitest run --config vitest.config.ts` in `website/`.
3. `bunx lintcn lint` in the package you edited.
4. **Playwriter browser validation**: the dev server runs in tuistory session
   `opensessions-dev` at http://localhost:8788 (`bunx tuistory read -s opensessions-dev`
   for logs; restart with `bunx tuistory launch "sigillo run -c dev -- pnpm exec vite dev"
   -s opensessions-dev --cwd <repo>/website`). Load the pages you built, click through
   the flows (observe → act → observe, check `getLatestLogs` after every action), and
   screenshot the result. A feature is NOT done until it works in the real browser.
   The user's Chrome is signed into Google; login flows work end to end.

## Code patterns (copied from akarso — follow them exactly)

- **Routes** live in `website/src/app.tsx`: `.loader()` per route level (auth +
  membership at `/org/:orgId/*`, event data at `/org/:orgId/e/:eventId/*`), `.layout()`
  for shells, `.page()` with dynamic `import()` of client components.
- **Mutations** are server actions in `website/src/actions.tsx` (`'use server'`), typed
  input objects validated with zod, auth-checked via `getActionRequest()` +
  `requireSession`/`requireOrgAccess` FIRST. Actions redirect with `throw redirect(...)`.
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
