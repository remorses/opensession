// Event sidebar (left nav) for /org/:orgId/e/:eventId/* pages — the
// OpenSession take on SessionBoard's grouped sidebar (see images/doc-image-05).
// Header shows the event name + dates only; org/event switchers stay in the
// top navbar rendered by the outer /org/:orgId/* layout. Nav groups are the
// single source of truth for sidebar sections — later tasks replace each
// placeholder page but should NOT need to touch this file except to tweak
// labels/icons.
'use client'

import {
  CalendarDaysIcon,
  CodeXmlIcon,
  ExternalLinkIcon,
  FileIcon,
  FileTextIcon,
  InboxIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  MailIcon,
  MicIcon,
  SettingsIcon,
  StarIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react'
import { Link, router, useLoaderData, useRouterState } from 'spiceflow/react'
import { cn, formatDateRange } from '../lib/utils.ts'

type NavSegment = '' | 'abstracts' | 'sessions' | 'files' | 'forms' | 'evaluation' | 'agenda' | 'tasks' | 'speakers' | 'emails' | 'embeds' | 'settings'

type NavItem = {
  label: string
  /** Path segment under /org/:orgId/e/:eventId — '' is the dashboard. */
  segment: NavSegment
  icon: LucideIcon
}

type NavGroup = {
  /** Small uppercase group label; null for the top-level Dashboard item. */
  label: string | null
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    label: null,
    items: [{ label: 'Dashboard', segment: '', icon: LayoutDashboardIcon }],
  },
  {
    label: 'Submissions',
    items: [
      { label: 'Abstracts', segment: 'abstracts', icon: InboxIcon },
      { label: 'Sessions', segment: 'sessions', icon: MicIcon },
      { label: 'Files', segment: 'files', icon: FileIcon },
    ],
  },
  {
    label: 'Collect & Review',
    items: [
      { label: 'Forms', segment: 'forms', icon: FileTextIcon },
      { label: 'Evaluation', segment: 'evaluation', icon: StarIcon },
      { label: 'Agenda', segment: 'agenda', icon: CalendarDaysIcon },
    ],
  },
  {
    label: 'Portal',
    items: [
      { label: 'Tasks', segment: 'tasks', icon: ListChecksIcon },
      { label: 'Speakers', segment: 'speakers', icon: UsersIcon },
    ],
  },
  {
    label: 'Communications',
    items: [
      { label: 'Emails', segment: 'emails', icon: MailIcon },
      { label: 'Embeds', segment: 'embeds', icon: CodeXmlIcon },
    ],
  },
  {
    label: 'Configure',
    items: [{ label: 'Settings', segment: 'settings', icon: SettingsIcon }],
  },
]

function eventHref({ orgId, eventId, segment }: { orgId: string; eventId: string; segment: NavSegment }) {
  const params = { orgId, eventId }
  switch (segment) {
    case 'abstracts': return router.href(`/org/${orgId}/e/${eventId}/abstracts`)
    case 'sessions': return router.href(`/org/${orgId}/e/${eventId}/sessions`)
    case 'files': return router.href(`/org/${orgId}/e/${eventId}/files`)
    case 'forms': return router.href('/org/:orgId/e/:eventId/forms', params)
    case 'evaluation': return router.href(`/org/${orgId}/e/${eventId}/evaluation`)
    case 'agenda': return router.href(`/org/${orgId}/e/${eventId}/agenda`)
    case 'tasks': return router.href(`/org/${orgId}/e/${eventId}/tasks`)
    case 'speakers': return router.href(`/org/${orgId}/e/${eventId}/speakers`)
    case 'emails': return router.href(`/org/${orgId}/e/${eventId}/emails`)
    case 'embeds': return router.href('/org/:orgId/e/:eventId/embeds', params)
    case 'settings': return router.href(`/org/${orgId}/e/${eventId}/settings`)
    default: return router.href('/org/:orgId/e/:eventId', params)
  }
}

export function EventSidebar() {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event } = useLoaderData('/org/:orgId/e/:eventId/*')
  const { pathname } = useRouterState()
  const base = router.href('/org/:orgId/e/:eventId', { orgId: currentOrgId, eventId: event.id })

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-1 border-r border-border px-3 py-4">
      <div className="flex flex-col px-2 pb-3">
        <span className="truncate text-sm font-semibold">{event.name}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDateRange({ startMs: event.startsAt, endMs: event.endsAt, timezone: event.timezone })}
        </span>
        <Link
          href={router.href('/portal/:eventSlug', { eventSlug: event.slug })}
          target="_blank"
          rel="noreferrer"
          className="mt-2 flex w-fit items-center gap-1.5 text-xs font-medium text-foreground no-underline hover:underline"
        >
          View speaker portal
          <ExternalLinkIcon className="size-3" />
        </Link>
      </div>
      <nav className="flex flex-col gap-0.5">
        {navGroups.map((group) => (
          <div key={group.label ?? 'top'} className="flex flex-col gap-0.5">
            {group.label ? (
              <span className="px-2 pt-4 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 select-none">
                {group.label}
              </span>
            ) : null}
            {group.items.map((item) => {
              const href = eventHref({ orgId: currentOrgId, eventId: event.id, segment: item.segment })
              const active = item.segment
                ? pathname === href || pathname.startsWith(`${href}/`)
                : pathname === base
              return (
                <Link
                  key={item.segment}
                  href={href}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm no-underline transition-colors',
                    active
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  <item.icon className="size-4 shrink-0 opacity-80" />
                  {item.label}
                </Link>
              )
            })}
          </div>
        ))}
      </nav>
    </aside>
  )
}
