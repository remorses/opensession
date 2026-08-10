// Builds the complete ChatGPT prompt copied from the MDX form editor.
// The authoring guide is imported as raw text, while reserved field names
// come from the same registry used by submission persistence.

import dedent from 'string-dedent'
import formAuthoringGuide from './mdx-forms.md?raw'
import { sessionWellKnown, speakerWellKnown } from './well-known-names.ts'

const wellKnownFieldGuide = [
  ...Object.entries(sessionWellKnown).map(([name, column]) => `- \`${name}\` → \`eventSession.${column}\``),
  ...Object.entries(speakerWellKnown).map(([name, column]) => `- \`${name}\` → \`speaker.${column}\``),
].join('\n')

export function formUseCase(purpose: string, target: string): string {
  if (purpose === 'CFP') return 'collecting conference talk proposals'
  if (purpose === 'EVALUATION') return 'scoring assigned conference submissions'
  if (target === 'SPEAKER') return 'updating speaker profiles'
  return 'collecting accepted-session materials'
}

export function buildFormCustomizationPrompt({
  formName,
  useCase,
  fieldNames,
  mdxSource,
}: {
  formName: string
  useCase: string
  fieldNames: string[]
  mdxSource: string
}): string {
  const fields = fieldNames.length > 0 ? fieldNames.map((name) => `\`${name}\``).join(', ') : 'no fields yet'
  const firstQuestion = `This form shows ${fields} in OpenSession for ${useCase}. How do you want to customize this form?`

  return dedent`
    You are customizing the OpenSession form **${formName}**.

    Follow the authoring guide and preserve well-known field names when their special behavior is needed. You can add stable custom names for all other answers.

    Always return the full, valid MDX form, not a partial diff or isolated field snippet. Return it in one \`mdx\` code block so it can replace the current form in OpenSession.

    If the user did not include a customization request after this prompt, do not edit the form yet. Ask exactly:

    > ${firstQuestion}

    ## Current form MDX

    \`\`\`mdx
    ${mdxSource}
    \`\`\`

    ## Well-known field names

    These names have special meaning in OpenSession. Their answers are copied to typed session and speaker fields used by abstracts, agenda, public schedules, and the speaker portal. Other names remain custom form answers.

    ${wellKnownFieldGuide}

    ## OpenSession MDX form authoring guide

    ${formAuthoringGuide}
  `
}

/** ChatGPT URL that pre-fills a new chat with `prompt`.
 *
 * Uses the hash form (`#?q=`) so the prompt stays client-side. A plain
 * `?q=` query string hits Cloudflare's ~16 KB request-line limit on our
 * full authoring-guide prompts (HTTP 431). ChatGPT still reads `q` from
 * the hash the same way it reads it from the search string.
 */
export function chatgptPromptUrl(prompt: string): string {
  return `https://chatgpt.com/#?q=${encodeURIComponent(prompt)}`
}
