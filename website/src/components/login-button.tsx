// Google sign-in button that starts a full-document OAuth navigation.
// window.location.href is deliberate — the OAuth flow 302s to Google's
// consent screen, which requires a full document navigation. Do not
// convert this to Link/router.push.
'use client'

import { useState } from 'react'
import { Button } from './ui/button.tsx'

export function GoogleSignInButton({ href, children }: { href: string; children: React.ReactNode }) {
  const [loading, setLoading] = useState(false)

  return (
    <Button
      className="w-full"
      size="lg"
      variant="outline"
      loading={loading}
      loadingText="Redirecting..."
      onClick={() => {
        setLoading(true)
        window.location.href = href
      }}
    >
      {children}
    </Button>
  )
}
