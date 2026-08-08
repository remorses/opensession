import { cloudflare } from '@cloudflare/vite-plugin'
import { holocron } from '@holocron.so/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 8788 },
  plugins: [
    holocron({ entry: './src/app.tsx', pagesDir: 'src/pages' }),
    cloudflare({
      viteEnvironment: {
        name: 'rsc',
        childEnvironments: ['ssr'],
      },
    }),
  ],
})
