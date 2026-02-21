import { log } from 'apify'
import type { BrowserContext } from 'playwright'
import type { CompetitorSocialResult, SocialPost } from './types.js'

type ProfileResult = Omit<CompetitorSocialResult, 'customer_slug' | 'name' | 'platform' | 'scraped_at'>

/**
 * Scrape a Facebook public page using Playwright.
 *
 * Strategy cascade:
 * 1. Desktop www.facebook.com — JS renders, extract from embedded JSON
 * 2. mbasic.facebook.com — simpler HTML fallback (same browser context = has cookies)
 *
 * Optimizations:
 * - Datacenter proxy (set in main.ts context) — FB tolerates it, $0.25/GB vs $10/GB
 * - Resource blocking applied at context level (images, CSS, fonts)
 * - Wait for specific selectors (#4)
 */
export async function scrapeFacebook(
  context: BrowserContext,
  pageHandle: string,
  postsLimit: number,
): Promise<ProfileResult> {
  // Strategy 1: Desktop page — JS renders, rich embedded JSON
  const desktopResult = await tryDesktopPage(context, pageHandle, postsLimit)

  if (desktopResult && desktopResult.recent_posts.length >= 2) {
    log.info(`    FB desktop: ${desktopResult.recent_posts.length} posts, ${desktopResult.followers ?? '?'} followers`)
    return desktopResult
  }

  // Strategy 2: mbasic — simpler HTML (same context = cookies from desktop visit)
  log.info(`    FB desktop gave ${desktopResult?.recent_posts.length ?? 0} posts, trying mbasic`)
  const mbasicResult = await tryMbasicPage(context, pageHandle, postsLimit)

  if (mbasicResult && mbasicResult.recent_posts.length > 0) {
    return {
      followers: desktopResult?.followers ?? mbasicResult.followers,
      following: null,
      posts_count: null,
      bio: desktopResult?.bio ?? mbasicResult.bio,
      recent_posts: mbasicResult.recent_posts,
      error: null,
    }
  }

  return desktopResult ?? {
    followers: null, following: null, posts_count: null, bio: null,
    recent_posts: [], error: 'All Facebook strategies failed',
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: Desktop page (Playwright renders JS)
// ---------------------------------------------------------------------------

async function tryDesktopPage(
  context: BrowserContext,
  pageHandle: string,
  postsLimit: number,
): Promise<ProfileResult | null> {
  const page = await context.newPage()

  try {
    const url = `https://www.facebook.com/${pageHandle}/`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })

    // Optimization #4: Wait for FB page content to render
    await page.waitForSelector(
      '[role="main"], [data-pagelet="PageProfileContent"], [aria-label="Posts"]',
      { timeout: 15_000 },
    ).catch(() => {
      log.info('    FB: page content not found after 15s, continuing')
    })

    // Scroll down to load more posts
    await page.evaluate(() => window.scrollBy(0, 2000))
    await page.waitForTimeout(2000)

    const html = await page.content()
    log.info(`    FB desktop: ${html.length} chars`)

    const title = await page.title()
    const hasOg = html.includes('og:description')
    const hasCreationTime = (html.match(/"creation_time"/g) || []).length
    const hasMessage = (html.match(/"message"\s*:\s*\{/g) || []).length
    const hasReactionCount = (html.match(/"reaction_count"/g) || []).length
    const isLoginPage = html.includes('login_form') || html.includes('/login/?next')
    log.info(`    FB: title="${title}" og=${hasOg} creation_time=${hasCreationTime} messages=${hasMessage} reactions=${hasReactionCount} login=${isLoginPage}`)

    const posts = extractPostsFromDesktopJson(html, postsLimit)
    const followers = extractFollowers(html)
    const bio = extractBio(html)

    await page.close()

    return {
      followers,
      following: null,
      posts_count: null,
      bio,
      recent_posts: posts,
      error: null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await page.close().catch(() => {})
    return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: message }
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: mbasic page (simpler HTML, same context has cookies)
// ---------------------------------------------------------------------------

async function tryMbasicPage(
  context: BrowserContext,
  pageHandle: string,
  postsLimit: number,
): Promise<ProfileResult | null> {
  const page = await context.newPage()

  try {
    const url = `https://mbasic.facebook.com/${pageHandle}/`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    // Check if we got redirected to login
    const currentUrl = page.url()
    if (currentUrl.includes('/login')) {
      log.info('    FB mbasic: redirected to login')
      await page.close()
      return null
    }

    await page.waitForTimeout(1000)

    const html = await page.content()
    log.info(`    FB mbasic: ${html.length} chars`)
    const hasStoryLinks = (html.match(/story\.php/g) || []).length
    const hasDataFt = (html.match(/data-ft/g) || []).length
    log.info(`    FB mbasic: storyLinks=${hasStoryLinks} dataFt=${hasDataFt}`)

    const posts = extractPostsFromMbasic(html, postsLimit)
    const followers = extractMbasicFollowers(html)

    await page.close()

    return {
      followers,
      following: null,
      posts_count: null,
      bio: null,
      recent_posts: posts,
      error: null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await page.close().catch(() => {})
    return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `mbasic: ${message}` }
  }
}

// ---------------------------------------------------------------------------
// Extract posts from desktop embedded JSON
// ---------------------------------------------------------------------------

function extractPostsFromDesktopJson(html: string, limit: number): SocialPost[] {
  const posts: SocialPost[] = []
  const seen = new Set<string>()

  // Method A: creation_time anchors
  const creationTimePattern = /"creation_time"\s*:\s*(\d{10})/g
  let match: RegExpExecArray | null

  while ((match = creationTimePattern.exec(html)) !== null && posts.length < limit) {
    const timestamp = parseInt(match[1], 10)
    const ageInDays = (Date.now() / 1000 - timestamp) / 86400
    if (ageInDays > 365) continue

    const pos = match.index
    const start = Math.max(0, pos - 3000)
    const end = Math.min(html.length, pos + 5000)
    const vicinity = html.slice(start, end)

    const messageMatch = vicinity.match(/"message"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]
      ?? vicinity.match(/"text"\s*:\s*"((?:[^"\\]|\\[\s\S]){10,300})"/)?.[1]

    if (!messageMatch || messageMatch.length < 5) continue

    const text = decodeJsonEscapes(messageMatch).slice(0, 300)
    const dedupeKey = text.slice(0, 50)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const reactions = vicinity.match(/"reaction_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
      ?? vicinity.match(/"reactors"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
      ?? vicinity.match(/"i18n_reaction_count"\s*:\s*"(\d+)/)
    const commentCount = vicinity.match(/"comment_count"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/)
      ?? vicinity.match(/"total_comment_count"\s*:\s*(\d+)/)

    const postUrl = vicinity.match(/"url"\s*:\s*"(https?:\\\/\\\/www\.facebook\.com\\\/[^"]+permalink[^"]+)"/)?.[1]
      ?? vicinity.match(/"url"\s*:\s*"(https?:\\\/\\\/www\.facebook\.com\\\/(?:photo|video|reel)[^"]+)"/)?.[1]

    const mediaType = vicinity.includes('"is_video":true') ? 'video'
      : vicinity.includes('"photo_image"') || vicinity.includes('"image"') ? 'image'
      : null

    posts.push({
      url: postUrl ? decodeJsonEscapes(postUrl) : '',
      caption_snippet: text,
      likes: reactions ? parseInt(reactions[1], 10) : null,
      comments: commentCount ? parseInt(commentCount[1], 10) : null,
      posted_at: new Date(timestamp * 1000).toISOString().split('T')[0],
      media_type: mediaType,
    })
  }

  // Method B: message text anchors
  if (posts.length < limit) {
    const messagePattern = /"message"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g
    while ((match = messagePattern.exec(html)) !== null && posts.length < limit) {
      const rawText = match[1]
      if (rawText.length < 10) continue

      const text = decodeJsonEscapes(rawText).slice(0, 300)
      const dedupeKey = text.slice(0, 50)
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      const pos = match.index
      const vicinityStart = Math.max(0, pos - 2000)
      const vicinityEnd = Math.min(html.length, pos + 3000)
      const vicinity = html.slice(vicinityStart, vicinityEnd)

      const reactions = vicinity.match(/"reaction_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
      const commentCount = vicinity.match(/"comment_count"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/)
      const timeMatch = vicinity.match(/"creation_time"\s*:\s*(\d{10})/)

      posts.push({
        url: '',
        caption_snippet: text,
        likes: reactions ? parseInt(reactions[1], 10) : null,
        comments: commentCount ? parseInt(commentCount[1], 10) : null,
        posted_at: timeMatch
          ? new Date(parseInt(timeMatch[1], 10) * 1000).toISOString().split('T')[0]
          : null,
        media_type: null,
      })
    }
  }

  posts.sort((a, b) => {
    if (!a.posted_at || !b.posted_at) return 0
    return b.posted_at.localeCompare(a.posted_at)
  })

  return posts.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Extract posts from mbasic HTML
// ---------------------------------------------------------------------------

function extractPostsFromMbasic(html: string, limit: number): SocialPost[] {
  const posts: SocialPost[] = []
  const seen = new Set<string>()

  const storyLinkPattern = /href="(\/story\.php\?story_fbid=\d+&amp;id=\d+[^"]*)"/g
  let match: RegExpExecArray | null

  while ((match = storyLinkPattern.exec(html)) !== null && posts.length < limit) {
    const storyPath = decodeHtmlEntities(match[1])
    const pos = match.index

    const textStart = Math.max(0, pos - 2000)
    const textRegion = html.slice(textStart, pos)

    const textMatch = textRegion.match(/<div[^>]*>([^<]{15,})<\/div>/g)
    if (!textMatch || textMatch.length === 0) continue

    const lastBlock = textMatch[textMatch.length - 1]
    const text = lastBlock.replace(/<[^>]+>/g, '').trim()

    if (text.length < 10) continue

    const dedupeKey = text.slice(0, 50)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const timeRegion = html.slice(textStart, Math.min(html.length, pos + 500))
    const dateMatch = timeRegion.match(/data-utime="(\d+)"/)

    let postedAt: string | null = null
    if (dateMatch?.[1] && /^\d{10}$/.test(dateMatch[1])) {
      postedAt = new Date(parseInt(dateMatch[1], 10) * 1000).toISOString().split('T')[0]
    }

    const engageRegion = html.slice(pos, Math.min(html.length, pos + 1000))
    const likesMatch = engageRegion.match(/(\d+)\s*(?:reactions?|people reacted|like)/i)
    const commentsMatch = engageRegion.match(/(\d+)\s*comment/i)

    posts.push({
      url: `https://mbasic.facebook.com${storyPath}`,
      caption_snippet: decodeHtmlEntities(text).slice(0, 300),
      likes: likesMatch ? parseInt(likesMatch[1], 10) : null,
      comments: commentsMatch ? parseInt(commentsMatch[1], 10) : null,
      posted_at: postedAt,
      media_type: null,
    })
  }

  if (posts.length === 0) {
    const articlePattern = /<div[^>]*data-ft[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*>\s*<a[^>]*href="\/story/g
    while ((match = articlePattern.exec(html)) !== null && posts.length < limit) {
      const content = match[1].replace(/<[^>]+>/g, '').trim()
      if (content.length < 15) continue

      const dedupeKey = content.slice(0, 50)
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      posts.push({
        url: '',
        caption_snippet: decodeHtmlEntities(content).slice(0, 300),
        likes: null, comments: null, posted_at: null, media_type: null,
      })
    }
  }

  return posts
}

// ---------------------------------------------------------------------------
// Follower / bio extraction
// ---------------------------------------------------------------------------

function extractMbasicFollowers(html: string): number | null {
  const likeMatch = html.match(/([\d,.\s]+)\s*(?:people like this|os[oó]b lubi|people follow)/i)
  if (likeMatch) return parseCount(likeMatch[1])
  return null
}

function extractFollowers(html: string): number | null {
  const ogMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)
    ?? html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i)
  if (ogMatch) {
    const desc = decodeHtmlEntities(ogMatch[1])
    const plMatch = desc.match(/([\d\s,.]+)\s*(?:os[oó]b lubi|obserwuj[aą]cych|polubie[nń])/i)
    if (plMatch) return parseCount(plMatch[1])
    const enMatch = desc.match(/([\d\s,.]+)\s*(?:people like|followers|likes)/i)
    if (enMatch) return parseCount(enMatch[1])
  }

  const metaDesc = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)
  if (metaDesc) {
    const desc = decodeHtmlEntities(metaDesc[1])
    const plMatch = desc.match(/([\d\s,.]+)\s*(?:os[oó]b lubi|obserwuj[aą]cych|polubie[nń])/i)
    if (plMatch) return parseCount(plMatch[1])
    const enMatch = desc.match(/([\d\s,.]+)\s*(?:people like|followers|likes)/i)
    if (enMatch) return parseCount(enMatch[1])
  }

  const followerJsonMatch = html.match(/"follower_count"\s*:\s*(\d+)/i)
    ?? html.match(/"followers_count"\s*:\s*(\d+)/i)
    ?? html.match(/"fan_count"\s*:\s*(\d+)/i)
  if (followerJsonMatch) return parseInt(followerJsonMatch[1], 10)

  return null
}

function extractBio(html: string): string | null {
  const ogMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)
    ?? html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i)
  if (ogMatch) {
    const desc = decodeHtmlEntities(ogMatch[1])
    const bioMatch = desc.match(/[-\u2013\u2014\u00b7.]\s*(.{10,})$/)
    if (bioMatch) return bioMatch[1].trim().slice(0, 300)
  }

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (titleMatch) {
    const title = decodeHtmlEntities(titleMatch[1]).replace(/\s*[-|]\s*Facebook.*$/i, '').trim()
    if (title.length > 5) return title.slice(0, 300)
  }

  return null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[\u00A0\u2009\u202F]/g, ' ')
}

function decodeJsonEscapes(text: string): string {
  return text
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, '')
    .replace(/\\t/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\u([\da-fA-F]{4})/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)) } catch { return '' }
    })
}

function parseCount(text: string): number | null {
  const cleaned = text.trim().replace(/\s/g, '')
  const match = cleaned.match(/([\d,.]+)\s*([KkMm])?/)
  if (!match) return null

  let numStr = match[1]
  if (/,\d{3}/.test(numStr)) {
    numStr = numStr.replace(/,/g, '')
  } else if (/\.\d{3}/.test(numStr)) {
    numStr = numStr.replace(/\./g, '')
  } else {
    numStr = numStr.replace(',', '.')
  }

  let num = parseFloat(numStr)
  if (isNaN(num)) return null

  const mult = match[2]?.toUpperCase()
  if (mult === 'K') num *= 1000
  if (mult === 'M') num *= 1_000_000

  return Math.round(num)
}
