import { Actor, log } from 'apify'
import type { CompetitorSocialResult, SocialPost } from './types.js'

type ProfileResult = Omit<CompetitorSocialResult, 'customer_slug' | 'name' | 'platform' | 'scraped_at'>

/**
 * Scrape an Instagram public profile — focused on POST ENGAGEMENT data.
 *
 * Strategy cascade (each gives progressively less data):
 * 1. Private REST API — full data: profile + posts with likes/comments/dates
 * 2. Profile HTML JSON extraction — posts with engagement from embedded <script> data
 * 3. Meta tag fallback — profile metrics only (followers, posts count), no post engagement
 *
 * The primary goal is recent_posts[] with per-post engagement (likes, comments).
 * Profile metrics (followers) are secondary.
 */
export async function scrapeInstagram(
  handle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<ProfileResult> {
  const cleanHandle = handle.replace(/^@/, '')

  // Strategy 1: Private REST API — best data (posts with full engagement)
  const apiResult = await tryPrivateApi(cleanHandle, postsLimit, proxyUrl)
  if (apiResult && !apiResult.error && apiResult.recent_posts.length > 0) return apiResult

  // Strategy 1b: Retry API with fresh proxy IP (429 is often IP-specific)
  if (apiResult?.error?.includes('429') && proxyUrl) {
    log.info(`    IG API 429 — retrying with fresh proxy IP after 5s delay`)
    await sleep(5000)
    const freshProxyUrl = await getFreshProxyUrl(proxyUrl)
    const retryResult = await tryPrivateApi(cleanHandle, postsLimit, freshProxyUrl)
    if (retryResult && !retryResult.error && retryResult.recent_posts.length > 0) return retryResult
  }

  // Strategy 2: Web page HTML — extract posts from embedded JSON + meta tags
  log.info(`    IG API: ${apiResult?.error ?? 'no posts'}, trying web page extraction`)
  const webResult = await tryWebPage(cleanHandle, postsLimit, proxyUrl)

  // Prefer web result if it has posts (even if API returned some profile data)
  if (webResult && webResult.recent_posts.length > 0) return webResult

  // If web result has profile data but no posts, merge with any API data
  if (webResult && webResult.followers !== null) {
    // Web has profile metrics, API might have had partial data
    return {
      ...webResult,
      error: webResult.recent_posts.length === 0
        ? 'Profile metrics OK but no post engagement data (IG blocks API + no embedded JSON)'
        : null,
    }
  }

  // Return whatever we got
  return apiResult ?? webResult ?? {
    followers: null, following: null, posts_count: null, bio: null,
    recent_posts: [], error: 'All strategies failed',
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: Instagram private REST API
// ---------------------------------------------------------------------------

async function tryPrivateApi(
  handle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<ProfileResult | null> {
  try {
    // Visit the PROFILE page (not homepage) to get relevant session cookies
    const sessionCookies = await getSessionCookies(
      `https://www.instagram.com/${handle}/`,
      proxyUrl,
    )

    // Small delay — immediate API call after cookie fetch looks bot-like
    await sleep(randomBetween(1500, 3000))

    const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`

    const ua = randomUserAgent()
    const headers: Record<string, string> = {
      'x-ig-app-id': '936619743392459',
      'User-Agent': ua,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Origin': 'https://www.instagram.com',
      'Referer': `https://www.instagram.com/${handle}/`,
      'X-Requested-With': 'XMLHttpRequest',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    }

    if (sessionCookies) {
      headers['Cookie'] = sessionCookies
      const csrfMatch = sessionCookies.match(/csrftoken=([^;]+)/)
      if (csrfMatch) headers['X-CSRFToken'] = csrfMatch[1]
    }

    const response = await fetchWithProxy(url, { headers, signal: AbortSignal.timeout(30_000) }, proxyUrl)

    if (!response.ok) {
      return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `HTTP ${response.status}` }
    }

    const data = await response.json() as InstagramApiResponse
    const user = data?.data?.user

    if (!user) {
      return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: 'No user data in API response' }
    }

    const followers = user.edge_followed_by?.count ?? null
    const following = user.edge_follow?.count ?? null
    const postsCount = user.edge_owner_to_timeline_media?.count ?? null
    const bio = user.biography?.slice(0, 300) ?? null

    const recentPosts: SocialPost[] = []
    const edges = user.edge_owner_to_timeline_media?.edges ?? []

    for (const edge of edges.slice(0, postsLimit)) {
      const node = edge.node
      if (!node) continue

      recentPosts.push({
        url: `https://www.instagram.com/p/${node.shortcode}/`,
        caption_snippet: (node.edge_media_to_caption?.edges?.[0]?.node?.text ?? '').slice(0, 300),
        likes: node.edge_liked_by?.count ?? node.edge_media_preview_like?.count ?? null,
        comments: node.edge_media_to_comment?.count ?? null,
        posted_at: node.taken_at_timestamp
          ? new Date(node.taken_at_timestamp * 1000).toISOString().split('T')[0]
          : null,
        media_type: node.is_video ? 'video' : 'image',
      })
    }

    log.info(`    IG API: ${followers} followers, ${recentPosts.length} posts with engagement`)
    return { followers, following, posts_count: postsCount, bio, recent_posts: recentPosts, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: message }
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: Web page — extract embedded JSON posts + meta tag profile data
// ---------------------------------------------------------------------------

async function tryWebPage(
  handle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<ProfileResult | null> {
  try {
    const url = `https://www.instagram.com/${handle}/`

    const response = await fetchWithProxy(url, {
      headers: {
        'User-Agent': randomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
      },
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
    }, proxyUrl)

    if (!response.ok) {
      return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `Web HTTP ${response.status}` }
    }

    const html = await response.text()

    // --- Extract posts from embedded JSON in HTML ---
    const posts = extractPostsFromHtml(html, postsLimit)
    if (posts.length > 0) {
      log.info(`    IG HTML: extracted ${posts.length} posts with engagement from embedded JSON`)
    }

    // --- Extract profile metrics from meta tags ---
    const profile = extractProfileFromMetaTags(html)

    // If we found posts in JSON, also try to get profile data from JSON
    const jsonProfile = extractProfileFromJson(html)

    return {
      followers: jsonProfile.followers ?? profile.followers,
      following: jsonProfile.following ?? profile.following,
      posts_count: jsonProfile.postsCount ?? profile.postsCount,
      bio: jsonProfile.bio ?? profile.bio,
      recent_posts: posts,
      error: null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `Web: ${message}` }
  }
}

// ---------------------------------------------------------------------------
// Extract posts from embedded JSON in HTML
// ---------------------------------------------------------------------------

function extractPostsFromHtml(html: string, limit: number): SocialPost[] {
  const posts: SocialPost[] = []
  const seen = new Set<string>()

  // Instagram embeds post data in <script> tags as JSON.
  // Look for "shortcode" occurrences and extract nearby engagement data.
  const shortcodePattern = /"shortcode"\s*:\s*"([A-Za-z0-9_-]+)"/g
  let match: RegExpExecArray | null

  while ((match = shortcodePattern.exec(html)) !== null && posts.length < limit) {
    const shortcode = match[1]
    if (seen.has(shortcode)) continue
    seen.add(shortcode)

    const pos = match.index
    // Look in a window around the shortcode for related data
    const start = Math.max(0, pos - 500)
    const end = Math.min(html.length, pos + 3000)
    const vicinity = html.slice(start, end)

    // Extract engagement metrics from the vicinity
    const likes = vicinity.match(/"edge_liked_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
      ?? vicinity.match(/"edge_media_preview_like"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
    const comments = vicinity.match(/"edge_media_to_comment"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
    const timestamp = vicinity.match(/"taken_at_timestamp"\s*:\s*(\d+)/)
    const isVideo = vicinity.match(/"is_video"\s*:\s*(true|false)/)

    // Caption: may be in nested edges structure
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
// Extract profile metrics from meta tags (og:description)
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
  const bioMatch = decoded.match(/[-–—]\s*(.+)$/)

  return {
    followers: followersMatch ? parseCount(followersMatch[1]) : null,
    following: followingMatch ? parseCount(followingMatch[1]) : null,
    postsCount: postsMatch ? parseCount(postsMatch[1]) : null,
    bio: bioMatch ? bioMatch[1].trim().slice(0, 300) : null,
  }
}

// ---------------------------------------------------------------------------
// Extract profile metrics from embedded JSON (more accurate than meta tags)
// ---------------------------------------------------------------------------

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
// Get session cookies by visiting a page
// ---------------------------------------------------------------------------

async function getSessionCookies(pageUrl: string, proxyUrl: string | null): Promise<string | null> {
  try {
    const response = await fetchWithProxy(pageUrl, {
      headers: {
        'User-Agent': randomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    }, proxyUrl)

    const setCookies = response.headers.getSetCookie?.() ?? []
    if (setCookies.length === 0) return null

    const cookies = setCookies
      .map(c => c.split(';')[0])
      .join('; ')

    return cookies || null
  } catch (err) {
    log.warning(`Failed to get session cookies: ${err}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Get a fresh proxy URL with new session ID (= new IP)
// ---------------------------------------------------------------------------

async function getFreshProxyUrl(currentProxyUrl: string): Promise<string | null> {
  try {
    const proxyConfig = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'] })
    return (await proxyConfig?.newUrl(`retry_${Date.now()}`)) ?? currentProxyUrl
  } catch {
    return currentProxyUrl
  }
}

// ---------------------------------------------------------------------------
// Fetch helper with optional proxy
// ---------------------------------------------------------------------------

async function fetchWithProxy(
  url: string,
  init: RequestInit,
  proxyUrl: string | null,
): Promise<Response> {
  if (proxyUrl) {
    const { ProxyAgent } = await import('undici')
    const agent = new ProxyAgent(proxyUrl)
    return fetch(url, { ...init, dispatcher: agent } as RequestInit)
  }
  return fetch(url, init)
}

// ---------------------------------------------------------------------------
// Instagram API response types
// ---------------------------------------------------------------------------

interface InstagramApiResponse {
  data?: {
    user?: {
      biography?: string
      edge_followed_by?: { count: number }
      edge_follow?: { count: number }
      edge_owner_to_timeline_media?: {
        count: number
        edges: {
          node: {
            shortcode: string
            taken_at_timestamp?: number
            is_video?: boolean
            edge_media_to_caption?: { edges: { node: { text: string } }[] }
            edge_liked_by?: { count: number }
            edge_media_preview_like?: { count: number }
            edge_media_to_comment?: { count: number }
          }
        }[]
      }
    }
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

/** Decode JSON string escapes like \n, \u00f3, \/ */
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
]

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}
