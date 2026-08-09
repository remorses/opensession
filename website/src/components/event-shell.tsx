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
  FileIcon,
  FileTextIcon,
  InboxIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  MailIcon,
  MicIcon,
  NotebookPenIcon,
  SettingsIcon,
  StarIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react'
import { Link, useLoaderData, useRouterState } from 'spiceflow/react'
import { cn, formatDateRange } from '../lib/utils.ts'

type NavItem = {
  label: string
  /** Path segment under /org/:orgId/e/:eventId — '' is the dashboard. */
  segment: string
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
      { label: 'Portal Forms', segment: 'portal-forms', icon: NotebookPenIcon },
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

export function EventSidebar() {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event } = useLoaderData('/org/:orgId/e/:eventId/*')
  const { pathname } = useRouterState()
  const base = `/org/${currentOrgId}/e/${event.id}`

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-1 border-r border-border px-3 py-4">
      <div className="flex flex-col px-2 pb-3">
        <span className="truncate text-sm font-semibold">{event.name}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDateRange({ startMs: event.startsAt, endMs: event.endsAt, timezone: event.timezone })}
        </span>
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
              const href = item.segment ? `${base}/${item.segment}` : base
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
