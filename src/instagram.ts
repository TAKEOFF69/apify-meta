import { log } from 'apify'
import type { CompetitorSocialResult, SocialPost } from './types.js'

/**
 * Scrape an Instagram public profile.
 *
 * Strategy (in order):
 * 1. Private REST API — full data (followers, posts with engagement)
 * 2. Web page HTML fallback — profile metrics from meta tags (no post engagement)
 *
 * Bandwidth: ~50-200 KB per request (vs 3-5 MB with Playwright).
 * Requires residential proxy to avoid blocking.
 */
export async function scrapeInstagram(
  handle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<Omit<CompetitorSocialResult, 'customer_slug' | 'name' | 'platform' | 'scraped_at'>> {
  const cleanHandle = handle.replace(/^@/, '')

  // Strategy 1: Try private API (returns full data including post engagement)
  const apiResult = await tryPrivateApi(cleanHandle, postsLimit, proxyUrl)
  if (apiResult && !apiResult.error) return apiResult

  // Strategy 2: Fallback to web page HTML parsing (profile metrics from meta tags)
  log.info(`    IG API returned ${apiResult?.error ?? 'unknown error'}, trying web fallback`)
  const webResult = await tryWebPageFallback(cleanHandle, proxyUrl)
  if (webResult && (webResult.followers !== null || webResult.bio !== null)) return webResult

  // Return API result (even if error) as it has more context
  return apiResult ?? { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: 'All strategies failed' }
}

// ---------------------------------------------------------------------------
// Strategy 1: Instagram private REST API
// ---------------------------------------------------------------------------

async function tryPrivateApi(
  handle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<Omit<CompetitorSocialResult, 'customer_slug' | 'name' | 'platform' | 'scraped_at'> | null> {
  try {
    // First, visit the main page to get session cookies
    const sessionCookies = await getSessionCookies(proxyUrl)

    const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`

    const headers: Record<string, string> = {
      'x-ig-app-id': '936619743392459',
      'User-Agent': randomUserAgent(),
      'Accept': '*/*',
      'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Origin': 'https://www.instagram.com',
      'Referer': `https://www.instagram.com/${handle}/`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    }

    if (sessionCookies) {
      headers['Cookie'] = sessionCookies
      // Extract csrftoken from cookies
      const csrfMatch = sessionCookies.match(/csrftoken=([^;]+)/)
      if (csrfMatch) headers['X-CSRFToken'] = csrfMatch[1]
    }

    let response: Response
    if (proxyUrl) {
      const { ProxyAgent } = await import('undici')
      const agent = new ProxyAgent(proxyUrl)
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30_000),
        dispatcher: agent,
      } as RequestInit)
    } else {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30_000),
      })
    }

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

    return { followers, following, posts_count: postsCount, bio, recent_posts: recentPosts, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: message }
  }
}

// ---------------------------------------------------------------------------
// Get session cookies from Instagram home page
// ---------------------------------------------------------------------------

async function getSessionCookies(proxyUrl: string | null): Promise<string | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': randomUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
    }

    let response: Response
    if (proxyUrl) {
      const { ProxyAgent } = await import('undici')
      const agent = new ProxyAgent(proxyUrl)
      response = await fetch('https://www.instagram.com/', {
        headers,
        signal: AbortSignal.timeout(15_000),
        redirect: 'follow',
        dispatcher: agent,
      } as RequestInit)
    } else {
      response = await fetch('https://www.instagram.com/', {
        headers,
        signal: AbortSignal.timeout(15_000),
        redirect: 'follow',
      })
    }

    // Extract Set-Cookie headers
    const setCookies = response.headers.getSetCookie?.() ?? []
    if (setCookies.length === 0) return null

    // Build cookie string from Set-Cookie headers
    const cookies = setCookies
      .map(c => c.split(';')[0]) // Take name=value part only
      .join('; ')

    return cookies || null
  } catch (err) {
    log.warning(`Failed to get session cookies: ${err}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: Web page HTML fallback (meta tags)
// ---------------------------------------------------------------------------

async function tryWebPageFallback(
  handle: string,
  proxyUrl: string | null,
): Promise<Omit<CompetitorSocialResult, 'customer_slug' | 'name' | 'platform' | 'scraped_at'> | null> {
  try {
    const url = `https://www.instagram.com/${handle}/`

    // Use English locale — IG meta description has follower counts in English format
    // Polish locale returns "zobacz zdjęcia..." without numbers
    const headers: Record<string, string> = {
      'User-Agent': randomUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    }

    let response: Response
    if (proxyUrl) {
      const { ProxyAgent } = await import('undici')
      const agent = new ProxyAgent(proxyUrl)
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
        dispatcher: agent,
      } as RequestInit)
    } else {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
      })
    }

    if (!response.ok) {
      return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `Web fallback HTTP ${response.status}` }
    }

    const html = await response.text()

    // Parse og:description: "1,234 Followers, 567 Following, 89 Posts - Bio text here"
    const ogMatch = html.match(/<meta\s+(?:property="og:description"\s+content="([^"]+)"|content="([^"]+)"\s+property="og:description")/i)
    const descMatch = html.match(/<meta\s+(?:name="description"\s+content="([^"]+)"|content="([^"]+)"\s+name="description")/i)
    const desc = ogMatch?.[1] ?? ogMatch?.[2] ?? descMatch?.[1] ?? descMatch?.[2]

    if (!desc) {
      return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: 'No meta description in page HTML' }
    }

    const decoded = decodeHtmlEntities(desc)

    // Parse "1,234 Followers, 567 Following, 89 Posts - Bio"
    const followersMatch = decoded.match(/([\d,.\s]+)\s*(?:Followers|obserwuj[aą]cych|follower)/i)
    const followingMatch = decoded.match(/([\d,.\s]+)\s*(?:Following|obserwowanych)/i)
    const postsMatch = decoded.match(/([\d,.\s]+)\s*(?:Posts|post[oó]w|post)/i)
    const bioMatch = decoded.match(/[-–—]\s*(.+)$/)

    return {
      followers: followersMatch ? parseCount(followersMatch[1]) : null,
      following: followingMatch ? parseCount(followingMatch[1]) : null,
      posts_count: postsMatch ? parseCount(postsMatch[1]) : null,
      bio: bioMatch ? bioMatch[1].trim().slice(0, 300) : null,
      recent_posts: [], // No post engagement data from HTML
      error: null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `Web fallback: ${message}` }
  }
}

// ---------------------------------------------------------------------------
// Instagram API response types (partial — only what we use)
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

function parseCount(text: string): number | null {
  const cleaned = text.trim().replace(/\s/g, '')
  const multiplierMatch = cleaned.match(/([\d,.]+)\s*([KkMm])?/)
  if (!multiplierMatch) return null

  let num = parseFloat(multiplierMatch[1].replace(',', '.'))
  if (isNaN(num)) return null

  const multiplier = multiplierMatch[2]?.toUpperCase()
  if (multiplier === 'K') num *= 1000
  if (multiplier === 'M') num *= 1_000_000

  return Math.round(num)
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
