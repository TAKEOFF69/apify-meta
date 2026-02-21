import { log } from 'apify'
import type { CompetitorSocialResult, SocialPost } from './types.js'

type ProfileResult = Omit<CompetitorSocialResult, 'customer_slug' | 'name' | 'platform' | 'scraped_at'>

/**
 * Scrape a Facebook public page — focused on POST ENGAGEMENT data.
 *
 * Strategy cascade:
 * 1. Desktop HTML (www.facebook.com) — extract posts from embedded JSON blobs
 *    (creation_time, message text, reaction_count, comment_count, share_count)
 * 2. Mobile HTML (mbasic.facebook.com) — fallback for post text extraction
 *    when desktop JSON extraction fails
 *
 * The primary goal is recent_posts[] with per-post engagement.
 * Profile metrics (followers) are secondary.
 */
export async function scrapeFacebook(
  pageHandle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<ProfileResult> {
  // Strategy 1: Desktop page — rich JSON embedded in HTML
  const desktopResult = await tryDesktopPage(pageHandle, postsLimit, proxyUrl)

  // If we got posts with engagement, we're done
  if (desktopResult && desktopResult.recent_posts.length >= 2) {
    log.info(`    FB desktop: ${desktopResult.recent_posts.length} posts, ${desktopResult.followers ?? '?'} followers`)
    return desktopResult
  }

  // Strategy 2: mbasic — simpler HTML, more reliable post text extraction
  log.info(`    FB desktop gave ${desktopResult?.recent_posts.length ?? 0} posts, trying mbasic`)
  const mbasicResult = await tryMbasicPage(pageHandle, postsLimit, proxyUrl)

  // Merge: mbasic posts + desktop profile metrics
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

  // Return desktop result (even if few/no posts) — it at least has profile data
  return desktopResult ?? {
    followers: null, following: null, posts_count: null, bio: null,
    recent_posts: [], error: 'All Facebook strategies failed',
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: Desktop page (www.facebook.com) — JSON blob extraction
// ---------------------------------------------------------------------------

async function tryDesktopPage(
  pageHandle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<ProfileResult | null> {
  try {
    const url = `https://www.facebook.com/${pageHandle}/`

    const response = await fetchWithProxy(url, {
      headers: {
        'User-Agent': randomDesktopUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
    }, proxyUrl)

    if (!response.ok) {
      return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `HTTP ${response.status}` }
    }

    const html = await response.text()
    log.info(`    FB desktop: ${response.status}, HTML ${html.length} chars`)

    // Debug: what patterns exist in the HTML
    const hasOg = html.includes('og:description')
    const hasCreationTime = (html.match(/"creation_time"/g) || []).length
    const hasMessage = (html.match(/"message"\s*:\s*\{/g) || []).length
    const hasReactionCount = (html.match(/"reaction_count"/g) || []).length
    const hasFollowerCount = html.includes('follower_count') || html.includes('fan_count')
    log.info(`    FB desktop: og=${hasOg} creation_time=${hasCreationTime} messages=${hasMessage} reactions=${hasReactionCount} followerJson=${hasFollowerCount}`)

    // Check if we got a login redirect
    if (html.includes('login_form') || html.includes('/login/')) {
      log.warning('    FB desktop: got login page instead of public page')
    }

    // Extract posts from embedded JSON (primary goal)
    const posts = extractPostsFromDesktopJson(html, postsLimit)

    // Extract profile metrics
    const followers = extractFollowers(html)
    const bio = extractBio(html)

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
    return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: message }
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: mbasic page — simple HTML post extraction
// ---------------------------------------------------------------------------

async function tryMbasicPage(
  pageHandle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<ProfileResult | null> {
  try {
    const url = `https://mbasic.facebook.com/${pageHandle}/`

    const response = await fetchWithProxy(url, {
      headers: {
        // mbasic expects a basic mobile user agent
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
    }, proxyUrl)

    if (!response.ok) {
      return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `mbasic HTTP ${response.status}` }
    }

    const html = await response.text()
    log.info(`    FB mbasic: ${response.status}, HTML ${html.length} chars`)
    const hasStoryLinks = (html.match(/story\.php/g) || []).length
    const hasDataFt = (html.match(/data-ft/g) || []).length
    log.info(`    FB mbasic: storyLinks=${hasStoryLinks} dataFt=${hasDataFt}`)
    if (html.includes('login_form') || html.includes('/login/')) {
      log.warning('    FB mbasic: got login page')
    }

    const posts = extractPostsFromMbasic(html, postsLimit)
    const followers = extractMbasicFollowers(html)

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
    return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `mbasic: ${message}` }
  }
}

// ---------------------------------------------------------------------------
// Extract posts from desktop HTML embedded JSON
// ---------------------------------------------------------------------------

function extractPostsFromDesktopJson(html: string, limit: number): SocialPost[] {
  const posts: SocialPost[] = []
  const seen = new Set<string>()

  // --- Method A: Find "creation_time" anchors and extract nearby post data ---
  // Facebook embeds structured post data as JSON in <script> tags.
  // Pattern: "creation_time":1708300800 is a reliable anchor for posts.

  const creationTimePattern = /"creation_time"\s*:\s*(\d{10})/g
  let match: RegExpExecArray | null

  while ((match = creationTimePattern.exec(html)) !== null && posts.length < limit) {
    const timestamp = parseInt(match[1], 10)

    // Skip very old timestamps (more than 1 year) — likely not recent posts
    const ageInDays = (Date.now() / 1000 - timestamp) / 86400
    if (ageInDays > 365) continue

    const pos = match.index
    // Search in a wide window around the timestamp for post data
    const start = Math.max(0, pos - 3000)
    const end = Math.min(html.length, pos + 5000)
    const vicinity = html.slice(start, end)

    // Extract post message text
    const messageMatch = vicinity.match(/"message"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]
      ?? vicinity.match(/"text"\s*:\s*"((?:[^"\\]|\\[\s\S]){10,300})"/)?.[1]

    // Skip if no meaningful text (system posts, etc)
    if (!messageMatch || messageMatch.length < 5) continue

    const text = decodeJsonEscapes(messageMatch).slice(0, 300)

    // Deduplicate by content (first 50 chars)
    const dedupeKey = text.slice(0, 50)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    // Extract engagement data from vicinity
    const reactions = vicinity.match(/"reaction_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
      ?? vicinity.match(/"reactors"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)
      ?? vicinity.match(/"i18n_reaction_count"\s*:\s*"(\d+)/)
    const commentCount = vicinity.match(/"comment_count"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/)
      ?? vicinity.match(/"total_comment_count"\s*:\s*(\d+)/)
    const shareCount = vicinity.match(/"share_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/)

    // Try to find post URL
    const postUrl = vicinity.match(/"url"\s*:\s*"(https?:\\\/\\\/www\.facebook\.com\\\/[^"]+permalink[^"]+)"/)?.[1]
      ?? vicinity.match(/"url"\s*:\s*"(https?:\\\/\\\/www\.facebook\.com\\\/(?:photo|video|reel)[^"]+)"/)?.[1]

    // Detect media type
    const mediaType = vicinity.includes('"is_video":true') ? 'video'
      : vicinity.includes('"photo_image"') || vicinity.includes('"image"') ? 'image'
      : null

    const totalEngagement = (reactions ? parseInt(reactions[1], 10) : 0)
      + (commentCount ? parseInt(commentCount[1], 10) : 0)
      + (shareCount ? parseInt(shareCount[1], 10) : 0)

    posts.push({
      url: postUrl ? decodeJsonEscapes(postUrl) : '',
      caption_snippet: text,
      likes: reactions ? parseInt(reactions[1], 10) : null,
      comments: commentCount ? parseInt(commentCount[1], 10) : null,
      posted_at: new Date(timestamp * 1000).toISOString().split('T')[0],
      media_type: mediaType,
    })
  }

  // --- Method B: Find "message":{"text":"..."} if method A found few posts ---
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

  // Sort by date (newest first)
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

  // mbasic.facebook.com shows posts in <article> or <div> elements
  // Each post typically has:
  // - Text in a <p> or <div> element
  // - A "Full Story" link: <a href="/story.php?...">Full Story</a>
  // - Sometimes timestamp text like "2 hours ago" or "February 20 at 3:45 PM"

  // Strategy: Find "Full Story" links and extract surrounding text
  const storyLinkPattern = /href="(\/story\.php\?story_fbid=\d+&amp;id=\d+[^"]*)"/g
  let match: RegExpExecArray | null

  while ((match = storyLinkPattern.exec(html)) !== null && posts.length < limit) {
    const storyPath = decodeHtmlEntities(match[1])
    const pos = match.index

    // Look backwards for post text (within 2000 chars before the link)
    const textStart = Math.max(0, pos - 2000)
    const textRegion = html.slice(textStart, pos)

    // Extract text from the nearest <div> with content
    // mbasic wraps post text in simple divs/paragraphs
    const textMatch = textRegion.match(/<div[^>]*>([^<]{15,})<\/div>/g)
    if (!textMatch || textMatch.length === 0) continue

    // Take the last (nearest) text block before the story link
    const lastBlock = textMatch[textMatch.length - 1]
    const text = lastBlock.replace(/<[^>]+>/g, '').trim()

    if (text.length < 10) continue

    const dedupeKey = text.slice(0, 50)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    // Look for timestamp near the post
    const timeRegion = html.slice(textStart, Math.min(html.length, pos + 500))
    const dateMatch = timeRegion.match(/data-utime="(\d+)"/)
      ?? timeRegion.match(/<abbr[^>]*>([^<]+)<\/abbr>/)

    let postedAt: string | null = null
    if (dateMatch?.[1] && /^\d{10}$/.test(dateMatch[1])) {
      postedAt = new Date(parseInt(dateMatch[1], 10) * 1000).toISOString().split('T')[0]
    }

    // Look for reaction counts near the post
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

  // Alternative: look for article-like structures if story links not found
  if (posts.length === 0) {
    // mbasic sometimes uses different structures
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
        likes: null,
        comments: null,
        posted_at: null,
        media_type: null,
      })
    }
  }

  return posts
}

// ---------------------------------------------------------------------------
// Extract followers from mbasic HTML
// ---------------------------------------------------------------------------

function extractMbasicFollowers(html: string): number | null {
  // mbasic often shows "X people like this" or "X followers"
  const likeMatch = html.match(/([\d,.\s]+)\s*(?:people like this|osób lubi|people follow)/i)
  if (likeMatch) return parseCount(likeMatch[1])
  return null
}

// ---------------------------------------------------------------------------
// Extract follower count from desktop HTML
// ---------------------------------------------------------------------------

function extractFollowers(html: string): number | null {
  // Strategy 1: og:description
  const ogMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)
    ?? html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i)
  if (ogMatch) {
    const desc = decodeHtmlEntities(ogMatch[1])
    const plMatch = desc.match(/([\d\s,.]+)\s*(?:os[oó]b lubi|obserwuj[aą]cych|polubie[nń])/i)
    if (plMatch) return parseCount(plMatch[1])
    const enMatch = desc.match(/([\d\s,.]+)\s*(?:people like|followers|likes)/i)
    if (enMatch) return parseCount(enMatch[1])
  }

  // Strategy 2: meta description
  const metaDesc = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)
  if (metaDesc) {
    const desc = decodeHtmlEntities(metaDesc[1])
    const plMatch = desc.match(/([\d\s,.]+)\s*(?:os[oó]b lubi|obserwuj[aą]cych|polubie[nń])/i)
    if (plMatch) return parseCount(plMatch[1])
    const enMatch = desc.match(/([\d\s,.]+)\s*(?:people like|followers|likes)/i)
    if (enMatch) return parseCount(enMatch[1])
  }

  // Strategy 3: JSON blob in page source
  const followerJsonMatch = html.match(/"follower_count"\s*:\s*(\d+)/i)
    ?? html.match(/"followers_count"\s*:\s*(\d+)/i)
    ?? html.match(/"fan_count"\s*:\s*(\d+)/i)
  if (followerJsonMatch) return parseInt(followerJsonMatch[1], 10)

  return null
}

// ---------------------------------------------------------------------------
// Extract bio from desktop HTML
// ---------------------------------------------------------------------------

function extractBio(html: string): string | null {
  const ogMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)
    ?? html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i)
  if (ogMatch) {
    const desc = decodeHtmlEntities(ogMatch[1])
    const bioMatch = desc.match(/[-–—·.]\s*(.{10,})$/)
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

function randomDesktopUA(): string {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  ]
  return agents[Math.floor(Math.random() * agents.length)]
}
