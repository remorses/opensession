import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({
  // omit baseURL — client and server share the same domain
})
