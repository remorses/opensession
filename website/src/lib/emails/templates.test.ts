// Snapshot tests for all 9 email templates plus the injection guards:
// attacker-controlled titles must be HTML-escaped in the body and stripped of
// newlines in the subject (raw MIME header injection).

import { describe, expect, test } from 'vitest'
import {
  buildEmail,
  escapeHtml,
  formatEventDate,
  formatEventTime,
  sanitizeSubject,
  type EmailContext,
  type EmailKind,
  type EmailPayload,
} from './templates.ts'

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

const payloads: Record<EmailKind, EmailPayload> = {
  SUBMISSION_CONFIRMATION: {
    kind: 'SUBMISSION_CONFIRMATION',
    context,
    data: { sessionId: 'S1', sessionTitle: 'Shipping RSC on the edge' },
  },
  DECISION_ACCEPTED: {
    kind: 'DECISION_ACCEPTED',
    context,
    data: { sessionId: 'S1', sessionTitle: 'Shipping RSC on the edge' },
  },
  DECISION_DECLINED: {
    kind: 'DECISION_DECLINED',
    context,
    data: { sessionId: 'S1', sessionTitle: 'Shipping RSC on the edge' },
  },
  TASK_ASSIGNED: {
    kind: 'TASK_ASSIGNED',
    context,
    data: { assignmentId: 'A1', taskTitle: 'Complete speaker profile', dueAt },
  },
  TASK_REMINDER: {
    kind: 'TASK_REMINDER',
    context,
    data: {
      assignmentId: 'A2',
      taskTitle: 'Upload session materials',
      dueAt,
      sessionTitle: 'Shipping RSC on the edge',
      daysUntilDue: 3,
    },
  },
  DRAFT_REMINDER: {
    kind: 'DRAFT_REMINDER',
    context,
    data: {
      formName: 'Call for speakers',
      formSlug: 'cfp',
      closesAt: dueAt,
      daysUntilClose: 1,
    },
  },
  SCHEDULE_INVITE: {
    kind: 'SCHEDULE_INVITE',
    context,
    data: {
      sessionId: 'S1',
      sessionTitle: 'Shipping RSC on the edge',
      startsAt,
      endsAt,
      roomName: 'Main Hall',
    },
  },
  SCHEDULE_UPDATE: {
    kind: 'SCHEDULE_UPDATE',
    context,
    data: {
      sessionId: 'S1',
      sessionTitle: 'Shipping RSC on the edge',
      startsAt,
      endsAt,
      roomName: 'Room B',
    },
  },
  SCHEDULE_CANCEL: {
    kind: 'SCHEDULE_CANCEL',
    context,
    data: { sessionId: 'S1', sessionTitle: 'Shipping RSC on the edge', startsAt, endsAt },
  },
  REVIEWER_INVITE: {
    kind: 'REVIEWER_INVITE',
    context,
    data: { roundName: 'Initial Review', inviteUrl: 'https://opensession.dev/invite/I1' },
  },
  REVIEW_REMINDER: {
    kind: 'REVIEW_REMINDER',
    context,
    data: { roundName: 'Initial Review', reviewUrl: 'https://opensession.dev/review/F1', pendingCount: 2, closesAt: dueAt },
  },
}

describe('formatters', () => {
  test('render in the event timezone, not UTC', () => {
    expect(formatEventTime(startsAt, 'America/Los_Angeles')).toMatchInlineSnapshot(
      `"Mon, Oct 12, 2026, 10:30 AM PDT"`,
    )
    expect(formatEventTime(startsAt, 'Europe/Rome')).toMatchInlineSnapshot(
      `"Mon, Oct 12, 2026, 7:30 PM GMT+2"`,
    )
    expect(formatEventDate(startsAt, 'America/Los_Angeles')).toMatchInlineSnapshot(
      `"Mon, Oct 12, 2026"`,
    )
  })
})

describe('subjects', () => {
  test('every kind has a short, specific subject', () => {
    const subjects = Object.fromEntries(
      (Object.keys(payloads) as EmailKind[]).map((kind) => [
        kind,
        buildEmail(payloads[kind]).subject,
      ]),
    )
    expect(subjects).toMatchInlineSnapshot(`
      {
        "DECISION_ACCEPTED": "Your talk was accepted for AI Engineer World Fair",
        "DECISION_DECLINED": "Update on your AI Engineer World Fair submission",
        "DRAFT_REMINDER": "Your AI Engineer World Fair draft is still unsubmitted",
        "REVIEWER_INVITE": "Review submissions for AI Engineer World Fair",
        "REVIEW_REMINDER": "Reminder: 2 reviews left for Initial Review",
        "SCHEDULE_CANCEL": "Shipping RSC on the edge was removed from the schedule",
        "SCHEDULE_INVITE": "Your AI Engineer World Fair session is scheduled",
        "SCHEDULE_UPDATE": "Time change for Shipping RSC on the edge",
        "SUBMISSION_CONFIRMATION": "We got your submission for AI Engineer World Fair",
        "TASK_ASSIGNED": "New task: Complete speaker profile",
        "TASK_REMINDER": "Reminder: Upload session materials",
      }
    `)
  })

  test('overdue task reminders change the subject', () => {
    const email = buildEmail({
      kind: 'TASK_REMINDER',
      context,
      data: {
        assignmentId: 'A2',
        taskTitle: 'Upload session materials',
        dueAt,
        daysUntilDue: -2,
      },
    })
    expect(email.subject).toMatchInlineSnapshot(`"Overdue: Upload session materials"`)
    expect(email.text).toContain('It was due Wed, Sep 30, 2026.')
  })
})

describe('bodies', () => {
  test('SUBMISSION_CONFIRMATION html', () => {
    expect('\n' + buildEmail(payloads.SUBMISSION_CONFIRMATION).html).toMatchInlineSnapshot(`
      "
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <meta name="supported-color-schemes" content="light dark" />
          <style>
            body { background-color: #ffffff; }
            a { color: #15c; }
            @media (prefers-color-scheme: dark) {
              body { background-color: #1f1f1f !important; color: #e3e3e3 !important; }
              a { color: #8ab4f8 !important; }
            }
          </style>
        </head>
        <body style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.5; color: #222; margin: 0; padding: 16px; -webkit-text-size-adjust: 100%;">
          <div style="max-width: 600px;">
            <p>Hey Ada,</p>

            <p>thanks for submitting <strong>Shipping RSC on the edge</strong> to AI Engineer World Fair. It is in the review queue now.</p>

            <p>You can review or edit it while it is still pending: <a href="https://opensession.dev/portal/aie-world-fair/submissions/S1">https://opensession.dev/portal/aie-world-fair/submissions/S1</a></p>

            <p>We will email you as soon as the program committee decides.</p>

            <p>If anything looks off, just reply to this email.<br />AI Engineer World Fair</p>
          </div>
        </body>
      </html>"
    `)
  })

  test('every kind renders a plain-text alternative', () => {
    const texts = Object.fromEntries(
      (Object.keys(payloads) as EmailKind[]).map((kind) => [
        kind,
        buildEmail(payloads[kind]).text,
      ]),
    )
    expect('\n' + JSON.stringify(texts, null, 2)).toMatchInlineSnapshot(`
      "
      {
        "SUBMISSION_CONFIRMATION": "Hey Ada,\\n\\nthanks for submitting \\"Shipping RSC on the edge\\" to AI Engineer World Fair. It is in the review queue now.\\n\\nYou can review or edit it while it is still pending:\\nhttps://opensession.dev/portal/aie-world-fair/submissions/S1\\n\\nWe will email you as soon as the program committee decides.\\n\\nIf anything looks off, just reply to this email.\\nAI Engineer World Fair",
        "DECISION_ACCEPTED": "Hey Ada,\\n\\ngood news: \\"Shipping RSC on the edge\\" was accepted for AI Engineer World Fair.\\n\\nYour speaker portal is open. There are a few onboarding tasks waiting there, like your profile and your slides:\\nhttps://opensession.dev/portal/aie-world-fair\\n\\nWe will send a calendar invite once your session has a room and a time.\\n\\nIf anything looks off, just reply to this email.\\nAI Engineer World Fair",
        "DECISION_DECLINED": "Hey Ada,\\n\\nthanks for submitting \\"Shipping RSC on the edge\\" to AI Engineer World Fair.\\n\\nWe could not fit it into the program this time. That is not a judgement on the work; we simply had far more good proposals than slots.\\n\\nPlease do submit again next time.\\n\\nIf anything looks off, just reply to this email.\\nAI Engineer World Fair",
        "TASK_ASSIGNED": "Hey Ada,\\n\\nthere is a new task waiting in your AI Engineer World Fair speaker portal: \\"Complete speaker profile\\". It is due Wed, Sep 30, 2026.\\n\\nhttps://opensession.dev/portal/aie-world-fair/tasks/A1\\n\\nIf anything looks off, just reply to this email.\\nAI Engineer World Fair",
        "TASK_REMINDER": "Hey Ada,\\n\\n\\"Upload session materials\\" is still open in your AI Engineer World Fair speaker portal. It is due in 3 days.\\n\\nIt takes a couple of minutes:\\nhttps://opensession.dev/portal/aie-world-fair/tasks/A2\\n\\nIf anything looks off, just reply to this email.\\nAI Engineer World Fair",
        "DRAFT_REMINDER": "Hey Ada,\\n\\nyou started a submission for \\"Call for speakers\\" but never sent it. It closes in 1 day, on Wed, Sep 30, 2026.\\n\\nYour draft is saved, pick it up here:\\nhttps://opensession.dev/submit/aie-world-fair/cfp\\n\\nIf anything looks off, just reply to this email.\\nAI Engineer World Fair",
        "SCHEDULE_INVITE": "Hey Ada,\\n\\n\\"Shipping RSC on the edge\\" now has a slot at AI Engineer World Fair.\\n\\nWhen: Mon, Oct 12, 2026, 10:30 AM PDT to Mon, Oct 12, 2026, 11:00 AM PDT\\nWhere: Main Hall\\n\\nThe calendar invite is attached, so it should land in your calendar automatically. Details:\\nhttps://opensession.dev/portal/aie-world-fair/submissions/S1\\n\\nIf anything looks off, just reply to this email.\\nAI Engineer World Fair",
        "SCHEDULE_UPDATE": "Hey Ada,\\n\\nthe slot for \\"Shipping RSC on the edge\\" at AI Engineer World Fair moved.\\n\\nWhen: Mon, Oct 12, 2026, 10:30 AM PDT to Mon, Oct 12, 2026, 11:00 AM PDT\\nWhere: Room B\\n\\nThe attached invite updates the entry already in your calendar. Details:\\nhttps://opensession.dev/portal/aie-world-fair/submissions/S1\\n\\nIf anything looks off, just reply to this email.\\nAI Engineer World Fair",
        "SCHEDULE_CANCEL": "Hey Ada,\\n\\n\\"Shipping RSC on the edge\\" was taken off the AI Engineer World Fair schedule and the calendar entry is cancelled.\\n\\nIf this is a surprise, reply here and we will sort it out.\\n\\nIf anything looks off, just reply to this email.\\nAI Engineer World Fair",
        "REVIEWER_INVITE": "Hey Ada,\\n\\nyou were invited to join the \\"Initial Review\\" reviewer pool for AI Engineer World Fair.\\n\\nAccept the invitation with the Google account that received this email:\\nhttps://opensession.dev/invite/I1\\n\\nIf anything looks off, just reply to this email.\\nAI Engineer World Fair",
        "REVIEW_REMINDER": "Hey Ada,\\n\\nyou still have 2 reviews to finish in Initial Review. The round closes Wed, Sep 30, 2026.\\n\\nhttps://opensession.dev/review/F1\\n\\nIf anything looks off, just reply to this email.\\nAI Engineer World Fair"
      }"
    `)
  })

  test('every kind links back to an absolute opensession.dev url', () => {
    for (const kind of Object.keys(payloads) as EmailKind[]) {
      const email = buildEmail(payloads[kind])
      // CANCEL is the one mail with nothing left to link to.
      if (kind === 'SCHEDULE_CANCEL' || kind === 'DECISION_DECLINED') continue
      expect(email.html, kind).toContain('https://opensession.dev/')
      expect(email.text, kind).toContain('https://opensession.dev/')
    }
  })

  test('every kind invites a reply', () => {
    for (const kind of Object.keys(payloads) as EmailKind[]) {
      expect(buildEmail(payloads[kind]).text, kind).toContain('just reply to this email')
    }
  })
})

describe('injection guards', () => {
  const hostile = '<img src=x onerror=alert(1)>'

  test('escapeHtml neutralizes tags and quotes', () => {
    expect(escapeHtml(`${hostile} "quoted" & 'single'`)).toMatchInlineSnapshot(
      `"&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &amp; &#39;single&#39;"`,
    )
  })

  test('a hostile session title cannot break out of the html body', () => {
    const email = buildEmail({
      kind: 'DECISION_ACCEPTED',
      context: { ...context, eventName: hostile, recipientName: hostile },
      data: { sessionId: 'S1', sessionTitle: hostile },
    })
    expect(email.html).not.toContain('<img src=x')
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    // The text alternative is not HTML, so the raw string is fine there, but it
    // must never gain a script-executing context.
    expect(email.text).toContain(hostile)
  })

  test('a newline in a title cannot inject a mail header', () => {
    const email = buildEmail({
      kind: 'SCHEDULE_UPDATE',
      context,
      data: {
        sessionId: 'S1',
        sessionTitle: 'Talk\r\nBcc: victim@example.com',
        startsAt,
        endsAt,
      },
    })
    expect(email.subject).toMatchInlineSnapshot(
      `"Time change for Talk Bcc: victim@example.com"`,
    )
    expect(email.subject).not.toContain('\n')
    expect(email.subject).not.toContain('\r')
  })

  test('subjects are capped below the 998 char header limit', () => {
    expect(sanitizeSubject('x'.repeat(2000))).toHaveLength(998)
  })
})
