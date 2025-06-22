import { z } from 'zod'
import { Agent } from '@openserv-labs/sdk'
import 'dotenv/config'
import axios, { AxiosError } from 'axios'
const port = 10000;
const neynarV2ApiBaseUrl = 'https://api.neynar.com/v2/farcaster'
const xaiApiBaseUrl = 'https://api.x.ai/v1'

const neynarApiKey = process.env.NEYNAR_API_KEY
const xaiApiKey = process.env.XAI_API_KEY

// ---- INTERNAL CONFIGURATION ----
const RECENT_CASTS_LIMIT_FOR_TOP_CONTENT = 15;
const RECENT_CASTS_LIMIT_FOR_INTEREST_ANALYSIS = 30; // More casts for better interest profiling
const FOLLOWER_FETCH_LIMIT = 30;
const NOTIFICATION_FETCH_LIMIT = 25;
const BULK_USER_FETCH_CHUNK_SIZE = 100;
const X_EVENT_SEARCH_RESULT_LIMIT = 3; // How many specific events/announcements from X
// ------------------------------

if (!neynarApiKey) {
  console.error("ERROR: NEYNAR_API_KEY environment variable is not set.")
  process.exit(1)
}
if (!xaiApiKey) {
  console.error("ERROR: XAI_API_KEY environment variable is not set. LLM-based synthesis and X event search cannot proceed.")
  process.exit(1)
}

const agent = new Agent({
  systemPrompt: 'You are a Farcaster Performance & Content Strategist. You generate a user digest including stats, top content, follower insights, and suggest Farcaster cast ideas based on recent X (Twitter) events relevant to their Farcaster persona.'
})

// --- Type Interfaces (same as before) ---
interface NeynarUser {
  fid: number;
  username?: string;
  display_name?: string;
  pfp_url?: string;
  profile?: { bio?: { text?: string } };
  follower_count?: number;
  following_count?: number;
  power_badge?: boolean;
}
interface NeynarCast { /* ... same ... */ hash: string; author: NeynarUser; text?: string; timestamp: string; reactions?: { likes_count?: number; recasts_count?: number; [key: string]: any }; replies?: { count?: number }; }
interface NeynarFollowerResponseUser { /* ... same ... */ object: "user"; fid: number; username?: string; display_name?: string; power_badge?: boolean; }
interface NeynarFollowerEntry { /* ... same ... */ object: "follow"; user: NeynarFollowerResponseUser; }
interface NeynarNotification { /* ... same ... */ object: "notification"; most_recent_timestamp: string; type: string; cast?: NeynarCast; reactions?: Array<{ object: string; user: NeynarUser, cast?: {hash: string} }>; follows?: Array<{object: string; user: NeynarUser}>; }
interface XaiSearchResponse { /* ... same ... */ choices: Array<{ message: { content: string }, finish_reason: string }>; citations?: string[]; }


// --- Neynar API Helper Functions (same as before) ---
async function makeNeynarRequest<T>(endpoint: string, params?: Record<string, any>): Promise<{ data?: T; error?: string }> {
    const url = new URL(`${neynarV2ApiBaseUrl}${endpoint}`);
    if (params) {
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined) url.searchParams.append(key, String(value));
        });
    }
    try {
        const response = await axios.get(url.toString(), {
            headers: { 'api_key': neynarApiKey!, 'Accept': 'application/json' }
        });
        return { data: response.data };
    } catch (e: any) {
        const error = e as AxiosError;
        const errorMessage = (error.response?.data as any)?.message || error.message;
        console.error(`Error fetching ${url.pathname}:`, errorMessage, error.response?.data);
        return { error: `Neynar API error for ${url.pathname}: ${errorMessage}` };
    }
}
const fetchFarcasterUser = async (fid: string): Promise<{ user?: NeynarUser; error?: string }> => { /* ... same ... */ const result = await makeNeynarRequest<{users: NeynarUser[]}>(`/user/bulk`, { fids: fid }); if (result.error) return { error: result.error }; if (result.data?.users && result.data.users.length > 0) { return { user: result.data.users[0] }; } return { error: 'User not found.' }; };
const fetchUserRecentCastsForTopContent = async (fid: string): Promise<{ casts?: NeynarCast[]; error?: string }> => { /* ... same ... */ return makeNeynarRequest<{casts: NeynarCast[]}>(`/feed/user/casts`, { fid, limit: RECENT_CASTS_LIMIT_FOR_TOP_CONTENT, include_replies: 'false' }); };
const fetchUserCastsForInterestAnalysis = async (fid: string): Promise<{ casts?: NeynarCast[]; error?: string }> => { /* ... same ... */ return makeNeynarRequest<{casts: NeynarCast[]}>(`/feed/user/casts`, { fid, limit: RECENT_CASTS_LIMIT_FOR_INTEREST_ANALYSIS, include_replies: 'true' }); };
const fetchRecentFollowers = async (fid: string): Promise<{ followers?: NeynarFollowerEntry[]; error?: string }> => { /* ... same ... */ const result = await makeNeynarRequest<{users: NeynarFollowerEntry[]}>(`/followers`, { fid, limit: FOLLOWER_FETCH_LIMIT, sort_type: 'desc_chron' }); return { followers: result.data?.users, error: result.error }; };
const fetchBulkUsersByFid = async (fids: number[]): Promise<{ users?: NeynarUser[]; error?: string }> => { /* ... same ... */ if (fids.length === 0) return { users: [] }; const allUsers: NeynarUser[] = []; let anyError: string | undefined; for (let i = 0; i < fids.length; i += BULK_USER_FETCH_CHUNK_SIZE) { const chunk = fids.slice(i, i + BULK_USER_FETCH_CHUNK_SIZE); const result = await makeNeynarRequest<{users: NeynarUser[]}>(`/user/bulk`, { fids: chunk.join(',') }); if (result.error)  anyError = (anyError ? anyError + "; " : "") + `Chunk starting ${i}: ${result.error}`; if (result.data?.users) allUsers.push(...result.data.users); } return { users: allUsers, error: anyError }; };
const fetchUserNotifications = async (fid: string): Promise<{ notifications?: NeynarNotification[]; error?: string }> => { /* ... same ... */ return makeNeynarRequest<{notifications: NeynarNotification[]}>(`/notifications`, { fid, limit: NOTIFICATION_FETCH_LIMIT }); };


// --- xAI Helper Functions ---
async function getInterestsFromProfileAndCasts(profileBio: string | undefined, recentCasts: NeynarCast[]): Promise<string> {
    const castTexts = recentCasts.map(c => c.text).filter(Boolean).join("\n").substring(0, 2000);
    const prompt = `
        From the Farcaster user bio and recent cast texts, extract up to 5 key interests, themes, or topics.
        List them as concise, comma-separated keywords or short phrases. This will be used to find relevant news.

        Bio: ${profileBio || "Not available"}
        Recent Casts Excerpts:
        ${castTexts || "No cast text available"}

        Key Interests/Themes for News Search:
    `; // Prompt refined for search keywords
    try {
        const response = await axios.post<XaiSearchResponse>(`${xaiApiBaseUrl}/chat/completions`, {
            model: 'grok-3-latest', messages: [{ role: 'user', content: prompt }],
            max_tokens: 70, temperature: 0.2, // More focused output
        }, { headers: { 'Authorization': `Bearer ${xaiApiKey!}`, 'Content-Type': 'application/json' }});
        if (response.data.choices && response.data.choices.length > 0) {
            return response.data.choices[0].message.content.trim();
        }
        return "Could not determine specific interests for news search.";
    } catch (error) {
        console.error("Error extracting interests with xAI:", error);
        return "Error determining interests for news search.";
    }
}

async function searchRecentEventsOnX(interests: string): Promise<{ x_events_summary?: string; error?: string; citations?: string[] }> {
    if (!interests || interests.toLowerCase().includes("could not determine") || interests.toLowerCase().includes("error determining")) {
        return { x_events_summary: "Not enough Farcaster interest data to search for relevant X events." };
    }
    // **REFINED PROMPT FOR XAI SEARCH**
    const prompt = `
    Scan X (Twitter) for up to ${X_EVENT_SEARCH_RESULT_LIMIT} specific and significant events, major announcements, product launches, or notable discussions that happened in the LAST WEEK related to these topics: ${interests}.
    For each, provide a very brief (1-2 sentence) summary of the event/announcement. Focus on concrete happenings, not generic trends.
    Example: "OpenAI announced GPT-5 preview access for select developers." or "Vitalik Buterin published a new paper on ETH staking centralization concerns."
    If no highly specific events are found for all topics, indicate that for the respective topic.
    `;
    try {
        console.log(`Searching X for recent events related to: ${interests}`);
        const response = await axios.post<XaiSearchResponse>(`${xaiApiBaseUrl}/chat/completions`, {
            model: 'grok-3-latest',
            messages: [{ role: 'user', content: prompt }],
            search_parameters: { mode: "on", sources: [{ "type": "x" }] },
            max_tokens: 600, temperature: 0.5, // Allow more tokens for multiple event summaries
        }, { headers: { 'Authorization': `Bearer ${xaiApiKey!}`, 'Content-Type': 'application/json' }});
        
        if (response.data.choices && response.data.choices.length > 0) {
            return { x_events_summary: response.data.choices[0].message.content, citations: response.data.citations };
        }
        return { error: "Could not find specific events on X or xAI response invalid." };
    } catch (error) {
        const axiosError = error as AxiosError;
        console.error("Error searching X events with xAI:", axiosError.response?.data || axiosError.message);
        return { error: `Error searching X events: ${(axiosError.response?.data as any)?.error?.message || axiosError.message}` };
    }
}

async function synthesizeStrategicDigestWithLLM(data: any): Promise<string> {
  // **REFINED PROMPT FOR FINAL SYNTHESIS**
  const prompt = `
    As a Farcaster content strategist, generate a concise and highly actionable performance summary and content strategy advice for user FID ${data.target_fid} (${data.stats?.username || 'username not available'}).

    User's Farcaster Persona/Interests (derived from their bio & casts):
    ${data.derived_interests || 'General Farcaster user.'}

    Recent Specific Events/Announcements on X (Twitter) relevant to these interests (from the last week):
    ${data.x_events_summary_for_synthesis || "No specific recent X events were highlighted for these interests, or data was unavailable."}
    ${data.x_event_citations ? `(Sources for X events: ${data.x_event_citations.slice(0,1).join(', ')})` : ''}

    Performance Data:
    - Follower Count: ${data.stats?.follower_count ?? 'N/A'}
    - Top Performing Cast (recent): 
        - Text Snippet: "${data.top_cast?.text?.substring(0, 100).replace(/\n/g, ' ') ?? 'N/A'}"
        - Likes: ${data.top_cast?.reactions?.likes_count ?? 0}
        - Recasts: ${data.top_cast?.reactions?.recasts_count ?? 0}
    - New Power Followers (sample): ${data.new_power_followers_sample?.map((f: Partial<NeynarUser>) => f.username || `FID ${f.fid}`).join(', ') || 'None in recent sample'}

    Instructions for Synthesis:
    1.  Provide a brief performance overview (followers, top cast if notable).
    2.  Acknowledge new power followers, if any from the sample.
    3.  **Crucially:** Based on the user's Farcaster persona/interests AND the specific recent X events/announcements, generate 1-2 concrete Farcaster cast ideas.
        For each idea:
        a.  Briefly state the X event/announcement.
        b.  Suggest how the user can approach this topic on Farcaster, aligning with their established interests or voice. Be specific about the angle or question they could pose.
        Example for a user interested in 'AI ethics': "X Event: XYZ Corp launched a new AI model with potential privacy issues. Cast Idea for Farcaster: You could share your take on XYZ's new model, asking your Farcaster followers about the ethical implications for decentralized identity, a topic you often discuss."
    4.  Include an encouraging closing remark.
    Keep the entire summary concise (4-7 sentences). If specific X events are not available, focus on general content advice based on their interests.

    Synthesize the digest:
  `;

  try {
    console.log("Attempting STRATEGIC LLM synthesis with xAI Grok (with X events & cast ideas)...");
    const response = await axios.post<XaiSearchResponse>(`${xaiApiBaseUrl}/chat/completions`, {
      model: 'grok-3-latest',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500, // Increased slightly for more detailed cast ideas
      temperature: 0.65 
    }, { headers: { 'Authorization': `Bearer ${xaiApiKey!}`, 'Content-Type': 'application/json' }});
    
    if (response.data.choices && response.data.choices.length > 0 && response.data.choices[0].message) {
      console.log("Strategic LLM synthesis successful.");
      return response.data.choices[0].message.content;
    }
    return "Strategic LLM synthesis returned an unexpected structure.";
  } catch (error: any) {
    const axiosError = error as AxiosError;
    console.error("Error during STRATEGIC LLM synthesis:", axiosError.response?.data || axiosError.message);
    return `Error synthesizing strategic digest: ${(axiosError.response?.data as any)?.error?.message || axiosError.message}.`;
  }
}

// --- Agent Capability ---
agent.addCapability({
  name: 'getFarcasterStrategicDigest',
  description: `Generates a Farcaster digest: stats, top content, follower insights, and actionable cast ideas based on recent X (Twitter) events relevant to user's Farcaster persona. Synthesized by Grok-3.`,
  schema: z.object({
    fid: z.string().regex(/^\d+$/).describe('The Farcaster FID of the user (e.g., "942471").')
  }),
  async run({ args }) {
    const { fid } = args;
    console.log(`Generating STRATEGIC weekly digest for FID: ${fid}`);

    const report: any = {
      target_fid: fid,
      fetch_timestamp: new Date().toISOString(),
      errors: []
    };

    // 1. Fetch core stats
    const userStatsData = await fetchFarcasterUser(fid);
    if (userStatsData.error) report.errors.push(`UserStats: ${userStatsData.error}`);
    report.stats = userStatsData.user || null;

    // 2. Identify top-performing content
    const recentCastsDataForTopContent = await fetchUserRecentCastsForTopContent(fid);
    if (recentCastsDataForTopContent.error) report.errors.push(`RecentCastsTop: ${recentCastsDataForTopContent.error}`);
    if (recentCastsDataForTopContent.casts && recentCastsDataForTopContent.casts.length > 0) {
      const sortedCasts = [...recentCastsDataForTopContent.casts].sort((a, b) => 
        ((b.reactions?.likes_count || 0) + (b.reactions?.recasts_count || 0) * 2) -
        ((a.reactions?.likes_count || 0) + (a.reactions?.recasts_count || 0) * 2)
      );
      report.top_cast = sortedCasts[0] || null;
    } else { report.top_cast = null; }

    // 3. & 4. Analyze new followers (sample)
    const recentFollowersData = await fetchRecentFollowers(fid);
    if (recentFollowersData.error) report.errors.push(`RecentFollowers: ${recentFollowersData.error}`);
    if (recentFollowersData.followers && recentFollowersData.followers.length > 0) {
        report.recent_followers_sample_count = recentFollowersData.followers.length;
        const recentFollowerFids = recentFollowersData.followers.map(f => f.user.fid).filter(id => id != null);
        if (recentFollowerFids.length > 0) {
            const hydratedFollowersData = await fetchBulkUsersByFid(recentFollowerFids);
            if (hydratedFollowersData.error) report.errors.push(`HydrateFollowers: ${hydratedFollowersData.error}`);
            report.new_power_followers_sample = hydratedFollowersData.users?.filter(u => u.power_badge).map(u => ({
                fid: u.fid, username: u.username, display_name: u.display_name
            })) || [];
        } else { report.new_power_followers_sample = []; }
    } else {
        report.recent_followers_sample_count = 0;
        report.new_power_followers_sample = [];
    }

    // 5. Check notifications (simplified for this example, could be expanded)
    // For brevity, we'll skip detailed notification analysis in this iteration to focus on X trends
    report.high_impact_notifications_sample = []; 
    console.log("Skipping detailed notification analysis for this version to focus on X trends integration.");


    // 6. Derive Interests and Find Recent X Events
    const castsForInterest = await fetchUserCastsForInterestAnalysis(fid);
    if(castsForInterest.error) report.errors.push(`CastsForInterest: ${castsForInterest.error}`);
    
    report.derived_interests = await getInterestsFromProfileAndCasts(report.stats?.profile?.bio?.text, castsForInterest.casts || []);
    if (report.derived_interests.toLowerCase().includes("error") || report.derived_interests.toLowerCase().includes("could not determine")) {
        report.errors.push(`DeriveInterests: ${report.derived_interests}`);
    }

    const xEventsResult = await searchRecentEventsOnX(report.derived_interests);
    if (xEventsResult.error) report.errors.push(`XEventsSearch: ${xEventsResult.error}`);
    report.x_events_summary_for_synthesis = xEventsResult.x_events_summary; // Store for synthesis prompt
    report.x_event_citations = xEventsResult.citations; // Store citations

    // 7. Synthesize Enhanced Message
    report.synthesized_summary = await synthesizeStrategicDigestWithLLM(report);
     if (report.synthesized_summary.toLowerCase().includes("error")) {
        report.errors.push(`Synthesis: ${report.synthesized_summary}`);
    }
    
    console.log("Strategic weekly digest generation complete.");
    if (report.errors.length > 0) console.warn("Generated digest with some errors:", report.errors);
    
    // Clean up report for final output - remove intermediate data if not needed by consumer
    const finalOutput = {
        target_fid: report.target_fid,
        username: report.stats?.username,
        display_name: report.stats?.display_name,
        synthesized_summary: report.synthesized_summary,
        details: {
            follower_count: report.stats?.follower_count,
            top_cast_snippet: report.top_cast?.text?.substring(0,75) + "...",
            top_cast_likes: report.top_cast?.reactions?.likes_count,
            new_power_followers_count_in_sample: report.new_power_followers_sample.length,
            derived_farcaster_interests: report.derived_interests,
            recent_x_events_found: report.x_events_summary_for_synthesis,
            x_event_citations: report.x_event_citations
        },
        errors: report.errors.length > 0 ? report.errors : undefined
    };
    if (!finalOutput.errors) delete finalOutput.errors;


    return JSON.stringify(finalOutput);
  }
})

agent.start()
  .then(() => {
    console.log(`Farcaster Strategic Digest Agent server started. Listening on port ${port}.`);
  })
  .catch(error => {
    console.error('Error starting agent server:', error);
  });
