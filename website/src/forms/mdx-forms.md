<!-- OpenSession MDX form authoring guide imported as raw text by the form editor. -->

# MDX forms

OpenSession forms are **plain MDX**. Markdown is the copy. JSX components are the fields.

```mdx
# Call for speakers

Tell us what you want to present.

<TextField name="title" label="Session title" required maxLength={80} />
<RichText name="description" label="Abstract" required maxLength={5000} />
<Select name="track" label="Track" options={tracks} required />
```

Each form version stores one immutable `mdxSource` string. The public CFP page, the portal, and the admin preview all render that same source through `FormRenderer`.

---

## Mental model

```
  Organizer edits MDX in Monaco
              │
              ▼
     FormVersion.mdxSource  (immutable snapshot)
              │
     ┌────────┴────────┐
     ▼                 ▼
 FormRenderer      collectFields + validate
 (browser)         (server on submit)
     │                 │
     ▼                 ▼
 { values,         FormFieldValue rows
   participants }  + typed Session/Speaker columns
```

- **`name` is the data contract.** Every field reads and writes `values[name]` (or a participant record when inside `<Participants>`).
- **Scope** injects live data into expressions: `values`, `tracks`, `formats`.
- **Server and client use the same conditional logic.** On submit the server re-collects visible fields with the submitted values in scope, then validates.

Submitted shape:

```ts
type FieldValue = string | string[]
type FormSubmission = {
  values: Record<string, FieldValue>
  participants: Array<Record<string, FieldValue>>
}
```

---

## Full default CFP form

This is the starter template created with every new CFP form (`starterCfpTemplate`).
It uses `<Step>` blocks so the public wizard shows Welcome → Account → Submission → Speakers → Review.

See `website/src/forms/starter-template.ts` for the full source. Event create also seeds:

- **Speaker profile** (`starterSpeakerProfileTemplate`, slug `speaker-profile`)
- **Session materials** (`starterSessionMaterialsTemplate`, slug `session-materials`)

---

## Layout and copy

Free markdown between components is welcome text. Use headings, paragraphs, and lists.

### `<Step title="...">`

First-class multistep marker for the public CFP and portal wizards.

```mdx
# Welcome copy (everything before the first Step)

<Step title="Submission">
  <TextField name="title" label="Title" required />
</Step>

<Step title="Speakers">
  <Participants min={1} max={3}>
    <TextField name="speaker.firstName" label="First name" required />
  </Participants>
</Step>
```

The wizard builds tabs as **1 Welcome → 2 Account → 3… MDX Steps → Review**.

- Markdown and non-Step JSX **before the first `<Step>`** is the Welcome body.
- Each `<Step title="…">` is one content step. **Next** validates only that step's fields.
- Final **Submit** runs full validation against the whole form MDX.
- If the MDX has **zero** `<Step>` blocks, the whole source is one content step titled Submission (compat).
- The admin editor preview still renders every step's children in document order.

### `<Section title="...">`

Groups fields under an `h2`. Does not affect data.

```mdx
<Section title="Your session">
  <TextField name="title" label="Title" required />
</Section>
```

### `<Info>`

Muted callout box for instructions.

```mdx
<Info>
  Keep the abstract under 500 words. No sales pitches.
</Info>
```

### Markdown elements

Supported styled tags: `#` / `##` headings, paragraphs, and `-` lists.

```mdx
# Welcome

Please read the rules before you submit.

- One talk per primary speaker
- All speakers must confirm by email
```

---

## Field components

### `<TextField>`

Single-line input, or textarea when `multiline` is set.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | string | **required** | Storage key |
| `label` | string | — | Shown above the control |
| `required` | boolean | `false` | |
| `maxLength` | number | — | HTML + server check |
| `placeholder` | string | — | |
| `multiline` | boolean | `false` | Renders a textarea |
| `rows` | number | `4` | Only with `multiline` |

```mdx
<TextField name="title" label="Session title" required maxLength={80} placeholder="A concise title" />

<TextField name="notes" label="Notes for organizers" multiline rows={6} maxLength={1000} />
```

### `<RichText>`

Long text. MVP is a plain textarea (6 rows) with an optional character counter. Stored as a string like every other field.

| Prop | Type | Default |
| --- | --- | --- |
| `name` | string | **required** |
| `label` | string | — |
| `required` | boolean | `false` |
| `maxLength` | number | — |

```mdx
<RichText name="description" label="Abstract" required maxLength={5000} />
```

### `<Select>`

Dropdown for a single value, or a checkbox group when `multiple`.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | string | **required** | |
| `label` | string | — | |
| `options` | array | — | Strings, `{value,label}`, or scope arrays |
| `required` | boolean | `false` | |
| `multiple` | boolean | `false` | Value becomes `string[]` |
| `placeholder` | string | `"Select…"` | Empty option label (single only) |

**Options sources:**

```mdx
{/* Event library — value is the track/format row id */}
<Select name="track" label="Track" options={tracks} required />
<Select name="format" label="Format" options={formats} required />

{/* Inline strings */}
<Select name="level" label="Level" options={['beginner', 'intermediate', 'advanced']} />

{/* Inline value/label objects */}
<Select
  name="language"
  label="Language"
  options={[{ value: 'en', label: 'English' }, { value: 'it', label: 'Italian' }]}
/>

{/* Multi-select — stores string[] */}
<Select
  name="topics"
  label="Topics"
  multiple
  options={['ai', 'devops', 'security', 'frontend']}
/>
```

### `<Checkbox>`

One boolean control. **Stored value is `'true'` or `'false'`** (strings), so conditionals can test equality in MDX.

| Prop | Type | Default |
| --- | --- | --- |
| `name` | string | **required** |
| `label` | string | — |

```mdx
<Checkbox name="needsAV" label="My session needs special A/V equipment" />

<Show when={values.needsAV === 'true'}>
  <TextField name="avDetails" label="Describe your A/V needs" required multiline />
</Show>
```

### `<Radio>`

Single choice as radio buttons.

| Prop | Type | Default |
| --- | --- | --- |
| `name` | string | **required** |
| `label` | string | — |
| `options` | array | — | Same shapes as Select |
| `required` | boolean | `false` |

```mdx
<Radio
  name="audience"
  label="Primary audience"
  required
  options={['developers', 'managers', 'everyone']}
/>
```

### `<FileUpload>`

Picks one file, uploads through `POST /api/upload`, stores the returned **file id** string as the value.

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | string | **required** | |
| `label` | string | — | |
| `accept` | string | — | Native `accept` attribute |
| `required` | boolean | `false` | |

```mdx
<FileUpload name="coverImage" label="Cover image" accept="image/*" />

<FileUpload name="slides" label="Presentation" accept=".pdf,.key,.pptx" required />

{/* Inside Participants — projects to speaker.headshotFileId when well-known */}
<FileUpload name="speaker.headshot" label="Headshot" accept="image/*" />
```

In the admin MDX preview, uploads stay disabled (no `uploadFile` callback).

---

## Conditionals: `<Show when={...}>`

**This is the only supported branch.** safe-mdx cannot evaluate JSX inside `{cond && <Field />}` expressions. Attribute expressions work and re-run on every value change.

```mdx
<Select name="format" label="Format" options={formats} required />

<Show when={values.format === 'workshop-id-here'}>
  <TextField name="maxAttendees" label="Max attendees" required />
</Show>

<Checkbox name="hasCoSpeaker" label="I have a co-speaker" />

<Show when={values.hasCoSpeaker === 'true'}>
  <TextField name="coSpeakerNote" label="How will you split the talk?" multiline />
</Show>
```

### What `when` can read

| In scope | Meaning |
| --- | --- |
| `values` | Current top-level field values |
| `tracks` | Event track options `{ value, label }[]` |
| `formats` | Event format options `{ value, label }[]` |

Checkbox values are **`'true'` / `'false'` strings**, not booleans:

```mdx
{/* correct */}
<Show when={values.needsAV === 'true'}>...</Show>

{/* wrong — Checkbox never stores a real boolean */}
<Show when={values.needsAV}>...</Show>
```

### Limits

- Conditionals only see **top-level** `values`. There is no per-participant `when` today.
- Fields hidden by `<Show>` are **not** collected or validated. Hidden values are stripped on submit.
- Prefer testing concrete values (`=== 'x'`) over truthiness.

---

## Multiple speakers: `<Participants>`

Repeats its children once per speaker row. Add/remove controls respect `min` / `max`.

| Prop | Type | Default |
| --- | --- | --- |
| `min` | number | `1` |
| `max` | number | `10` |

```mdx
<Participants min={1} max={3}>
  <TextField name="speaker.firstName" label="First name" required maxLength={80} />
  <TextField name="speaker.lastName" label="Last name" required maxLength={80} />
  <TextField name="speaker.email" label="Email" required maxLength={200} />
  <RichText name="speaker.bio" label="Bio" maxLength={5000} />
  <FileUpload name="speaker.headshot" label="Headshot" accept="image/*" />
</Participants>
```

### Rules

- **One** `<Participants>` block per form.
- **No nesting** (`Participants` inside `Participants` is an error).
- Child field names should use the `speaker.*` prefix so values project onto real `speaker` rows.
- Participant records are a separate array on submit, not nested under `values`.
- CFP also enforces product rules: at least one participant, unique emails, first participant email matches the signed-in user.

Example submission:

```ts
{
  values: { title: 'Shipping faster', track: 'trk_…', format: 'fmt_…' },
  participants: [
    {
      'speaker.firstName': 'Ada',
      'speaker.lastName': 'Lovelace',
      'speaker.email': 'ada@example.com',
      'speaker.bio': '…',
    },
    {
      'speaker.firstName': 'Grace',
      'speaker.lastName': 'Hopper',
      'speaker.email': 'grace@example.com',
    },
  ],
}
```

There is **no general array-of-objects field** yet. Lists that are not speakers are not supported as repeatable object rows. Multi-select is the only other array: `string[]` of option values.

---

## Well-known field names

Every answer is stored as `FormFieldValue` KV rows. Some `name`s are **also** copied to typed columns used by abstracts, agenda, embeds, and the speaker portal.

### Session (top-level)

| Form `name` | Typed column | Notes |
| --- | --- | --- |
| `title` | `event_session.title` | |
| `description` | `event_session.description` | Abstract body |
| `track` | `event_session.trackId` | Must be a track **id** (`options={tracks}`) |
| `format` | `event_session.formatId` | Must be a format **id** (`options={formats}`) |
| `coverImage` | `event_session.coverImageFileId` | FileUpload file id |

### Speaker (inside `<Participants>`)

| Form `name` | Typed column |
| --- | --- |
| `speaker.firstName` | `speaker.firstName` |
| `speaker.lastName` | `speaker.lastName` |
| `speaker.email` | `speaker.email` |
| `speaker.bio` | `speaker.bio` |
| `speaker.jobTitle` | `speaker.jobTitle` |
| `speaker.companyName` | `speaker.companyName` |
| `speaker.pronouns` | `speaker.pronouns` |
| `speaker.websiteUrl` | `speaker.websiteUrl` |
| `speaker.linkedinUrl` | `speaker.linkedinUrl` |
| `speaker.twitterUrl` | `speaker.twitterUrl` |
| `speaker.headshot` | `speaker.headshotFileId` |

### Custom names

Any other `name` stays custom KV only. Use clear, stable keys:

```mdx
<TextField name="githubUrl" label="GitHub profile" />
<Select name="travelNeeded" label="Need travel support?" options={['yes', 'no']} />
<Checkbox name="recordingOk" label="OK to record this session" />
```

Renaming a well-known field (for example `title` → `sessionTitle`) stops the typed projection. The answer still saves as custom data, but abstracts/agenda lose the mapped column until you put the reserved name back.

---

## Recipe: richer speaker profile

```mdx
<Section title="Speakers">

<Participants min={1} max={5}>
  <TextField name="speaker.firstName" label="First name" required maxLength={80} />
  <TextField name="speaker.lastName" label="Last name" required maxLength={80} />
  <TextField name="speaker.email" label="Email" required maxLength={200} />
  <TextField name="speaker.pronouns" label="Pronouns" maxLength={40} placeholder="they/them" />
  <TextField name="speaker.jobTitle" label="Job title" maxLength={120} />
  <TextField name="speaker.companyName" label="Company" maxLength={120} />
  <RichText name="speaker.bio" label="Bio" maxLength={5000} />
  <FileUpload name="speaker.headshot" label="Headshot" accept="image/*" />
  <TextField name="speaker.websiteUrl" label="Website" maxLength={300} />
  <TextField name="speaker.linkedinUrl" label="LinkedIn" maxLength={300} />
  <TextField name="speaker.twitterUrl" label="X / Twitter" maxLength={300} />
</Participants>

</Section>
```

---

## Recipe: workshop-only questions

Keep the well-known `format` select so agenda gets `formatId`. Add a separate custom radio when you need readable conditionals without hardcoding library ids:

```mdx
<Select name="format" label="Format" options={formats} required />

<Radio
  name="sessionKind"
  label="Session kind"
  required
  options={[
    { value: 'talk', label: 'Talk' },
    { value: 'workshop', label: 'Workshop' },
  ]}
/>

<Show when={values.sessionKind === 'workshop'}>
  <TextField name="workshopDuration" label="Workshop length (hours)" required />
  <TextField name="maxAttendees" label="Max attendees" required />
  <Checkbox name="needsLaptops" label="Attendees should bring laptops" />
</Show>
```

To branch on a real library format instead, compare against the format **row id**:

```mdx
<Select name="format" label="Format" options={formats} required />

<Show when={values.format === '01hxxx_your_workshop_format_id'}>
  <TextField name="maxAttendees" label="Max attendees" required />
</Show>
```

---

## Recipe: multi-select tags + conditional detail

```mdx
<Select
  name="topics"
  label="Topics"
  multiple
  required
  options={['ai', 'security', 'platform', 'dx']}
/>

<Checkbox name="liveDemo" label="This session includes a live demo" />

<Show when={values.liveDemo === 'true'}>
  <TextField
    name="demoRequirements"
    label="What do you need for the demo?"
    required
    multiline
    maxLength={500}
  />
</Show>
```

---

## Validation behavior (what speakers hit)

On submit the server:

1. Parses the **pinned** form version MDX (not the latest edit if they opened an older draft).
2. Collects fields visible under the same `<Show>` rules with submitted `values`.
3. Rejects unknown names, missing required fields, over-long strings, and invalid option values.
4. Checks participant count against `min` / `max`.
5. Writes KV rows, creates/links speakers, and projects well-known names.

Duplicate `name`s in the MDX are form definition errors. Empty `name` is also an error.

---

## Authoring checklist

1. Prefer **well-known names** for title, abstract, track, format, and speaker identity fields.
2. Use `options={tracks}` / `options={formats}` for library selects so values are real row ids.
3. Branch with **`<Show when={...}>` only**, never `{cond && <Field />}`.
4. Compare checkbox values to **`'true'`**.
5. Put speaker fields inside **one** `<Participants min max>` block with `speaker.*` names.
6. Keep custom names stable; they are the permanent keys in `FormFieldValue`.
7. Preview in the form editor (Editor | Preview) before opening the CFP.

---

## Component quick reference

| Component | Role | Defaults |
| --- | --- | --- |
| `TextField` | text / textarea | `multiline=false`, `rows=4` |
| `RichText` | long text | 6-row textarea |
| `Select` | single or multi choice | `multiple=false`, placeholder `Select…` |
| `Checkbox` | boolean as `'true'`/`'false'` | unchecked → no value until toggled |
| `Radio` | single choice radios | — |
| `FileUpload` | file → file id string | disabled without upload handler |
| `Participants` | repeat speaker rows | `min=1`, `max=10` |
| `Show` | conditional children | hidden when `when` is falsy |
| `Section` | titled group | — |
| `Info` | callout | — |

Source of truth in code:

- Components: `website/src/forms/field-components.tsx`, `components-map.tsx`
- Starters: `website/src/forms/starter-template.ts`
- Well-known map: `website/src/forms/well-known-names.ts`
- Collect / validate: `website/src/forms/collect-fields.ts`, `validate.ts`
- Renderer: `website/src/forms/form-renderer.tsx`
