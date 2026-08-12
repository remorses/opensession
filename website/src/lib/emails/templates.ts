// Transactional email templates for every EmailKind (pure — no DB, no env).
//
// Plain HTML template strings on purpose. React/JSX rendering is impossible
// here: react-dom/server is unavailable under the react-server condition, and
// framework renderers cannot run from the preview script or the cron. Strings
// work in every runtime.
//
// House style (see the transactional-email skill): looks like a message a human
// typed in Gmail. No headings, no logo header, no branded footer, no dividers.
// Gmail-default typography, Gmail-blue links WITH underline, one dark-mode
// media query. Replies are encouraged because Reply-To is the organizer.
//
// SECURITY: session titles, speaker names, and event names are attacker
// controlled (anyone can submit a CFP). Every interpolated value goes through
// escapeHtml. There is no raw-HTML escape hatch in this module on purpose.

import dedent from 'string-dedent'

export type EmailKind =
  | 'SUBMISSION_CONFIRMATION'
  | 'DECISION_ACCEPTED'
  | 'DECISION_DECLINED'
  | 'TASK_ASSIGNED'
  | 'TASK_REMINDER'
  | 'DRAFT_REMINDER'
  | 'SCHEDULE_INVITE'
  | 'SCHEDULE_UPDATE'
  | 'SCHEDULE_CANCEL'
  | 'REVIEWER_INVITE'
  | 'REVIEW_REMINDER'
  | 'SPEAKER_INVITE'
  | 'CUSTOM'

export type BuiltEmail = { subject: string; html: string; text: string }

/** Fields every template needs to address the reader and link back. */
export type EmailContext = {
  eventName: string
  eventSlug: string
  /** Absolute origin, no trailing slash, e.g. "https://opensession.dev". */
  appUrl: string
  /** IANA zone of the event — all human-readable times render in it. */
  timezone: string
  recipientName?: string | null
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
}

function paragraph(html: string): string {
  return `<p>${html}</p>`
}

/**
 * Deterministic timezone-aware formatting. Intl with an EXPLICIT timeZone and
 * locale is safe here because this only ever runs server-side while building an
 * email body; never call it from a component that hydrates (the client's tz
 * would differ from the server's and React would scream).
 */
export function formatEventTime(epochMs: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(epochMs))
}

export function formatEventDate(epochMs: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(epochMs))
}

function greeting(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0]
  return first ? `Hey ${escapeHtml(first)},` : 'Hey,'
}

function greetingText(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0]
  return first ? `Hey ${first},` : 'Hey,'
}

/** Gmail-default shell. The only chrome an email in this product gets. */
function shell(bodyHtml: string): string {
  const HTML = dedent`
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
    ${bodyHtml}
        </div>
      </body>
    </html>
  `
  return HTML
}

const SIGN_OFF_HTML = (context: EmailContext) =>
  paragraph(
    `If anything looks off, just reply to this email.<br />${escapeHtml(context.eventName)}`,
  )

const SIGN_OFF_TEXT = (context: EmailContext) =>
  `If anything looks off, just reply to this email.\n${context.eventName}`

/**
 * Subjects become a raw MIME header. A newline in an attacker-controlled
 * session title would otherwise inject arbitrary headers (Bcc, Content-Type),
 * so collapse all whitespace and cap at the Cloudflare 998-char limit.
 */
export function sanitizeSubject(subject: string): string {
  const flat = subject.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return flat.length > 998 ? `${flat.slice(0, 995)}...` : flat
}

function compose(
  context: EmailContext,
  subject: string,
  parts: { html: string[]; text: string[] },
): BuiltEmail {
  const html = shell(
    [
      paragraph(greeting(context.recipientName)),
      ...parts.html,
      SIGN_OFF_HTML(context),
    ]
      .map((block) => `      ${block}`)
      .join('\n\n'),
  )
  const text = [greetingText(context.recipientName), ...parts.text, SIGN_OFF_TEXT(context)].join(
    '\n\n',
  )
  return { subject: sanitizeSubject(subject), html, text }
}

// ── URL builders ────────────────────────────────────────────────────
// Every link is absolute (mail clients have no origin) and slug-based, so
// internal ids never leak into an inbox.

export function portalUrl(context: EmailContext): string {
  return `${context.appUrl}/portal/${context.eventSlug}`
}

export function portalSubmissionUrl(context: EmailContext, sessionId: string): string {
  return `${portalUrl(context)}/submissions/${sessionId}`
}

export function portalTaskUrl(context: EmailContext, assignmentId: string): string {
  return `${portalUrl(context)}/tasks/${assignmentId}`
}

export function submitFormUrl(context: EmailContext, formSlug: string): string {
  return `${context.appUrl}/submit/${context.eventSlug}/${formSlug}`
}

// ── Payloads ────────────────────────────────────────────────────────

export type SubmissionConfirmationData = {
  sessionId: string
  sessionTitle: string
}

export type DecisionData = {
  sessionId: string
  sessionTitle: string
}

export type TaskData = {
  assignmentId: string
  taskTitle: string
  /** Epoch ms; null when the organizer set no deadline. */
  dueAt: number | null
  /** Set for SUBMISSION-target tasks so the speaker knows which talk. */
  sessionTitle?: string | null
}

export type TaskReminderData = TaskData & {
  /** Whole days until dueAt; negative means overdue. */
  daysUntilDue: number
}

export type DraftReminderData = {
  formName: string
  formSlug: string
  /** Epoch ms when the form stops accepting submissions. */
  closesAt: number
  daysUntilClose: number
}

export type ScheduleData = {
  sessionId: string
  sessionTitle: string
  startsAt: number
  endsAt: number
  roomName?: string | null
}

export type ReviewerInviteData = { roundName: string; inviteUrl: string }
export type ReviewReminderData = { roundName: string; reviewUrl: string; pendingCount: number; closesAt: number | null }
export type SpeakerInviteData = { portalUrl: string }
export type CustomEmailData = { subject: string; body: string }

export type EmailPayload =
  | { kind: 'SUBMISSION_CONFIRMATION'; context: EmailContext; data: SubmissionConfirmationData }
  | { kind: 'DECISION_ACCEPTED'; context: EmailContext; data: DecisionData }
  | { kind: 'DECISION_DECLINED'; context: EmailContext; data: DecisionData }
  | { kind: 'TASK_ASSIGNED'; context: EmailContext; data: TaskData }
  | { kind: 'TASK_REMINDER'; context: EmailContext; data: TaskReminderData }
  | { kind: 'DRAFT_REMINDER'; context: EmailContext; data: DraftReminderData }
  | { kind: 'SCHEDULE_INVITE'; context: EmailContext; data: ScheduleData }
  | { kind: 'SCHEDULE_UPDATE'; context: EmailContext; data: ScheduleData }
  | { kind: 'SCHEDULE_CANCEL'; context: EmailContext; data: ScheduleData }
  | { kind: 'REVIEWER_INVITE'; context: EmailContext; data: ReviewerInviteData }
  | { kind: 'REVIEW_REMINDER'; context: EmailContext; data: ReviewReminderData }
  | { kind: 'SPEAKER_INVITE'; context: EmailContext; data: SpeakerInviteData }
  | { kind: 'CUSTOM'; context: EmailContext; data: CustomEmailData }

/** Single entry point: send.ts never picks a builder by hand. */
export function buildEmail(payload: EmailPayload): BuiltEmail {
  switch (payload.kind) {
    case 'SUBMISSION_CONFIRMATION':
      return buildSubmissionConfirmation(payload.context, payload.data)
    case 'DECISION_ACCEPTED':
      return buildDecisionAccepted(payload.context, payload.data)
    case 'DECISION_DECLINED':
      return buildDecisionDeclined(payload.context, payload.data)
    case 'TASK_ASSIGNED':
      return buildTaskAssigned(payload.context, payload.data)
    case 'TASK_REMINDER':
      return buildTaskReminder(payload.context, payload.data)
    case 'DRAFT_REMINDER':
      return buildDraftReminder(payload.context, payload.data)
    case 'SCHEDULE_INVITE':
      return buildScheduleInvite(payload.context, payload.data)
    case 'SCHEDULE_UPDATE':
      return buildScheduleUpdate(payload.context, payload.data)
    case 'SCHEDULE_CANCEL':
      return buildScheduleCancel(payload.context, payload.data)
    case 'REVIEWER_INVITE':
      return buildReviewerInvite(payload.context, payload.data)
    case 'REVIEW_REMINDER':
      return buildReviewReminder(payload.context, payload.data)
    case 'SPEAKER_INVITE':
      return buildSpeakerInvite(payload.context, payload.data)
    case 'CUSTOM':
      return buildCustomEmail(payload.context, payload.data)
  }
}

// ── Templates ───────────────────────────────────────────────────────

export function buildSubmissionConfirmation(
  context: EmailContext,
  data: SubmissionConfirmationData,
): BuiltEmail {
  const url = portalSubmissionUrl(context, data.sessionId)
  return compose(context, `We got your submission for ${context.eventName}`, {
    html: [
      paragraph(
        `thanks for submitting <strong>${escapeHtml(data.sessionTitle)}</strong> to ${escapeHtml(context.eventName)}. It is in the review queue now.`,
      ),
      paragraph(
        `You can review or edit it while it is still pending: ${link(url, url)}`,
      ),
      paragraph(`We will email you as soon as the program committee decides.`),
    ],
    text: [
      `thanks for submitting "${data.sessionTitle}" to ${context.eventName}. It is in the review queue now.`,
      `You can review or edit it while it is still pending:\n${url}`,
      `We will email you as soon as the program committee decides.`,
    ],
  })
}

export function buildDecisionAccepted(
  context: EmailContext,
  data: DecisionData,
): BuiltEmail {
  const url = portalUrl(context)
  return compose(context, `Your talk was accepted for ${context.eventName}`, {
    html: [
      paragraph(
        `good news: <strong>${escapeHtml(data.sessionTitle)}</strong> was accepted for ${escapeHtml(context.eventName)}.`,
      ),
      paragraph(
        `Your speaker portal is open. There are a few onboarding tasks waiting there, like your profile and your slides: ${link(url, url)}`,
      ),
      paragraph(
        `We will send a calendar invite once your session has a room and a time.`,
      ),
    ],
    text: [
      `good news: "${data.sessionTitle}" was accepted for ${context.eventName}.`,
      `Your speaker portal is open. There are a few onboarding tasks waiting there, like your profile and your slides:\n${url}`,
      `We will send a calendar invite once your session has a room and a time.`,
    ],
  })
}

export function buildDecisionDeclined(
  context: EmailContext,
  data: DecisionData,
): BuiltEmail {
  return compose(context, `Update on your ${context.eventName} submission`, {
    html: [
      paragraph(
        `thanks for submitting <strong>${escapeHtml(data.sessionTitle)}</strong> to ${escapeHtml(context.eventName)}.`,
      ),
      paragraph(
        `We could not fit it into the program this time. That is not a judgement on the work; we simply had far more good proposals than slots.`,
      ),
      paragraph(`Please do submit again next time.`),
    ],
    text: [
      `thanks for submitting "${data.sessionTitle}" to ${context.eventName}.`,
      `We could not fit it into the program this time. That is not a judgement on the work; we simply had far more good proposals than slots.`,
      `Please do submit again next time.`,
    ],
  })
}

function dueLine(dueAt: number | null, timezone: string): string | null {
  if (dueAt == null) return null
  return `It is due ${formatEventDate(dueAt, timezone)}.`
}

export function buildTaskAssigned(context: EmailContext, data: TaskData): BuiltEmail {
  const url = portalTaskUrl(context, data.assignmentId)
  const due = dueLine(data.dueAt, context.timezone)
  const forSession = data.sessionTitle
    ? ` for <strong>${escapeHtml(data.sessionTitle)}</strong>`
    : ''
  const forSessionText = data.sessionTitle ? ` for "${data.sessionTitle}"` : ''
  return compose(context, `New task: ${data.taskTitle}`, {
    html: [
      paragraph(
        `there is a new task waiting in your ${escapeHtml(context.eventName)} speaker portal: <strong>${escapeHtml(data.taskTitle)}</strong>${forSession}.${due ? ` ${escapeHtml(due)}` : ''}`,
      ),
      paragraph(link(url, url)),
    ],
    text: [
      `there is a new task waiting in your ${context.eventName} speaker portal: "${data.taskTitle}"${forSessionText}.${due ? ` ${due}` : ''}`,
      url,
    ],
  })
}

export function buildTaskReminder(
  context: EmailContext,
  data: TaskReminderData,
): BuiltEmail {
  const url = portalTaskUrl(context, data.assignmentId)
  const overdue = data.daysUntilDue < 0
  const when = data.dueAt == null
    ? 'Please complete it when you can.'
    : overdue
      ? `It was due ${formatEventDate(data.dueAt, context.timezone)}.`
      : data.daysUntilDue === 0
        ? 'It is due today.'
        : `It is due in ${data.daysUntilDue} day${data.daysUntilDue === 1 ? '' : 's'}.`
  const subject = overdue
    ? `Overdue: ${data.taskTitle}`
    : `Reminder: ${data.taskTitle}`
  return compose(context, subject, {
    html: [
      paragraph(
        `<strong>${escapeHtml(data.taskTitle)}</strong> is still open in your ${escapeHtml(context.eventName)} speaker portal. ${escapeHtml(when)}`,
      ),
      paragraph(`It takes a couple of minutes: ${link(url, url)}`),
    ],
    text: [
      `"${data.taskTitle}" is still open in your ${context.eventName} speaker portal. ${when}`,
      `It takes a couple of minutes:\n${url}`,
    ],
  })
}

export function buildDraftReminder(
  context: EmailContext,
  data: DraftReminderData,
): BuiltEmail {
  const url = submitFormUrl(context, data.formSlug)
  const when =
    data.daysUntilClose <= 0
      ? 'It closes today.'
      : `It closes in ${data.daysUntilClose} day${data.daysUntilClose === 1 ? '' : 's'}, on ${formatEventDate(data.closesAt, context.timezone)}.`
  return compose(context, `Your ${context.eventName} draft is still unsubmitted`, {
    html: [
      paragraph(
        `you started a submission for <strong>${escapeHtml(data.formName)}</strong> but never sent it. ${escapeHtml(when)}`,
      ),
      paragraph(`Your draft is saved, pick it up here: ${link(url, url)}`),
    ],
    text: [
      `you started a submission for "${data.formName}" but never sent it. ${when}`,
      `Your draft is saved, pick it up here:\n${url}`,
    ],
  })
}

function scheduleLines(context: EmailContext, data: ScheduleData): string[] {
  const lines = [
    `When: ${formatEventTime(data.startsAt, context.timezone)} to ${formatEventTime(data.endsAt, context.timezone)}`,
  ]
  if (data.roomName) lines.push(`Where: ${data.roomName}`)
  return lines
}

function scheduleListHtml(lines: string[]): string {
  const items = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('\n        ')
  return `<ul style="margin: 0 0 16px 0; padding-left: 24px;">\n        ${items}\n      </ul>`
}

export function buildScheduleInvite(
  context: EmailContext,
  data: ScheduleData,
): BuiltEmail {
  const url = portalSubmissionUrl(context, data.sessionId)
  const lines = scheduleLines(context, data)
  return compose(context, `Your ${context.eventName} session is scheduled`, {
    html: [
      paragraph(
        `<strong>${escapeHtml(data.sessionTitle)}</strong> now has a slot at ${escapeHtml(context.eventName)}.`,
      ),
      scheduleListHtml(lines),
      paragraph(
        `The calendar invite is attached, so it should land in your calendar automatically. Details: ${link(url, url)}`,
      ),
    ],
    text: [
      `"${data.sessionTitle}" now has a slot at ${context.eventName}.`,
      lines.join('\n'),
      `The calendar invite is attached, so it should land in your calendar automatically. Details:\n${url}`,
    ],
  })
}

export function buildScheduleUpdate(
  context: EmailContext,
  data: ScheduleData,
): BuiltEmail {
  const url = portalSubmissionUrl(context, data.sessionId)
  const lines = scheduleLines(context, data)
  return compose(context, `Time change for ${data.sessionTitle}`, {
    html: [
      paragraph(
        `the slot for <strong>${escapeHtml(data.sessionTitle)}</strong> at ${escapeHtml(context.eventName)} moved.`,
      ),
      scheduleListHtml(lines),
      paragraph(
        `The attached invite updates the entry already in your calendar. Details: ${link(url, url)}`,
      ),
    ],
    text: [
      `the slot for "${data.sessionTitle}" at ${context.eventName} moved.`,
      lines.join('\n'),
      `The attached invite updates the entry already in your calendar. Details:\n${url}`,
    ],
  })
}

export function buildScheduleCancel(
  context: EmailContext,
  data: ScheduleData,
): BuiltEmail {
  return compose(context, `${data.sessionTitle} was removed from the schedule`, {
    html: [
      paragraph(
        `<strong>${escapeHtml(data.sessionTitle)}</strong> was taken off the ${escapeHtml(context.eventName)} schedule and the calendar entry is cancelled.`,
      ),
      paragraph(`If this is a surprise, reply here and we will sort it out.`),
    ],
    text: [
      `"${data.sessionTitle}" was taken off the ${context.eventName} schedule and the calendar entry is cancelled.`,
      `If this is a surprise, reply here and we will sort it out.`,
    ],
  })
}

export function buildReviewerInvite(context: EmailContext, data: ReviewerInviteData): BuiltEmail {
  return compose(context, `Review submissions for ${context.eventName}`, {
    html: [
      paragraph(`you were invited to join the <strong>${escapeHtml(data.roundName)}</strong> reviewer pool for ${escapeHtml(context.eventName)}.`),
      paragraph(`Accept the invitation with the verified email address that received this message: ${link(data.inviteUrl, data.inviteUrl)}`),
    ],
    text: [
      `you were invited to join the "${data.roundName}" reviewer pool for ${context.eventName}.`,
      `Accept the invitation with the verified email address that received this message:\n${data.inviteUrl}`,
    ],
  })
}

export function buildReviewReminder(context: EmailContext, data: ReviewReminderData): BuiltEmail {
  const deadline = data.closesAt == null ? '' : ` The round closes ${formatEventDate(data.closesAt, context.timezone)}.`
  const count = `${data.pendingCount} review${data.pendingCount === 1 ? '' : 's'}`
  return compose(context, `Reminder: ${count} left for ${data.roundName}`, {
    html: [
      paragraph(`you still have <strong>${count}</strong> to finish in ${escapeHtml(data.roundName)}.${escapeHtml(deadline)}`),
      paragraph(link(data.reviewUrl, data.reviewUrl)),
    ],
    text: [
      `you still have ${count} to finish in ${data.roundName}.${deadline}`,
      data.reviewUrl,
    ],
  })
}

export function buildSpeakerInvite(context: EmailContext, data: SpeakerInviteData): BuiltEmail {
  return compose(context, `Your ${context.eventName} speaker portal`, {
    html: [
      paragraph(`your speaker portal for <strong>${escapeHtml(context.eventName)}</strong> is ready.`),
      paragraph(`Sign in with this email address to see your sessions and tasks: ${link(data.portalUrl, data.portalUrl)}`),
    ],
    text: [
      `your speaker portal for ${context.eventName} is ready.`,
      `Sign in with this email address to see your sessions and tasks:\n${data.portalUrl}`,
    ],
  })
}

export function buildCustomEmail(context: EmailContext, data: CustomEmailData): BuiltEmail {
  const lines = data.body.split(/\r?\n/).filter((line) => line.trim())
  return compose(context, data.subject, {
    html: lines.map((line) => paragraph(escapeHtml(line))),
    text: lines,
  })
}
