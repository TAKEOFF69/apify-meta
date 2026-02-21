import { log } from 'apify'
import type { CompetitorSocialResult, SocialPost } from './types.js'

/**
 * Scrape a Facebook public page via HTTP fetch (no browser).
 *
 * Strategy:
 * 1. Fetch page HTML via residential proxy
 * 2. Extract og:description for follower/like counts
 * 3. Parse JSON-LD structured data for page info
 * 4. Extract recent posts from embedded data if available
 *
 * Facebook public pages are accessible without login.
 * Bandwidth: ~100-300 KB per request (vs 3-5 MB with Playwright).
 */
export async function scrapeFacebook(
  pageHandle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<Omit<CompetitorSocialResult, 'customer_slug' | 'name' | 'platform' | 'scraped_at'>> {
  const url = `https://www.facebook.com/${pageHandle}/`

  try {
    const headers: Record<string, string> = {
      'User-Agent': randomUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
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
      return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `HTTP ${response.status}` }
    }

    const html = await response.text()

    // Extract data from HTML
    const followers = extractFollowers(html)
    const bio = extractBio(html)
    const recentPosts = extractPostsFromHtml(html, postsLimit)

    return {
      followers,
      following: null, // FB pages don't expose "following" count
      posts_count: null, // Not reliably available in HTML
      bio,
      recent_posts: recentPosts,
      error: null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: message }
  }
}

// ---------------------------------------------------------------------------
// Follower extraction from HTML
// ---------------------------------------------------------------------------

function extractFollowers(html: string): number | null {
  // Strategy 1: og:description — "1,234 people like this" or Polish variant
  const ogMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)
    ?? html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i)
  if (ogMatch) {
    const desc = decodeHtmlEntities(ogMatch[1])

    // Polish: "92 525 osób lubi to" or "1 234 obserwujących"
    const plMatch = desc.match(/([\d\s,.]+)\s*(?:os[oó]b lubi|obserwuj[aą]cych|polubie[nń])/i)
    if (plMatch) return parseCount(plMatch[1])

    // English: "1,234 people like this" or "1,234 followers"
    const enMatch = desc.match(/([\d\s,.]+)\s*(?:people like|followers|likes)/i)
    if (enMatch) return parseCount(enMatch[1])
  }

  // Strategy 2: Look for follower count in page meta
  const metaDesc = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)
  if (metaDesc) {
    const desc = decodeHtmlEntities(metaDesc[1])
    const plMatch = desc.match(/([\d\s,.]+)\s*(?:os[oó]b lubi|obserwuj[aą]cych|polubie[nń])/i)
    if (plMatch) return parseCount(plMatch[1])
    const enMatch = desc.match(/([\d\s,.]+)\s*(?:people like|followers|likes)/i)
    if (enMatch) return parseCount(enMatch[1])
  }

  // Strategy 3: JSON blob in page source (Facebook embeds data as JSON)
  const followerJsonMatch = html.match(/"follower_count"\s*:\s*(\d+)/i)
    ?? html.match(/"followers_count"\s*:\s*(\d+)/i)
    ?? html.match(/"fan_count"\s*:\s*(\d+)/i)
  if (followerJsonMatch) return parseInt(followerJsonMatch[1], 10)

  return null
}

// ---------------------------------------------------------------------------
// Bio / About extraction
// ---------------------------------------------------------------------------

function extractBio(html: string): string | null {
  // og:description often has bio after the follower info
  const ogMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)
    ?? html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i)
  if (ogMatch) {
    const desc = decodeHtmlEntities(ogMatch[1])
    // Bio is typically after the stats portion, separated by dash, dot, or middle dot
    const bioMatch = desc.match(/[-–—·.]\s*(.{10,})$/)
    if (bioMatch) return bioMatch[1].trim().slice(0, 300)
  }

  // Try page title for basic info
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (titleMatch) {
    const title = decodeHtmlEntities(titleMatch[1]).replace(/\s*[-|]\s*Facebook.*$/i, '').trim()
    if (title.length > 5) return title.slice(0, 300)
  }

  return null
}

// ---------------------------------------------------------------------------
// Post extraction from embedded HTML data
// ---------------------------------------------------------------------------

function extractPostsFromHtml(html: string, limit: number): SocialPost[] {
  const posts: SocialPost[] = []

  // Facebook embeds post data as JSON blobs in the HTML
  const postPattern = /"message"\s*:\s*\{[^}]*"text"\s*:\s*"([^"]{10,300})"/g
  let match: RegExpExecArray | null
  let count = 0

  while ((match = postPattern.exec(html)) !== null && count < limit) {
    const text = decodeHtmlEntities(
      match[1]
        .replace(/\\n/g, ' ')
        .replace(/\\u[\da-fA-F]{4}/g, (m) => {
          try { return String.fromCodePoint(parseInt(m.slice(2), 16)) } catch { return '' }
        })
    ).trim()

    if (text.length < 10) continue

    posts.push({
      url: '',
      caption_snippet: text.slice(0, 300),
      likes: null,
      comments: null,
      posted_at: null,
      media_type: null,
    })
    count++
  }

  // Try to extract reaction counts from nearby JSON
  const reactionPattern = /"reaction_count"\s*:\s*\{[^}]*"count"\s*:\s*(\d+)/g
  let reactionIdx = 0
  while ((match = reactionPattern.exec(html)) !== null && reactionIdx < posts.length) {
    posts[reactionIdx].likes = parseInt(match[1], 10)
    reactionIdx++
  }

  return posts
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
}

function parseCount(text: string): number | null {
  const cleaned = text.trim().replace(/\s/g, '')
  const match = cleaned.match(/([\d,.]+)\s*([KkMm])?/)
  if (!match) return null

  let num = parseFloat(match[1].replace(',', '.'))
  if (isNaN(num)) return null

  const mult = match[2]?.toUpperCase()
  if (mult === 'K') num *= 1000
  if (mult === 'M') num *= 1_000_000

  return Math.round(num)
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
]

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}
