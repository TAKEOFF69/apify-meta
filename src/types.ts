// ---------------------------------------------------------------------------
// Actor Input
// ---------------------------------------------------------------------------

export interface CompetitorInput {
  name: string
  instagram?: string
  facebook?: string
}

export interface ActorInput {
  customer_slug: string
  competitors: CompetitorInput[]
  posts_per_profile?: number // default 12
}

// ---------------------------------------------------------------------------
// Actor Output (pushed to Apify dataset)
// ---------------------------------------------------------------------------

export interface SocialPost {
  url: string
  caption_snippet: string
  likes: number | null
  comments: number | null
  posted_at: string | null
  media_type: string | null
}

export interface CompetitorSocialResult {
  customer_slug: string
  name: string
  platform: 'instagram' | 'facebook'
  scraped_at: string
  followers: number | null
  following: number | null
  posts_count: number | null
  bio: string | null
  recent_posts: SocialPost[]
  error: string | null
}

// ---------------------------------------------------------------------------
// competitor-social.json (written by sync script)
// ---------------------------------------------------------------------------

export interface CompetitorSocialFile {
  last_scraped: string
  competitors: {
    name: string
    instagram?: PlatformData
    facebook?: PlatformData
  }[]
}

export interface PlatformData {
  followers: number | null
  following?: number | null
  posts_count: number | null
  bio?: string | null
  engagement_rate: number | null
  recent_posts: SocialPost[]
}
