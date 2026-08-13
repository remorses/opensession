// Organizer embed builder with browser-local named presets. Public output
// configuration stays in validated query parameters, never database rows.
'use client'

import { useEffect, useState } from 'react'
import { CheckIcon, CircleAlertIcon, ClipboardIcon, ExternalLinkIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react'
import { Link, router, useLoaderData } from 'spiceflow/react'
import {
  buildEmbedOutput,
  parseEmbedPresets,
  PUBLIC_WIDGET_FIELDS,
  serializeEmbedPresets,
  type EmbedOutputFormat,
  type EmbedPreset,
  type PublicWidgetField,
  type PublicWidgetView,
} from '../lib/public-program.ts'
import { Button } from './ui/button.tsx'
import { Frame } from './ui/frame.tsx'
import { Badge, Input, NativeSelect } from './ui/primitives.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import { toast } from './ui/toast.tsx'

const widgetTypes: Array<{ value: PublicWidgetView; label: string; description: string }> = [
  { value: 'sessions', label: 'Sessions list', description: 'A searchable list for event and content pages.' },
  { value: 'speakers', label: 'Speaker directory', description: 'A detailed directory with speaker profiles and sessions.' },
  { value: 'agenda', label: 'Agenda grid', description: 'A room-by-time schedule for the main event program page.' },
  { value: 'itinerary', label: 'Attendee itinerary', description: 'A schedule list where attendees can build a personal plan.' },
  { value: 'gallery', label: 'Speaker gallery', description: 'A visual speaker grid for landing pages and promotional sites.' },
]
const outputFormats: Array<{ value: EmbedOutputFormat; label: string; kind: string; description: string }> = [
  { value: 'styled', label: 'Styled JavaScript', kind: 'Embed code', description: 'Paste one script tag into a website. Basic coding access is required.' },
  { value: 'html', label: 'Hosted HTML', kind: 'Embed code', description: 'Paste an iframe into a website. No JavaScript integration is required.' },
  { value: 'json', label: 'JSON', kind: 'API feed', description: 'Structured data for a custom website or app. Developer work is required.' },
  { value: 'xml', label: 'XML', kind: 'API feed', description: 'Structured XML for CMS and integration tools. Developer work is usually required.' },
  { value: 'ical', label: 'iCal', kind: 'Calendar feed', description: 'A calendar subscription or download URL. No website coding is required.' },
]
const fields: Array<{ value: PublicWidgetField; label: string }> = [
  { value: 'description', label: 'Descriptions' },
  { value: 'speakers', label: 'Speakers' },
  { value: 'track', label: 'Tracks' },
  { value: 'format', label: 'Formats' },
  { value: 'room', label: 'Rooms' },
  { value: 'time', label: 'Dates and times' },
  { value: 'photo', label: 'Speaker photos' },
  { value: 'jobTitle', label: 'Job titles' },
  { value: 'company', label: 'Companies' },
  { value: 'bio', label: 'Speaker biographies' },
  { value: 'sessions', label: 'Speaker sessions' },
]

export function EmbedBuilder() {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event, tracks, formats, rooms, appUrl } = useLoaderData('/org/:orgId/e/:eventId/*')
  const [widget, setWidget] = useState<PublicWidgetView>('sessions')
  const [format, setOutputFormat] = useState<EmbedOutputFormat>('styled')
  const [accent, setAccent] = useState('#171717')
  const [compact, setCompact] = useState(false)
  const [track, setTrack] = useState('')
  const [sessionFormat, setSessionFormat] = useState('')
  const [room, setRoom] = useState('')
  const [visibleFields, setVisibleFields] = useState<PublicWidgetField[]>(fields.map((field) => field.value))
  const [refreshToken, setRefreshToken] = useState(0)
  const [presetName, setPresetName] = useState('')
  const [presets, setPresets] = useState<EmbedPreset[]>([])
  const [presetsReady, setPresetsReady] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [nextName, setNextName] = useState('')
  const [retrieved, setRetrieved] = useState<{ name: string; output: string } | null>(null)
  const storageKey = `opensession:embed-presets:${event.id}`
  const config = {
    widget, outputFormat: format, accent, compact, trackId: track,
    formatId: sessionFormat, roomId: room, visibleFields,
  }
  const { widgetUrl, outputUrl, output } = buildEmbedOutput({
    appUrl, eventSlug: event.slug, eventName: event.name, config,
  })
  const widgetDescription = widgetTypes.find((item) => item.value === widget)?.description
  const outputFormat = outputFormats.find((item) => item.value === format)!

  useEffect(() => {
    const stored = localStorage.getItem(storageKey)
    const parsed = parseEmbedPresets(stored)
    setPresets(parsed)
    setPresetsReady(true)
    if (stored && serializeEmbedPresets(parsed) !== stored) {
      if (parsed.length) localStorage.setItem(storageKey, serializeEmbedPresets(parsed))
      else localStorage.removeItem(storageKey)
    }
  }, [storageKey])

  useEffect(() => {
    if (!presetsReady) return
    if (presets.length) localStorage.setItem(storageKey, serializeEmbedPresets(presets))
    else localStorage.removeItem(storageKey)
  }, [presets, presetsReady, storageKey])

  function savePreset() {
    const name = presetName.trim()
    if (!name) return toast.error('Enter a preset name')
    if (presets.some((preset) => preset.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))) {
      return toast.error('Preset names must be unique')
    }
    setPresets((current) => [...current, { name, enabled: true, ...config }])
    setPresetName('')
    toast.success('Embed preset saved in this browser')
  }

  function loadPreset(preset: EmbedPreset) {
    setWidget(preset.widget)
    setOutputFormat(preset.outputFormat)
    setAccent(preset.accent)
    setCompact(preset.compact)
    setTrack(preset.trackId)
    setSessionFormat(preset.formatId)
    setRoom(preset.roomId)
    setVisibleFields(preset.visibleFields)
    toast.success(`Loaded ${preset.name}`)
  }

  function renamePreset(name: string) {
    const renamed = nextName.trim()
    if (!renamed) return toast.error('Enter a preset name')
    if (presets.some((preset) => preset.name !== name && preset.name.toLocaleLowerCase('en-US') === renamed.toLocaleLowerCase('en-US'))) {
      return toast.error('Preset names must be unique')
    }
    setPresets((current) => current.map((preset) => preset.name === name ? { ...preset, name: renamed } : preset))
    setEditingName(null)
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(output)
      toast.success(format === 'styled' || format === 'html' ? 'Embed code copied' : 'Feed URL copied')
    } catch {
      toast.error('Your browser did not allow clipboard access')
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Embeds and feeds</h1>
        <p className="text-sm text-muted-foreground">
          Choose a public display or data feed. Output configuration stays in each URL. Named presets stay only in this browser.
        </p>
      </div>

      {!event.programPublishedAt ? (
        <div className="flex flex-col gap-3 border-y border-warning/40 bg-warning/5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            <CircleAlertIcon className="mt-0.5 size-5 shrink-0 text-warning" />
            <div className="flex flex-col gap-1">
              <strong>Publish the program before sharing widgets or feeds</strong>
              <p className="text-sm text-muted-foreground">
                These outputs are blocked until Agenda publication. First approve public sessions, schedule them, review conflicts, and publish.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            render={<Link href={router.href(`/org/${currentOrgId}/e/${event.id}/agenda`, { view: 'list' })} />}
          >
            Open Agenda
          </Button>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[22rem_1fr]">
        <div className="flex flex-col gap-5">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Widget
            <NativeSelect value={widget} onChange={(event) => {
              const next = widgetTypes.find((item) => item.value === event.target.value)?.value
              if (!next) return
              setWidget(next)
              if ((next === 'speakers' || next === 'gallery') && format === 'ical') setOutputFormat('styled')
            }}>
              {widgetTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </NativeSelect>
            <span className="font-normal text-muted-foreground">{widgetDescription}</span>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Output format
            <NativeSelect value={format} onChange={(event) => {
              const next = outputFormats.find((item) => item.value === event.target.value)?.value
              if (next) setOutputFormat(next)
            }}>
              {outputFormats.map((item) => <option key={item.value} value={item.value} disabled={item.value === 'ical' && (widget === 'speakers' || widget === 'gallery')}>{item.label}</option>)}
            </NativeSelect>
            <span className="font-normal text-muted-foreground">
              <strong className="font-medium text-foreground">{outputFormat.kind}.</strong> {outputFormat.description}
            </span>
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
            <Filter value={sessionFormat} label="All formats" rows={formats} onChange={setSessionFormat} />
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
            <iframe key={`${widgetUrl}:${refreshToken}`} src={widgetUrl} title={`${event.name} preview`} className="h-[38rem] w-full border-0 bg-background" />
          </Frame>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{outputFormat.kind}: {outputFormat.label}</span>
              <Button size="sm" variant="outline" onClick={copySnippet}><ClipboardIcon />Copy</Button>
            </div>
            <pre className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 text-xs"><code>{output}</code></pre>
            <div className="flex flex-col gap-1 border-t border-border pt-3">
              <span className="text-sm font-medium">Share URL</span>
              <p className="text-sm text-muted-foreground">Open or send the hosted widget directly. No coding is required.</p>
              <code className="break-all text-xs">{widgetUrl}</code>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setRefreshToken((value) => value + 1)}><RefreshCwIcon />Refresh live preview</Button>
              <Button variant="outline" render={<Link href={format === 'styled' ? widgetUrl : outputUrl} target="_blank" />}><ExternalLinkIcon />Open output</Button>
            </div>
            <p className="text-sm text-muted-foreground">Outputs use current organizer data. Refreshing does not require saving or regenerating the embed.</p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-5">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold">Saved embed presets</h2>
          <p className="text-sm text-muted-foreground">Presets organize code in this browser. Disabling a preset does not revoke URLs or code that was already copied.</p>
        </div>
        <div className="flex max-w-xl gap-2">
          <Input aria-label="Preset name" placeholder="Preset name" value={presetName} onChange={(event) => setPresetName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') savePreset() }} />
          <Button onClick={savePreset}>Save current</Button>
        </div>
        {presets.length ? (
          <Frame>
            <Table>
              <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Configuration</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
              <TableBody>{presets.map((preset) => {
                const presetOutput = buildEmbedOutput({ appUrl, eventSlug: event.slug, eventName: event.name, config: preset })
                return <TableRow key={preset.name} className={preset.enabled ? undefined : 'opacity-55'}>
                  <TableCell>
                    {editingName === preset.name ? <div className="flex gap-2"><Input aria-label={`Rename ${preset.name}`} value={nextName} onChange={(event) => setNextName(event.target.value)} /><Button size="sm" onClick={() => renamePreset(preset.name)}>Save</Button></div> : <div className="flex items-center gap-2"><strong>{preset.name}</strong><Badge variant={preset.enabled ? 'success' : 'secondary'}>{preset.enabled ? 'Enabled' : 'Disabled'}</Badge></div>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{widgetTypes.find((row) => row.value === preset.widget)?.label} · {outputFormats.find((row) => row.value === preset.outputFormat)?.label}</TableCell>
                  <TableCell><div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => loadPreset(preset)}>Load</Button>
                    <Button size="sm" variant="outline" onClick={() => { setEditingName(preset.name); setNextName(preset.name) }}>Rename</Button>
                    <Button size="sm" variant="outline" onClick={() => setPresets((current) => current.map((row) => row.name === preset.name ? { ...row, enabled: !row.enabled } : row))}>{preset.enabled ? 'Disable' : 'Enable'}</Button>
                    <Button size="sm" variant="outline" disabled={!preset.enabled} onClick={async () => {
                      setRetrieved({ name: preset.name, output: presetOutput.output })
                      try { await navigator.clipboard.writeText(presetOutput.output); toast.success(`Code copied for ${preset.name}`) }
                      catch { toast.error('Your browser did not allow clipboard access') }
                    }}><ClipboardIcon />Get code</Button>
                    <Button size="sm" variant="outline" disabled={!preset.enabled} render={<Link href={preset.outputFormat === 'styled' ? presetOutput.widgetUrl : presetOutput.outputUrl} target="_blank" />}><ExternalLinkIcon />Open</Button>
                    <Button aria-label={`Delete ${preset.name}`} size="sm" variant="ghost" onClick={() => setPresets((current) => current.filter((row) => row.name !== preset.name))}><Trash2Icon /></Button>
                  </div></TableCell>
                </TableRow>
              })}</TableBody>
            </Table>
          </Frame>
        ) : <p className="text-sm text-muted-foreground">No presets saved in this browser.</p>}
        {retrieved ? <div className="flex flex-col gap-2"><strong className="text-sm">Code for {retrieved.name}</strong><pre className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 text-xs"><code>{retrieved.output}</code></pre></div> : null}
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-5">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold">Direct outputs</h2>
          <p className="text-sm text-muted-foreground">API feeds need developer integration. The calendar feed and public program can be shared without code.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <FeedLink href={new URL(`/public/${event.slug}/schedule.json`, appUrl).href} kind="API feed">Schedule JSON</FeedLink>
          <FeedLink href={new URL(`/public/${event.slug}/speakers.json`, appUrl).href} kind="API feed">Speakers JSON</FeedLink>
          <FeedLink href={new URL(`/public/${event.slug}/schedule.ics`, appUrl).href} kind="Calendar feed">Schedule ICS</FeedLink>
          <FeedLink href={new URL(`/public/${event.slug}/sessions`, appUrl).href} kind="Share URL">Public program</FeedLink>
        </div>
        {event.programPublishedAt ? <p className="flex items-center gap-1.5 text-sm text-success"><CheckIcon className="size-4" />Program published. Outputs return live public data.</p> : null}
      </div>
    </div>
  )
}

function Filter({ value, label, rows, onChange }: { value: string; label: string; rows: Array<{ id: string; name: string }>; onChange: (value: string) => void }) {
  return <NativeSelect aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}><option value="">{label}</option>{rows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</NativeSelect>
}

function FeedLink({ href, kind, children }: { href: string; kind: string; children: React.ReactNode }) {
  return <Button size="sm" variant="outline" render={<Link href={href} target="_blank" />}><span className="text-muted-foreground">{kind}:</span> {children}<ExternalLinkIcon /></Button>
}
