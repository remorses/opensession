// Organizer embed builder. Configuration stays in validated iframe query
// parameters; no widget records or saved configuration tables are needed.
'use client'

import { useState } from 'react'
import { CheckIcon, ClipboardIcon, ExternalLinkIcon } from 'lucide-react'
import { Link, useLoaderData } from 'spiceflow/react'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import { Input, NativeSelect } from './ui/primitives.tsx'
import { toast } from './ui/toast.tsx'

type WidgetType = 'sessions' | 'speakers' | 'agenda' | 'itinerary' | 'gallery'
type FieldName = 'description' | 'speakers' | 'track' | 'format' | 'room' | 'time'

const widgetTypes: Array<{ value: WidgetType; label: string }> = [
  { value: 'sessions', label: 'Sessions list' },
  { value: 'speakers', label: 'Speakers list' },
  { value: 'agenda', label: 'Agenda grid' },
  { value: 'itinerary', label: 'Schedule itinerary' },
  { value: 'gallery', label: 'Speaker gallery' },
]
const fields: Array<{ value: FieldName; label: string }> = [
  { value: 'description', label: 'Descriptions' },
  { value: 'speakers', label: 'Speakers' },
  { value: 'track', label: 'Tracks' },
  { value: 'format', label: 'Formats' },
  { value: 'room', label: 'Rooms' },
  { value: 'time', label: 'Dates and times' },
]

export function EmbedBuilder() {
  const { event, tracks, formats, rooms, appUrl } = useLoaderData('/org/:orgId/e/:eventId/*')
  const [widget, setWidget] = useState<WidgetType>('sessions')
  const [accent, setAccent] = useState('#171717')
  const [compact, setCompact] = useState(false)
  const [track, setTrack] = useState('')
  const [format, setFormat] = useState('')
  const [room, setRoom] = useState('')
  const [visibleFields, setVisibleFields] = useState<FieldName[]>(fields.map((field) => field.value))
  const params = new URLSearchParams()
  if (accent !== '#171717') params.set('accent', accent)
  if (compact) params.set('compact', '1')
  if (track) params.set('track', track)
  if (format) params.set('format', format)
  if (room) params.set('room', room)
  if (visibleFields.length !== fields.length) params.set('fields', visibleFields.join(','))
  const suffix = params.size > 0 ? `?${params}` : ''
  const path = `/embed/${encodeURIComponent(event.slug)}/${widget}${suffix}`
  const url = new URL(path, appUrl).href
  const snippet = `<iframe src="${url}" title="${event.name} ${widget}" loading="lazy" style="width:100%;height:720px;border:0" allow="clipboard-write"></iframe>`

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet)
      toast.success('Iframe snippet copied')
    } catch {
      toast.error('Your browser did not allow clipboard access')
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Embeds and feeds</h1>
        <p className="text-sm text-muted-foreground">
          Generate live iframe URLs. Configuration is encoded in the URL, so no saved widget can become stale.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[22rem_1fr]">
        <div className="flex flex-col gap-5">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Widget
            <NativeSelect value={widget} onChange={(event) => setWidget(event.target.value as WidgetType)}>
              {widgetTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </NativeSelect>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Accent color
            <span className="flex gap-2"><Input className="w-14 p-1" type="color" value={accent} onChange={(event) => setAccent(event.target.value)} /><Input value={accent} pattern="#[0-9a-fA-F]{6}" onChange={(event) => setAccent(event.target.value)} /></span>
          </label>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={compact} onChange={(event) => setCompact(event.target.checked)} />
            Compact density
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Content filters</span>
            <Filter value={track} label="All tracks" rows={tracks} onChange={setTrack} />
            <Filter value={format} label="All formats" rows={formats} onChange={setFormat} />
            <Filter value={room} label="All rooms" rows={rooms} onChange={setRoom} />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="pb-1 text-sm font-medium">Visible fields</legend>
            {fields.map((field) => (
              <label key={field.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={visibleFields.includes(field.value)}
                  onChange={(event) => setVisibleFields(event.target.checked
                    ? [...visibleFields, field.value]
                    : visibleFields.filter((value) => value !== field.value))}
                />
                {field.label}
              </label>
            ))}
          </fieldset>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Frame className="overflow-hidden">
            <iframe key={url} src={url} title={`${event.name} preview`} className="h-[38rem] w-full border-0 bg-background" />
          </Frame>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Iframe snippet</span>
              <Button size="sm" variant="outline" onClick={copySnippet}><ClipboardIcon />Copy</Button>
            </div>
            <pre className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 text-xs"><code>{snippet}</code></pre>
            <Button variant="outline" render={<Link href={url} target="_blank" />}><ExternalLinkIcon />Open widget URL</Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-5">
        <h2 className="font-semibold">Live feeds</h2>
        <div className="flex flex-wrap gap-2">
          <FeedLink href={new URL(`/public/${event.slug}/schedule.json`, appUrl).href}>Schedule JSON</FeedLink>
          <FeedLink href={new URL(`/public/${event.slug}/speakers.json`, appUrl).href}>Speakers JSON</FeedLink>
          <FeedLink href={new URL(`/public/${event.slug}/schedule.ics`, appUrl).href}>Schedule ICS</FeedLink>
          <FeedLink href={new URL(`/public/${event.slug}/sessions`, appUrl).href}>Public program</FeedLink>
        </div>
        {!event.programPublishedAt ? <p className="text-sm text-muted-foreground">Publish the program from Agenda before these links return public data.</p> : <p className="flex items-center gap-1.5 text-sm text-success"><CheckIcon className="size-4" />Program published</p>}
      </div>
    </div>
  )
}

function Filter({ value, label, rows, onChange }: { value: string; label: string; rows: Array<{ id: string; name: string }>; onChange: (value: string) => void }) {
  return <NativeSelect aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}><option value="">{label}</option>{rows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</NativeSelect>
}

function FeedLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Button size="sm" variant="outline" render={<Link href={href} target="_blank" />}>{children}<ExternalLinkIcon /></Button>
}
