import type { Browser } from 'playwright'
import type { CompetitorSocialResult, SocialPost } from './types.js'

/**
 * Scrape an Instagram public profile for followers, post count, and recent posts.
 *
 * Strategy:
 * 1. Navigate to profile page with residential proxy
 * 2. Try extracting structured data from page's embedded JSON
 * 3. Fallback to meta tags + DOM parsing
 * 4. Extract recent posts from the grid
 */
export async function scrapeInstagram(
  browser: Browser,
  handle: string,
  postsLimit: number,
): Promise<Omit<CompetitorSocialResult, 'customer_slug' | 'name' | 'platform' | 'scraped_at'>> {
  // Normalize handle — strip @ prefix
  const cleanHandle = handle.replace(/^@/, '')
  const url = `https://www.instagram.com/${cleanHandle}/`

  const context = await browser.newContext({
    userAgent: randomUserAgent(),
    viewport: { width: 1280, height: 900 },
    locale: 'pl-PL',
  })
  const page = await context.newPage()

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    if (!response || response.status() >= 400) {
      return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `HTTP ${response?.status() ?? 'no response'}` }
    }

    // Wait for content to render
    await page.waitForTimeout(2000)

    // Strategy 1: Try to extract from embedded JSON (meta tags or script tags)
    const profileData = await extractFromMeta(page)

    // Strategy 2: DOM parsing fallback
    const domData = profileData.followers === null ? await extractFromDom(page) : null

    const followers = profileData.followers ?? domData?.followers ?? null
    const following = profileData.following ?? domData?.following ?? null
    const postsCount = profileData.postsCount ?? domData?.postsCount ?? null
    const bio = profileData.bio ?? domData?.bio ?? null

    // Extract recent posts from grid
    const recentPosts = await extractPosts(page, postsLimit)

    return { followers, following, posts_count: postsCount, bio, recent_posts: recentPosts, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: message }
  } finally {
    await context.close()
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: Meta tags + og:description parsing
// ---------------------------------------------------------------------------

interface ProfileMeta {
  followers: number | null
  following: number | null
  postsCount: number | null
  bio: string | null
}

async function extractFromMeta(page: import('playwright').Page): Promise<ProfileMeta> {
  try {
    // og:description often contains "X Followers, Y Following, Z Posts - ..."
    const ogDesc = await page.getAttribute('meta[property="og:description"]', 'content')
    if (ogDesc) {
      const parsed = parseOgDescription(ogDesc)
      if (parsed.followers !== null) return parsed
    }

    // Try description meta tag
    const desc = await page.getAttribute('meta[name="description"]', 'content')
    if (desc) {
      return parseOgDescription(desc)
    }
  } catch {
    // Ignore — fallback to DOM
  }
  return { followers: null, following: null, postsCount: null, bio: null }
}

/**
 * Parse Instagram's og:description format:
 * "1,234 Followers, 567 Following, 89 Posts - Bio text here"
 * or Polish: "1 234 obserwujących, 567 obserwowanych, 89 postów"
 */
function parseOgDescription(text: string): ProfileMeta {
  const result: ProfileMeta = { followers: null, following: null, postsCount: null, bio: null }

  // Extract followers
  const followersMatch = text.match(/([\d,.\s]+)\s*(?:Followers|obserwujących|follower)/i)
  if (followersMatch) result.followers = parseCount(followersMatch[1])

  // Extract following
  const followingMatch = text.match(/([\d,.\s]+)\s*(?:Following|obserwowanych)/i)
  if (followingMatch) result.following = parseCount(followingMatch[1])

  // Extract posts count
  const postsMatch = text.match(/([\d,.\s]+)\s*(?:Posts|postów|post)/i)
  if (postsMatch) result.postsCount = parseCount(postsMatch[1])

  // Extract bio (after the dash separator)
  const bioMatch = text.match(/[-–—]\s*(.+)$/)
  if (bioMatch) result.bio = bioMatch[1].trim().slice(0, 300)

  return result
}

// ---------------------------------------------------------------------------
// Strategy 2: DOM parsing
// ---------------------------------------------------------------------------

async function extractFromDom(page: import('playwright').Page): Promise<ProfileMeta> {
  try {
    // Instagram renders follower counts in various selectors depending on version
    // Try common patterns
    const statsText = await page.evaluate(() => {
      // Look for the stats section (followers/following/posts)
      const headerSection = document.querySelector('header section')
      if (!headerSection) return null

      // Get all list items in the header that typically contain stats
      const items = headerSection.querySelectorAll('li, span[title]')
      const texts: string[] = []
      items.forEach((item) => {
        const text = item.textContent?.trim()
        if (text) texts.push(text)
      })
      return texts.join(' | ')
    })

    if (!statsText) return { followers: null, following: null, postsCount: null, bio: null }

    // Try to parse numbers from stats text
    const numbers = statsText.match(/[\d,.\s]+/g)?.map(parseCount).filter((n) => n !== null) ?? []

    // Bio from header
    const bio = await page.evaluate(() => {
      const bioEl = document.querySelector('header section div.-vDIg span, header section div span[dir="auto"]')
      return bioEl?.textContent?.trim()?.slice(0, 300) ?? null
    })

    // Instagram typically shows: posts | followers | following (in that order)
    return {
      postsCount: numbers[0] ?? null,
      followers: numbers[1] ?? null,
      following: numbers[2] ?? null,
      bio,
    }
  } catch {
    return { followers: null, following: null, postsCount: null, bio: null }
  }
}

// ---------------------------------------------------------------------------
// Post extraction from grid
// ---------------------------------------------------------------------------

async function extractPosts(page: import('playwright').Page, limit: number): Promise<SocialPost[]> {
  try {
    const posts = await page.evaluate((lim: number) => {
      const results: { url: string; caption: string; likes: string | null; type: string | null }[] = []

      // Posts are typically in article or div[role="presentation"] links
      const postLinks = document.querySelectorAll('article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]')

      for (const link of postLinks) {
        if (results.length >= lim) break
        const href = (link as HTMLAnchorElement).href
        if (!href) continue

        // Try to get alt text (Instagram puts captions in img alt)
        const img = link.querySelector('img')
        const caption = img?.alt ?? ''

        // Try to find likes text in parent
        const parent = link.closest('article') ?? link.parentElement
        const likesEl = parent?.querySelector('span[class*="like"], button[class*="like"] span')
        const likesText = likesEl?.textContent ?? null

        // Detect media type from the element
        const hasVideo = !!link.querySelector('svg[aria-label*="Reel"], svg[aria-label*="Video"], span[class*="reel"]')
        const type = hasVideo ? 'video' : 'image'

        results.push({ url: href, caption: caption.slice(0, 300), likes: likesText, type })
      }
      return results
    }, limit)

    return posts.map((p) => ({
      url: p.url,
      caption_snippet: p.caption,
      likes: p.likes ? parseCount(p.likes) : null,
      comments: null, // Not reliably extractable from grid view
      posted_at: null, // Not reliably extractable from grid view
      media_type: p.type,
    }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCount(text: string): number | null {
  // Handle formats: "1,234" | "1.234" | "1 234" | "12.5K" | "1.2M"
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
