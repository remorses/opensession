// Vitest config for plain unit tests (pure helpers like src/lib/calendar.ts).
// A dedicated config so vitest does NOT load vite.config.ts, which boots the
// cloudflare + holocron plugins and requires worker secrets.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
