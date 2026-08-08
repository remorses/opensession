// Interactive MDX form field components ('use client').
//
// The `name` prop is the data contract: every field reads/writes its value
// through FormValuesContext keyed by name. Inside <Participants> a
// ParticipantIndexContext routes `speaker.*` names to that participant's
// record instead of the top-level values. The components map that safe-mdx
// consumes lives in components-map.tsx (NO 'use client' — RSC rule), which
// imports these.

'use client'

import { MinusIcon, PlusIcon } from 'lucide-react'
import * as React from 'react'
import { Button } from '../components/ui/button.tsx'
import { Input, Textarea, NativeSelect } from '../components/ui/primitives.tsx'
import { cn } from '../lib/utils.ts'
import { normalizeOptions, type FieldValue, type ValuesRecord } from './collect-fields.ts'

// ── Context ─────────────────────────────────────────────────────────

export type FormValuesState = {
  values: ValuesRecord
  participants: ValuesRecord[]
  setValue: (name: string, value: FieldValue) => void
  setParticipantValue: (index: number, name: string, value: FieldValue) => void
  addParticipant: () => void
  removeParticipant: (index: number) => void
  /** Pads the participants array up to `count` empty records (used by
   *  <Participants min> so the submitted array matches the rendered rows). */
  ensureParticipantCount: (count: number) => void
  /** Real upload wiring lands in task 4: uploads the file, returns the
   *  File row id that FileUpload stores as the field value. */
  uploadFile?: (file: File) => Promise<string>
}

export const FormValuesContext = React.createContext<FormValuesState | null>(null)
const ParticipantIndexContext = React.createContext<number | null>(null)

function useFormValues(): FormValuesState {
  const ctx = React.useContext(FormValuesContext)
  if (!ctx) throw new Error('Form fields must be rendered inside FormRenderer')
  return ctx
}

/** Resolve the read/write binding for a field name: participant-scoped
 *  inside <Participants>, top-level otherwise. */
function useFieldBinding(name: string): { value: FieldValue | undefined; set: (value: FieldValue) => void } {
  const ctx = useFormValues()
  const participantIndex = React.useContext(ParticipantIndexContext)
  if (participantIndex != null) {
    return {
      value: ctx.participants[participantIndex]?.[name],
      set: (value) => ctx.setParticipantValue(participantIndex, name, value),
    }
  }
  return { value: ctx.values[name], set: (value) => ctx.setValue(name, value) }
}

function FieldShell({ label, required, children }: { label?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      {label ? (
        <span className="text-sm font-medium">
          {label}
          {required ? <span className="text-destructive"> *</span> : null}
        </span>
      ) : null}
      {children}
    </label>
  )
}

// ── Text fields ─────────────────────────────────────────────────────

export function TextField({
  name,
  label,
  required,
  maxLength,
  placeholder,
  multiline,
  rows,
}: {
  name: string
  label?: string
  required?: boolean
  maxLength?: number
  placeholder?: string
  multiline?: boolean
  rows?: number
}) {
  const { value, set } = useFieldBinding(name)
  const text = typeof value === 'string' ? value : ''
  return (
    <FieldShell label={label} required={required}>
      {multiline ? (
        <Textarea
          value={text}
          rows={rows ?? 4}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => set(e.target.value)}
        />
      ) : (
        <Input
          value={text}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </FieldShell>
  )
}

/** Rich text is a plain textarea for the MVP (rich editor later); the
 *  value is stored as text like every other field. */
export function RichText({
  name,
  label,
  required,
  maxLength,
}: {
  name: string
  label?: string
  required?: boolean
  maxLength?: number
}) {
  const { value, set } = useFieldBinding(name)
  const text = typeof value === 'string' ? value : ''
  return (
    <FieldShell label={label} required={required}>
      <Textarea value={text} rows={6} maxLength={maxLength} onChange={(e) => set(e.target.value)} />
      {maxLength ? (
        <span className="self-end text-xs text-muted-foreground tabular-nums">
          {text.length}/{maxLength}
        </span>
      ) : null}
    </FieldShell>
  )
}

// ── Select / Checkbox / Radio ───────────────────────────────────────

export function Select({
  name,
  label,
  options,
  required,
  multiple,
  placeholder,
}: {
  name: string
  label?: string
  /** Inline array of strings/{value,label} or a scope array (tracks/formats). */
  options?: unknown
  required?: boolean
  multiple?: boolean
  placeholder?: string
}) {
  const { value, set } = useFieldBinding(name)
  const normalized = normalizeOptions(options)

  if (multiple) {
    // Multi-select renders as a checkbox group (friendlier than a native
    // multi-select); the value is a string[] — one row per value on submit.
    const selected = Array.isArray(value) ? value : []
    const toggle = (optionValue: string) => {
      set(selected.includes(optionValue) ? selected.filter((v) => v !== optionValue) : [...selected, optionValue])
    }
    return (
      <FieldShell label={label} required={required}>
        <div className="flex flex-col gap-1.5">
          {normalized.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={selected.includes(option.value)}
                onChange={() => toggle(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </FieldShell>
    )
  }

  const single = typeof value === 'string' ? value : ''
  return (
    <FieldShell label={label} required={required}>
      <NativeSelect value={single} onChange={(e) => set(e.target.value)}>
        <option value="">{placeholder ?? 'Select…'}</option>
        {normalized.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </FieldShell>
  )
}

/** Single boolean checkbox; the stored value is 'true'/'false' so MDX
 *  conditionals can test `values.name === 'true'`. */
export function Checkbox({ name, label }: { name: string; label?: string }) {
  const { value, set } = useFieldBinding(name)
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 accent-primary"
        checked={value === 'true'}
        onChange={(e) => set(e.target.checked ? 'true' : 'false')}
      />
      {label}
    </label>
  )
}

export function Radio({
  name,
  label,
  options,
  required,
}: {
  name: string
  label?: string
  options?: unknown
  required?: boolean
}) {
  const { value, set } = useFieldBinding(name)
  const normalized = normalizeOptions(options)
  return (
    <FieldShell label={label} required={required}>
      <div className="flex flex-col gap-1.5">
        {normalized.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              className="size-4 accent-primary"
              checked={value === option.value}
              onChange={() => set(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </FieldShell>
  )
}

// ── FileUpload ──────────────────────────────────────────────────────

/** Stub for the MVP: picks a file and, when the FormRenderer provides an
 *  uploadFile callback (task 4 wires it to /api/upload), stores the
 *  returned fileId string as the field value. Without the callback the
 *  input is disabled with a hint. */
export function FileUpload({
  name,
  label,
  accept,
  required,
}: {
  name: string
  label?: string
  accept?: string
  required?: boolean
}) {
  const ctx = useFormValues()
  const { value, set } = useFieldBinding(name)
  const [uploading, setUploading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !ctx.uploadFile) return
    setUploading(true)
    setError(null)
    try {
      set(await ctx.uploadFile(file))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <FieldShell label={label} required={required}>
      <input
        type="file"
        accept={accept}
        disabled={!ctx.uploadFile || uploading}
        onChange={onChange}
        className={cn(
          'text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm',
          !ctx.uploadFile && 'opacity-50',
        )}
      />
      {!ctx.uploadFile ? (
        <span className="text-xs text-muted-foreground">File uploads are not available in this preview.</span>
      ) : null}
      {uploading ? <span className="text-xs text-muted-foreground">Uploading…</span> : null}
      {typeof value === 'string' && value ? (
        <span className="text-xs text-muted-foreground">Uploaded file: {value}</span>
      ) : null}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </FieldShell>
  )
}

// ── Participants ────────────────────────────────────────────────────

/** Repeats its children once per participant entry. Children with
 *  `speaker.*` names read/write that participant's record via
 *  ParticipantIndexContext. Add/remove respect min/max. */
export function Participants({
  min = 1,
  max = 10,
  children,
}: {
  min?: number
  max?: number
  children?: React.ReactNode
}) {
  const ctx = useFormValues()
  const count = ctx.participants.length

  // Pad up to min once so the rendered rows and the submitted array agree.
  // A useEffect (not render-time mutation) because it sets renderer state.
  React.useEffect(() => {
    if (count < min) ctx.ensureParticipantCount(min)
  }, [count, min])

  return (
    <div className="flex flex-col gap-4">
      {ctx.participants.map((_, index) => (
        <ParticipantIndexContext.Provider key={index} value={index}>
          <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">Participant {index + 1}</span>
              {count > min ? (
                <Button variant="ghost" size="sm" onClick={() => ctx.removeParticipant(index)}>
                  <MinusIcon className="size-3.5" />
                  Remove
                </Button>
              ) : null}
            </div>
            {children}
          </div>
        </ParticipantIndexContext.Provider>
      ))}
      {count < max ? (
        <Button variant="outline" size="sm" className="self-start" onClick={ctx.addParticipant}>
          <PlusIcon className="size-3.5" />
          Add participant
        </Button>
      ) : null}
    </div>
  )
}
