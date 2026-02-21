import { log } from 'apify'
import { Impit } from 'impit'
import type { CompetitorSocialResult, SocialPost } from './types.js'

type ProfileResult = Omit<CompetitorSocialResult, 'customer_slug' | 'name' | 'platform' | 'scraped_at'>

const IG_APP_ID = '936619743392459'

/**
 * Scrape an Instagram public profile using IMPIT (Rust TLS impersonation).
 *
 * Strategy cascade:
 * 1. REST API (/api/v1/users/web_profile_info/) — JSON with profile + posts + engagement
 * 2. Web HTML (instagram.com/{handle}/) — extract from embedded JSON / meta tags
 *
 * IMPIT impersonates Chrome's exact TLS fingerprint at the Rust level,
 * so Meta serves SSR content instead of JS-only shells.
 */
export async function scrapeInstagram(
  handle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<ProfileResult> {
  const cleanHandle = handle.replace(/^@/, '')

  // Strategy 1: REST API (structured JSON, ~50KB)
  const apiResult = await tryRestApi(cleanHandle, postsLimit, proxyUrl)
  if (apiResult && apiResult.recent_posts.length > 0) {
    log.info(`    IG API: ${apiResult.followers ?? '?'} followers, ${apiResult.recent_posts.length} posts`)
    return apiResult
  }

  // Strategy 2: Web page HTML with embedded JSON
  log.info(`    IG API gave ${apiResult?.recent_posts.length ?? 0} posts (${apiResult?.error ?? 'no error'}), trying web HTML`)
  const webResult = await tryWebHtml(cleanHandle, postsLimit, proxyUrl)
  if (webResult && (webResult.recent_posts.length > 0 || webResult.followers !== null)) {
    log.info(`    IG web: ${webResult.followers ?? '?'} followers, ${webResult.recent_posts.length} posts`)
    return webResult
  }

  return apiResult ?? webResult ?? {
    followers: null, following: null, posts_count: null, bio: null,
    recent_posts: [], error: 'All Instagram strategies failed',
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: Instagram REST API
// ---------------------------------------------------------------------------

async function tryRestApi(
  handle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<ProfileResult | null> {
  try {
    const impit = new Impit({ browser: 'chrome', proxyUrl: proxyUrl ?? undefined })

    const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    const resp = await impit.fetch(url, {
      signal: controller.signal,
      headers: {
        'x-ig-app-id': IG_APP_ID,
        'x-requested-with': 'XMLHttpRequest',
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'referer': `https://www.instagram.com/${handle}/`,
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
      log.info(`    IG API: Non-200 status ${resp.status}`)
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
// Strategy 2: Web HTML (embedded JSON extraction)
// ---------------------------------------------------------------------------

async function tryWebHtml(
  handle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<ProfileResult | null> {
  try {
    const impit = new Impit({ browser: 'chrome', proxyUrl: proxyUrl ?? undefined })

    const url = `https://www.instagram.com/${handle}/`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    const resp = await impit.fetch(url, {
      signal: controller.signal,
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9,pl;q=0.8',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
      },
    })
    clearTimeout(timeout)

    if (resp.status !== 200) {
      log.info(`    IG web: HTTP ${resp.status}`)
      return null
    }

    const html = await resp.text()

    // Debug: what kind of page did we get?
    const titleMatch = html.match(/<title[^>]*>([^<]{0,200})<\/title>/i)
    const title = titleMatch ? titleMatch[1].trim() : '(no title)'
    const hasMetaTags = html.includes('og:description')
    const hasShortcodes = html.includes('"shortcode"')
    const hasEdgeMedia = html.includes('edge_owner_to_timeline_media')
    log.info(`    IG web: ${html.length} chars, title="${title}" meta=${hasMetaTags} shortcodes=${hasShortcodes} edgeMedia=${hasEdgeMedia}`)

    // Extract profile from meta tags (most reliable when SSR content is present)
    const metaProfile = extractProfileFromMetaTags(html)
    let { followers, following, postsCount, bio } = metaProfile

    // Try embedded JSON (more accurate when available)
    const jsonProfile = extractProfileFromJson(html)
    followers = jsonProfile.followers ?? followers
    following = jsonProfile.following ?? following
    postsCount = jsonProfile.postsCount ?? postsCount
    bio = jsonProfile.bio ?? bio

    // Extract posts from embedded JSON
    const posts = extractPostsFromJson(html, postsLimit)

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
    log.warning(`    IG web error: ${message}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Extract posts from embedded JSON in page HTML
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
