// Client chrome for the dashboard shell: org switcher (header, right after
// the logo), user menu (circle avatar, header right), and the footer theme
// select. All read route data from the /org/:orgId/* loader.
'use client'

import { useEffect, useState } from 'react'
import { ErrorBoundary, router, useLoaderData } from 'spiceflow/react'
import { BuildingIcon, CheckIcon, ChevronDownIcon, LogOutIcon, PencilIcon, PlusIcon } from 'lucide-react'
import { cn } from '../lib/utils.ts'
import { authClient } from '../lib/auth-client.ts'
import { createOrg, renameOrg } from '../actions.tsx'
import { Button } from './ui/button.tsx'
import { Input, NativeSelect } from './ui/primitives.tsx'
import {
  Dialog, DialogDescription, DialogHeader,
  DialogPanel, DialogPopup, DialogTitle,
} from './ui/dialog.tsx'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPopup,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx'

// ── Org switcher ────────────────────────────────────────────────────
// Lists all orgs the user belongs to. The org id lives in the URL
// (/org/:orgId/*), so switching is a plain client-side navigation —
// loaders re-run with the new org, no server action, no cookie.

export function OrgSwitch() {
  const { orgName, orgs, currentOrgId, role } = useLoaderData('/org/:orgId/*')
  const [dialog, setDialog] = useState<'create' | 'rename' | null>(null)
  const isAdmin = role === 'admin'

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            // pt aligns the trigger with the logo wordmark baseline
            'flex items-center gap-2 rounded-md px-2 pt-2.5 pb-1.5 text-sm transition-colors hover:bg-accent data-[popup-open]:bg-accent',
          )}
        >
          <span className="max-w-40 truncate font-medium">{orgName}</span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>

        <DropdownMenuPopup side="bottom" align="start" sideOffset={4}>
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          {orgs.map((org) => (
            <DropdownMenuItem
              key={org.orgId}
              onClick={() => {
                if (org.orgId === currentOrgId) return
                router.push(router.href('/org/:orgId', { orgId: org.orgId }))
              }}
            >
              <div className="flex size-6 items-center justify-center rounded-md border">
                <BuildingIcon className="size-3.5 shrink-0" />
              </div>
              <span className="flex-1 truncate">{org.name}</span>
              {org.orgId === currentOrgId ? <CheckIcon className="size-3.5 text-muted-foreground" /> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setDialog('create')}>
            <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
              <PlusIcon className="size-4" />
            </div>
            <span className="font-medium">Add organization</span>
          </DropdownMenuItem>
          {isAdmin && (
            <DropdownMenuItem onClick={() => setDialog('rename')}>
              <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                <PencilIcon className="size-3.5" />
              </div>
              <span>Rename organization</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuPopup>
      </DropdownMenu>
      <CreateOrgDialog
        open={dialog === 'create'}
        onOpenChange={(open) => setDialog(open ? 'create' : null)}
      />
      <RenameOrgDialog
        open={dialog === 'rename'}
        onOpenChange={(open) => setDialog(open ? 'rename' : null)}
        orgId={currentOrgId}
        currentName={orgName}
      />
    </>
  )
}

function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  // The createOrg action redirects to the new org's events page —
  // client-side navigation, no reload. Errors thrown by the action are
  // caught by the ErrorBoundary; `below` keeps the form visible to retry.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add organization</DialogTitle>
          <DialogDescription>
            A separate workspace with its own events, speakers, and members.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ErrorBoundary
            below
            fallback={<ErrorBoundary.ErrorMessage className="mt-3 text-sm text-destructive" />}
          >
            <form
              className="flex flex-col gap-3"
              action={async (formData: FormData) => {
                const name = String(formData.get('name') ?? '').trim()
                await createOrg({ name })
                // The action redirects to the new org's page, but
                // same-pathname navigation wouldn't auto-close the
                // dialog, so close it explicitly.
                onOpenChange(false)
              }}
            >
              <Input autoFocus required name="name" placeholder="Organization name" maxLength={60} />
              <Button type="submit" className="w-full">
                Create organization
              </Button>
            </form>
          </ErrorBoundary>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

function RenameOrgDialog({ open, onOpenChange, orgId, currentName }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  currentName: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Rename organization</DialogTitle>
          <DialogDescription>Change the display name of this organization.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ErrorBoundary
            below
            fallback={<ErrorBoundary.ErrorMessage className="mt-3 text-sm text-destructive" />}
          >
            <form
              className="flex flex-col gap-3"
              action={async (formData: FormData) => {
                const name = String(formData.get('name') ?? '').trim()
                await renameOrg({ orgId, name })
                onOpenChange(false)
              }}
            >
              <Input autoFocus required name="name" defaultValue={currentName} maxLength={60} />
              <Button type="submit" className="w-full">
                Rename
              </Button>
            </form>
          </ErrorBoundary>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

// ── User menu (circle avatar) ───────────────────────────────────────

export function UserMenu() {
  const { user } = useLoaderData('/org/:orgId/*')

  const initials = user.name
    ? user.name
        .split(' ')
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : '?'

  const avatar = user.image ? (
    <img src={user.image} alt={user.name} className="size-8 shrink-0 rounded-full object-cover" />
  ) : (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground font-medium text-xs">
      {initials}
    </div>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="rounded-full transition-opacity hover:opacity-80 data-[popup-open]:opacity-80">
        {avatar}
      </DropdownMenuTrigger>

      <DropdownMenuPopup side="bottom" align="end" sideOffset={6} className="min-w-56">
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
          {avatar}
          <div className="grid flex-1 leading-tight min-w-0">
            <span className="truncate font-medium text-sm">{user.name}</span>
            <span className="truncate text-xs text-muted-foreground">{user.email}</span>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={async () => {
            await authClient.signOut()
            // Hard navigation on purpose: it flushes the signed-out user's
            // in-memory loader data. Do not convert to router.push.
            window.location.href = '/login'
          }}
        >
          <LogOutIcon className="size-4 text-muted-foreground" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuPopup>
    </DropdownMenu>
  )
}

// ── Theme selector ──────────────────────────────────────────────────
// Shares the color-theme cookie with the holocron docs so app pages and
// docs stay in sync (same mechanism as sigillo).

type ThemeChoice = 'system' | 'light' | 'dark'

function parseThemeChoice(value: string | undefined): ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

function getStoredTheme(): ThemeChoice {
  if (typeof document === 'undefined') return 'system'
  const match = document.cookie.match(/(?:^|;\s*)color-theme=(light|dark)(?:;|$)/)
  return parseThemeChoice(match?.[1])
}

function applyTheme(theme: ThemeChoice) {
  const resolved =
    theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme

  document.documentElement.classList.toggle('dark', resolved === 'dark')
  if (theme === 'system') {
    document.cookie = 'color-theme=; Path=/; Max-Age=0; SameSite=Lax'
  } else {
    document.cookie = `color-theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`
  }
}

export function ThemeSelect() {
  const [theme, setTheme] = useState<ThemeChoice>('system')

  useEffect(() => {
    const storedTheme = getStoredTheme()
    setTheme(storedTheme)
    applyTheme(storedTheme)

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onSystemChange = () => {
      if (getStoredTheme() === 'system') applyTheme('system')
    }
    media.addEventListener('change', onSystemChange)
    return () => media.removeEventListener('change', onSystemChange)
  }, [])

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Theme</span>
      <NativeSelect
        aria-label="Theme"
        className="min-h-7 min-w-28 text-xs sm:min-h-7 sm:text-xs"
        value={theme}
        onChange={(event) => {
          const nextTheme = parseThemeChoice(event.currentTarget.value)
          setTheme(nextTheme)
          applyTheme(nextTheme)
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </NativeSelect>
    </div>
  )
}
