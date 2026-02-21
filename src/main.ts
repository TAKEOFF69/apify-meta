import { Actor, log } from 'apify'
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

// Get residential proxy URL — primary choice for IG/FB
let proxyUrl: string | null = null
try {
  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
  })
  proxyUrl = (await proxyConfiguration?.newUrl()) ?? null
  log.info(`Residential proxy: ${proxyUrl ? proxyUrl.replace(/:[^:]+@/, ':***@') : 'none'}`)
} catch (err) {
  log.warning(`Residential proxy not available: ${err}. Trying datacenter fallback.`)
  try {
    const dcProxy = await Actor.createProxyConfiguration({
      groups: ['BUYPROXIES94952'],
    })
    proxyUrl = (await dcProxy?.newUrl()) ?? null
    log.info(`Datacenter proxy fallback: ${proxyUrl ? proxyUrl.replace(/:[^:]+@/, ':***@') : 'none'}`)
  } catch {
    log.warning('No proxy available, running without proxy')
  }
}

let successCount = 0
let errorCount = 0

for (const comp of input.competitors) {
  log.info(`Scraping competitor: ${comp.name}`)

  // Instagram (via private REST API — ~50KB per request)
  if (comp.instagram) {
    const handle = comp.instagram.replace(/^@/, '')
    log.info(`  IG: @${handle}`)
    try {
      // Get a fresh proxy URL per request for IP rotation
      let igProxyUrl = proxyUrl
      try {
        const proxyConfig = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'] })
        igProxyUrl = (await proxyConfig?.newUrl(`ig_${handle}_${Date.now()}`)) ?? proxyUrl
      } catch { /* use existing */ }

      const result = await scrapeInstagram(handle, postsLimit, igProxyUrl)
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
    await sleep(randomBetween(2000, 5000))
  }

  // Facebook (via HTTP HTML fetch — ~100-300KB per request)
  if (comp.facebook) {
    log.info(`  FB: ${comp.facebook}`)
    try {
      // Fresh proxy URL for FB
      let fbProxyUrl = proxyUrl
      try {
        const proxyConfig = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'] })
        fbProxyUrl = (await proxyConfig?.newUrl(`fb_${comp.facebook}_${Date.now()}`)) ?? proxyUrl
      } catch { /* use existing */ }

      const result = await scrapeFacebook(comp.facebook, postsLimit, fbProxyUrl)
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
    await sleep(randomBetween(2000, 5000))
  }

  // Extra delay between competitors
  await sleep(randomBetween(1000, 3000))
}

log.info(`Done: ${successCount} profiles scraped, ${errorCount} errors`)
await Actor.exit()
