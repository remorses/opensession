// Components map for SafeMdxRenderer — NO 'use client' directive on
// purpose (RSC rule from the safe-mdx/spiceflow docs: a map exported from
// a 'use client' barrel becomes an opaque client reference and safe-mdx
// silently falls back to bare HTML tags). Server-safe layout components
// live here; the interactive fields are imported from the 'use client'
// field-components module.

import type { ReactNode } from 'react'
import {
  Checkbox,
  FileUpload,
  Number,
  Participants,
  Radio,
  RichText,
  Select,
  TextField,
} from './field-components.tsx'

// ── Server-safe layout / logic components ───────────────────────────

/** Conditional wrapper: renders children only when `when` is truthy.
 *  This is THE conditional mechanism for form MDX — safe-mdx cannot
 *  evaluate JSX inside `{cond && <.../>}` expressions, but attribute
 *  expressions like when={values.needsAV === 'true'} evaluate fine and
 *  re-run on every value change. */
export function Show({ when, children }: { when?: unknown; children?: ReactNode }) {
  return when ? <>{children}</> : null
}

export function Section({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      {title ? <h2 className="text-lg font-semibold tracking-tight">{title}</h2> : null}
      {children}
    </section>
  )
}

export function Info({ children }: { children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground [&_p]:m-0">
      {children}
    </div>
  )
}

/** Multistep form marker. Full-form preview (admin editor) renders every
 *  step's children in document order. The public wizard slices MDX per
 *  step and never mounts this wrapper for a single step body. */
export function Step({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      {title ? <h2 className="text-lg font-semibold tracking-tight">{title}</h2> : null}
      {children}
    </section>
  )
}

// ── Markdown element styling (welcome copy between fields) ──────────

function P({ children }: { children?: ReactNode }) {
  return <p className="text-sm text-muted-foreground leading-relaxed">{children}</p>
}

function H1({ children }: { children?: ReactNode }) {
  return <h1 className="text-xl font-semibold tracking-tight">{children}</h1>
}

function H2({ children }: { children?: ReactNode }) {
  return <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
}

function Ul({ children }: { children?: ReactNode }) {
  return <ul className="list-disc pl-5 text-sm text-muted-foreground flex flex-col gap-1">{children}</ul>
}

/** The map consumed by SafeMdxRenderer/MdastToJsx in the form renderer. */
export const formComponents = {
  TextField,
  RichText,
  Number,
  Select,
  Checkbox,
  Radio,
  FileUpload,
  Participants,
  Show,
  Section,
  Step,
  Info,
  p: P,
  h1: H1,
  h2: H2,
  ul: Ul,
}
