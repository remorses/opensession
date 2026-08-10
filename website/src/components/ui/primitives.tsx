// Input, Textarea, NativeSelect, TimezoneSelect, Badge, EmptyState, Spinner,
// Tooltip — small UI primitives ported from sigillo, grouped in one file to
// avoid tiny files.
'use client'

import { ChevronsUpDownIcon, Loader2Icon } from 'lucide-react'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'spiceflow/react'
import { timezoneGroupsWith, timezoneLabel } from '../../lib/timezones.ts'
import { cn } from '../../lib/utils.ts'

// ── Input / Textarea ────────────────────────────────────────────────

export function Input({
  className,
  inputSize = 'default',
  ...props
}: Omit<React.ComponentProps<'input'>, 'size'> & { inputSize?: 'default' | 'sm'; size?: never }): React.ReactElement {
  return (
    <input
      className={cn(
        'rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring',
        inputSize === 'sm' ? 'h-7 px-2' : 'h-9 px-3',
        className,
      )}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>): React.ReactElement {
  return (
    <textarea
      className={cn(
        'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-y',
        className,
      )}
      {...props}
    />
  )
}

// ── NativeSelect ────────────────────────────────────────────────────

const nativeSelectVariants = cva(
  // min-w-0 (not min-w-36): w-full selects in tight grids (e.g. Place session
  // Day/Start/Minutes) must shrink with the column instead of overflowing.
  'relative inline-flex min-h-9 w-full min-w-0 items-center rounded-lg border border-input bg-background px-[calc(--spacing(3)-1px)] pr-8 text-left text-base text-foreground shadow-xs/5 outline-none ring-ring/24 transition-shadow focus-visible:border-ring focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-64 sm:min-h-8 sm:text-sm dark:bg-input/32',
)

export function NativeSelect({
  children,
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>): React.ReactElement {
  return (
    <div className={cn('relative w-full', className)}>
      <select className={cn(nativeSelectVariants(), 'appearance-none rounded-md')} {...props}>
        {children}
      </select>
      <ChevronsUpDownIcon className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 opacity-80 sm:size-4" />
    </div>
  )
}

// ── TimezoneSelect ──────────────────────────────────────────────────
// Native select over the curated IANA list in lib/timezones.ts. `value` is the
// event's stored timezone; it is passed through timezoneGroupsWith so a
// non-curated (but valid) id stays selectable instead of being silently
// replaced by the first option.

export function TimezoneSelect({
  value,
  ...props
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'value'> & {
  value?: string
}): React.ReactElement {
  return (
    <NativeSelect defaultValue={value} {...props}>
      {timezoneGroupsWith(value).map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.zones.map((zone) => (
            <option key={zone} value={zone}>
              {timezoneLabel(zone)}
            </option>
          ))}
        </optgroup>
      ))}
    </NativeSelect>
  )
}

// ── Badge ───────────────────────────────────────────────────────────

export const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent font-medium outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: { size: 'default', variant: 'default' },
    variants: {
      size: {
        default: 'h-5.5 min-w-5.5 px-[calc(--spacing(1)-1px)] text-sm sm:h-4.5 sm:min-w-4.5 sm:text-xs',
        lg: 'h-6.5 min-w-6.5 px-[calc(--spacing(1.5)-1px)] text-base sm:h-5.5 sm:min-w-5.5 sm:text-sm',
        sm: 'h-5 min-w-5 rounded-[.25rem] px-[calc(--spacing(1)-1px)] text-xs sm:h-4 sm:min-w-4 sm:text-[.625rem]',
      },
      variant: {
        default: 'bg-primary text-primary-foreground',
        destructive: 'bg-destructive/15 text-destructive-foreground',
        outline: 'border-input bg-background text-foreground dark:bg-input/32',
        secondary: 'bg-secondary text-secondary-foreground',
        success: 'bg-success/15 text-success-foreground',
        warning: 'bg-warning/15 text-warning-foreground',
      },
    },
  },
)

export function Badge({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>): React.ReactElement {
  return <span className={cn(badgeVariants({ className, size, variant }))} data-slot="badge" {...props} />
}

// ── EmptyState ──────────────────────────────────────────────────────

export function EmptyState({
  icon,
  title,
  description,
  children,
  className,
}: {
  icon: React.ReactNode
  title: string
  description: string
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-16 text-center', className)}>
      <div className="flex size-12 items-center justify-center rounded-xl bg-muted mb-4">{icon}</div>
      <h3 className="text-base font-semibold mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground mb-6 max-w-xs">{description}</p>
      {children}
    </div>
  )
}

// ── Spinner ─────────────────────────────────────────────────────────

export function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2Icon>): React.ReactElement {
  return <Loader2Icon aria-label="Loading" className={cn('animate-spin', className)} role="status" {...props} />
}

// ── Tooltip ─────────────────────────────────────────────────────────
// Mintlify-compatible Tooltip (props: tip, title/headline, description, cta,
// href). The popup renders through createPortal into document.body with fixed
// positioning, so it escapes overflow containers — unlike holocron's builtin
// Tooltip, whose inline absolute-positioned popup gets clipped by the
// scrollable pricing table. Imported in MDX pages to shadow the builtin by
// the same name.
//
// Hand-rolled instead of @base-ui/react/tooltip on purpose: base-ui's
// Trigger never opened when hydrated inside MDX markdown tables (its
// pointer tracking silently did nothing there) and its useId-based ids
// caused SSR hydration mismatch warnings. Plain useState + createPortal
// has neither problem.

export function Tooltip({
  tip,
  description,
  headline,
  title,
  cta,
  href,
  className,
  children,
}: {
  tip?: string
  description?: string
  headline?: string
  title?: string
  cta?: string
  href?: string
  className?: string
  children?: React.ReactNode
}): React.ReactElement {
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null)
  const triggerRef = React.useRef<HTMLSpanElement>(null)
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const resolvedTitle = title ?? headline
  const resolvedDescription = description ?? tip
  // safe-mdx wraps text children in a block P element; unwrap plain text so
  // the trigger stays a valid inline element inside table cells.
  const trigger = typeof children === 'string' || typeof children === 'number' ? String(children) : children

  const open = () => {
    clearTimeout(closeTimer.current)
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setPos({ x: rect.left + rect.width / 2, y: rect.top })
  }
  // Delayed close so the mouse can travel from the trigger into the popup
  // (needed to click the CTA link) without the tooltip disappearing.
  const closeSoon = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setPos(null), 150)
  }

  return (
    <span
      ref={triggerRef}
      onMouseEnter={open}
      onMouseLeave={closeSoon}
      className={cn('cursor-help underline decoration-dotted decoration-muted-foreground underline-offset-2', className)}
    >
      {trigger}
      {pos &&
        createPortal(
          <span
            role="tooltip"
            onMouseEnter={open}
            onMouseLeave={closeSoon}
            style={{ position: 'fixed', left: pos.x, top: pos.y - 8, transform: 'translate(-50%, -100%)' }}
            className="z-50 block max-w-xs rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg"
          >
            {resolvedTitle && <span className="block text-xs font-semibold">{resolvedTitle}</span>}
            {resolvedDescription && <span className="block">{resolvedDescription}</span>}
            {cta && href && (
              // Link handles internal docs pages client-side (verified: navigating
              // into holocron-rendered pages works) and falls back to normal
              // anchor behavior for external URLs.
              <Link href={href} className="mt-1 inline-block text-xs text-primary hover:underline">
                {cta}
              </Link>
            )}
          </span>,
          document.body,
        )}
    </span>
  )
}
