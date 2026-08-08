// MDX form editor ('use client') — /org/:orgId/e/:eventId/forms/:formId.
// Monaco editor and live FormRenderer preview (debounced ~300ms, with the
// event's real tracks/formats in scope) share the SAME full-width pane,
// toggled via an Editor | Preview tab row or Cmd/Ctrl+P (bound globally
// AND inside Monaco, since Monaco swallows keydown while focused). Save
// inserts a NEW immutable FormVersion (saveFormVersion warns when field
// names disappear on a form that already has responses). Version history
// loads an old version's source into the editor (unsaved until Save).
// Settings dialog edits name/slug/status/closesAt; purpose/target are
// immutable.
'use client'

import * as React from 'react'
import Editor from '@monaco-editor/react'
import { ErrorBoundary, Link, useLoaderData } from 'spiceflow/react'
import { ArrowLeftIcon, CheckIcon, CopyIcon, HistoryIcon, SettingsIcon, TrashIcon } from 'lucide-react'
import { deleteForm, saveFormVersion, updateFormSettings } from '../actions.tsx'
import { collectFields, libraryOptions } from '../forms/collect-fields.ts'
import { FormRenderer } from '../forms/form-renderer.tsx'
import { cn, formatDateTimeUTC } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { Input, NativeSelect } from './ui/primitives.tsx'
import { FormStatusBadge } from './forms-list.tsx'
import {
  Dialog, DialogDescription, DialogHeader,
  DialogPanel, DialogPopup, DialogTitle,
} from './ui/dialog.tsx'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPopup,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx'

// ── Dark mode (hydration-safe, tailwind-skill pattern) ──────────────

function getIsDark(): boolean {
  return document.documentElement.classList.contains('dark')
}
const getServerIsDark = () => false
function subscribeTheme(cb: () => void) {
  const observer = new MutationObserver(cb)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

// ── datetime-local helpers (closesAt is epoch ms) ───────────────────

function epochToDateTimeLocalInput(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function FormEditorPage() {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event, tracks, formats } = useLoaderData('/org/:orgId/e/:eventId/*')
  const { form, versions, submitted, drafts } = useLoaderData('/org/:orgId/e/:eventId/forms/:formId')
  const isDark = React.useSyncExternalStore(subscribeTheme, getIsDark, getServerIsDark)

  const newest = versions[0]
  const [source, setSource] = React.useState(newest?.mdxSource ?? '')
  const [loadedVersionId, setLoadedVersionId] = React.useState(newest?.id ?? null)
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [removedWarning, setRemovedWarning] = React.useState<string[] | null>(null)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [pane, setPane] = React.useState<'editor' | 'preview'>('editor')

  // Cmd/Ctrl+P toggles Editor/Preview. Bound on window (preventDefault so
  // the browser print/palette dialog never opens) AND inside Monaco via
  // addCommand — Monaco consumes keydown before it bubbles to window.
  // toggleRef keeps the Monaco command (registered once in onMount)
  // pointing at the latest state setter.
  const toggleRef = React.useRef(() => {})
  toggleRef.current = () => setPane((prev) => (prev === 'editor' ? 'preview' : 'editor'))
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        toggleRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Debounced preview: Monaco fires on every keystroke; the preview
  // re-parses MDX only after ~300ms of quiet.
  const [previewSource, setPreviewSource] = React.useState(source)
  React.useEffect(() => {
    const timer = setTimeout(() => setPreviewSource(source), 300)
    return () => clearTimeout(timer)
  }, [source])

  const scope = React.useMemo(
    () => ({ tracks: libraryOptions(tracks), formats: libraryOptions(formats) }),
    [tracks, formats],
  )

  // Field summary: the collector is pure and browser-safe. Empty values
  // scope = the fields visible before any conditional toggles.
  const summary = React.useMemo(
    () => collectFields({ mdxSource: previewSource, scope: { values: {}, ...scope } }),
    [previewSource, scope],
  )

  const dirty = source !== (newest?.mdxSource ?? '')
  const publicPath = `/submit/${event.slug}/${form.slug}`

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    setRemovedWarning(null)
    try {
      const result = await saveFormVersion({
        orgId: currentOrgId,
        eventId: event.id,
        formId: form.id,
        mdxSource: source,
      })
      setLoadedVersionId(result.versionId)
      if (result.removedFields.length > 0) setRemovedWarning(result.removedFields)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleCopyUrl = async () => {
    await navigator.clipboard.writeText(`${window.location.origin}${publicPath}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex flex-col gap-4">
      <Link
        href={`/org/${currentOrgId}/e/${event.id}/${form.purpose === 'PORTAL' ? 'portal-forms' : 'forms'}`}
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground no-underline transition-colors hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to forms
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{form.name}</h1>
            <FormStatusBadge status={form.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {form.purpose === 'CFP' ? 'CFP form' : `Portal form · ${form.target.toLowerCase()} target`}
            {' · '}
            {submitted} submission{submitted === 1 ? '' : 's'} · {drafts} draft{drafts === 1 ? '' : 's'}
            {form.closesAt ? ` · closes ${formatDateTimeUTC(form.closesAt)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <VersionHistory
            versions={versions}
            loadedVersionId={loadedVersionId}
            onLoad={(version) => {
              setSource(version.mdxSource)
              setLoadedVersionId(version.id)
            }}
          />
          <Button variant="outline" onClick={() => setSettingsOpen(true)}>
            <SettingsIcon />
            Settings
          </Button>
          <Button disabled={!dirty} loading={saving} onClick={handleSave}>
            Save version
          </Button>
        </div>
      </div>

      {form.purpose === 'CFP' && form.status === 'OPEN' ? (
        <div className="flex w-fit items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-1.5">
          <span className="text-xs text-muted-foreground">Public URL</span>
          <Link href={publicPath} className="font-mono text-xs underline underline-offset-4">{publicPath}</Link>
          <Button
            aria-label="Copy public URL"
            size="icon-xs"
            variant="ghost"
            title="Copy public URL"
            onClick={handleCopyUrl}
          >
            {copied ? <CheckIcon className="size-3.5 text-success-foreground" /> : <CopyIcon className="size-3.5 text-muted-foreground" />}
          </Button>
        </div>
      ) : null}

      {saveError ? <p className="text-sm text-destructive">{saveError}</p> : null}
      {removedWarning ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <span className="font-medium">Saved, but field names were removed: </span>
          <span className="font-mono">{removedWarning.join(', ')}</span>
          <span className="text-muted-foreground">
            {' '}
            — existing responses keep their values under those names, but new responses will no longer collect them.
          </span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center gap-1">
          {(['editor', 'preview'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setPane(value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-sm capitalize transition-colors',
                pane === value
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {value}
            </button>
          ))}
          <span className="ml-1 text-xs text-muted-foreground" title="Toggle editor and preview">
            ⌘P
          </span>
        </div>

        {/* Both panes stay mounted so Monaco keeps cursor/undo state and
            the preview keeps its form values across toggles. */}
        <div className={cn('overflow-hidden rounded-lg border border-border', pane !== 'editor' && 'hidden')}>
          <Editor
            height="calc(100vh - 21rem)"
            language="markdown"
            theme={isDark ? 'vs-dark' : 'light'}
            value={source}
            onChange={(value) => setSource(value ?? '')}
            onMount={(editor, monaco) => {
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => toggleRef.current())
            }}
            options={{
              minimap: { enabled: false },
              wordWrap: 'on',
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              tabSize: 2,
              renderLineHighlight: 'none',
              overviewRulerLanes: 0,
              padding: { top: 12, bottom: 12 },
            }}
          />
        </div>

        <div
          className={cn(
            'flex h-[calc(100vh-21rem)] min-w-0 flex-col gap-5 overflow-y-auto rounded-lg border border-border p-5',
            pane !== 'preview' && 'hidden',
          )}
        >
          <FormRenderer mdxSource={previewSource} scope={scope} />
          <div className="mt-auto flex flex-col gap-1 border-t border-border pt-3">
            <span className="text-xs font-medium text-muted-foreground">
              Visible fields ({summary.fields.length + summary.participantFields.length})
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {[...summary.fields, ...summary.participantFields].map((field) => field.name).join(', ') || '—'}
            </span>
          </div>
        </div>
      </div>

      <DangerZone
        orgId={currentOrgId}
        eventId={event.id}
        form={form}
        hasResponses={submitted + drafts > 0}
      />

      <FormSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        orgId={currentOrgId}
        eventId={event.id}
        form={form}
      />
    </div>
  )
}

// ── Version history ─────────────────────────────────────────────────

type VersionRow = { id: string; createdAt: number; mdxSource: string }

function VersionHistory({ versions, loadedVersionId, onLoad }: {
  versions: VersionRow[]
  loadedVersionId: string | null
  onLoad: (version: VersionRow) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" />}
      >
        <HistoryIcon />
        Versions
        <span className="text-xs text-muted-foreground tabular-nums">{versions.length}</span>
      </DropdownMenuTrigger>
      <DropdownMenuPopup side="bottom" align="end" sideOffset={4}>
        <DropdownMenuLabel>Version history</DropdownMenuLabel>
        {versions.map((version, index) => (
          <DropdownMenuItem key={version.id} onClick={() => onLoad(version)}>
            <span className="flex-1 text-sm tabular-nums">{formatDateTimeUTC(version.createdAt)}</span>
            {index === 0 ? <span className="text-xs text-muted-foreground">current</span> : null}
            {version.id === loadedVersionId ? <CheckIcon className="size-3.5 text-muted-foreground" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuPopup>
    </DropdownMenu>
  )
}

// ── Settings dialog ─────────────────────────────────────────────────

type FormRow = {
  id: string
  name: string
  slug: string
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'ARCHIVED'
  purpose: 'CFP' | 'PORTAL'
  target: 'SUBMISSION' | 'SPEAKER'
  closesAt: number | null
}

function FormSettingsDialog({ open, onOpenChange, orgId, eventId, form }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  eventId: string
  form: FormRow
}) {
  const [saved, setSaved] = React.useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Form settings</DialogTitle>
          <DialogDescription>
            Name, slug, status, and the submission deadline. Purpose and target are fixed at creation.
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
                const closesAtRaw = String(formData.get('closesAt') ?? '').trim()
                const statusValue = formData.get('status')
                // datetime-local values parse as LOCAL time — the admin's
                // wall clock, stored as epoch ms.
                const closesAt = closesAtRaw ? Date.parse(closesAtRaw) : null
                if (closesAtRaw && Number.isNaN(closesAt)) throw new Error('Invalid deadline')
                await updateFormSettings({
                  orgId,
                  eventId,
                  formId: form.id,
                  name: String(formData.get('name') ?? '').trim(),
                  slug: String(formData.get('slug') ?? '').trim(),
                  status:
                    statusValue === 'OPEN' || statusValue === 'CLOSED' || statusValue === 'ARCHIVED'
                      ? statusValue
                      : 'DRAFT',
                  closesAt,
                })
                setSaved(true)
                setTimeout(() => setSaved(false), 1500)
              }}
            >
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Name
                <Input required name="name" defaultValue={form.name} maxLength={120} />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Slug
                <Input
                  required
                  name="slug"
                  defaultValue={form.slug}
                  maxLength={60}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  title="Lowercase letters, numbers, and dashes"
                  className="font-mono"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Status
                <NativeSelect name="status" defaultValue={form.status}>
                  <option value="DRAFT">Draft</option>
                  <option value="OPEN">Open</option>
                  <option value="CLOSED">Closed</option>
                  <option value="ARCHIVED">Archived</option>
                </NativeSelect>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Closes at
                <Input
                  name="closesAt"
                  type="datetime-local"
                  defaultValue={form.closesAt ? epochToDateTimeLocalInput(form.closesAt) : ''}
                />
              </label>
              <div className="flex gap-6 text-sm">
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">Purpose</span>
                  <span className="text-muted-foreground">{form.purpose}</span>
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">Target</span>
                  <span className="text-muted-foreground">{form.target}</span>
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Button type="submit">Save settings</Button>
                {saved ? <span className="text-sm text-muted-foreground">Saved</span> : null}
              </div>
            </form>
          </ErrorBoundary>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

// ── Danger zone (delete / archive) ──────────────────────────────────

function DangerZone({ orgId, eventId, form, hasResponses }: {
  orgId: string
  eventId: string
  form: FormRow
  hasResponses: boolean
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const run = <T,>(action: () => Promise<T>) => {
    setError(null)
    setPending(true)
    void (async () => {
      try {
        await action()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed')
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <div className="flex items-center gap-3 border-t border-border pt-4">
      {hasResponses ? (
        <>
          <Button
            disabled={form.status === 'ARCHIVED'}
            loading={pending}
            variant="outline"
            onClick={() =>
              run(() =>
                updateFormSettings({
                  orgId,
                  eventId,
                  formId: form.id,
                  name: form.name,
                  slug: form.slug,
                  status: 'ARCHIVED',
                  closesAt: form.closesAt,
                }),
              )
            }
          >
            {form.status === 'ARCHIVED' ? 'Archived' : 'Archive form'}
          </Button>
          <span className="text-sm text-muted-foreground">
            Forms with responses cannot be deleted — archive hides them from speakers.
          </span>
        </>
      ) : (
        <>
          <Button
            loading={pending}
            variant="outline"
            className="text-destructive-foreground"
            onClick={() => {
              if (!window.confirm(`Delete the form "${form.name}" and all of its versions?`)) return
              // deleteForm redirects back to the owning list.
              run(() => deleteForm({ orgId, eventId, formId: form.id }))
            }}
          >
            <TrashIcon />
            Delete form
          </Button>
          <span className="text-sm text-muted-foreground">
            This form has no responses yet, so it can be deleted permanently.
          </span>
        </>
      )}
      {error ? <span className="text-sm text-destructive">{error}</span> : null}
    </div>
  )
}
