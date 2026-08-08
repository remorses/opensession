// Global toast notifications for server-action failures (and light success).
// No third-party toast lib: a tiny pub/sub store + fixed viewport. Mount
// <Toaster /> once in each top-level shell (dashboard, portal, public forms).
'use client'

import * as React from 'react'
import { XIcon } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from './button.tsx'

export type ToastTone = 'error' | 'success' | 'info'

export type ToastItem = {
  id: string
  tone: ToastTone
  title?: string
  message: string
  createdAt: number
}

const MAX_TOASTS = 4
const DEFAULT_MS = 8_000

type Listener = (items: ToastItem[]) => void

let items: ToastItem[] = []
const listeners = new Set<Listener>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function emit() {
  const snapshot = items
  for (const listener of listeners) listener(snapshot)
}

function dismiss(id: string) {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  items = items.filter((row) => row.id !== id)
  emit()
}

function push(tone: ToastTone, message: string, title?: string, durationMs = DEFAULT_MS) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const next: ToastItem = { id, tone, title, message: message.trim() || 'Something went wrong', createdAt: Date.now() }
  items = [next, ...items].slice(0, MAX_TOASTS)
  emit()
  if (durationMs > 0) {
    timers.set(id, setTimeout(() => dismiss(id), durationMs))
  }
  return id
}

/** Show a toast. Prefer toast.error for failed server actions. */
export const toast = {
  error(message: string, title = 'Action failed') {
    return push('error', message, title)
  },
  success(message: string, title?: string) {
    return push('success', message, title, 4_000)
  },
  info(message: string, title?: string) {
    return push('info', message, title, 5_000)
  },
  dismiss,
}

/** Normalize any thrown value into a short user-facing message and toast it. */
export function toastActionError(err: unknown, fallback = 'Something went wrong') {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : fallback
  toast.error(message)
  return message
}

/** Run an async server action; toast on throw. Returns null on failure. */
export async function runAction<T>(
  fn: () => Promise<T>,
  opts?: { success?: string; fallbackError?: string },
): Promise<T | null> {
  try {
    const result = await fn()
    if (opts?.success) toast.success(opts.success)
    return result
  } catch (err) {
    toastActionError(err, opts?.fallbackError)
    return null
  }
}

export function Toaster() {
  const [list, setList] = React.useState<ToastItem[]>(items)

  React.useEffect(() => {
    const listener: Listener = (next) => setList(next)
    listeners.add(listener)
    setList(items)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  if (list.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-end gap-2 p-4 sm:p-6"
      aria-live="polite"
      aria-relevant="additions"
    >
      {list.map((item) => (
        <div
          key={item.id}
          role={item.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border px-3 py-2.5 shadow-lg',
            'bg-popover text-popover-foreground',
            item.tone === 'error' && 'border-destructive/40',
            item.tone === 'success' && 'border-primary/30',
            item.tone === 'info' && 'border-border',
          )}
        >
          <div className="min-w-0 flex-1 flex flex-col gap-0.5">
            {item.title ? (
              <p
                className={cn(
                  'text-sm font-medium',
                  item.tone === 'error' && 'text-destructive',
                )}
              >
                {item.title}
              </p>
            ) : null}
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{item.message}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            aria-label="Dismiss"
            onClick={() => dismiss(item.id)}
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </div>
  )
}
