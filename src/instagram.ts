import { log } from 'apify'
import type { BrowserContext } from 'playwright'
import type { CompetitorSocialResult, SocialPost } from './types.js'

type ProfileResult = Omit<CompetitorSocialResult, 'customer_slug' | 'name' | 'platform' | 'scraped_at'>

/**
 * Scrape an Instagram public profile using Playwright.
 *
 * Optimizations:
 * - Browser context reused (created once in main.ts, resource blocking applied)
 * - Wait for specific selectors, not arbitrary timeouts (#4)
 * - Extract from rendered page: embedded JSON has profile + posts with engagement
 */
export async function scrapeInstagram(
  context: BrowserContext,
  handle: string,
  postsLimit: number,
): Promise<ProfileResult> {
  const cleanHandle = handle.replace(/^@/, '')
  const page = await context.newPage()

  try {
    const url = `https://www.instagram.com/${cleanHandle}/`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })

    // Optimization #4: Wait for specific content selectors, not arbitrary timeout
    await page.waitForSelector(
      'meta[property="og:description"], header section, article, [data-testid="user-avatar"]',
      { timeout: 15_000 },
    ).catch(() => {
      log.info('    IG: profile elements not found after 15s, continuing with available data')
    })

    // Small extra wait for dynamic JSON injection
    await page.waitForTimeout(2000)

    const html = await page.content()
    log.info(`    IG page: ${html.length} chars`)

    // Debug: page content analysis
    const title = await page.title()
    const hasMetaTags = html.includes('og:description')
    const hasShortcodes = html.includes('"shortcode"')
    const hasEdgeMedia = html.includes('edge_owner_to_timeline_media')
    log.info(`    IG: title="${title}" meta=${hasMetaTags} shortcodes=${hasShortcodes} edgeMedia=${hasEdgeMedia}`)

    // --- Extract profile metrics ---
    const metaProfile = extractProfileFromMetaTags(html)
    const jsonProfile = extractProfileFromJson(html)

    const followers = jsonProfile.followers ?? metaProfile.followers
    const following = jsonProfile.following ?? metaProfile.following
    const postsCount = jsonProfile.postsCount ?? metaProfile.postsCount
    const bio = jsonProfile.bio ?? metaProfile.bio

    // --- Extract posts ---
    const posts = extractPostsFromJson(html, postsLimit)

    log.info(`    IG: ${followers ?? '?'} followers, ${posts.length} posts extracted`)
    await page.close()

    return {
      followers,
      following,
      posts_count: postsCount,
      bio,
      recent_posts: posts,
      error: posts.length === 0 && followers === null ? 'Could not extract data from profile page' : null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await page.close().catch(() => {})
    return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: message }
  }
}

// ---------------------------------------------------------------------------
// Extract posts from embedded JSON in rendered page
// ---------------------------------------------------------------------------

function extractPostsFromJson(html: string, limit: number): SocialPost[] {
  const posts: SocialPost[] = []
  const seen = new Set<string>()

  const shortcodePattern = /"shortcode"\s*:\s*"([A-Za-z0-9_-]+)"/g
  let match: RegExpExecArray | null

  while ((match = shortcodePattern.exec(html)) !== null && posts.length < limit) {
    const shortcode = match[1]
    if (seen.has(shortcode)) continue
    seen.add(shortcode)

    const pos = match.index
    const start = Math.max(0, pos - 500)
    const end = Math.min(html.length, pos + 3000)
    const vicinity = html.slice(start, end)

    const likes = vicinity.match(/"edge_liked_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
      ?? vicinity.match(/"edge_media_preview_like"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
    const comments = vicinity.match(/"edge_media_to_comment"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
    const timestamp = vicinity.match(/"taken_at_timestamp"\s*:\s*(\d+)/)
    const isVideo = vicinity.match(/"is_video"\s*:\s*(true|false)/)
    const captionText = vicinity.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]

    posts.push({
      url: `https://www.instagram.com/p/${shortcode}/`,
      caption_snippet: captionText ? decodeJsonEscapes(captionText).slice(0, 300) : '',
      likes: likes ? parseInt(likes[1], 10) : null,
      comments: comments ? parseInt(comments[1], 10) : null,
      posted_at: timestamp
        ? new Date(parseInt(timestamp[1], 10) * 1000).toISOString().split('T')[0]
        : null,
      media_type: isVideo?.[1] === 'true' ? 'video' : 'image',
    })
  }

  return posts
}

// ---------------------------------------------------------------------------
// Profile extraction
// ---------------------------------------------------------------------------

function extractProfileFromMetaTags(html: string): {
  followers: number | null; following: number | null; postsCount: number | null; bio: string | null
} {
  const ogMatch = html.match(/<meta\s+(?:property="og:description"\s+content="([^"]+)"|content="([^"]+)"\s+property="og:description")/i)
  const descMatch = html.match(/<meta\s+(?:name="description"\s+content="([^"]+)"|content="([^"]+)"\s+name="description")/i)
  const desc = ogMatch?.[1] ?? ogMatch?.[2] ?? descMatch?.[1] ?? descMatch?.[2]

  if (!desc) return { followers: null, following: null, postsCount: null, bio: null }

  const decoded = decodeHtmlEntities(desc)
  const followersMatch = decoded.match(/([\d,.]+[KkMm]?)\s*(?:Followers|obserwuj[aą]cych|follower)/i)
  const followingMatch = decoded.match(/([\d,.]+[KkMm]?)\s*(?:Following|obserwowanych)/i)
  const postsMatch = decoded.match(/([\d,.]+[KkMm]?)\s*(?:Posts|post[oó]w|post)\b/i)
  const bioMatch = decoded.match(/[-\u2013\u2014]\s*(.+)$/)

  return {
    followers: followersMatch ? parseCount(followersMatch[1]) : null,
    following: followingMatch ? parseCount(followingMatch[1]) : null,
    postsCount: postsMatch ? parseCount(postsMatch[1]) : null,
    bio: bioMatch ? bioMatch[1].trim().slice(0, 300) : null,
  }
}

function extractProfileFromJson(html: string): {
  followers: number | null; following: number | null; postsCount: number | null; bio: string | null
} {
  const followedBy = html.match(/"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
  const follow = html.match(/"edge_follow"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
  const mediaCount = html.match(/"edge_owner_to_timeline_media"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
  const bio = html.match(/"biography"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]

  return {
    followers: followedBy ? parseInt(followedBy[1], 10) : null,
    following: follow ? parseInt(follow[1], 10) : null,
    postsCount: mediaCount ? parseInt(mediaCount[1], 10) : null,
    bio: bio ? decodeJsonEscapes(bio).slice(0, 300) : null,
  }
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
  const multiplierMatch = cleaned.match(/([\d,.]+)\s*([KkMm])?/)
  if (!multiplierMatch) return null

  let numStr = multiplierMatch[1]
  if (/,\d{3}/.test(numStr)) {
    numStr = numStr.replace(/,/g, '')
  } else if (/\.\d{3}/.test(numStr)) {
    numStr = numStr.replace(/\./g, '')
  } else {
    numStr = numStr.replace(',', '.')
  }

  let num = parseFloat(numStr)
  if (isNaN(num)) return null

  const multiplier = multiplierMatch[2]?.toUpperCase()
  if (multiplier === 'K') num *= 1000
  if (multiplier === 'M') num *= 1_000_000

  return Math.round(num)
}
