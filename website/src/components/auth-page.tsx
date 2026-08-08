// Reusable centered auth layout used by login, device, and dashboard pages.

import type { ReactNode } from 'react'
import { Head } from 'spiceflow/react'
import { cn } from '../lib/utils.ts'

/**
 * Reusable OpenSessions logo image with dark mode support.
 * The jpeg has a white background, so light mode blends it away with
 * mix-blend-multiply and dark mode inverts + screens it.
 * Use this everywhere the logo appears (auth pages, dashboard nav, etc.)
 * instead of plain "OpenSessions" text.
 */
export function OpenSessionsLogo({ className, imageClassName = 'h-7' }: { className?: string; imageClassName?: string }) {
  return (
    <span className={cn('inline-flex items-center', className)}>
      <img
        src="/holocron-api/ai-logo/opensessions.jpeg"
        alt="OpenSessions"
        className={cn(imageClassName, 'w-auto shrink-0 mix-blend-multiply dark:hidden')}
      />
      <img
        src="/holocron-api/ai-logo/opensessions.jpeg"
        alt="OpenSessions"
        className={cn(imageClassName, 'w-auto shrink-0 invert mix-blend-screen hidden dark:block')}
      />
    </span>
  )
}

export function AuthPage({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description: string
  children?: ReactNode
  footer?: ReactNode
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <Head>
        <Head.Title>{`${title || 'OpenSessions'}`}</Head.Title>
        <Head.Meta name="description" content={description} />
      </Head>
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        {/* Landing page, not /dashboard: these pages are mostly viewed
            signed-out, where /dashboard would chain a second redirect
            to /login. Plain <a> — '/' is served by the mounted holocron
            docs app, so the typed router can't link it. */}
        <a href="/">
          <OpenSessionsLogo imageClassName="h-8" />
        </a>
        <div className="flex flex-col gap-2">
          {title && <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>}
          <p className="text-sm text-muted-foreground text-balance">{description}</p>
        </div>
        {children}
        {footer ? <div className="flex w-full flex-col gap-3">{footer}</div> : null}
      </div>
    </main>
  )
}
