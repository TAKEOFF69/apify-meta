import type { Browser } from 'playwright'
import type { CompetitorSocialResult, SocialPost } from './types.js'

/**
 * Scrape a Facebook public page for followers, post count, and recent posts.
 *
 * Strategy:
 * 1. Navigate to the page URL
 * 2. Extract page info (name, followers, category) from visible DOM
 * 3. Scroll down to load recent posts
 * 4. Extract post text, reactions, comments, shares from visible cards
 *
 * Facebook public pages are accessible without login.
 * Datacenter proxies typically work (FB is less aggressive than IG).
 */
export async function scrapeFacebook(
  browser: Browser,
  pageHandle: string,
  postsLimit: number,
): Promise<Omit<CompetitorSocialResult, 'customer_slug' | 'name' | 'platform' | 'scraped_at'>> {
  const url = `https://www.facebook.com/${pageHandle}/`

  const context = await browser.newContext({
    userAgent: randomUserAgent(),
    viewport: { width: 1280, height: 900 },
    locale: 'pl-PL',
  })
  const page = await context.newPage()

  try {
    // Block heavy resources to speed up loading
    await page.route('**/*.{mp4,webm,ogg,avi}', (route) => route.abort())
    await page.route('**/video/**', (route) => route.abort())

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    if (!response || response.status() >= 400) {
      return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `HTTP ${response?.status() ?? 'no response'}` }
    }

    // Handle cookie consent popup (common in EU)
    await dismissCookiePopup(page)

    // Wait for content to render
    await page.waitForTimeout(3000)

    // Extract page info
    const pageInfo = await extractPageInfo(page)

    // Scroll to load posts
    await scrollForPosts(page, 3) // 3 scroll attempts

    // Extract posts
    const recentPosts = await extractPosts(page, postsLimit)

    return {
      followers: pageInfo.followers,
      following: null, // FB pages don't show "following" count
      posts_count: null, // Not easily available on page profiles
      bio: pageInfo.bio,
      recent_posts: recentPosts,
      error: null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: message }
  } finally {
    await context.close()
  }
}

// ---------------------------------------------------------------------------
// Cookie popup dismissal
// ---------------------------------------------------------------------------

async function dismissCookiePopup(page: import('playwright').Page): Promise<void> {
  try {
    // Facebook shows various cookie consent buttons
    const selectors = [
      'button[data-cookiebanner="accept_button"]',
      'button[title="Allow all cookies"]',
      'button[title="Zezwól na wszystkie pliki cookie"]',
      'div[role="dialog"] button:has-text("Allow")',
      'div[role="dialog"] button:has-text("Zezwól")',
    ]
    for (const sel of selectors) {
      const btn = await page.$(sel)
      if (btn) {
        await btn.click()
        await page.waitForTimeout(1000)
        return
      }
    }
  } catch {
    // Ignore — popup may not exist
  }
}

// ---------------------------------------------------------------------------
// Page info extraction
// ---------------------------------------------------------------------------

interface PageInfo {
  followers: number | null
  bio: string | null
}

async function extractPageInfo(page: import('playwright').Page): Promise<PageInfo> {
  try {
    const data = await page.evaluate(() => {
      let followers: string | null = null
      let bio: string | null = null

      // Look for follower count — FB shows it in various formats
      // Common patterns: "1,234 people like this" / "1 234 osób lubi to"
      // or "1,234 followers" / "1 234 obserwujących"
      const allText = document.body.innerText

      // Try Polish format first
      const plFollowers = allText.match(/([\d\s,.]+)\s*(?:obserwujących|osób lubi|osób to lubi|polubień)/i)
      if (plFollowers) followers = plFollowers[1]

      // English fallback
      if (!followers) {
        const enFollowers = allText.match(/([\d\s,.]+)\s*(?:followers|people like|likes)/i)
        if (enFollowers) followers = enFollowers[1]
      }

      // Bio / About text — typically in a span/div near the top
      const aboutSection = document.querySelector('[data-pagelet="ProfileTilesFeed_0"]')
        ?? document.querySelector('div[class*="about"]')
      if (aboutSection) {
        bio = aboutSection.textContent?.trim()?.slice(0, 300) ?? null
      }

      return { followers, bio }
    })

    return {
      followers: data.followers ? parseCount(data.followers) : null,
      bio: data.bio,
    }
  } catch {
    return { followers: null, bio: null }
  }
}

// ---------------------------------------------------------------------------
// Scroll to load posts
// ---------------------------------------------------------------------------

async function scrollForPosts(page: import('playwright').Page, scrollCount: number): Promise<void> {
  for (let i = 0; i < scrollCount; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5))
    await page.waitForTimeout(1500 + Math.random() * 1000)
  }
}

// ---------------------------------------------------------------------------
// Post extraction
// ---------------------------------------------------------------------------

async function extractPosts(page: import('playwright').Page, limit: number): Promise<SocialPost[]> {
  try {
    const rawPosts = await page.evaluate((lim: number) => {
      const results: { text: string; reactions: string | null; comments: string | null; shares: string | null; url: string | null; time: string | null }[] = []

      // Facebook posts are typically in div[role="article"] or similar
      const articles = document.querySelectorAll('div[role="article"], div[data-pagelet*="FeedUnit"]')

      for (const article of articles) {
        if (results.length >= lim) break

        // Post text — look for the main text content
        const textEl = article.querySelector('div[data-ad-preview="message"], div[dir="auto"]')
        const text = textEl?.textContent?.trim() ?? ''
        if (!text || text.length < 10) continue // Skip empty/tiny posts

        // Reactions count (likes + other reactions)
        const reactionsEl = article.querySelector('span[class*="reaction"], div[aria-label*="reaction"], span[aria-label*="reakcj"]')
        const reactions = reactionsEl?.textContent ?? reactionsEl?.getAttribute('aria-label') ?? null

        // Comments count
        const commentsEl = article.querySelector('span:has-text("comment"), span:has-text("komentarz")')
        const comments = commentsEl?.textContent ?? null

        // Shares count
        const sharesEl = article.querySelector('span:has-text("share"), span:has-text("udostępni")')
        const shares = sharesEl?.textContent ?? null

        // Post URL — look for timestamp link
        const linkEl = article.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[role="link"][tabindex="0"]')
        const url = (linkEl as HTMLAnchorElement)?.href ?? null

        // Timestamp
        const timeEl = article.querySelector('abbr[data-utime], span[id*="jsc_c"] a, a[role="link"] span')
        const time = timeEl?.textContent ?? null

        results.push({ text: text.slice(0, 300), reactions, comments, shares, url, time })
      }
      return results
    }, limit)

    return rawPosts.map((p) => ({
      url: p.url ?? '',
      caption_snippet: p.text,
      likes: p.reactions ? extractNumber(p.reactions) : null,
      comments: p.comments ? extractNumber(p.comments) : null,
      posted_at: p.time,
      media_type: null,
    }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function extractNumber(text: string): number | null {
  const match = text.match(/([\d,.\s]+)/)
  if (!match) return null
  return parseCount(match[1])
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
]

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}
