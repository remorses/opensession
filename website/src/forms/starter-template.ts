// Default MDX templates for new forms (pure strings).
//
// starterCfpTemplate is the default CFP form (mirrors SessionBoard's
// wizard: welcome copy, abstract fields, track/format selects, a
// conditional example, and a participants block with speaker.* fields).
// starterPortalTemplate is the default portal form (slide upload).
//
// Conditional syntax: `<Show when={expr}>` — safe-mdx cannot evaluate JSX
// inside `{cond && <.../>}` expressions, so Show is the supported way to
// branch. Expressions read the live `values` record plus the `tracks` and
// `formats` option arrays from scope.

import dedent from 'string-dedent'

export const starterCfpTemplate = dedent`
  # Call for speakers

  We are excited to hear what you want to present. Fill out the form below to
  submit your session — you can come back and edit it until the CFP closes.

  <Info>
    Submissions are reviewed by the program committee after the CFP closes.
    You will be notified by email either way.
  </Info>

  <Section title="Your session">

  <TextField name="title" label="Session title" required maxLength={80} placeholder="A concise, descriptive title" />

  <RichText name="description" label="Abstract" required maxLength={5000} />

  <Select name="track" label="Track" options={tracks} required />

  <Select name="format" label="Format" options={formats} required />

  <Checkbox name="needsAV" label="My session needs special A/V equipment" />

  <Show when={values.needsAV === 'true'}>
    <TextField name="avDetails" label="Describe your A/V needs" required maxLength={500} multiline />
  </Show>

  </Section>

  <Section title="Speakers">

  Add everyone who will be on stage. The first participant is the primary
  contact for this submission.

  <Participants min={1} max={3}>
    <TextField name="speaker.firstName" label="First name" required maxLength={80} />
    <TextField name="speaker.lastName" label="Last name" required maxLength={80} />
    <TextField name="speaker.email" label="Email" required maxLength={200} />
    <RichText name="speaker.bio" label="Bio" maxLength={5000} />
  </Participants>

  </Section>
`

export const starterPortalTemplate = dedent`
  # Upload your slides

  Please upload the final version of your presentation before the deadline.

  <Info>
    Accepted formats: PDF, Keynote, or PowerPoint. Max 100 MB.
  </Info>

  <FileUpload name="slides" label="Presentation file" accept=".pdf,.key,.pptx" required />

  <TextField name="slidesNotes" label="Anything the organizers should know?" maxLength={500} multiline />
`
