// Ambient declarations for Vite asset imports used by worker code.
// tsconfig has `types: []` so vite/client is not loaded; declare only the
// suffix imports we actually use (SKILL.md served by mcp.ts).
declare module '*?raw' {
  const content: string
  export default content
}

// import.meta.hot / import.meta.env are used by strada-browser.tsx and the
// strada init in app.tsx to detect vite dev. hot is truthy in vite dev and
// undefined in production builds; env.DEV is statically replaced at build.
interface ImportMeta {
  readonly hot?: unknown
  readonly env?: { readonly DEV?: boolean }
}

// TEST_MIGRATIONS exists only in the Miniflare workerd suite. Keep this
// augmentation separate from Wrangler's generated worker-configuration.d.ts.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: D1Migration[]
    EMAIL_DELIVERY_DISABLED?: string
  }
}

interface D1Migration {
  name: string
  queries: string[]
}
