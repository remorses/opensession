<div align='center' class='hidden'>
    <br/>
    <br/>
    <h3>OpenSession</h3>
    <p>Open-source speaker and session management for conferences</p>
    <br/>
    <br/>
</div>

Free, self-hosted alternative to [SessionBoard](https://sessionboard.com) and [Sessionize](https://sessionize.com). Collect talk submissions, review abstracts, build your agenda, and onboard speakers through a portal. Runs on Cloudflare Workers with zero infrastructure cost.

**[opensession.dev](https://opensession.dev)** · [Self-hosting guide](https://opensession.dev/guides/self-hosting) · [API reference](https://sessionboard.mintlify.app/llms-full.txt)

## Features

| Feature | Description |
| --- | --- |
| **Call for Papers** | MDX forms with conditional logic, multi-speaker support, file uploads. Speakers sign in with Google and submit in minutes. |
| **Abstract Review** | Team voting (Yes/Maybe/No), 1-5 ratings, comments. Accept and decline queues with batch notifications. |
| **Agenda Builder** | Place sessions into rooms and time slots. Conflict engine flags room overlaps and double-booked speakers. |
| **Speaker Portal** | Self-service onboarding: profile, tasks, slide uploads, headshot, social links. Completion tracking for organizers. |
| **Emails & Calendar** | Decision emails, task reminders, ICS calendar invites (RFC 5545). Replies go to the organizer. |
| **Embeds & Feeds** | Embeddable agenda and speaker gallery. JSON, XML, and ICS feeds for your event website. |

## How it works

```
  Speaker submits              Organizer reviews             Organizer schedules
  ┌────────────────┐          ┌────────────────────┐        ┌───────────────────┐
  │  Public CFP    │─────────>│  Abstracts table   │───────>│  Agenda builder   │
  │  Google login  │          │  Vote / Rate / Tag │        │  Rooms & times    │
  │  Draft & submit│          │  Accept / Decline  │        │  Conflict detect  │
  └────────────────┘          └────────────────────┘        └───────┬───────────┘
                                       │                            │
                                       v                            v
                              ┌────────────────────┐        ┌───────────────────┐
                              │  Decision emails   │        │  Calendar invites │
                              │  with ICS attached │        │  auto-sent to all │
                              └────────────────────┘        └───────┬───────────┘
                                                                    │
                                                                    v
                                                            ┌───────────────────┐
                                                            │  Speaker portal   │
                                                            │  Profile + slides │
                                                            │  Task tracking    │
                                                            └───────────────────┘
```

1. **Create your event.** Sign in with Google, name the event, pick dates and timezone.
2. **Publish the CFP.** Share the public link. Speakers submit talks with auto-saving drafts.
3. **Review and accept.** Your team votes on submissions. Batch-accept and notify speakers.
4. **Build the agenda.** Place talks into rooms and time slots. Conflicts are flagged automatically.
5. **Track onboarding.** Speakers complete profile, upload slides, confirm participation through the portal.

## Quick start

```bash
git clone https://github.com/remorses/opensession
cd opensession
pnpm install
```

Create Cloudflare resources:

```bash
cd website
npx wrangler d1 create opensession-db
npx wrangler r2 bucket create opensession-files
```

Set secrets and deploy:

```bash
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET

pnpm db:migrate:remote
pnpm deploy
```

See the full [self-hosting guide](https://opensession.dev/guides/self-hosting) for Google OAuth setup, domain configuration, and local development.

## Stack

- **[Cloudflare Workers](https://workers.cloudflare.com/)** for edge compute, D1 (SQLite), R2 (files), email sending
- **[Spiceflow](https://github.com/nicolo-ribaudo/spiceflow)** for React Server Components, type-safe routes, server actions
- **[Drizzle ORM](https://orm.drizzle.team/)** for type-safe SQL, migrations, SQLite-proxy for D1
- **[BetterAuth](https://www.better-auth.com/)** for Google OAuth, session management
- **[Holocron](https://holocron.so)** for the landing page and docs

## Comparisons

- [OpenSession vs SessionBoard](https://opensession.dev/compare/vs-sessionboard): free and open source vs $40k/year enterprise suite
- [OpenSession vs Sessionize](https://opensession.dev/compare/vs-sessionize): self-hosted control vs managed SaaS with attendee app

## Project structure

```
opensession/
  website/       Cloudflare Worker (Spiceflow app, pages, actions, forms)
  db/            Drizzle schema, migrations, shared types
  docs/          Internal design docs and plans
```

## Local development

```bash
cd website
pnpm db:migrate:local    # apply migrations to local D1
pnpm dev                 # starts on http://localhost:8788
```

Secrets are injected via [sigillo](https://github.com/nicolo-ribaudo/sigillo). Never commit `.env` or `.dev.vars`.

## License

MIT
