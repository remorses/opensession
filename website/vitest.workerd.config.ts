// Workerd integration-test config. It loads production binding definitions
// from wrangler.jsonc, then adds only the in-memory D1 migration payload.
import fs from 'node:fs'
import path from 'node:path'
import { holocron } from '@holocron.so/vite'
import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const migrationsPath = path.resolve(import.meta.dirname, '../db/drizzle')
const migrationDirectories = fs.readdirSync(migrationsPath, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const migrations = (await Promise.all(
  migrationDirectories.map(async (directory) => {
    const nested = await readD1Migrations(path.join(migrationsPath, directory))
    return nested.map((migration) => ({
      ...migration,
      name: `${directory}/${migration.name}`,
    }))
  }),
)).flat()

export default defineConfig({
  // Holocron owns the Spiceflow plugin, but its workerd environment does not
  // inherit Spiceflow's Vitest condition. This enables direct page rendering.
  resolve: { conditions: ['spiceflow-vitest'] },
  plugins: [
    cloudflareTest({
      main: './src/app.tsx',
      remoteBindings: false,
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          TEST_AUTH_ENABLED: 'true',
          EMAIL_DELIVERY_DISABLED: 'true',
          BETTER_AUTH_SECRET: 'test-only-better-auth-secret-at-least-32-characters',
          BETTER_AUTH_URL: 'http://localhost',
          GOOGLE_CLIENT_ID: 'test-google-client-id',
          GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
        },
      },
    }),
    holocron({ entry: './src/app.tsx', pagesDir: 'src/pages' }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
  },
})
