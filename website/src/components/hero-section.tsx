// Hero section for the OpenSession landing page.
// Uses VideoBackgroundShader from @holocron.so/vite/mdx (same as holocron.so).
// IvarText serif font for the heading.
'use client'

import { useEffect, useState } from 'react'
import { VideoBackgroundShader } from '@holocron.so/vite/mdx'
import { Link, router } from 'spiceflow/react'

const HERO_FONT = "'IvarText', serif"

export function HeroSection() {
  const [fontsReady, setFontsReady] = useState(false)

  useEffect(() => {
    const timeout = setTimeout(() => setFontsReady(true), 3000)
    void document.fonts.ready.then(() => setFontsReady(true))
    return () => clearTimeout(timeout)
  }, [])

  return (
    <div className='relative mt-4 lg:mt-8 mb-6 lg:mb-10 w-screen ml-[calc(-50vw+50%)] flex flex-col items-center overflow-hidden'>
      <VideoBackgroundShader
        src='/hero-bg.mp4'
        className='absolute inset-0 w-full h-full'
        canvasClassName='dark:opacity-60 opacity-40'
        dotStyle='ascii'
        dotColor='#5edceb'
        dotSize={10}
        chars=' .:-~=session'
      />

      {/* Foreground content */}
      <div
        className='relative z-[2] flex flex-col items-center justify-center text-center max-w-[820px] mx-auto w-full px-5 py-18 sm:py-24 lg:py-28 gap-5'
        style={{
          opacity: fontsReady ? 1 : 0,
          transition: 'opacity 0.3s cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        <h1
          className='flex flex-col items-center leading-tight text-[32px] sm:text-[44px] md:text-[54px] text-foreground'
          style={{ fontFamily: HERO_FONT }}
        >
          <span>run your conference program</span>
          <span>without the $40k SaaS bill</span>
        </h1>

        {/* CTAs */}
        <div className='flex gap-2.5 flex-wrap justify-center'>
          <Link
            href={router.href('/login/google')}
            className='inline-flex items-center gap-2 rounded-md bg-primary/90 backdrop-blur-sm h-9 px-4 text-sm font-medium text-primary-foreground no-underline hover:bg-primary/80 transition-colors'
          >
            <svg className='size-4' viewBox='0 0 24 24' fill='currentColor'>
              <path d='M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z' />
              <path d='M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z' />
              <path d='M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z' />
              <path d='M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z' />
            </svg>
            Login with Google
          </Link>
          <Link
            href={router.href('/#features')}
            className='inline-flex items-center gap-2 rounded-md backdrop-blur-sm h-9 px-4 text-sm font-medium text-foreground no-underline hover:bg-accent/50 transition-colors'
          >
            Learn more ↓
          </Link>
        </div>
      </div>
    </div>
  )
}
