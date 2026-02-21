import { Actor, log } from 'apify'
import { chromium, type BrowserContext } from 'playwright'
import { scrapeInstagram } from './instagram.js'
import { scrapeFacebook } from './facebook.js'
import type { ActorInput, CompetitorSocialResult } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// ---------------------------------------------------------------------------
// Blocked resource types — optimization #1: skip images, CSS, fonts, media
// ---------------------------------------------------------------------------

const BLOCKED_RESOURCE_TYPES = new Set([
  'image', 'stylesheet', 'font', 'media', 'imageset', 'other',
])

const BLOCKED_URL_PATTERNS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.css', '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.webm', '.mp3',
  'analytics', 'tracking', 'pixel', 'fbevents',
]

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await Actor.init()

const input = (await Actor.getInput()) as ActorInput | null
if (!input?.customer_slug || !input?.competitors?.length) {
  log.error('Invalid input: customer_slug and competitors[] are required')
  await Actor.exit({ exitCode: 1 })
  throw new Error('Invalid input')
}

const postsLimit = input.posts_per_profile ?? 12

log.info(`Starting social scrape for ${input.customer_slug}: ${input.competitors.length} competitors`)

// --- Optimization #3: Separate proxy configs for IG (residential) and FB (datacenter) ---
let igProxyUrl: string | null = null
let fbProxyUrl: string | null = null

try {
  const residentialProxy = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'] })
  igProxyUrl = (await residentialProxy?.newUrl(`ig_session_${Date.now()}`)) ?? null
  log.info(`IG proxy (residential): ${igProxyUrl ? igProxyUrl.replace(/:[^:]+@/, ':***@') : 'none'}`)
} catch (err) {
  log.warning(`Residential proxy not available: ${err}`)
}

try {
  // Datacenter is cheaper ($0.25/GB vs $10/GB) and FB tolerates it
  const dcProxy = await Actor.createProxyConfiguration({ groups: ['BUYPROXIES94952'] })
  fbProxyUrl = (await dcProxy?.newUrl(`fb_session_${Date.now()}`)) ?? null
  log.info(`FB proxy (datacenter): ${fbProxyUrl ? fbProxyUrl.replace(/:[^:]+@/, ':***@') : 'none'}`)
} catch {
  // Fall back to residential for FB if datacenter not available
  fbProxyUrl = igProxyUrl
  log.info('FB proxy: falling back to residential')
}

// --- Optimization #2: Reuse browser contexts (one launch, multiple pages) ---
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
})

// Create separate contexts for IG and FB with different proxies
async function createContext(proxyUrl: string | null): Promise<BrowserContext> {
  const contextOptions: any = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
    javaScriptEnabled: true,
  }
  if (proxyUrl) {
    // Parse proxy URL for Playwright format
    const parsed = new URL(proxyUrl)
    contextOptions.proxy = {
      server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
      username: parsed.username,
      password: parsed.password,
    }
  }
  const ctx = await browser.newContext(contextOptions)

  // Optimization #1: Block unnecessary resources
  await ctx.route('**/*', (route) => {
    const req = route.request()
    const resourceType = req.resourceType()
    const url = req.url().toLowerCase()

    if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
      return route.abort()
    }
    if (BLOCKED_URL_PATTERNS.some((p) => url.includes(p))) {
      return route.abort()
    }
    return route.continue()
  })

  return ctx
}

const igContext = await createContext(igProxyUrl)
const fbContext = await createContext(fbProxyUrl)

let successCount = 0
let errorCount = 0

for (const comp of input.competitors) {
  log.info(`Scraping competitor: ${comp.name}`)

  // --- Instagram ---
  if (comp.instagram) {
    const handle = comp.instagram.replace(/^@/, '')
    log.info(`  IG: @${handle}`)
    try {
      // Optimization #5: Fresh proxy session per profile
      let profileContext = igContext
      try {
        const proxyConfig = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'] })
        const freshProxy = (await proxyConfig?.newUrl(`ig_${handle}_${Date.now()}`)) ?? null
        if (freshProxy && freshProxy !== igProxyUrl) {
          profileContext = await createContext(freshProxy)
        }
      } catch { /* use shared context */ }

      const result = await scrapeInstagram(profileContext, handle, postsLimit)
      const data: CompetitorSocialResult = {
        customer_slug: input.customer_slug,
        name: comp.name,
        platform: 'instagram',
        scraped_at: new Date().toISOString(),
        ...result,
      }
      await Actor.pushData(data)

      if (result.error) {
        log.warning(`  IG error for ${comp.name}: ${result.error}`)
        errorCount++
      } else {
        log.info(`  IG OK: ${result.followers ?? '?'} followers, ${result.recent_posts.length} posts`)
        successCount++
      }

      // Close per-profile context if we created a fresh one
      if (profileContext !== igContext) {
        await profileContext.close().catch(() => {})
      }
    } catch (err) {
      log.error(`  IG fatal error for ${comp.name}: ${err}`)
      await Actor.pushData({
        customer_slug: input.customer_slug,
        name: comp.name,
        platform: 'instagram',
        scraped_at: new Date().toISOString(),
        followers: null, following: null, posts_count: null, bio: null,
        recent_posts: [], error: String(err),
      } satisfies CompetitorSocialResult)
      errorCount++
    }

    await sleep(randomBetween(2000, 5000))
  }

  // --- Facebook ---
  if (comp.facebook) {
    log.info(`  FB: ${comp.facebook}`)
    try {
      const result = await scrapeFacebook(fbContext, comp.facebook, postsLimit)
      const data: CompetitorSocialResult = {
        customer_slug: input.customer_slug,
        name: comp.name,
        platform: 'facebook',
        scraped_at: new Date().toISOString(),
        ...result,
      }
      await Actor.pushData(data)

      if (result.error) {
        log.warning(`  FB error for ${comp.name}: ${result.error}`)
        errorCount++
      } else {
        log.info(`  FB OK: ${result.followers ?? '?'} followers, ${result.recent_posts.length} posts`)
        successCount++
      }
    } catch (err) {
      log.error(`  FB fatal error for ${comp.name}: ${err}`)
      await Actor.pushData({
        customer_slug: input.customer_slug,
        name: comp.name,
        platform: 'facebook',
        scraped_at: new Date().toISOString(),
        followers: null, following: null, posts_count: null, bio: null,
        recent_posts: [], error: String(err),
      } satisfies CompetitorSocialResult)
      errorCount++
    }

    await sleep(randomBetween(2000, 5000))
  }

  await sleep(randomBetween(1000, 3000))
}

// Clean up
await igContext.close().catch(() => {})
await fbContext.close().catch(() => {})
await browser.close().catch(() => {})

log.info(`Done: ${successCount} OK, ${errorCount} errors`)
await Actor.exit()
