// Shared pure auth/request helpers: login redirect normalization. Pure
// (no cloudflare:workers import) so plain vitest can cover it — the
// effectful org resolution lives in db.ts.

const redirectBase = 'https://opensession.local'

export function normalizeAuthRedirectPath(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/dashboard'

  const url = new URL(value, redirectBase)
  url.searchParams.delete('__rsc')

  if (url.pathname === '/index.rsc') {
    url.pathname = '/'
  } else if (url.pathname.endsWith('.rsc')) {
    url.pathname = url.pathname.slice(0, -4)
  }

  return `${url.pathname}${url.search}${url.hash}`
}
