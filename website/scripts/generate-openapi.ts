// Generate the Holocron API reference from the live Spiceflow route schemas.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

Bun.plugin({
  name: 'cloudflare-workers-stub',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      loader: 'object',
      exports: { env: {} },
    }))
  },
})

console.log('Loading OpenSession API routes...')
const { apiApp } = await import('../src/api.ts')
const response = await apiApp.handle(new Request('http://localhost/api/v1/openapi.json'))
if (!response.ok) {
  throw new Error(`OpenAPI endpoint returned ${response.status}: ${await response.text()}`)
}
const document = await response.json<any>()
delete document.paths?.['/api/v1/openapi.json']

const output = path.join(import.meta.dirname, '../src/pages/openapi.json')
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`)
console.log(`Wrote ${output} with ${Object.keys(document.paths ?? {}).length} paths`)
