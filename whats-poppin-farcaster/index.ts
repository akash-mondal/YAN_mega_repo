import { z } from 'zod';
import { Agent } from '@openserv-labs/sdk';
import 'dotenv/config';
import axios, { AxiosError } from 'axios';
const port = 10000;
// --- CONFIGURATION (same as your last "full code" version) ---
const neynarV2ApiBaseUrl = 'https://api.neynar.com/v2/farcaster';
const xaiApiBaseUrl = 'https://api.x.ai/v1';
const neynarApiKey = process.env.NEYNAR_API_KEY;
const xaiApiKey = process.env.XAI_API_KEY;

const TRENDING_FEED_LIMIT = 5;
const TRENDING_TIME_WINDOW = '7d';
const CATALYST_CAST_REPLIES_LIMIT = 10;
const XAI_SUMMARY_MAX_TOKENS = 250;
const XAI_X_SEARCH_MAX_TOKENS = 400; // For specific event search
const XAI_FINAL_SYNTHESIS_MAX_TOKENS = 500;

if (!neynarApiKey || !xaiApiKey) {
  console.error("ERROR: NEYNAR_API_KEY and XAI_API_KEY environment variables must be set.");
  process.exit(1);
}

const agent = new Agent({
  systemPrompt: 'You are a Farcaster Pulse Analyzer. You identify a major Farcaster conversation, its catalyst, summarize discussions (using X if direct replies are sparse), and find very recent X (Twitter) context to explain "why" it is happening now.'
});

// --- TYPE INTERFACES (same as before) ---
interface NeynarUser { fid: number; username?: string; display_name?: string; power_badge?: boolean; }
interface NeynarCast { hash: string; author: NeynarUser; text?: string; timestamp: string; reactions?: { likes_count?: number; recasts_count?: number; }; replies?: { count?: number}; parent_hash?: string | null; parent_url?: string | null; channel?: {id: string, name: string} | null }
interface XaiSearchResponse { choices: Array<{ message: { content: string } }>; citations?: string[]; }

// --- API HELPER (makeNeynarRequest, makeXaiRequest - same) ---
async function makeNeynarRequest<T>(endpoint: string, params?: Record<string, any>): Promise<{ data?: T; error?: string }> { /* ... same ... */ const url = new URL(`${neynarV2ApiBaseUrl}${endpoint}`); if (params) Object.entries(params).forEach(([key, value]) => { if (value !== undefined) url.searchParams.append(key, String(value)); }); try { const response = await axios.get(url.toString(), { headers: { 'api_key': neynarApiKey!, 'Accept': 'application/json' } }); return { data: response.data }; } catch (e: any) { const error = e as AxiosError; const errorMessage = (error.response?.data as any)?.message || error.message; console.error(`Error Neynar ${url.pathname}:`, errorMessage); return { error: `Neynar API error for ${url.pathname}: ${errorMessage}` }; } }
async function makeXaiRequest(prompt: string, searchParams?: object, maxTokens: number = 200, temperature: number = 0.5): Promise<{ content?: string; citations?: string[]; error?: string }> { /* ... same ... */ try { const payload: any = { model: 'grok-3-latest', messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: temperature,}; if (searchParams) payload.search_parameters = searchParams; const response = await axios.post<XaiSearchResponse>(`${xaiApiBaseUrl}/chat/completions`, payload, { headers: { 'Authorization': `Bearer ${xaiApiKey!}`, 'Content-Type': 'application/json' } }); if (response.data.choices && response.data.choices.length > 0) return { content: response.data.choices[0].message.content.trim(), citations: response.data.citations }; return { error: "xAI response structure invalid or no content." }; } catch (e: any) { const error = e as AxiosError; const errorMessage = (error.response?.data as any)?.error?.message || (error.response?.data as any)?.message || error.message; console.error("Error xAI:", errorMessage); return { error: `xAI API error: ${errorMessage}` }; } }


// --- CORE LOGIC FUNCTIONS ---
async function fetchTrendingFarcasterFeed(viewerFid: string): Promise<{ casts?: NeynarCast[]; error?: string }> {
    console.log(`Fetching trending Farcaster feed for viewer FID ${viewerFid}`);
    return makeNeynarRequest<{ casts: NeynarCast[] }>(`/feed/trending`, {
        limit: TRENDING_FEED_LIMIT, time_window: TRENDING_TIME_WINDOW,
        provider: 'neynar', viewer_fid: viewerFid
    });
}

// ***** CORRECTED FUNCTION TO FETCH REPLIES *****
async function fetchCastRepliesUsingParentUrl(parentCast: NeynarCast, viewerFid: string): Promise<{ casts?: NeynarCast[]; error?: string }> {
    if (!parentCast.author.username || !parentCast.hash) {
        const errorMsg = "Parent cast author username or hash is missing, cannot construct parent_url for replies.";
        console.error(errorMsg);
        return { error: errorMsg };
    }
    const parentUrl = `https://warpcast.com/${parentCast.author.username}/${parentCast.hash}`;
    console.log(`Fetching replies for parent_url: ${parentUrl}`);

    return makeNeynarRequest<{ casts: NeynarCast[] }>(`/feed`, {
        feed_type: 'filter',
        filter_type: 'parent_url', // Correct filter_type
        parent_url: parentUrl,     // Use the constructed parent URL
        with_recasts: 'false',
        with_replies: 'true', // Ensure we get replies in the thread under this parent
        limit: CATALYST_CAST_REPLIES_LIMIT,
        viewer_fid: viewerFid
    });
}
// ***********************************************

async function summarizeFarcasterDiscussionOrXReactions(catalystCast: NeynarCast, directReplies: NeynarCast[]): Promise<string> {
    const catalystText = catalystCast.text || "a cast with no text";
    if (directReplies.length > 0) {
        console.log("Summarizing Farcaster internal discussion (direct replies) with xAI...");
        const repliesText = directReplies.map(r => `@${r.author.username || `fid:${r.author.fid}`}: ${r.text}`).slice(0,7).join("\n---\n");
        const prompt = `
            Catalyst Farcaster Cast by @${catalystCast.author.username || `fid:${catalystCast.author.fid}`}: "${catalystText}"
            Recent Replies on Farcaster (sample):
            ${repliesText}
            Based on these, what is the main topic of the catalyst cast and what are the 2-3 primary themes or sentiments in the Farcaster replies? Be concise.`;
        const result = await makeXaiRequest(prompt, undefined, XAI_SUMMARY_MAX_TOKENS, 0.3);
        return result.content || `Error summarizing Farcaster replies: ${result.error}`;
    } else {
        console.log("No direct Farcaster replies found/fetched. Fetching related X discussions for context...");
        const prompt = `The following Farcaster cast is gaining attention: "@${catalystCast.author.username || `fid:${catalystCast.author.fid}`}: ${catalystText}"
        Scan X (Twitter) for discussions, reactions, or context related to the topic of this cast that have occurred in the last 24 hours.
        Summarize the general sentiment or key points from X regarding this topic.`;
        const result = await makeXaiRequest(prompt, { mode: "on", sources: [{ "type": "x" }] }, XAI_SUMMARY_MAX_TOKENS, 0.5);
        if (result.content && !result.content.toLowerCase().includes("error") && !result.content.toLowerCase().includes("could not find")) {
            return `No direct Farcaster replies were available for analysis. However, related discussions on X (Twitter) in the last 24 hours about "${catalystText.substring(0,50)}..." show: ${result.content}`;
        }
        return `No direct Farcaster replies were available for analysis, and could not fetch significant related X discussions for "${catalystText.substring(0,50)}...". The catalyst cast's topic itself is the primary focus.`;
    }
}

async function getRecentXEventsContext(topic: string): Promise<string> {
    console.log(`Searching X for RECENT (24h) events/context on: "${topic}"`);
    const prompt = `What specific events, news, product launches, or significant discussions happened on X (Twitter) in the *last 24 hours* that directly relate to the topic: "${topic}"?
    Focus on concrete happenings that could explain why this topic is currently relevant or being discussed. Provide 1-2 brief summaries.
    If nothing highly specific in the last 24h, state that no major X events were found for this topic in that timeframe.`;
    const result = await makeXaiRequest(prompt, { mode: "on", sources: [{ "type": "x" }] }, XAI_X_SEARCH_MAX_TOKENS, 0.5);
    return result.content || `Error fetching recent X events context: ${result.error}`;
}

// --- AGENT CAPABILITY ---
agent.addCapability({
    name: 'analyzeFarcasterPulseWithXContext',
    description: 'Identifies a top Farcaster conversation, its catalyst, summarizes discussions (using X for context if replies are sparse), and uses xAI to find very recent X (Twitter) events explaining "why" it is happening now.',
    schema: z.object({
        viewerFid: z.string().regex(/^\d+$/).describe('The FID of the user requesting the analysis (used for personalizing trending feed).')
    }),
    async run({ args }) {
        const { viewerFid } = args;
        const report: any = {
            requesting_fid: viewerFid,
            analysis_timestamp: new Date().toISOString(),
            errors: [],
            steps: {},
            focused_catalyst_analysis: {}
        };

        // 1. Fetch Trending Farcaster Feed
        const trendingFeedResult = await makeNeynarRequest<{ casts: NeynarCast[] }>(`/feed/trending`, {
            limit: TRENDING_FEED_LIMIT, time_window: TRENDING_TIME_WINDOW,
            provider: 'neynar', viewer_fid: viewerFid
        });

        if (trendingFeedResult.error || !trendingFeedResult.data?.casts || trendingFeedResult.data.casts.length === 0) {
            report.errors.push(`TrendingFeed: ${trendingFeedResult.error || 'No trending casts found.'}`);
            report.final_summary = "Could not identify a strong trending Farcaster conversation at this moment.";
            return JSON.stringify(report);
        }
        report.steps.trending_feed_fetched = true;
        report.trending_casts_overview_sample = trendingFeedResult.data.casts.slice(0,3).map(c => ({ hash: c.hash, author: c.author.username || `FID ${c.author.fid}`, text_snippet: c.text?.substring(0,70)+"..." }));

        // 2. Focus on the Top Catalyst Cast
        const catalystCast = trendingFeedResult.data.casts[0];
        report.focused_catalyst_analysis.catalyst_cast_details = { /* ... same ... */ hash: catalystCast.hash, author_fid: catalystCast.author.fid, author_username: catalystCast.author.username || `FID ${catalystCast.author.fid}`, text: catalystCast.text, channel: catalystCast.channel?.name || "N/A", likes: catalystCast.reactions?.likes_count, recasts: catalystCast.reactions?.recasts_count, timestamp: catalystCast.timestamp };
        report.steps.catalyst_identified = true;

        // 3. Fetch Replies for Catalyst Cast using the corrected method
        // ***** CALLING CORRECTED FUNCTION *****
        const repliesData = await fetchCastRepliesUsingParentUrl(catalystCast, viewerFid);
        if (repliesData.error) {
            report.errors.push(`CatalystReplies: ${repliesData.error}`);
            report.focused_catalyst_analysis.replies_sample = [];
        } else {
            report.focused_catalyst_analysis.replies_sample = (repliesData.data?.casts || []).map(r => ({
                author: r.author.username || `FID ${r.author.fid}`,
                text: r.text
            })).slice(0,5);
        }
        report.steps.replies_fetched = true;

        // 4. Summarize Farcaster Discussion (or X reactions if no direct replies)
        const discussionSummary = await summarizeFarcasterDiscussionOrXReactions(catalystCast, repliesData.data?.casts || []);
        report.focused_catalyst_analysis.discussion_summary = discussionSummary;
        report.steps.discussion_summarized = true;
        
        const mainTopicForSearch = catalystCast.text?.substring(0,70).replace(/\n/g, " ") || "current Farcaster topics";
        report.focused_catalyst_analysis.derived_main_topic_for_search = mainTopicForSearch;

        // 5. Get RECENT (24h) X Events Context
        const xEventsContext = await getRecentXEventsContext(mainTopicForSearch);
        report.focused_catalyst_analysis.recent_x_events_context = xEventsContext;
        report.steps.x_events_context_fetched = true;

        // 6. Final Synthesis with xAI
        const synthesisPrompt = `
        Analyze the current top conversation on Farcaster, providing context from recent X (Twitter) events.
        
        Catalyst Farcaster Cast by @${report.focused_catalyst_analysis.catalyst_cast_details.author_username}: 
        "${report.focused_catalyst_analysis.catalyst_cast_details.text?.substring(0,250).replace(/\n/g, ' ')}..." 
        (Likes: ${report.focused_catalyst_analysis.catalyst_cast_details.likes}, Recasts: ${report.focused_catalyst_analysis.catalyst_cast_details.recasts})
        Channel: /${report.focused_catalyst_analysis.catalyst_cast_details.channel || 'general'}.
        
        Summary of Discussion (this may be from direct Farcaster replies or related X chatter if no direct replies were found):
        ${report.focused_catalyst_analysis.discussion_summary}

        Context from X (Twitter) - Specific Events/News in the LAST 24 HOURS related to "${mainTopicForSearch}":
        ${report.focused_catalyst_analysis.recent_x_events_context}

        Based on ALL the above, provide a concise answer to: "What's the big conversation on Farcaster today (focusing on the catalyst cast), and what very recent X events (last 24h) might be fueling or contextualizing it?"
        Structure your answer:
        1. The Conversation on Farcaster: Briefly state the main topic of the catalyst cast and who initiated it.
        2. Current Buzz/Sentiment (from FC replies or X context): Summarize the nature of the discussion around the catalyst.
        3. The "Why Now" (from recent X Events): Explain the likely reasons this topic is relevant *today/this week* based *specifically* on the identified recent X events or lack thereof. If X events provide strong context, highlight it. If not, acknowledge that the Farcaster conversation might be self-contained or driven by other factors not immediately apparent on X.
        4. Actionable Insight/Takeaway: Suggest how one might engage with or build upon this conversation on Farcaster, perhaps by referencing the X context if relevant.
        
        Be analytical and insightful. If the discussion summary indicates it's based on X chatter due to lack of Farcaster replies, frame it accordingly.
        `;
        const finalSummaryResult = await makeXaiRequest(synthesisPrompt, undefined, XAI_FINAL_SYNTHESIS_MAX_TOKENS, 0.6);
        report.final_summary = finalSummaryResult.content || `Error in final synthesis: ${finalSummaryResult.error}`;
        report.steps.final_synthesis_complete = true;

        if (report.errors.length > 0) console.warn("Farcaster Pulse Analysis completed with errors:", report.errors);
        else console.log("Farcaster Pulse Analysis completed successfully.");
        
        return JSON.stringify(report);
    }
});

agent.start()
  .then(() => {
    console.log(`Farcaster Pulse Analyzer (X-Context Focused) Agent server started. Listening on port ${port}.`);
  })
  .catch(error => {
    console.error('Error starting Farcaster Pulse Analyzer agent server:', error);
  });
