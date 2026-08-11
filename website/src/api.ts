// Authenticated OpenSession REST API and its generated OpenAPI contract.
import { Spiceflow, json } from 'spiceflow'
import { openapi } from 'spiceflow/openapi'
import dedent from 'string-dedent'
import * as orm from 'drizzle-orm'
import * as schema from 'db/schema'
import { ulid } from 'ulid'
import { z } from 'zod'
import { getDb, hashApiKeySecret } from './db.ts'
import { clearSessionSlot, scheduleSessionSlot } from './lib/agenda-server.ts'
import { toZonedSlot } from './lib/conflicts.ts'
import {
  CreateFormatRequest,
  CreateRoomRequest,
  CreateSessionRequest,
  CreateSpeakerRequest,
  CreateTrackRequest,
  DeleteResponse,
  ErrorResponse,
  EventListResponse,
  EventParams,
  EventSchema,
  FormatListResponse,
  FormatSchema,
  PublicationResponse,
  ReviewListQuery,
  ReviewListResponse,
  ReviewSchema,
  RoomListResponse,
  RoomSchema,
  ScheduleSessionRequest,
  SessionListQuery,
  SessionListResponse,
  SessionSchema,
  SpeakerListQuery,
  SpeakerListResponse,
  SpeakerSchema,
  TrackListResponse,
  TrackSchema,
  UpdateFormatRequest,
  UpdateRoomRequest,
  UpdateSessionRequest,
  UpdateSpeakerRequest,
  UpdateTrackRequest,
  type ApiScope,
} from './api-schemas.ts'

type ApiCaller = {
  keyId: string
  orgId: string
  eventId: string
  scopes: ApiScope[]
}

const commonResponses = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  500: ErrorResponse,
} as const

const sessionParams = z.object({ eventId: z.string().min(1), sessionId: z.string().min(1) })
const speakerParams = z.object({ eventId: z.string().min(1), speakerId: z.string().min(1) })
const trackParams = z.object({ eventId: z.string().min(1), trackId: z.string().min(1) })
const formatParams = z.object({ eventId: z.string().min(1), formatId: z.string().min(1) })
const roomParams = z.object({ eventId: z.string().min(1), roomId: z.string().min(1) })
const reviewParams = z.object({ eventId: z.string().min(1), reviewId: z.string().min(1) })

function fail(status: 400 | 401 | 403 | 404 | 409 | 422 | 500, code: string, message: string): never {
  throw json({ code, message }, { status })
}

function requireScope(caller: ApiCaller | null, scope: ApiScope): ApiCaller {
  if (!caller) fail(401, 'unauthorized', 'Valid API key required')
  if (!caller.scopes.includes(scope)) fail(403, 'insufficient_scope', `The ${scope} scope is required`)
  return caller
}

async function requireApiEvent(caller: ApiCaller, eventId: string) {
  if (caller.eventId !== eventId) fail(404, 'not_found', 'Event not found')
  const event = await getDb().query.event.findFirst({
    where: { id: eventId, orgId: caller.orgId },
    with: {
      tracks: { orderBy: { sortOrder: 'asc', name: 'asc' } },
      formats: { orderBy: { sortOrder: 'asc', name: 'asc' } },
      rooms: { orderBy: { sortOrder: 'asc', name: 'asc' } },
    },
  })
  if (!event) fail(404, 'not_found', 'Event not found')
  return event
}

function projectSession(row: any) {
  return {
    id: row.id,
    eventId: row.eventId,
    submitterSpeakerId: row.submitterSpeakerId,
    kind: row.kind,
    status: row.status,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    coverImageFileId: row.coverImageFileId,
    track: row.track,
    format: row.format,
    room: row.room,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    participants: row.participants.flatMap((participant: any) => participant.speaker ? [{
      id: participant.id,
      role: participant.role,
      confirmationStatus: participant.confirmationStatus,
      sortOrder: participant.sortOrder,
      speaker: {
        id: participant.speaker.id,
        firstName: participant.speaker.firstName,
        lastName: participant.speaker.lastName,
        email: participant.speaker.email,
      },
    }] : []),
    submittedAt: row.submittedAt,
    decidedAt: row.decidedAt,
    notifiedAt: row.notifiedAt,
    withdrawnAt: row.withdrawnAt,
    icsSequence: row.icsSequence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function loadSession(eventId: string, sessionId: string) {
  return getDb().query.eventSession.findFirst({
    where: { id: sessionId, eventId },
    with: {
      track: true,
      format: true,
      room: true,
      participants: { with: { speaker: true }, orderBy: { sortOrder: 'asc' } },
      formResponses: true,
    },
  })
}

function projectSpeaker(row: any) {
  return {
    id: row.id,
    eventId: row.eventId,
    userId: row.userId,
    email: row.email,
    status: row.status,
    firstName: row.firstName,
    lastName: row.lastName,
    bio: row.bio,
    jobTitle: row.jobTitle,
    companyName: row.companyName,
    pronouns: row.pronouns,
    websiteUrl: row.websiteUrl,
    linkedinUrl: row.linkedinUrl,
    twitterUrl: row.twitterUrl,
    headshotFileId: row.headshotFileId,
    avatarUrl: row.avatarUrl,
    sessions: row.participations.flatMap((participation: any) => participation.session ? [{
      id: participation.session.id,
      title: participation.session.title,
      role: participation.role,
      confirmationStatus: participation.confirmationStatus,
    }] : []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function loadSpeaker(eventId: string, speakerId: string) {
  return getDb().query.speaker.findFirst({
    where: { id: speakerId, eventId },
    with: {
      participations: { with: { session: true }, orderBy: { sortOrder: 'asc' } },
      submittedSessions: true,
      formResponses: true,
    },
  })
}

function projectReview(row: any) {
  const state: 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'RECUSED' = row.recusedAt != null
    ? 'RECUSED'
    : row.response?.status === 'SUBMITTED'
      ? 'COMPLETED'
      : row.response
        ? 'IN_PROGRESS'
        : 'ASSIGNED'
  return {
    id: row.id,
    eventId: row.eventId,
    formId: row.formId,
    session: { id: row.session.id, title: row.session.title },
    reviewer: { id: row.reviewer.id, name: row.reviewer.name, email: row.reviewer.email },
    state,
    recusedAt: row.recusedAt,
    recusalReason: row.recusalReason,
    response: row.response ? {
      id: row.response.id,
      formVersionId: row.response.formVersionId,
      status: row.response.status,
      submittedAt: row.response.submittedAt,
      answers: row.response.fieldValues.map((answer: any) => ({ name: answer.name, value: answer.value })),
    } : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export const apiApp = new Spiceflow({ basePath: '/api/v1' })
  .state('apiCaller', null as ApiCaller | null)
  .use(openapi({
    path: '/openapi.json',
    info: {
      title: 'OpenSession API',
      version: '1.0.0',
      description: dedent`

        Manage event sessions, speakers, schedule metadata, reviews, and publication.

        Create an event-scoped API key in **Settings → API**, then send it with
        \`Authorization: Bearer osk_...\`. Timestamps are epoch milliseconds.

      `,
    },
    servers: [{ url: 'https://opensession.dev', description: 'Production' }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'osk_...',
          description: 'Event API key from Settings → API',
        },
      },
    },
    security: [{ apiKey: [] }],
    tags: [
      { name: 'Events', description: 'Event details and publication state' },
      { name: 'Sessions', description: 'Proposals, service blocks, participants, and schedule placement' },
      { name: 'Speakers', description: 'Event speaker profiles and session participation' },
      { name: 'Metadata', description: 'Tracks, formats, and rooms' },
      { name: 'Reviews', description: 'Read-only evaluation assignments and answers' },
    ],
  }))
  .use(async ({ request, state }, next) => {
    if (request.parsedUrl.pathname === '/api/v1/openapi.json') return next()
    const match = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)
    if (!match) fail(401, 'unauthorized', 'Send an API key with the Authorization Bearer header')
    const keyHash = await hashApiKeySecret(match[1]!)
    const key = await getDb().query.apiKey.findFirst({
      where: { keyHash },
      with: { scopes: true },
    })
    if (!key || key.revokedAt != null || (key.expiresAt != null && key.expiresAt <= Date.now())) {
      fail(401, 'unauthorized', 'API key is invalid, expired, or revoked')
    }
    state.apiCaller = {
      keyId: key.id,
      orgId: key.orgId,
      eventId: key.eventId,
      scopes: key.scopes.map((row) => row.scope),
    }
    if (key.lastUsedAt == null || key.lastUsedAt < Date.now() - 60 * 60 * 1000) {
      await getDb().update(schema.apiKey)
        .set({ lastUsedAt: Date.now() })
        .where(orm.eq(schema.apiKey.id, key.id))
        .limit(1)
    }
    return next()
  })
  .route({
    method: 'GET',
    path: '/events',
    response: { ...commonResponses, 200: EventListResponse },
    detail: { tags: ['Events'], summary: 'List events', operationId: 'listEvents' },
    async handler({ state }) {
      const caller = requireScope(state.apiCaller, 'read:events')
      const event = await requireApiEvent(caller, caller.eventId)
      const { tracks: _tracks, formats: _formats, rooms: _rooms, ...data } = event
      return { data: [data] }
    },
  })
  .route({
    method: 'GET',
    path: '/events/:eventId',
    params: EventParams,
    response: { ...commonResponses, 200: EventSchema, 404: ErrorResponse },
    detail: { tags: ['Events'], summary: 'Get event', operationId: 'getEvent' },
    async handler({ params, state }) {
      const event = await requireApiEvent(requireScope(state.apiCaller, 'read:events'), params.eventId)
      const { tracks: _tracks, formats: _formats, rooms: _rooms, ...data } = event
      return data
    },
  })
  .route({
    method: 'GET',
    path: '/events/:eventId/sessions',
    params: EventParams,
    query: SessionListQuery,
    response: { ...commonResponses, 200: SessionListResponse, 404: ErrorResponse },
    detail: { tags: ['Sessions'], summary: 'List sessions', operationId: 'listSessions' },
    async handler({ params, query, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'read:sessions'), params.eventId)
      const rows = await getDb().query.eventSession.findMany({
        where: { eventId: params.eventId },
        with: {
          track: true,
          format: true,
          room: true,
          participants: { with: { speaker: true }, orderBy: { sortOrder: 'asc' } },
        },
        orderBy: { createdAt: 'desc', id: 'asc' },
        limit: 1000,
      })
      const q = query.q?.toLowerCase()
      return {
        data: rows.filter((row) =>
          (!query.kind || row.kind === query.kind)
          && (!query.status || row.status === query.status)
          && (!query.visibility || row.visibility === query.visibility)
          && (query.scheduled == null || query.scheduled === (row.roomId != null && row.startsAt != null && row.endsAt != null))
          && (!q || row.title?.toLowerCase().includes(q) || row.description?.toLowerCase().includes(q)),
        ).map(projectSession),
      }
    },
  })
  .route({
    method: 'GET',
    path: '/events/:eventId/sessions/:sessionId',
    params: sessionParams,
    response: { ...commonResponses, 200: SessionSchema, 404: ErrorResponse },
    detail: { tags: ['Sessions'], summary: 'Get session', operationId: 'getSession' },
    async handler({ params, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'read:sessions'), params.eventId)
      const row = await loadSession(params.eventId, params.sessionId)
      if (!row) fail(404, 'not_found', 'Session not found')
      return projectSession(row)
    },
  })
  .route({
    method: 'POST',
    path: '/events/:eventId/sessions',
    params: EventParams,
    request: CreateSessionRequest,
    response: { ...commonResponses, 201: SessionSchema, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    detail: { tags: ['Sessions'], summary: 'Create session', operationId: 'createSession' },
    async handler({ params, request, response, state }) {
      const event = await requireApiEvent(requireScope(state.apiCaller, 'write:sessions'), params.eventId)
      const body = await request.json()
      if (body.trackId && !event.tracks.some((row) => row.id === body.trackId)) fail(422, 'invalid_track', 'Track does not belong to this event')
      if (body.formatId && !event.formats.some((row) => row.id === body.formatId)) fail(422, 'invalid_format', 'Format does not belong to this event')
      const id = ulid()
      await getDb().insert(schema.eventSession).values({
        id,
        eventId: params.eventId,
        kind: body.kind,
        status: body.kind === 'SERVICE' ? 'ACCEPTED' : 'PENDING',
        title: body.title,
        description: body.description,
        visibility: body.visibility,
        trackId: body.trackId,
        formatId: body.formatId,
      })
      const row = await loadSession(params.eventId, id)
      if (!row) fail(500, 'internal_error', 'Created session could not be loaded')
      response.status = 201
      return projectSession(row)
    },
  })
  .route({
    method: 'PUT',
    path: '/events/:eventId/sessions/:sessionId',
    params: sessionParams,
    request: UpdateSessionRequest,
    response: { ...commonResponses, 200: SessionSchema, 404: ErrorResponse, 422: ErrorResponse },
    detail: { tags: ['Sessions'], summary: 'Update session', operationId: 'updateSession' },
    async handler({ params, request, state }) {
      const event = await requireApiEvent(requireScope(state.apiCaller, 'write:sessions'), params.eventId)
      const existing = await loadSession(params.eventId, params.sessionId)
      if (!existing) fail(404, 'not_found', 'Session not found')
      const body = await request.json()
      if (body.trackId && !event.tracks.some((row) => row.id === body.trackId)) fail(422, 'invalid_track', 'Track does not belong to this event')
      if (body.formatId && !event.formats.some((row) => row.id === body.formatId)) fail(422, 'invalid_format', 'Format does not belong to this event')
      await getDb().update(schema.eventSession)
        .set({ ...body, updatedAt: Date.now() })
        .where(orm.and(
          orm.eq(schema.eventSession.id, params.sessionId),
          orm.eq(schema.eventSession.eventId, params.eventId),
        ))
        .limit(1)
      return projectSession((await loadSession(params.eventId, params.sessionId))!)
    },
  })
  .route({
    method: 'DELETE',
    path: '/events/:eventId/sessions/:sessionId',
    params: sessionParams,
    response: { ...commonResponses, 200: DeleteResponse, 404: ErrorResponse, 409: ErrorResponse },
    detail: { tags: ['Sessions'], summary: 'Delete session', operationId: 'deleteSession' },
    async handler({ params, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:sessions'), params.eventId)
      const row = await loadSession(params.eventId, params.sessionId)
      if (!row) fail(404, 'not_found', 'Session not found')
      if (row.kind !== 'SERVICE' || row.formResponses.length > 0) {
        fail(409, 'protected_history', 'Content sessions and sessions with form history cannot be deleted')
      }
      await getDb().delete(schema.eventSession)
        .where(orm.and(
          orm.eq(schema.eventSession.id, params.sessionId),
          orm.eq(schema.eventSession.eventId, params.eventId),
        ))
        .limit(1)
      return { deleted: true as const }
    },
  })
  .route({
    method: 'PUT',
    path: '/events/:eventId/sessions/:sessionId/schedule',
    params: sessionParams,
    request: ScheduleSessionRequest,
    response: { ...commonResponses, 200: SessionSchema, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    detail: { tags: ['Sessions'], summary: 'Schedule session', operationId: 'scheduleSession' },
    async handler({ params, request, state }) {
      const event = await requireApiEvent(requireScope(state.apiCaller, 'write:sessions'), params.eventId)
      const body = await request.json()
      const start = toZonedSlot(body.startsAt, event.timezone)
      const end = toZonedSlot(body.endsAt, event.timezone)
      const durationMinutes = (body.endsAt - body.startsAt) / 60_000
      if (start.dayKey !== end.dayKey || durationMinutes <= 0 || !Number.isInteger(durationMinutes)) {
        fail(422, 'invalid_schedule', 'Schedule times must be ordered whole minutes on one event day')
      }
      try {
        await scheduleSessionSlot({
          db: getDb(),
          event,
          sessionId: params.sessionId,
          roomId: body.roomId,
          dayKey: start.dayKey,
          startMinute: start.minutes,
          durationMinutes,
          confirmConflicts: body.confirmConflicts,
          now: Date.now(),
        })
      } catch (error) {
        fail(409, 'schedule_conflict', error instanceof Error ? error.message : 'Session could not be scheduled')
      }
      const row = await loadSession(params.eventId, params.sessionId)
      if (!row) fail(404, 'not_found', 'Session not found')
      return projectSession(row)
    },
  })
  .route({
    method: 'DELETE',
    path: '/events/:eventId/sessions/:sessionId/schedule',
    params: sessionParams,
    response: { ...commonResponses, 200: SessionSchema, 404: ErrorResponse },
    detail: { tags: ['Sessions'], summary: 'Clear schedule', operationId: 'clearSessionSchedule' },
    async handler({ params, state }) {
      const event = await requireApiEvent(requireScope(state.apiCaller, 'write:sessions'), params.eventId)
      await clearSessionSlot({ db: getDb(), event, sessionId: params.sessionId, now: Date.now() })
      const row = await loadSession(params.eventId, params.sessionId)
      if (!row) fail(404, 'not_found', 'Session not found')
      return projectSession(row)
    },
  })
  .route({
    method: 'GET',
    path: '/events/:eventId/speakers',
    params: EventParams,
    query: SpeakerListQuery,
    response: { ...commonResponses, 200: SpeakerListResponse, 404: ErrorResponse },
    detail: { tags: ['Speakers'], summary: 'List speakers', operationId: 'listSpeakers' },
    async handler({ params, query, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'read:speakers'), params.eventId)
      const rows = await getDb().query.speaker.findMany({
        where: { eventId: params.eventId },
        with: { participations: { with: { session: true }, orderBy: { sortOrder: 'asc' } } },
        orderBy: { lastName: 'asc', firstName: 'asc', id: 'asc' },
        limit: 1000,
      })
      const q = query.q?.toLowerCase()
      return { data: rows.filter((row) =>
        (!query.status || row.status === query.status)
        && (!q || `${row.firstName} ${row.lastName} ${row.email} ${row.companyName ?? ''}`.toLowerCase().includes(q)),
      ).map(projectSpeaker) }
    },
  })
  .route({
    method: 'GET',
    path: '/events/:eventId/speakers/:speakerId',
    params: speakerParams,
    response: { ...commonResponses, 200: SpeakerSchema, 404: ErrorResponse },
    detail: { tags: ['Speakers'], summary: 'Get speaker', operationId: 'getSpeaker' },
    async handler({ params, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'read:speakers'), params.eventId)
      const row = await loadSpeaker(params.eventId, params.speakerId)
      if (!row) fail(404, 'not_found', 'Speaker not found')
      return projectSpeaker(row)
    },
  })
  .route({
    method: 'POST',
    path: '/events/:eventId/speakers',
    params: EventParams,
    request: CreateSpeakerRequest,
    response: { ...commonResponses, 201: SpeakerSchema, 404: ErrorResponse, 409: ErrorResponse },
    detail: { tags: ['Speakers'], summary: 'Create speaker', operationId: 'createSpeaker' },
    async handler({ params, request, response, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:speakers'), params.eventId)
      const body = await request.json()
      const id = ulid()
      try {
        await getDb().insert(schema.speaker).values({ id, eventId: params.eventId, ...body })
      } catch {
        fail(409, 'duplicate_speaker', 'A speaker with this email already exists in the event')
      }
      response.status = 201
      return projectSpeaker((await loadSpeaker(params.eventId, id))!)
    },
  })
  .route({
    method: 'PUT',
    path: '/events/:eventId/speakers/:speakerId',
    params: speakerParams,
    request: UpdateSpeakerRequest,
    response: { ...commonResponses, 200: SpeakerSchema, 404: ErrorResponse, 409: ErrorResponse },
    detail: { tags: ['Speakers'], summary: 'Update speaker', operationId: 'updateSpeaker' },
    async handler({ params, request, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:speakers'), params.eventId)
      if (!await loadSpeaker(params.eventId, params.speakerId)) fail(404, 'not_found', 'Speaker not found')
      try {
        await getDb().update(schema.speaker)
          .set({ ...await request.json(), updatedAt: Date.now() })
          .where(orm.and(orm.eq(schema.speaker.id, params.speakerId), orm.eq(schema.speaker.eventId, params.eventId)))
          .limit(1)
      } catch {
        fail(409, 'duplicate_speaker', 'A speaker with this email already exists in the event')
      }
      return projectSpeaker((await loadSpeaker(params.eventId, params.speakerId))!)
    },
  })
  .route({
    method: 'DELETE',
    path: '/events/:eventId/speakers/:speakerId',
    params: speakerParams,
    response: { ...commonResponses, 200: DeleteResponse, 404: ErrorResponse, 409: ErrorResponse },
    detail: { tags: ['Speakers'], summary: 'Delete speaker', operationId: 'deleteSpeaker' },
    async handler({ params, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:speakers'), params.eventId)
      const row = await loadSpeaker(params.eventId, params.speakerId)
      if (!row) fail(404, 'not_found', 'Speaker not found')
      if (row.participations.length || row.submittedSessions.length || row.formResponses.length) {
        fail(409, 'protected_history', 'Speakers with session or form history cannot be deleted')
      }
      await getDb().delete(schema.speaker)
        .where(orm.and(orm.eq(schema.speaker.id, params.speakerId), orm.eq(schema.speaker.eventId, params.eventId)))
        .limit(1)
      return { deleted: true as const }
    },
  })
  .route({
    method: 'GET',
    path: '/events/:eventId/tracks',
    params: EventParams,
    response: { ...commonResponses, 200: TrackListResponse, 404: ErrorResponse },
    detail: { tags: ['Metadata'], summary: 'List tracks', operationId: 'listTracks' },
    async handler({ params, state }) {
      const event = await requireApiEvent(requireScope(state.apiCaller, 'read:metadata'), params.eventId)
      return { data: event.tracks }
    },
  })
  .route({
    method: 'POST',
    path: '/events/:eventId/tracks',
    params: EventParams,
    request: CreateTrackRequest,
    response: { ...commonResponses, 201: TrackSchema, 404: ErrorResponse, 409: ErrorResponse },
    detail: { tags: ['Metadata'], summary: 'Create track', operationId: 'createTrack' },
    async handler({ params, request, response, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:metadata'), params.eventId)
      try {
        const [row] = await getDb().insert(schema.track).values({ eventId: params.eventId, ...await request.json() }).returning()
        response.status = 201
        return row!
      } catch {
        fail(409, 'duplicate_track', 'A track with this name already exists')
      }
    },
  })
  .route({
    method: 'PUT',
    path: '/events/:eventId/tracks/:trackId',
    params: trackParams,
    request: UpdateTrackRequest,
    response: { ...commonResponses, 200: TrackSchema, 404: ErrorResponse, 409: ErrorResponse },
    detail: { tags: ['Metadata'], summary: 'Update track', operationId: 'updateTrack' },
    async handler({ params, request, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:metadata'), params.eventId)
      try {
        const [row] = await getDb().update(schema.track).set(await request.json())
          .where(orm.and(orm.eq(schema.track.id, params.trackId), orm.eq(schema.track.eventId, params.eventId))).limit(1).returning()
        if (!row) fail(404, 'not_found', 'Track not found')
        return row
      } catch {
        fail(409, 'duplicate_track', 'A track with this name already exists')
      }
    },
  })
  .route({
    method: 'DELETE',
    path: '/events/:eventId/tracks/:trackId',
    params: trackParams,
    response: { ...commonResponses, 200: DeleteResponse, 404: ErrorResponse },
    detail: { tags: ['Metadata'], summary: 'Delete track', operationId: 'deleteTrack' },
    async handler({ params, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:metadata'), params.eventId)
      const row = await getDb().query.track.findFirst({ where: { id: params.trackId, eventId: params.eventId } })
      if (!row) fail(404, 'not_found', 'Track not found')
      const db = getDb()
      await db.batch([
        db.update(schema.eventSession).set({ trackId: null }).where(orm.eq(schema.eventSession.trackId, params.trackId)),
        db.delete(schema.track).where(orm.eq(schema.track.id, params.trackId)).limit(1),
      ] as const)
      return { deleted: true as const }
    },
  })
  .route({
    method: 'GET',
    path: '/events/:eventId/formats',
    params: EventParams,
    response: { ...commonResponses, 200: FormatListResponse, 404: ErrorResponse },
    detail: { tags: ['Metadata'], summary: 'List formats', operationId: 'listFormats' },
    async handler({ params, state }) {
      const event = await requireApiEvent(requireScope(state.apiCaller, 'read:metadata'), params.eventId)
      return { data: event.formats }
    },
  })
  .route({
    method: 'POST',
    path: '/events/:eventId/formats',
    params: EventParams,
    request: CreateFormatRequest,
    response: { ...commonResponses, 201: FormatSchema, 404: ErrorResponse, 409: ErrorResponse },
    detail: { tags: ['Metadata'], summary: 'Create format', operationId: 'createFormat' },
    async handler({ params, request, response, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:metadata'), params.eventId)
      try {
        const [row] = await getDb().insert(schema.format).values({ eventId: params.eventId, ...await request.json() }).returning()
        response.status = 201
        return row!
      } catch {
        fail(409, 'duplicate_format', 'A format with this name already exists')
      }
    },
  })
  .route({
    method: 'PUT',
    path: '/events/:eventId/formats/:formatId',
    params: formatParams,
    request: UpdateFormatRequest,
    response: { ...commonResponses, 200: FormatSchema, 404: ErrorResponse, 409: ErrorResponse },
    detail: { tags: ['Metadata'], summary: 'Update format', operationId: 'updateFormat' },
    async handler({ params, request, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:metadata'), params.eventId)
      try {
        const [row] = await getDb().update(schema.format).set(await request.json())
          .where(orm.and(orm.eq(schema.format.id, params.formatId), orm.eq(schema.format.eventId, params.eventId))).limit(1).returning()
        if (!row) fail(404, 'not_found', 'Format not found')
        return row
      } catch {
        fail(409, 'duplicate_format', 'A format with this name already exists')
      }
    },
  })
  .route({
    method: 'DELETE',
    path: '/events/:eventId/formats/:formatId',
    params: formatParams,
    response: { ...commonResponses, 200: DeleteResponse, 404: ErrorResponse },
    detail: { tags: ['Metadata'], summary: 'Delete format', operationId: 'deleteFormat' },
    async handler({ params, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:metadata'), params.eventId)
      const row = await getDb().query.format.findFirst({ where: { id: params.formatId, eventId: params.eventId } })
      if (!row) fail(404, 'not_found', 'Format not found')
      const db = getDb()
      await db.batch([
        db.update(schema.eventSession).set({ formatId: null }).where(orm.eq(schema.eventSession.formatId, params.formatId)),
        db.delete(schema.format).where(orm.eq(schema.format.id, params.formatId)).limit(1),
      ] as const)
      return { deleted: true as const }
    },
  })
  .route({
    method: 'GET',
    path: '/events/:eventId/rooms',
    params: EventParams,
    response: { ...commonResponses, 200: RoomListResponse, 404: ErrorResponse },
    detail: { tags: ['Metadata'], summary: 'List rooms', operationId: 'listRooms' },
    async handler({ params, state }) {
      const event = await requireApiEvent(requireScope(state.apiCaller, 'read:metadata'), params.eventId)
      return { data: event.rooms }
    },
  })
  .route({
    method: 'POST',
    path: '/events/:eventId/rooms',
    params: EventParams,
    request: CreateRoomRequest,
    response: { ...commonResponses, 201: RoomSchema, 404: ErrorResponse, 409: ErrorResponse },
    detail: { tags: ['Metadata'], summary: 'Create room', operationId: 'createRoom' },
    async handler({ params, request, response, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:metadata'), params.eventId)
      try {
        const [row] = await getDb().insert(schema.room).values({ eventId: params.eventId, ...await request.json() }).returning()
        response.status = 201
        return row!
      } catch {
        fail(409, 'duplicate_room', 'A room with this name already exists')
      }
    },
  })
  .route({
    method: 'PUT',
    path: '/events/:eventId/rooms/:roomId',
    params: roomParams,
    request: UpdateRoomRequest,
    response: { ...commonResponses, 200: RoomSchema, 404: ErrorResponse, 409: ErrorResponse },
    detail: { tags: ['Metadata'], summary: 'Update room', operationId: 'updateRoom' },
    async handler({ params, request, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:metadata'), params.eventId)
      try {
        const [row] = await getDb().update(schema.room).set(await request.json())
          .where(orm.and(orm.eq(schema.room.id, params.roomId), orm.eq(schema.room.eventId, params.eventId))).limit(1).returning()
        if (!row) fail(404, 'not_found', 'Room not found')
        return row
      } catch {
        fail(409, 'duplicate_room', 'A room with this name already exists')
      }
    },
  })
  .route({
    method: 'DELETE',
    path: '/events/:eventId/rooms/:roomId',
    params: roomParams,
    response: { ...commonResponses, 200: DeleteResponse, 404: ErrorResponse },
    detail: { tags: ['Metadata'], summary: 'Delete room', operationId: 'deleteRoom' },
    async handler({ params, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:metadata'), params.eventId)
      const row = await getDb().query.room.findFirst({ where: { id: params.roomId, eventId: params.eventId } })
      if (!row) fail(404, 'not_found', 'Room not found')
      const db = getDb()
      await db.batch([
        db.update(schema.eventSession).set({ roomId: null, startsAt: null, endsAt: null })
          .where(orm.eq(schema.eventSession.roomId, params.roomId)),
        db.delete(schema.room).where(orm.eq(schema.room.id, params.roomId)).limit(1),
      ] as const)
      return { deleted: true as const }
    },
  })
  .route({
    method: 'GET',
    path: '/events/:eventId/schedule',
    params: EventParams,
    response: { ...commonResponses, 200: SessionListResponse, 404: ErrorResponse },
    detail: { tags: ['Events'], summary: 'Get schedule', operationId: 'getSchedule' },
    async handler({ params, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'read:events'), params.eventId)
      const rows = await getDb().query.eventSession.findMany({
        where: { eventId: params.eventId, startsAt: { isNotNull: true } },
        with: {
          track: true,
          format: true,
          room: true,
          participants: { with: { speaker: true }, orderBy: { sortOrder: 'asc' } },
        },
        orderBy: { startsAt: 'asc', id: 'asc' },
        limit: 1000,
      })
      return { data: rows.map(projectSession) }
    },
  })
  .route({
    method: 'POST',
    path: '/events/:eventId/schedule/publish',
    params: EventParams,
    response: { ...commonResponses, 200: PublicationResponse, 404: ErrorResponse },
    detail: { tags: ['Events'], summary: 'Publish schedule', operationId: 'publishSchedule' },
    async handler({ params, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:events'), params.eventId)
      const programPublishedAt = Date.now()
      await getDb().update(schema.event).set({ programPublishedAt, updatedAt: programPublishedAt })
        .where(orm.eq(schema.event.id, params.eventId)).limit(1)
      return { published: true, programPublishedAt }
    },
  })
  .route({
    method: 'POST',
    path: '/events/:eventId/schedule/unpublish',
    params: EventParams,
    response: { ...commonResponses, 200: PublicationResponse, 404: ErrorResponse },
    detail: { tags: ['Events'], summary: 'Unpublish schedule', operationId: 'unpublishSchedule' },
    async handler({ params, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'write:events'), params.eventId)
      await getDb().update(schema.event).set({ programPublishedAt: null, updatedAt: Date.now() })
        .where(orm.eq(schema.event.id, params.eventId)).limit(1)
      return { published: false, programPublishedAt: null }
    },
  })
  .route({
    method: 'GET',
    path: '/events/:eventId/reviews',
    params: EventParams,
    query: ReviewListQuery,
    response: { ...commonResponses, 200: ReviewListResponse, 404: ErrorResponse },
    detail: { tags: ['Reviews'], summary: 'List reviews', operationId: 'listReviews' },
    async handler({ params, query, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'read:reviews'), params.eventId)
      const rows = await getDb().query.review.findMany({
        where: { eventId: params.eventId },
        with: { session: true, reviewer: true, response: { with: { fieldValues: true } } },
        orderBy: { createdAt: 'desc', id: 'asc' },
        limit: 1000,
      })
      return { data: rows.map(projectReview).filter((row) =>
        (!query.formId || row.formId === query.formId)
        && (!query.sessionId || row.session.id === query.sessionId)
        && (!query.reviewerId || row.reviewer.id === query.reviewerId)
        && (!query.state || row.state === query.state),
      ) }
    },
  })
  .route({
    method: 'GET',
    path: '/events/:eventId/reviews/:reviewId',
    params: reviewParams,
    response: { ...commonResponses, 200: ReviewSchema, 404: ErrorResponse },
    detail: { tags: ['Reviews'], summary: 'Get review', operationId: 'getReview' },
    async handler({ params, state }) {
      await requireApiEvent(requireScope(state.apiCaller, 'read:reviews'), params.eventId)
      const row = await getDb().query.review.findFirst({
        where: { id: params.reviewId, eventId: params.eventId },
        with: { session: true, reviewer: true, response: { with: { fieldValues: true } } },
      })
      if (!row?.session || !row.reviewer) fail(404, 'not_found', 'Review not found')
      return projectReview(row)
    },
  })
  .onError(({ error, request }) => {
    console.error('OpenSession API error:', request.url, error)
    return json({ code: 'internal_error', message: 'Unexpected API error' }, { status: 500 })
  })
