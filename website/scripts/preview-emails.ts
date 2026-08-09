// Render every EmailKind to website/tmp/emails/*.html for light/dark review.
//
// Run: cd website && pnpm exec tsx scripts/preview-emails.ts
//
// The templates are pure strings with no DB or env access, which is exactly why
// this script can exist. Open the generated files in a browser (or screenshot
// them with Playwriter) and check BOTH color schemes before shipping a copy
// change.

import fs from 'node:fs'
import path from 'node:path'
import {
  buildEmail,
  type EmailContext,
  type EmailKind,
  type EmailPayload,
} from '../src/lib/emails/templates.ts'

const context: EmailContext = {
  eventName: 'AI Engineer World Fair',
  eventSlug: 'aie-world-fair',
  appUrl: 'https://opensession.dev',
  timezone: 'America/Los_Angeles',
  recipientName: 'Ada Lovelace',
}

const startsAt = Date.UTC(2026, 9, 12, 17, 30, 0)
const endsAt = Date.UTC(2026, 9, 12, 18, 0, 0)
const dueAt = Date.UTC(2026, 8, 30, 7, 0, 0)
const sessionTitle = 'Shipping React Server Components on the edge'

const payloads: EmailPayload[] = [
  {
    kind: 'SUBMISSION_CONFIRMATION',
    context,
    data: { sessionId: '01JSESSION', sessionTitle },
  },
  { kind: 'DECISION_ACCEPTED', context, data: { sessionId: '01JSESSION', sessionTitle } },
  { kind: 'DECISION_DECLINED', context, data: { sessionId: '01JSESSION', sessionTitle } },
  {
    kind: 'TASK_ASSIGNED',
    context,
    data: { assignmentId: '01JTASK', taskTitle: 'Complete speaker profile', dueAt },
  },
  {
    kind: 'TASK_REMINDER',
    context,
    data: {
      assignmentId: '01JTASK2',
      taskTitle: 'Upload session materials',
      dueAt,
      sessionTitle,
      daysUntilDue: 1,
    },
  },
  {
    kind: 'DRAFT_REMINDER',
    context,
    data: { formName: 'Call for speakers', formSlug: 'cfp', closesAt: dueAt, daysUntilClose: 3 },
  },
  {
    kind: 'SCHEDULE_INVITE',
    context,
    data: { sessionId: '01JSESSION', sessionTitle, startsAt, endsAt, roomName: 'Main Hall' },
  },
  {
    kind: 'SCHEDULE_UPDATE',
    context,
    data: { sessionId: '01JSESSION', sessionTitle, startsAt, endsAt, roomName: 'Room B' },
  },
  {
    kind: 'SCHEDULE_CANCEL',
    context,
    data: { sessionId: '01JSESSION', sessionTitle, startsAt, endsAt },
  },
  {
    kind: 'REVIEWER_INVITE',
    context,
    data: { roundName: 'Initial Review', inviteUrl: 'https://opensession.dev/invite/01JINVITE' },
  },
  {
    kind: 'REVIEW_REMINDER',
    context,
    data: { roundName: 'Initial Review', reviewUrl: 'https://opensession.dev/review/01JROUND', pendingCount: 2, closesAt: dueAt },
  },
]

function fileName(kind: EmailKind): string {
  return `${kind.toLowerCase().replace(/_/g, '-')}.html`
}

const outDir = path.join(process.cwd(), 'tmp', 'emails')
fs.mkdirSync(outDir, { recursive: true })

const index: string[] = []
for (const payload of payloads) {
  const email = buildEmail(payload)
  const target = path.join(outDir, fileName(payload.kind))
  fs.writeFileSync(target, email.html)
  console.log(`wrote ${target}`)
  console.log(`  subject: ${email.subject}`)
  index.push(
    `<li><a href="./${fileName(payload.kind)}">${payload.kind}</a> — ${email.subject}</li>`,
  )
  // The text alternative is what plain-text clients and spam filters read, so
  // dump it next to the HTML instead of leaving it unreviewed.
  const textTarget = target.replace(/\.html$/, '.txt')
  fs.writeFileSync(textTarget, email.text)
  console.log(`  wrote ${textTarget}`)
}

const indexPath = path.join(outDir, 'index.html')
fs.writeFileSync(
  indexPath,
  `<!DOCTYPE html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><body style="font-family: Arial, sans-serif; padding: 24px;"><ul>${index.join('')}</ul></body>`,
)
console.log(`wrote ${indexPath}`)
console.log(`done, ${payloads.length} templates rendered`)
