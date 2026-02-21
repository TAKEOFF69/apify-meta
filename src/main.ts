import { Actor, log } from 'apify'
import { chromium } from 'playwright'
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

// Launch browser with Apify proxy
// Try residential first (best for IG), fall back to datacenter proxies
let proxyConfiguration: Awaited<ReturnType<typeof Actor.createProxyConfiguration>> | null = null
for (const group of ['RESIDENTIAL', 'BUYPROXIES94952', 'StaticUS3']) {
  try {
    proxyConfiguration = await Actor.createProxyConfiguration({ groups: [group] })
    const testUrl = await proxyConfiguration!.newUrl()
    if (testUrl) {
      log.info(`Using proxy group: ${group}`)
      break
    }
  } catch {
    log.info(`Proxy group ${group} not available, trying next...`)
    proxyConfiguration = null
  }
}

// Fallback: auto proxy (Apify picks the best available)
if (!proxyConfiguration) {
  try {
    proxyConfiguration = await Actor.createProxyConfiguration()
    log.info('Using auto proxy configuration')
  } catch {
    log.warning('No proxy available, running without proxy')
  }
}

const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : null
log.info(`Proxy URL: ${proxyUrl ? proxyUrl.replace(/:[^:]+@/, ':***@') : 'none'}`)

const browser = await chromium.launch({
  headless: true,
  proxy: proxyUrl ? { server: proxyUrl } : undefined,
})

let successCount = 0
let errorCount = 0

for (const comp of input.competitors) {
  log.info(`Scraping competitor: ${comp.name}`)

  // Instagram
  if (comp.instagram) {
    log.info(`  IG: @${comp.instagram.replace(/^@/, '')}`)
    try {
      const result = await scrapeInstagram(browser, comp.instagram, postsLimit)
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
        log.info(`  IG: ${result.followers ?? '?'} followers, ${result.recent_posts.length} posts`)
        successCount++
      }
    } catch (err) {
      log.error(`  IG fatal error for ${comp.name}: ${err}`)
      await Actor.pushData({
        customer_slug: input.customer_slug,
        name: comp.name,
        platform: 'instagram',
        scraped_at: new Date().toISOString(),
        followers: null,
        following: null,
        posts_count: null,
        bio: null,
        recent_posts: [],
        error: String(err),
      } satisfies CompetitorSocialResult)
      errorCount++
    }

    // Polite delay between profiles
    await sleep(randomBetween(3000, 8000))
  }

  // Facebook
  if (comp.facebook) {
    log.info(`  FB: ${comp.facebook}`)
    try {
      const result = await scrapeFacebook(browser, comp.facebook, postsLimit)
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
        log.info(`  FB: ${result.followers ?? '?'} followers, ${result.recent_posts.length} posts`)
        successCount++
      }
    } catch (err) {
      log.error(`  FB fatal error for ${comp.name}: ${err}`)
      await Actor.pushData({
        customer_slug: input.customer_slug,
        name: comp.name,
        platform: 'facebook',
        scraped_at: new Date().toISOString(),
        followers: null,
        following: null,
        posts_count: null,
        bio: null,
        recent_posts: [],
        error: String(err),
      } satisfies CompetitorSocialResult)
      errorCount++
    }

    // Polite delay
    await sleep(randomBetween(3000, 8000))
  }

  // Extra delay between competitors
  await sleep(randomBetween(2000, 5000))
}

await browser.close()

log.info(`Done: ${successCount} profiles scraped, ${errorCount} errors`)
await Actor.exit()
