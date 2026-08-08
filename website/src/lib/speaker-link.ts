// Race-safe speaker identity linking by verified BetterAuth email.
// A user can own one Speaker row per event; unlinked co-speakers are claimed
// when that email first signs in, while conflicting links are rejected.
// Google name + image prefill empty profile fields on create/claim.
import * as orm from 'drizzle-orm'
import * as schema from 'db/schema'
import { ulid } from 'ulid'
import { getDb, type Session } from '../db.ts'
import {
  googleAvatarFromImage,
  namesFromGoogleProfile,
  speakerGooglePrefill as prefillFromGoogle,
} from './portal.ts'

export type SpeakerIdentityInput = {
  eventId: string
  session: Session
  profile?: { firstName: string; lastName: string }
}

type LinkedSpeaker = typeof schema.speaker.$inferSelect

export function normalizeSpeakerEmail(email: string): string {
  return email.trim().toLowerCase()
}

function requireVerifiedEmail(session: Session): string {
  if (!session.user.emailVerified) {
    throw new Error('A verified email address is required to use the speaker portal')
  }
  return normalizeSpeakerEmail(session.user.email)
}

function cleanName(value: string): string {
  return value.trim().slice(0, 80)
}

export function namesFromSession(session: Session): { firstName: string; lastName: string } {
  return namesFromGoogleProfile(session.user.name)
}

function speakerPrefill(
  session: Session,
  existing?: {
    firstName?: string | null
    lastName?: string | null
    headshotFileId?: string | null
    avatarUrl?: string | null
  } | null,
) {
  return prefillFromGoogle(
    { name: session.user.name, image: session.user.image },
    existing,
  )
}

/** Link an existing event speaker to the signed-in user. When `profile` is
 * supplied, create the row if no email match exists. Without it, absence is
 * returned as null so read-only callers do not invent identities. Portal
 * loaders pass profile so speakers can enter without a prior CFP. */
export function linkSpeakerIdentity(input: SpeakerIdentityInput & { profile: { firstName: string; lastName: string } }): Promise<LinkedSpeaker>
export function linkSpeakerIdentity(input: SpeakerIdentityInput): Promise<LinkedSpeaker | null>
export async function linkSpeakerIdentity({ eventId, session, profile }: SpeakerIdentityInput): Promise<LinkedSpeaker | null> {
  const email = requireVerifiedEmail(session)
  const db = getDb()
  const [byEmail, byUser] = await db.batch([
    db.query.speaker.findFirst({ where: { eventId, email } }),
    db.query.speaker.findFirst({ where: { eventId, userId: session.userId } }),
  ] as const)

  if (byUser) {
    if (byEmail && byEmail.id !== byUser.id) {
      throw new Error('This email and user are linked to different speaker profiles')
    }
    const prefill = speakerPrefill(session, byUser)
    const emailPatch = byUser.email !== email ? { email } : {}
    if (Object.keys(prefill).length > 0 || Object.keys(emailPatch).length > 0) {
      const [updated] = await db
        .update(schema.speaker)
        .set({ ...emailPatch, ...prefill, updatedAt: Date.now() })
        .where(orm.eq(schema.speaker.id, byUser.id))
        .limit(1)
        .returning()
      return updated ?? byUser
    }
    return byUser
  }

  if (byEmail) {
    if (byEmail.userId && byEmail.userId !== session.userId) {
      throw new Error('This speaker profile is linked to another user')
    }
    const prefill = speakerPrefill(session, byEmail)
    const [claimed] = await db
      .update(schema.speaker)
      .set({ userId: session.userId, ...prefill, updatedAt: Date.now() })
      .where(orm.and(orm.eq(schema.speaker.id, byEmail.id), orm.isNull(schema.speaker.userId)))
      .limit(1)
      .returning()
    if (claimed) return claimed

    const raced = await db.query.speaker.findFirst({ where: { id: byEmail.id, eventId } })
    if (raced?.userId === session.userId) return raced
    throw new Error('This speaker profile was linked to another user')
  }

  if (!profile) return null
  const fallback = namesFromSession(session)
  const avatarUrl = googleAvatarFromImage(session.user.image)
  const speakerId = ulid()
  try {
    const [created] = await db
      .insert(schema.speaker)
      .values({
        id: speakerId,
        eventId,
        userId: session.userId,
        email,
        firstName: cleanName(profile.firstName) || fallback.firstName,
        lastName: cleanName(profile.lastName) || fallback.lastName,
        avatarUrl,
      })
      .returning()
    return created!
  } catch (cause) {
    // An email or user partial-unique race can only have one valid winner.
    const [emailWinner, userWinner] = await db.batch([
      db.query.speaker.findFirst({ where: { eventId, email } }),
      db.query.speaker.findFirst({ where: { eventId, userId: session.userId } }),
    ] as const)
    const winner = userWinner ?? emailWinner
    if (winner?.userId === session.userId && winner.email === email) return winner
    throw cause
  }
}
