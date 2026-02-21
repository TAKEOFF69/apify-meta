import { log } from 'apify'
import type { CompetitorSocialResult, SocialPost } from './types.js'

/**
 * Scrape an Instagram public profile using Instagram's private REST API.
 *
 * Endpoint: GET https://i.instagram.com/api/v1/users/web_profile_info/?username={handle}
 * Header:   x-ig-app-id: 936619743392459
 *
 * Returns profile JSON with followers, following, posts count, bio,
 * and recent ~12 posts with like/comment counts.
 *
 * Bandwidth: ~50-100 KB per request (vs 3-5 MB with Playwright).
 * Requires residential proxy to avoid blocking.
 */
export async function scrapeInstagram(
  handle: string,
  postsLimit: number,
  proxyUrl: string | null,
): Promise<Omit<CompetitorSocialResult, 'customer_slug' | 'name' | 'platform' | 'scraped_at'>> {
  const cleanHandle = handle.replace(/^@/, '')

  try {
    const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(cleanHandle)}`

    const headers: Record<string, string> = {
      'x-ig-app-id': '936619743392459',
      'User-Agent': randomUserAgent(),
      'Accept': '*/*',
      'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Origin': 'https://www.instagram.com',
      'Referer': 'https://www.instagram.com/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    }

    // Use Apify's proxy via global agent or fetch option
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      headers,
      signal: AbortSignal.timeout(30_000),
    }

    // If proxy is available, use undici ProxyAgent
    let response: Response
    if (proxyUrl) {
      const { ProxyAgent } = await import('undici')
      const agent = new ProxyAgent(proxyUrl)
      response = await fetch(url, { ...fetchOptions, dispatcher: agent } as RequestInit)
    } else {
      response = await fetch(url, fetchOptions)
    }

    if (!response.ok) {
      const status = response.status
      if (status === 404) {
        return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `Profile not found: @${cleanHandle}` }
      }
      if (status === 401 || status === 403) {
        return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `Blocked by Instagram (HTTP ${status}) — may need proxy rotation` }
      }
      return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: `HTTP ${status}` }
    }

    const data = await response.json() as InstagramApiResponse
    const user = data?.data?.user

    if (!user) {
      return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: 'No user data in API response' }
    }

    // Extract profile metrics
    const followers = user.edge_followed_by?.count ?? null
    const following = user.edge_follow?.count ?? null
    const postsCount = user.edge_owner_to_timeline_media?.count ?? null
    const bio = user.biography?.slice(0, 300) ?? null

    // Extract recent posts
    const recentPosts: SocialPost[] = []
    const edges = user.edge_owner_to_timeline_media?.edges ?? []

    for (const edge of edges.slice(0, postsLimit)) {
      const node = edge.node
      if (!node) continue

      const postUrl = `https://www.instagram.com/p/${node.shortcode}/`
      const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text ?? ''
      const likes = node.edge_liked_by?.count ?? node.edge_media_preview_like?.count ?? null
      const comments = node.edge_media_to_comment?.count ?? null
      const postedAt = node.taken_at_timestamp
        ? new Date(node.taken_at_timestamp * 1000).toISOString().split('T')[0]
        : null
      const mediaType = node.is_video ? 'video' : 'image'

      recentPosts.push({
        url: postUrl,
        caption_snippet: caption.slice(0, 300),
        likes,
        comments,
        posted_at: postedAt,
        media_type: mediaType,
      })
    }

    return { followers, following, posts_count: postsCount, bio, recent_posts: recentPosts, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { followers: null, following: null, posts_count: null, bio: null, recent_posts: [], error: message }
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
