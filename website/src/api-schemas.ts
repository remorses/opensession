// Zod contracts shared by the OpenSession API routes and API-key settings UI.
import { z } from 'zod'

export const API_SCOPES = [
  'read:events',
  'write:events',
  'read:sessions',
  'write:sessions',
  'read:speakers',
  'write:speakers',
  'read:metadata',
  'write:metadata',
  'read:reviews',
] as const

export type ApiScope = typeof API_SCOPES[number]

export const ApiScopeSchema = z.enum(API_SCOPES)

export const ErrorResponse = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
})

export const EventSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
  websiteUrl: z.string().nullable(),
  location: z.string().nullable(),
  timezone: z.string(),
  startsAt: z.number(),
  endsAt: z.number(),
  description: z.string().nullable(),
  programPublishedAt: z.number().nullable(),
  contactEmail: z.string().nullable(),
  logoFileId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const TrackSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  name: z.string(),
  color: z.string(),
  sortOrder: z.number().int(),
  createdAt: z.number(),
})

export const FormatSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  name: z.string(),
  defaultDurationMinutes: z.number().int().nullable(),
  sortOrder: z.number().int(),
})

export const RoomSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  name: z.string(),
  sortOrder: z.number().int(),
})

export const SpeakerSummarySchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
})

export const ParticipantSchema = z.object({
  id: z.string(),
  role: z.enum(['SPEAKER', 'MODERATOR']),
  confirmationStatus: z.enum(['PENDING', 'CONFIRMED', 'DECLINED']),
  sortOrder: z.number().int(),
  speaker: SpeakerSummarySchema,
})

export const SessionSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  submitterSpeakerId: z.string().nullable(),
  kind: z.enum(['CONTENT', 'SERVICE']),
  status: z.enum(['DRAFT', 'PENDING', 'ACCEPT_QUEUE', 'ACCEPTED', 'DECLINE_QUEUE', 'DECLINED', 'WITHDRAWN']),
  title: z.string().nullable(),
  description: z.string().nullable(),
  visibility: z.enum(['PUBLIC', 'PRIVATE']),
  coverImageFileId: z.string().nullable(),
  track: TrackSchema.nullable(),
  format: FormatSchema.nullable(),
  room: RoomSchema.nullable(),
  startsAt: z.number().nullable(),
  endsAt: z.number().nullable(),
  participants: z.array(ParticipantSchema),
  submittedAt: z.number().nullable(),
  decidedAt: z.number().nullable(),
  notifiedAt: z.number().nullable(),
  withdrawnAt: z.number().nullable(),
  icsSequence: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const SpeakerSessionSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  role: z.enum(['SPEAKER', 'MODERATOR']),
  confirmationStatus: z.enum(['PENDING', 'CONFIRMED', 'DECLINED']),
})

export const SpeakerSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  userId: z.string().nullable(),
  email: z.string(),
  status: z.enum(['PENDING', 'INVITED', 'CONFIRMED', 'DECLINED']),
  firstName: z.string(),
  lastName: z.string(),
  bio: z.string().nullable(),
  jobTitle: z.string().nullable(),
  companyName: z.string().nullable(),
  pronouns: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  twitterUrl: z.string().nullable(),
  headshotFileId: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  sessions: z.array(SpeakerSessionSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const ReviewSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  formId: z.string(),
  session: z.object({ id: z.string(), title: z.string().nullable() }),
  reviewer: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  state: z.enum(['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'RECUSED']),
  recusedAt: z.number().nullable(),
  recusalReason: z.string().nullable(),
  response: z.object({
    id: z.string(),
    formVersionId: z.string(),
    status: z.enum(['DRAFT', 'SUBMITTED']),
    submittedAt: z.number().nullable(),
    answers: z.array(z.object({ name: z.string(), value: z.string() })),
  }).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const EventListResponse = z.object({ data: z.array(EventSchema) })
export const TrackListResponse = z.object({ data: z.array(TrackSchema) })
export const FormatListResponse = z.object({ data: z.array(FormatSchema) })
export const RoomListResponse = z.object({ data: z.array(RoomSchema) })
export const SessionListResponse = z.object({ data: z.array(SessionSchema) })
export const SpeakerListResponse = z.object({ data: z.array(SpeakerSchema) })
export const ReviewListResponse = z.object({ data: z.array(ReviewSchema) })
export const DeleteResponse = z.object({ deleted: z.literal(true) })

export const EventParams = z.object({ eventId: z.string().min(1) })
export const ResourceParams = EventParams.extend({ id: z.string().min(1) })

export const SessionListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(['CONTENT', 'SERVICE']).optional(),
  status: z.enum(['DRAFT', 'PENDING', 'ACCEPT_QUEUE', 'ACCEPTED', 'DECLINE_QUEUE', 'DECLINED', 'WITHDRAWN']).optional(),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
  scheduled: z.boolean().optional(),
})

export const SpeakerListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['PENDING', 'INVITED', 'CONFIRMED', 'DECLINED']).optional(),
})

export const ReviewListQuery = z.object({
  formId: z.string().optional(),
  sessionId: z.string().optional(),
  reviewerId: z.string().optional(),
  state: z.enum(['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'RECUSED']).optional(),
})

export const CreateTrackRequest = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  sortOrder: z.number().int().min(0).default(0),
})
export const UpdateTrackRequest = CreateTrackRequest.partial()

export const CreateFormatRequest = z.object({
  name: z.string().trim().min(1).max(80),
  defaultDurationMinutes: z.number().int().min(1).max(1440).nullable().default(null),
  sortOrder: z.number().int().min(0).default(0),
})
export const UpdateFormatRequest = CreateFormatRequest.partial()

export const CreateRoomRequest = z.object({
  name: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().min(0).default(0),
})
export const UpdateRoomRequest = CreateRoomRequest.partial()

const SpeakerFields = z.object({
  email: z.email().max(320),
  status: z.enum(['PENDING', 'INVITED', 'CONFIRMED', 'DECLINED']).default('PENDING'),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  bio: z.string().trim().max(5000).nullable().default(null),
  jobTitle: z.string().trim().max(200).nullable().default(null),
  companyName: z.string().trim().max(200).nullable().default(null),
  pronouns: z.string().trim().max(100).nullable().default(null),
  websiteUrl: z.url().max(500).nullable().default(null),
  linkedinUrl: z.url().max(500).nullable().default(null),
  twitterUrl: z.url().max(500).nullable().default(null),
  headshotFileId: z.string().nullable().default(null),
})
export const CreateSpeakerRequest = SpeakerFields
export const UpdateSpeakerRequest = SpeakerFields.partial()

export const CreateSessionRequest = z.object({
  kind: z.enum(['CONTENT', 'SERVICE']).default('CONTENT'),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(10_000).nullable().default(null),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PRIVATE'),
  trackId: z.string().nullable().default(null),
  formatId: z.string().nullable().default(null),
})

export const UpdateSessionRequest = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(10_000).nullable().optional(),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
  trackId: z.string().nullable().optional(),
  formatId: z.string().nullable().optional(),
})

export const ScheduleSessionRequest = z.object({
  roomId: z.string().min(1),
  startsAt: z.number().int(),
  endsAt: z.number().int(),
  confirmConflicts: z.boolean().default(false),
})

export const PublicationResponse = z.object({
  published: z.boolean(),
  programPublishedAt: z.number().nullable(),
})
