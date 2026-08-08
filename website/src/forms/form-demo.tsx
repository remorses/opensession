// TEMPORARY demo — replaced by task 3 (admin form editor pages).
//
// Proves the MDX form engine end to end in a real browser: renders the
// starter CFP template with the event's real tracks/formats, live <Show>
// conditionals, participants add/remove, and a Validate button that runs
// the server-side collector + validation via the validateFormDemo action.
'use client'

import * as React from 'react'
import { useLoaderData } from 'spiceflow/react'
import { validateFormDemo } from '../actions.tsx'
import { Badge } from '../components/ui/primitives.tsx'
import { libraryOptions, type FormSubmission } from './collect-fields.ts'
import { FormRenderer } from './form-renderer.tsx'
import { starterCfpTemplate } from './starter-template.ts'

type DemoResult = Awaited<ReturnType<typeof validateFormDemo>>

export function FormsDemoPage() {
  const { currentOrgId } = useLoaderData('/org/:orgId/*')
  const { event, tracks, formats } = useLoaderData('/org/:orgId/e/:eventId/*')
  const [result, setResult] = React.useState<DemoResult | null>(null)

  const onSubmit = async (submission: FormSubmission) => {
    setResult(
      await validateFormDemo({
        orgId: currentOrgId,
        eventId: event.id,
        values: submission.values,
        participants: submission.participants,
      }),
    )
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight">Forms</h1>
          <Badge variant="outline" className="px-1.5">Engine demo</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Live preview of the starter CFP form rendered by the MDX form engine. The editor with
          versioning arrives with the next milestone.
        </p>
      </div>

      <FormRenderer
        mdxSource={starterCfpTemplate}
        scope={{ tracks: libraryOptions(tracks), formats: libraryOptions(formats) }}
        onSubmit={onSubmit}
        submitLabel="Validate"
      />

      {result ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <span className="text-sm font-medium">
            Server validation: {result.ok ? 'passed' : `${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`}
          </span>
          {result.ok ? (
            <span className="text-sm text-muted-foreground">
              Visible fields: {[...result.fields, ...result.participantFields].map((f) => f.name).join(', ')}
            </span>
          ) : (
            <ul className="flex flex-col gap-1 text-sm text-destructive">
              {result.errors.map((error, i) => (
                <li key={i}>{error.message}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
