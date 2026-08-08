# Memory

## #project references resolve via kimaki, not folder names

When Tommy references `#akarso` or any `#project`, resolve it with
`kimaki project list --json` (channel_name → directory). Do NOT guess from
similarly-named folders in ~/Documents/GitHub (akarso-sso ≠ akarso; the real
akarso lives at ~/.kimaki/projects/akarso).

## This repo is built on akarso

Base project: ~/.kimaki/projects/akarso (BetterAuth on Cloudflare D1 via
drizzle, ULID ids, epochMs timestamps). Shared concepts (user/session/account/
verification, org, org_member, org_invitation) must keep akarso's exact shape
so code ports directly. Domain session table is `event_session` because
BetterAuth owns `session`.

## schema.prisma is a design artifact

Prisma has no enums on SQLite and forbids composite FKs mixing required +
nullable columns. Validate with: swap provider to postgresql into a tmp file,
then `DATABASE_URL='postgresql://x:x@localhost:5432/x' npx -y prisma@6
validate`. Constraints Prisma can't express live in the header appendix
comment (partial uniques, CHECKs, nullable composite FKs) for the drizzle
migration.

## Dev server runs on port 8788, not 8787

Port 8787 is taken by another local process, so website/vite.config.ts uses 8788 and the Google OAuth origins + dev BETTER_AUTH_URL use http://localhost:8788. Sigillo project is org `opensessions` / project `website` (01KZGPCGNE9SJ5PS6F2GSHDY9N).

## Legacy `opensessions` names that cannot be renamed

The product is OpenSession on opensession.dev. Two leftovers keep the old plural
spelling: the local checkout folder `~/Documents/GitHub/opensessions` (renaming breaks
the kimaki project mapping) and the sigillo org `opensessions` (the CLI has no
`orgs update` command). Everything else must say `opensession`.
