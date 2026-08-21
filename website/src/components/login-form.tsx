// Email/password sign-in and account creation alongside Google OAuth.
'use client'

import { useState } from 'react'
import { authClient } from '../lib/auth-client.ts'
import { GoogleSignInButton } from './login-button.tsx'
import { Button } from './ui/button.tsx'
import { Input } from './ui/primitives.tsx'

type Mode = 'sign-in' | 'sign-up'

export function LoginForm({
  callbackURL,
  googleHref,
  verificationRequired,
  defaultMode = 'sign-in',
}: {
  callbackURL: string
  googleHref: string
  verificationRequired: boolean
  defaultMode?: Mode
}) {
  const [mode, setMode] = useState<Mode>(defaultMode)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(
    verificationRequired ? 'Verify your email address before you continue.' : null,
  )
  const [email, setEmail] = useState('')

  const submit = async (formData: FormData) => {
    setLoading(true)
    setMessage(null)
    const password = String(formData.get('password') ?? '')
    const result = mode === 'sign-up'
      ? await authClient.signUp.email({
        callbackURL,
        email,
        name: String(formData.get('name') ?? ''),
        password,
      })
      : await authClient.signIn.email({ callbackURL, email, password })
    setLoading(false)

    if (result.error) {
      if (result.error.code === 'EMAIL_NOT_VERIFIED') {
        setMessage('Check your inbox and verify your email address before signing in.')
        return
      }
      setMessage(result.error.message || 'Could not sign in')
      return
    }
    if (mode === 'sign-up') {
      setMessage('Check your inbox to verify your email address, then sign in here.')
      setMode('sign-in')
      return
    }
    window.location.href = callbackURL
  }

  const resendVerification = async () => {
    if (!email) {
      setMessage('Enter your email address first.')
      return
    }
    setLoading(true)
    const result = await authClient.sendVerificationEmail({ email, callbackURL })
    setLoading(false)
    setMessage(result.error
      ? result.error.message || 'Could not send the verification email'
      : 'Check your inbox for a new verification link.')
  }

  return (
    <div className="flex w-full flex-col gap-5 text-left">
      <div className="grid grid-cols-2 rounded-lg bg-muted p-1">
        <button
          type="button"
          className={mode === 'sign-in' ? 'rounded-md bg-background px-3 py-2 text-sm font-medium' : 'px-3 py-2 text-sm text-muted-foreground'}
          onClick={() => { setMode('sign-in'); setMessage(null) }}
        >
          Sign in
        </button>
        <button
          type="button"
          className={mode === 'sign-up' ? 'rounded-md bg-background px-3 py-2 text-sm font-medium' : 'px-3 py-2 text-sm text-muted-foreground'}
          onClick={() => { setMode('sign-up'); setMessage(null) }}
        >
          Create account
        </button>
      </div>

      <form action={submit} className="flex flex-col gap-4">
        {mode === 'sign-up' ? (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Name
            <Input className="w-full" name="name" autoComplete="name" required />
          </label>
        ) : null}
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Email
          <Input
            className="w-full"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Password
          <Input
            className="w-full"
            name="password"
            type="password"
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            minLength={8}
            required
          />
          {mode === 'sign-up' ? <span className="font-normal text-muted-foreground">At least 8 characters.</span> : null}
        </label>
        <Button className="w-full" size="lg" type="submit" loading={loading} loadingText="Please wait...">
          {mode === 'sign-up' ? 'Create account with email' : 'Sign in with email'}
        </Button>
      </form>

      {message ? (
        <div className="flex flex-col gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          <span>{message}</span>
          {message.toLowerCase().includes('verif') ? (
            <button type="button" className="w-fit font-medium text-foreground underline" onClick={resendVerification}>
              Resend verification email
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <GoogleSignInButton href={googleHref}>Continue with Google</GoogleSignInButton>
    </div>
  )
}
