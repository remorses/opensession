// Pure tests for Google name/avatar prefill on speaker identity.
import { describe, expect, test } from 'vitest'
import {
  googleAvatarFromImage,
  namesFromGoogleProfile,
  speakerGooglePrefill,
} from './portal.ts'

describe('speaker Google prefill', () => {
  test('splits display name', () => {
    expect(namesFromGoogleProfile('Ada Lovelace')).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
    })
  })

  test('reads avatar URL', () => {
    expect(googleAvatarFromImage('https://lh3.googleusercontent.com/a/ada')).toBe(
      'https://lh3.googleusercontent.com/a/ada',
    )
    expect(googleAvatarFromImage(null)).toBeNull()
  })

  test('fills empty names and avatar when no headshot', () => {
    expect(speakerGooglePrefill(
      { name: 'Ada Lovelace', image: 'https://lh3.googleusercontent.com/a/ada' },
      {
        firstName: '',
        lastName: '',
        headshotFileId: null,
        avatarUrl: null,
      },
    )).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      avatarUrl: 'https://lh3.googleusercontent.com/a/ada',
    })
  })

  test('does not overwrite headshot or existing names', () => {
    expect(speakerGooglePrefill(
      { name: 'Ada Lovelace', image: 'https://lh3.googleusercontent.com/a/ada' },
      {
        firstName: 'A',
        lastName: 'L',
        headshotFileId: 'file_1',
        avatarUrl: null,
      },
    )).toEqual({})
  })
})
