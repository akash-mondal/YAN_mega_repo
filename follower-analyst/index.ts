import { z } from 'zod'
import { Agent } from '@openserv-labs/sdk'
import 'dotenv/config'
import axios from 'axios'
const port = 10000
const neynarApiBaseUrl = 'https://api.neynar.com/v2/farcaster'
const neynarApiKey = process.env.NEYNAR_API_KEY

// ---- INTERNAL CONFIGURATION ----
// Maximum number of followers to fetch and analyze for performance and API rate limits.
// You can adjust this value based on your needs and Neynar API tier.
const MAX_FOLLOWERS_TO_PROCESS = 150; // Example: process up to 150 followers
const FOLLOWER_FETCH_BATCH_SIZE = 50; // How many followers to fetch per API call
const BULK_USER_FETCH_CHUNK_SIZE = 100; // Neynar's limit for /user/bulk
// ------------------------------

if (!neynarApiKey) {
  console.error("ERROR: NEYNAR_API_KEY environment variable is not set.")
  process.exit(1)
}

const agent = new Agent({
  systemPrompt: 'You are an AI agent that analyzes a Farcaster user\'s audience to identify their most valuable followers, segmenting them into categories like Power Followers and Niche-Specific Followers.'
})

// --- Neynar API Helper Functions ---

interface NeynarFollower {
  object: string;
  user: NeynarUserProfile;
}

interface NeynarUserProfile {
  fid: number;
  username?: string;
  display_name?: string;
  pfp_url?: string;
  profile?: {
    bio?: {
      text?: string;
      mentioned_channels?: Array<{ id: string; name: string; }>;
    };
  };
  follower_count?: number;
  following_count?: number;
  power_badge?: boolean;
  score?: number;
  experimental?: {
    neynar_user_score?: number;
  }
}

interface FetchFollowersResponse {
  users?: NeynarFollower[];
  next?: { cursor?: string | null };
  error?: string;
}

interface BulkUsersResponse {
  users?: NeynarUserProfile[];
  error?: string;
}

const fetchUserFollowers = async (fid: string, limit: number, cursor?: string): Promise<FetchFollowersResponse> => {
  let apiUrl = `${neynarApiBaseUrl}/followers/?fid=${fid}&limit=${limit}`
  if (cursor) {
    apiUrl += `&cursor=${cursor}`
  }
  try {
    console.log(`Fetching followers for FID ${fid}, limit ${limit}, cursor ${cursor || 'N/A'}`)
    const response = await axios.get(apiUrl, {
      headers: { 'api_key': neynarApiKey, 'Accept': 'application/json' }
    })
    return { users: response.data.users, next: response.data.next }
  } catch (error: any) {
    console.error(`Error fetching followers for FID ${fid}:`, error.response?.data || error.message)
    return { error: `Neynar API error (followers): ${error.response?.data?.message || error.message}` }
  }
}

const fetchBulkUsers = async (fids: number[]): Promise<BulkUsersResponse> => {
  if (fids.length === 0) return { users: [] }
  
  const fidsToFetch = fids.join(',')
  const apiUrl = `${neynarApiBaseUrl}/user/bulk/?fids=${fidsToFetch}`
  try {
    console.log(`Fetching bulk user data for ${fids.length} FIDs (first few: ${fids.slice(0,5).join(',')})...`)
    const response = await axios.get(apiUrl, {
      headers: { 'api_key': neynarApiKey, 'Accept': 'application/json' }
    })
    return { users: response.data.users }
  } catch (error: any) {
    console.error(`Error fetching bulk user data:`, error.response?.data || error.message)
    return { error: `Neynar API error (bulk users): ${error.response?.data?.message || error.message}` }
  }
}

// --- Analysis Functions ---

const analyzeFollowerSegments = (followers: NeynarUserProfile[]) => {
  if (followers.length === 0) {
    return {
        power_followers_sample: [],
        high_engagement_potential_sample: [],
        common_bio_keywords: [],
        common_channel_mentions_in_bio: [],
        total_followers_analyzed: 0,
        analysis_note: "No follower profiles provided for analysis."
    }
  }

  const powerFollowers: NeynarUserProfile[] = []
  const highFollowerCountFollowers: NeynarUserProfile[] = []
  
  const followerCounts = followers.map(f => f.follower_count || 0).sort((a, b) => b - a)
  const top10PercentileIndex = Math.floor(followerCounts.length * 0.1)
  const highFollowerThreshold = followerCounts.length > 0 ? followerCounts[Math.min(top10PercentileIndex, followerCounts.length -1)] : 0

  for (const follower of followers) {
    if (follower.power_badge) {
      powerFollowers.push(follower)
    }
    if ((follower.follower_count || 0) >= highFollowerThreshold && (follower.follower_count || 0) > 100) { // Min 100 followers to be "high engagement potential"
      if (!follower.power_badge) { 
        highFollowerCountFollowers.push(follower)
      }
    }
  }

  const bioKeywords: Record<string, number> = {}
  const channelMentions: Record<string, {name: string, count: number}> = {}

  followers.forEach(follower => {
    const bioText = follower.profile?.bio?.text?.toLowerCase() || ''
    bioText.split(/\s+/).forEach(word => {
      const cleanWord = word.replace(/[.,!?;:"']/g, '').trim()
      if (cleanWord.length > 3 && isNaN(Number(cleanWord))) { 
        bioKeywords[cleanWord] = (bioKeywords[cleanWord] || 0) + 1
      }
    })
    follower.profile?.bio?.mentioned_channels?.forEach(channel => {
        if(channelMentions[channel.id]){
            channelMentions[channel.id].count++;
        } else {
            channelMentions[channel.id] = {name: channel.name, count: 1};
        }
    })
  })

  const sortedKeywords = Object.entries(bioKeywords)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10) 
    .map(([keyword, count]) => ({ keyword, count }))

  const sortedChannelMentions = Object.values(channelMentions)
    .sort((a,b) => b.count - a.count)
    .slice(0,10);

  return {
    power_followers_sample: powerFollowers.slice(0, 10).map(f => ({ fid: f.fid, username: f.username, display_name: f.display_name, follower_count: f.follower_count, score: f.score || f.experimental?.neynar_user_score })),
    high_engagement_potential_sample: highFollowerCountFollowers.sort((a,b) => (b.follower_count || 0) - (a.follower_count || 0)).slice(0, 10).map(f => ({ fid: f.fid, username: f.username, display_name: f.display_name, follower_count: f.follower_count, score: f.score || f.experimental?.neynar_user_score })),
    common_bio_keywords: sortedKeywords,
    common_channel_mentions_in_bio: sortedChannelMentions,
    total_followers_analyzed: followers.length,
  }
}


// --- Agent Capability ---
agent.addCapability({
  name: 'getTrueAudienceProfile',
  description: `Analyzes a Farcaster user's followers (up to ${MAX_FOLLOWERS_TO_PROCESS}) to identify valuable segments such as power users and niche interests.`,
  schema: z.object({ // INPUT SCHEMA - ONLY FID
    fid: z.string().regex(/^\d+$/).describe('The Farcaster FID of the user whose audience you want to analyze (e.g., "942471").'),
  }),
  async run({ args }) {
    const { fid } = args
    console.log(`Starting True Audience Profile analysis for FID: ${fid}, processing up to ${MAX_FOLLOWERS_TO_PROCESS} followers.`)

    let allFollowerFids: number[] = []
    let fetchedFollowersCount = 0
    let cursor: string | undefined | null = undefined
    let fetchError: string | undefined = undefined

    while (fetchedFollowersCount < MAX_FOLLOWERS_TO_PROCESS) {
      const limit = Math.min(FOLLOWER_FETCH_BATCH_SIZE, MAX_FOLLOWERS_TO_PROCESS - fetchedFollowersCount)
      if (limit <= 0) break;

      const followersResponse = await fetchUserFollowers(fid, limit, cursor)

      if (followersResponse.error) {
        fetchError = followersResponse.error
        console.error("Error fetching followers, stopping pagination.")
        break
      }

      if (followersResponse.users && followersResponse.users.length > 0) {
        followersResponse.users.forEach(follow => {
          if (follow.user && follow.user.fid) {
            allFollowerFids.push(follow.user.fid)
          }
        })
        fetchedFollowersCount += followersResponse.users.length
      }
      
      cursor = followersResponse.next?.cursor
      if (!cursor) {
        console.log("No more followers to fetch.")
        break
      }
      if (fetchedFollowersCount >= MAX_FOLLOWERS_TO_PROCESS){
        console.log(`Reached MAX_FOLLOWERS_TO_PROCESS limit (${MAX_FOLLOWERS_TO_PROCESS}).`);
        break;
      }
    }
    
    allFollowerFids = [...new Set(allFollowerFids)]; 
    console.log(`Total unique follower FIDs collected: ${allFollowerFids.length}`)

    if (allFollowerFids.length === 0) { // Check if any FIDs were collected
      const errorMsg = fetchError ? `Could not fetch followers: ${fetchError}` : `No followers found for FID ${fid}.`;
      return JSON.stringify({
        target_fid: fid,
        error: errorMsg,
        analysis_summary: "Analysis cannot proceed without follower data.",
        segments: analyzeFollowerSegments([]) // Return empty segments
      });
    }
    
    const followerProfilesToAnalyze: NeynarUserProfile[] = [];
    let bulkFetchError: string | undefined;

    for (let i = 0; i < allFollowerFids.length; i += BULK_USER_FETCH_CHUNK_SIZE) {
        const chunk = allFollowerFids.slice(i, i + BULK_USER_FETCH_CHUNK_SIZE);
        if (chunk.length > 0) {
            const bulkUsersData = await fetchBulkUsers(chunk);
            if (bulkUsersData.error) {
                bulkFetchError = (bulkFetchError || "") + `Chunk ${Math.floor(i/BULK_USER_FETCH_CHUNK_SIZE) +1} error: ${bulkUsersData.error}; `;
                console.error("Error during bulk user fetch for a chunk:", bulkUsersData.error)
            }
            if (bulkUsersData.users) {
                followerProfilesToAnalyze.push(...bulkUsersData.users);
            }
        }
    }
    
    console.log(`Total follower profiles hydrated for analysis: ${followerProfilesToAnalyze.length}`)

    if (followerProfilesToAnalyze.length === 0 && !bulkFetchError) { // If no profiles hydrated and no specific bulk error
        const errorMsg = fetchError ? `Follower FIDs collected, but failed to hydrate profiles. Initial fetch error: ${fetchError}` : "Follower FIDs collected, but failed to hydrate any profiles.";
        return JSON.stringify({
            target_fid: fid,
            error: errorMsg,
            analysis_summary: "Analysis aborted due to inability to hydrate follower profiles.",
            segments: analyzeFollowerSegments([]) // Return empty segments
        });
    }

    const analysisResults = analyzeFollowerSegments(followerProfilesToAnalyze)

    const responseReport = {
      target_fid: fid,
      analysis_summary: `Analyzed ${analysisResults.total_followers_analyzed} followers (from ${allFollowerFids.length} collected FIDs, up to ${MAX_FOLLOWERS_TO_PROCESS} processed).`,
      segments: analysisResults,
      data_fetching_notes: {
          initial_follower_fetch_error: fetchError,
          bulk_profile_fetch_error: bulkFetchError
      },
      error: fetchError || bulkFetchError ? "There were errors during data fetching. Results might be incomplete." : undefined
    }
    // Remove error field if it's undefined to keep JSON clean
    if (!responseReport.error) delete responseReport.error;


    return JSON.stringify(responseReport)
  }
})

agent.start()
  .then(() => {
    console.log(`Farcaster True Audience Profile Agent server started. Listening on port ${port} | Max followers to process: ${MAX_FOLLOWERS_TO_PROCESS}`)
  })
  .catch(error => {
    console.error('Error starting agent server:', error)
  })
