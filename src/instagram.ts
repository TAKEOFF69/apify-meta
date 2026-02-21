import { log } from 'apify'
import { Impit } from 'impit'
import type { CompetitorSocialResult, SocialPost } from './types.js'

type ProfileResult = Omit<CompetitorSocialResult, 'customer_slug' | 'name' | 'platform' | 'scraped_at'>

const IG_APP_ID = '936619743392459'

/**
 * Scrape an Instagram public profile using IMPIT (Rust TLS impersonation).
 *
 * Strategy:
 * 1. Visit the IG web page to bootstrap a session (get cookies: csrftoken, mid, ig_did)
 * 2. Use those cookies to call the REST API for structured profile + post data
 * 3. If API fails, fall back to extracting from the web page HTML
 *
 * Session bootstrapping is required because Meta returns 404 from the API
 * and JS-only shells from the web page without proper session cookies.
 */
export async function scrapeInstagram(
  handle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<ProfileResult> {
  const cleanHandle = handle.replace(/^@/, '')
  const impit = new Impit({ browser: 'chrome', proxyUrl: proxyUrl ?? undefined })

  // Step 1: Bootstrap session by visiting the profile page
  const { cookies, html } = await bootstrapSession(impit, cleanHandle)
  log.info(`    IG session: ${cookies.length} cookies captured`)

  // Step 2: Try REST API with session cookies
  if (cookies.length > 0) {
    const apiResult = await tryRestApi(impit, cleanHandle, postsLimit, cookies)
    if (apiResult && apiResult.recent_posts.length > 0) {
      log.info(`    IG API: ${apiResult.followers ?? '?'} followers, ${apiResult.recent_posts.length} posts`)
      return apiResult
    }
    log.info(`    IG API gave ${apiResult?.recent_posts.length ?? 0} posts, trying HTML extraction`)
  }

  // Step 3: Extract from the web page HTML we already have
  if (html) {
    const webResult = extractFromHtml(html, postsLimit)
    if (webResult.recent_posts.length > 0 || webResult.followers !== null) {
      log.info(`    IG web: ${webResult.followers ?? '?'} followers, ${webResult.recent_posts.length} posts`)
      return webResult
    }
  }

  return {
    followers: null, following: null, posts_count: null, bio: null,
    recent_posts: [], error: 'All Instagram strategies failed',
  }
}

// ---------------------------------------------------------------------------
// Session bootstrapping — visit web page to capture cookies
// ---------------------------------------------------------------------------

async function bootstrapSession(
  impit: Impit,
  handle: string,
): Promise<{ cookies: string; html: string | null }> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    const resp = await impit.fetch(`https://www.instagram.com/${handle}/`, {
      signal: controller.signal,
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'max-age=0',
        'sec-ch-ua': '"Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
      },
    })
    clearTimeout(timeout)

    // Extract cookies from response headers
    const cookies = extractCookies(resp.headers)
    log.info(`    IG bootstrap: HTTP ${resp.status}, cookies: ${cookies ? cookies.split(';').map(c => c.trim().split('=')[0]).join(', ') : 'none'}`)

    let html: string | null = null
    if (resp.status === 200) {
      html = await resp.text()
      const titleMatch = html.match(/<title[^>]*>([^<]{0,200})<\/title>/i)
      const title = titleMatch ? titleMatch[1].trim() : '(no title)'
      const hasMetaTags = html.includes('og:description')
      const hasShortcodes = html.includes('"shortcode"')
      log.info(`    IG bootstrap: ${html.length} chars, title="${title}" meta=${hasMetaTags} shortcodes=${hasShortcodes}`)
    }

    return { cookies, html }
  } catch (err) {
    log.warning(`    IG bootstrap error: ${err instanceof Error ? err.message : String(err)}`)
    return { cookies: '', html: null }
  }
}

// ---------------------------------------------------------------------------
// Extract cookies from response headers
// ---------------------------------------------------------------------------

function extractCookies(headers: any): string {
  const cookies: string[] = []

  // Try getSetCookie() (standard Headers API)
  if (typeof headers?.getSetCookie === 'function') {
    const setCookies = headers.getSetCookie()
    for (const cookie of setCookies) {
      const nameValue = cookie.split(';')[0]
      if (nameValue) cookies.push(nameValue)
    }
  }

  // Try get('set-cookie') — may return comma-joined or single
  if (cookies.length === 0 && typeof headers?.get === 'function') {
    const raw = headers.get('set-cookie')
    if (raw) {
      // set-cookie headers may be comma-separated
      for (const part of raw.split(/,(?=\s*\w+=)/)) {
        const nameValue = part.split(';')[0].trim()
        if (nameValue && nameValue.includes('=')) cookies.push(nameValue)
      }
    }
  }

  // Try iterating entries
  if (cookies.length === 0 && typeof headers?.entries === 'function') {
    for (const [key, value] of headers.entries()) {
      if (key.toLowerCase() === 'set-cookie') {
        const nameValue = value.split(';')[0]
        if (nameValue) cookies.push(nameValue)
      }
    }
  }

  // Try raw() method (Node.js undici)
  if (cookies.length === 0 && typeof headers?.raw === 'function') {
    const raw = headers.raw()
    const setCookie = raw['set-cookie'] ?? raw['Set-Cookie'] ?? []
    for (const c of setCookie) {
      const nameValue = c.split(';')[0]
      if (nameValue) cookies.push(nameValue)
    }
  }

  // Debug: log header keys available
  if (cookies.length === 0) {
    const keys: string[] = []
    if (typeof headers?.forEach === 'function') {
      headers.forEach((_v: string, k: string) => keys.push(k))
    } else if (typeof headers?.entries === 'function') {
      for (const [k] of headers.entries()) keys.push(k)
    }
    log.info(`    Cookie extraction: 0 cookies. Header keys: ${keys.join(', ') || 'none'}`)
    log.info(`    Headers type: ${typeof headers}, constructor: ${headers?.constructor?.name}`)
    if (typeof headers?.get === 'function') {
      log.info(`    set-cookie header: ${headers.get('set-cookie')?.slice(0, 200) ?? 'null'}`)
    }
  }

  return cookies.join('; ')
}

// ---------------------------------------------------------------------------
// REST API with session cookies
// ---------------------------------------------------------------------------

async function tryRestApi(
  impit: Impit,
  handle: string,
  postsLimit: number,
  cookies: string,
): Promise<ProfileResult | null> {
  try {
    const csrfMatch = cookies.match(/csrftoken=([^;]+)/)
    const csrfToken = csrfMatch?.[1] ?? ''

    const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    const resp = await impit.fetch(url, {
      signal: controller.signal,
      headers: {
        'cookie': cookies,
        'x-csrftoken': csrfToken,
        'x-ig-app-id': IG_APP_ID,
        'x-ig-www-claim': '0',
        'x-requested-with': 'XMLHttpRequest',
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'referer': `https://www.instagram.com/${handle}/`,
        'sec-ch-ua': '"Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
      },
    })
    clearTimeout(timeout)

    log.info(`    IG API: HTTP ${resp.status}`)

    if (resp.status === 429) {
      log.warning('    IG API: Rate limited (429)')
      return null
    }

    if (resp.status !== 200) {
      const body = await resp.text().catch(() => '')
      log.info(`    IG API: Non-200 (${resp.status}), body preview: ${body.slice(0, 200)}`)
      return null
    }

    const json = await resp.json() as any
    const user = json?.data?.user ?? json?.user
    if (!user) {
      log.info('    IG API: No user object in response')
      return null
    }

    const followers = user.edge_followed_by?.count ?? user.follower_count ?? null
    const following = user.edge_follow?.count ?? user.following_count ?? null
    const postsCount = user.edge_owner_to_timeline_media?.count ?? user.media_count ?? null
    const bio = user.biography ?? null

    // Extract posts with engagement data
    const posts: SocialPost[] = []
    const edges = user.edge_owner_to_timeline_media?.edges ?? []

    for (const edge of edges.slice(0, postsLimit)) {
      const node = edge.node
      if (!node) continue

      const captionEdges = node.edge_media_to_caption?.edges ?? []
      const caption = captionEdges[0]?.node?.text ?? ''

      posts.push({
        url: `https://www.instagram.com/p/${node.shortcode}/`,
        caption_snippet: caption.slice(0, 300),
        likes: node.edge_liked_by?.count ?? node.edge_media_preview_like?.count ?? node.like_count ?? null,
        comments: node.edge_media_to_comment?.count ?? node.comment_count ?? null,
        posted_at: node.taken_at_timestamp
          ? new Date(node.taken_at_timestamp * 1000).toISOString().split('T')[0]
          : null,
        media_type: node.is_video ? 'video' : 'image',
      })
    }

    return {
      followers,
      following,
      posts_count: postsCount,
      bio: bio?.slice(0, 300) ?? null,
      recent_posts: posts,
      error: null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warning(`    IG API error: ${message}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Extract from web page HTML (already fetched during bootstrap)
// ---------------------------------------------------------------------------

function extractFromHtml(html: string, postsLimit: number): ProfileResult {
  const metaProfile = extractProfileFromMetaTags(html)
  const jsonProfile = extractProfileFromJson(html)

  const followers = jsonProfile.followers ?? metaProfile.followers
  const following = jsonProfile.following ?? metaProfile.following
  const postsCount = jsonProfile.postsCount ?? metaProfile.postsCount
  const bio = jsonProfile.bio ?? metaProfile.bio

  const posts = extractPostsFromJson(html, postsLimit)

  return {
    followers,
    following,
    posts_count: postsCount,
    bio,
    recent_posts: posts,
    error: posts.length === 0 && followers === null ? 'Could not extract data from profile page' : null,
  }
}

// ---------------------------------------------------------------------------
// Extract posts from embedded JSON
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
// Profile extraction from meta tags / embedded JSON
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
