// Cloudflare Workers entrypoint for the Akarso D1 schema.
// Uses drizzle-orm/sqlite-proxy over the env.DB binding (with the `workerd`
// export condition) so worker code and local Node.js scripts can share the
// same `db` package import path.
//
// Why not drizzle-orm/d1: its batch mapper crashes when db.batch() contains a
// findFirst() that returns no rows (drizzle-team/drizzle-orm#2721). The
// sqlite-proxy driver guards that case. Same pattern as website/src/db.ts,
// which was switched in commit 06aafed for exactly that crash.
// drizzle-orm@beta no longer exports a D1Database type, so we type the
// binding structurally with just the members sqlite-proxy needs.

import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema.ts'

export { schema }

type D1PreparedStatement = {
  bind(...params: unknown[]): D1PreparedStatement
  run(): Promise<unknown>
  raw(): Promise<unknown[][]>
}

type D1Binding = {
  prepare(sql: string): D1PreparedStatement
  batch(stmts: D1PreparedStatement[]): Promise<{ results: unknown }[]>
}

// Convert D1 object rows to positional arrays for sqlite-proxy.
function d1ToRawRows(results: Record<string, unknown>[]) {
  return results.map((row) => Object.keys(row).map((k) => row[k]))
}

export function getDb() {
  const d1 = env.DB as D1Binding
  return drizzle(
    async (sql, params, method) => {
      const stmt = d1.prepare(sql).bind(...params)
      if (method === 'run') {
        await stmt.run()
        return { rows: [] as any[] }
      }
      // raw() returns positional arrays which sqlite-proxy expects.
      const rows = await stmt.raw()
      // sqlite-proxy expects a falsy value for `get` no-row results.
      // https://github.com/drizzle-team/drizzle-orm/issues/5461
      if (method === 'get') return { rows: rows[0] as any }
      return { rows: rows as any[] }
    },
    async (queries) => {
      // D1 batch() is atomic but only returns object rows (no raw()),
      // so convert to positional arrays for sqlite-proxy.
      const stmts = queries.map((q) => d1.prepare(q.sql).bind(...q.params))
      const results = await d1.batch(stmts)
      return results.map((r, i) => {
        const rows = d1ToRawRows(r.results as Record<string, unknown>[])
        if (queries[i]!.method === 'get') return { rows: rows[0] as any }
        return { rows: rows as any[] }
      })
    },
    { schema, relations: schema.relations },
  )
}
