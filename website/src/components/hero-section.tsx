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
            href={router.href('/login')}
            className='inline-flex items-center gap-2 rounded-md bg-primary/90 backdrop-blur-sm h-9 px-4 text-sm font-medium text-primary-foreground no-underline hover:bg-primary/80 transition-colors'
          >
            Sign in or create an account
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
