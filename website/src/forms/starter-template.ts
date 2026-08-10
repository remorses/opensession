// Default MDX templates for new forms (pure strings).
//
// starterCfpTemplate is the default CFP form (Welcome copy + <Step> blocks).
// starterSpeakerProfileTemplate is the PORTAL SPEAKER profile form.
// starterPortalTemplate / starterSessionMaterialsTemplate is the PORTAL
// SUBMISSION materials form (slides upload).
// starterEvaluationTemplate defines a weighted review scorecard.
//
// Conditional syntax: `<Show when={expr}>` — safe-mdx cannot evaluate JSX
// inside `{cond && <.../>}` expressions, so Show is the supported way to
// branch. Expressions read the live `values` record plus the `tracks` and
// `formats` option arrays from scope. `selected.track` and `selected.format`
// expose readable labels while submitted values keep library row ids.

import dedent from 'string-dedent'
export const starterCfpTemplate = dedent`
  # Call for speakers

  We are excited to hear what you want to present. Fill out the form to
  submit your session — you can come back and edit it until the CFP closes.

  <Info>
    Submissions are reviewed by the program committee after the CFP closes.
    You will be notified by email either way.
  </Info>

  <Step title="Submission">

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

  </Step>

  <Step title="Speakers">

  <Section title="Speakers">

  Add everyone who will be on stage. The first participant is the primary
  contact for this submission.

  <Participants min={1} max={3}>
    <TextField name="speaker.firstName" label="First name" required maxLength={80} />
    <TextField name="speaker.lastName" label="Last name" required maxLength={80} />
    <TextField name="speaker.email" label="Email" required maxLength={200} />
    <RichText name="speaker.bio" label="Bio" maxLength={5000} />
    <FileUpload name="speaker.headshot" label="Headshot" accept="image/*" />
  </Participants>

  </Section>

  </Step>
`

/** Default PORTAL SPEAKER form (profile onboarding). Field names are the
 *  speaker.* well-known keys so submit projects onto the Speaker row. */
export const starterSpeakerProfileTemplate = dedent`
  # Complete your speaker profile

  Organizers use this information on the public schedule and speaker pages.

  <Info>
    A square headshot works best. You can update these details later from the portal.
  </Info>

  <Step title="Profile">

  <TextField name="speaker.firstName" label="First name" required maxLength={80} />

  <TextField name="speaker.lastName" label="Last name" required maxLength={80} />

  <TextField name="speaker.pronouns" label="Pronouns" maxLength={40} placeholder="they/them" />

  <TextField name="speaker.jobTitle" label="Job title" maxLength={120} />

  <TextField name="speaker.companyName" label="Company" maxLength={120} />

  <RichText name="speaker.bio" label="Bio" required maxLength={5000} />

  <FileUpload name="speaker.headshot" label="Headshot" accept="image/*" />

  </Step>

  <Step title="Socials">

  <TextField name="speaker.websiteUrl" label="Website" maxLength={500} placeholder="https://" />

  <TextField name="speaker.linkedinUrl" label="LinkedIn" maxLength={500} placeholder="https://linkedin.com/in/..." />

  <TextField name="speaker.twitterUrl" label="X / Twitter" maxLength={500} placeholder="https://x.com/..." />

  </Step>

  <Step title="Logistics">

  <RichText name="speaker.travelLogistics" label="Travel and logistics" maxLength={2000} />

  </Step>
`

/** Default PORTAL SUBMISSION materials form (slides). */
export const starterSessionMaterialsTemplate = dedent`
  # Upload your slides

  Please upload the final version of your presentation before the deadline.

  <Info>
    Accepted formats: PDF, Keynote, or PowerPoint. Max 100 MB.
  </Info>

  <Step title="Materials">

  <FileUpload name="slides" label="Presentation file" accept=".pdf,.key,.pptx" required />

  <TextField name="slidesNotes" label="Anything the organizers should know?" maxLength={500} multiline />

  </Step>
`

/** @deprecated alias kept for createForm PORTAL default when target is SUBMISSION */
export const starterPortalTemplate = starterSessionMaterialsTemplate

export const starterEvaluationTemplate = dedent`
  # Review scorecard

  Score the assigned submission. You can save a draft before you submit.

  <Number name="rating" label="Rating" min={1} max={5} weight={1} required />

  <RichText name="comments" label="Comments" required maxLength={5000} />
`
