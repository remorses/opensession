// Pure task auto-assignment on session acceptance. SPEAKER targets get one
// assignment per participant speaker (sessionId NULL); SUBMISSION targets get
// one per (session × speaker) with sessionId set. DB insert uses
// onConflictDoNothing against the partial unique indexes for idempotency.

export type TaskTarget = 'SPEAKER' | 'SUBMISSION'
export type TaskSource = 'MANUAL' | 'FORM'
export type TaskAssignmentStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'

export type TaskDefForAssign = {
  id: string
  eventId: string
  target: TaskTarget
  dueAt: number | null
}

export type ParticipantForAssign = {
  speakerId: string
}

export type PlannedTaskAssignment = {
  eventId: string
  taskDefinitionId: string
  speakerId: string
  sessionId: string | null
  status: 'NOT_STARTED'
  dueAt: number | null
  createdAt: number
  updatedAt: number
}

/** Build the TaskAssignment rows that should exist after accepting one
 *  session. Pure + deterministic; caller inserts with onConflictDoNothing. */
export function buildAssignmentsForAcceptance({
  taskDefs,
  participants,
  sessionId,
  now,
}: {
  taskDefs: TaskDefForAssign[]
  participants: ParticipantForAssign[]
  sessionId: string
  now: number
}): PlannedTaskAssignment[] {
  const speakerIds = uniqueSpeakerIds(participants)
  const rows: PlannedTaskAssignment[] = []

  for (const def of taskDefs) {
    if (def.target === 'SPEAKER') {
      for (const speakerId of speakerIds) {
        rows.push({
          eventId: def.eventId,
          taskDefinitionId: def.id,
          speakerId,
          sessionId: null,
          status: 'NOT_STARTED',
          dueAt: def.dueAt,
          createdAt: now,
          updatedAt: now,
        })
      }
      continue
    }
    // SUBMISSION: one assignment per participant on this accepted session.
    for (const speakerId of speakerIds) {
      rows.push({
        eventId: def.eventId,
        taskDefinitionId: def.id,
        speakerId,
        sessionId,
        status: 'NOT_STARTED',
        dueAt: def.dueAt,
        createdAt: now,
        updatedAt: now,
      })
    }
  }
  return rows
}

function uniqueSpeakerIds(participants: ParticipantForAssign[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const row of participants) {
    if (seen.has(row.speakerId)) continue
    seen.add(row.speakerId)
    out.push(row.speakerId)
  }
  return out
}

/** Validate TaskDefinition source/form pairing before insert/update.
 *  FORM requires a PORTAL form whose target matches the task target;
 *  MANUAL requires formId null. */
export function assertTaskDefinitionShape(input: {
  source: TaskSource
  target: TaskTarget
  formId: string | null
  form?: { purpose: 'CFP' | 'PORTAL' | 'EVALUATION'; target: 'SPEAKER' | 'SUBMISSION' } | null
}): void {
  if (input.source === 'MANUAL') {
    if (input.formId != null) {
      throw new Error('Manual tasks cannot link a form')
    }
    return
  }
  if (!input.formId || !input.form) {
    throw new Error('Form tasks must link a portal form')
  }
  if (input.form.purpose !== 'PORTAL') {
    throw new Error('Form tasks must link a PORTAL form')
  }
  if (input.form.target !== input.target) {
    throw new Error(
      `Form target (${input.form.target}) must match task target (${input.target})`,
    )
  }
}

export type AssignmentProgress = {
  total: number
  completed: number
  inProgress: number
  notStarted: number
}

export function summarizeAssignmentProgress(
  assignments: Array<{ status: TaskAssignmentStatus }>,
): AssignmentProgress {
  let completed = 0
  let inProgress = 0
  let notStarted = 0
  for (const row of assignments) {
    if (row.status === 'COMPLETED') completed += 1
    else if (row.status === 'IN_PROGRESS') inProgress += 1
    else notStarted += 1
  }
  return {
    total: assignments.length,
    completed,
    inProgress,
    notStarted,
  }
}

/** Default FORM-linked onboarding tasks seeded with the default portal forms. */
export function defaultFormTaskDefinitions({
  eventId,
  now,
  speakerProfileFormId,
  sessionMaterialsFormId,
}: {
  eventId: string
  now: number
  speakerProfileFormId: string
  sessionMaterialsFormId: string
}) {
  return [
    {
      eventId,
      title: 'Complete Speaker Profile',
      instructionsHtml: null as string | null,
      target: 'SPEAKER' as const,
      source: 'FORM' as const,
      formId: speakerProfileFormId,
      dueAt: null as number | null,
      sortOrder: 0,
      createdAt: now,
    },
    {
      eventId,
      title: 'Upload Session Materials',
      instructionsHtml: null as string | null,
      target: 'SUBMISSION' as const,
      source: 'FORM' as const,
      formId: sessionMaterialsFormId,
      dueAt: null as number | null,
      sortOrder: 1,
      createdAt: now,
    },
  ]
}

/** @deprecated use defaultFormTaskDefinitions — kept only if a caller needs MANUAL seeds. */
export function defaultManualTaskDefinitions(eventId: string, now: number) {
  return [
    {
      eventId,
      title: 'Complete Speaker Profile',
      instructionsHtml: null as string | null,
      target: 'SPEAKER' as const,
      source: 'MANUAL' as const,
      formId: null as string | null,
      dueAt: null as number | null,
      sortOrder: 0,
      createdAt: now,
    },
    {
      eventId,
      title: 'Upload Session Materials',
      instructionsHtml: null as string | null,
      target: 'SUBMISSION' as const,
      source: 'MANUAL' as const,
      formId: null as string | null,
      dueAt: null as number | null,
      sortOrder: 1,
      createdAt: now,
    },
  ]
}
