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
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  HistoryIcon,
  SettingsIcon,
  TrashIcon,
} from 'lucide-react'
import { deleteForm, saveFormVersion, updateFormSettings } from '../actions.tsx'
import { collectFields, libraryOptions } from '../forms/collect-fields.ts'
import { buildFormCustomizationPrompt, formUseCase } from '../forms/form-customization-prompt.ts'
import { FormRenderer } from '../forms/form-renderer.tsx'
import { cn, formatDateTimeUTC } from '../lib/utils.ts'
import { Button } from './ui/button.tsx'
import { Input, NativeSelect } from './ui/primitives.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx'
import { FormStatusBadge } from './forms-list.tsx'
import {
  Dialog, DialogDescription, DialogHeader,
  DialogPanel, DialogPopup, DialogTitle,
} from './ui/dialog.tsx'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
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

function ChatGptIcon(props: React.ComponentProps<'svg'>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  )
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
  const [promptCopied, setPromptCopied] = React.useState(false)
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

  const customizationPrompt = buildFormCustomizationPrompt({
    formName: form.name,
    useCase: formUseCase(form.purpose, form.target),
    fieldNames: [...summary.fields, ...summary.participantFields].map((field) => field.name),
    mdxSource: source,
  })

  const handleCopyCustomizationPrompt = async () => {
    await navigator.clipboard.writeText(customizationPrompt)
    setPromptCopied(true)
    setTimeout(() => setPromptCopied(false), 1500)
  }

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
        href={`/org/${currentOrgId}/e/${event.id}/${form.purpose === 'PORTAL' ? 'portal-forms' : form.purpose === 'EVALUATION' ? 'evaluation' : 'forms'}`}
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
            {form.purpose === 'CFP'
              ? 'CFP form'
              : form.purpose === 'EVALUATION'
                ? 'Evaluation form'
                : `Portal form · ${form.target.toLowerCase()} target`}
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
          <DropdownMenu>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger render={<Button variant="outline" />}>
                    <ChatGptIcon data-icon="inline-start" />
                    Customize with ChatGPT
                    <ChevronDownIcon data-icon="inline-end" />
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  Opens ChatGPT and copies this form with the OpenSession MDX guide. Paste the prompt into the new chat, or copy it for another AI.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <DropdownMenuPopup side="bottom" align="end" sideOffset={4}>
              <DropdownMenuLinkItem
                href="https://chatgpt.com/"
                target="_blank"
                rel="noreferrer"
                onClick={() => navigator.clipboard.writeText(customizationPrompt)}
              >
                <ExternalLinkIcon />
                Open in ChatGPT
              </DropdownMenuLinkItem>
              <DropdownMenuItem onClick={handleCopyCustomizationPrompt}>
                {promptCopied ? <CheckIcon /> : <CopyIcon />}
                {promptCopied ? 'Prompt copied' : 'Copy prompt'}
              </DropdownMenuItem>
            </DropdownMenuPopup>
          </DropdownMenu>
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
  purpose: 'CFP' | 'PORTAL' | 'EVALUATION'
  target: 'SUBMISSION' | 'SPEAKER'
  opensAt: number | null
  closesAt: number | null
  blind: boolean
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
                const opensAtRaw = String(formData.get('opensAt') ?? '').trim()
                const statusValue = formData.get('status')
                // datetime-local values parse as LOCAL time — the admin's
                // wall clock, stored as epoch ms.
                const closesAt = closesAtRaw ? Date.parse(closesAtRaw) : null
                const opensAt = opensAtRaw ? Date.parse(opensAtRaw) : null
                if (closesAtRaw && Number.isNaN(closesAt)) throw new Error('Invalid deadline')
                if (opensAtRaw && Number.isNaN(opensAt)) throw new Error('Invalid open date')
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
                  opensAt,
                  blind: form.purpose === 'EVALUATION' ? formData.get('blind') === 'on' : false,
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
                Opens at
                <Input
                  name="opensAt"
                  type="datetime-local"
                  defaultValue={form.opensAt ? epochToDateTimeLocalInput(form.opensAt) : ''}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Closes at
                <Input
                  name="closesAt"
                  type="datetime-local"
                  defaultValue={form.closesAt ? epochToDateTimeLocalInput(form.closesAt) : ''}
                />
              </label>
              {form.purpose === 'EVALUATION' ? (
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input name="blind" type="checkbox" defaultChecked={form.blind} />
                  Hide speaker identity from reviewers
                </label>
              ) : null}
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
