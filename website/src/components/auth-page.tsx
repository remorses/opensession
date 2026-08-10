// Reusable centered auth layout used by login, device, and dashboard pages.

import type { ReactNode } from 'react'
import { Head, Link, router } from 'spiceflow/react'
import { cn } from '../lib/utils.ts'

/**
 * Reusable OpenSession logo image with dark mode support.
 * The jpeg has a white background, so light mode blends it away with
 * mix-blend-multiply and dark mode inverts + screens it.
 * Use this everywhere the logo appears (auth pages, dashboard nav, etc.)
 * instead of plain "OpenSession" text.
 */
export function OpenSessionLogo({ className, imageClassName = 'h-7' }: { className?: string; imageClassName?: string }) {
  return (
    // `flex`, NOT `inline-flex`: an inline-level box sits on its parent's text
    // baseline, so the line box adds ~6px of descender leading BELOW the image.
    // That made the wrapping <a> 34px tall for a 28px logo and pushed the logo
    // visually toward the top of the navbar. Block-level flex has no line box,
    // so the wrapper height matches the image exactly.
    <span className={cn('flex items-center', className)}>
      <img
        src="/holocron-api/ai-logo/opensession.jpeg"
        alt="OpenSession"
        className={cn(imageClassName, 'w-auto shrink-0 mix-blend-multiply dark:hidden')}
      />
      <img
        src="/holocron-api/ai-logo/opensession.jpeg"
        alt="OpenSession"
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
        <Head.Title>{`${title || 'OpenSession'}`}</Head.Title>
        <Head.Meta name="description" content={description} />
      </Head>
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        {/* Landing page, not /dashboard: these pages are mostly viewed
            signed-out, where /dashboard would chain a second redirect
            to /login. */}
        <Link href={router.href('/')}>
          <OpenSessionLogo imageClassName="h-8" />
        </Link>
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
