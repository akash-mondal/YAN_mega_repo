import { z } from 'zod';
import { Agent } from '@openserv-labs/sdk';
import 'dotenv/config';
import axios, { AxiosError } from 'axios';
const portToUse = 10000;
// --- CONFIGURATION ---
const neynarV2ApiBaseUrl = 'https://api.neynar.com/v2/farcaster';
const xaiApiBaseUrl = 'https://api.x.ai/v1';
const neynarApiKey = process.env.NEYNAR_API_KEY;
const xaiApiKey = process.env.XAI_API_KEY;

const FC_CAST_LIMIT_FOR_PERSONA = 20;
const X_ACTIVITY_DAYS_TO_SCAN = 3; // For user's own X activity
const X_RECENT_EVENTS_LIMIT = 3;    // For trending X events related to interests
const XAI_MAX_TOKENS_INTERESTS = 100;
const XAI_MAX_TOKENS_X_ACTIVITY = 300;
const XAI_MAX_TOKENS_X_EVENTS = 400;
const XAI_MAX_TOKENS_CAST_SUGGESTIONS = 700; // Allow more for multiple cast suggestions + rationales


if (!neynarApiKey || !xaiApiKey) {
  console.error("ERROR: NEYNAR_API_KEY and XAI_API_KEY environment variables must be set.");
  process.exit(1);
}

const agent = new Agent({
  systemPrompt: "You are the Farcaster Cast Crafter, an AI assistant that helps users generate engaging Farcaster cast ideas based on their existing X (Twitter) and Farcaster activity, persona, and recent happenings on X."
});

// --- TYPE INTERFACES ---
interface NeynarUser { fid: number; username?: string; display_name?: string; profile?: { bio?: { text?: string } }; /* ... */ }
interface NeynarCast { text?: string; /* ... */ }
interface XaiResponse { choices: Array<{ message: { content: string } }>; citations?: string[]; }


// --- API HELPERS (makeNeynarRequest, makeXaiRequest - ensure they are robust) ---
async function makeNeynarRequest<T>(endpoint: string, params?: Record<string, any>): Promise<{ responseData?: T; error?: string }> {
    const url = new URL(`${neynarV2ApiBaseUrl}${endpoint}`);
    if (params) Object.entries(params).forEach(([key, value]) => { if (value !== undefined) url.searchParams.append(key, String(value)); });
    try {
        const response = await axios.get<T>(url.toString(), { headers: { 'api_key': neynarApiKey!, 'Accept': 'application/json' } });
        return { responseData: response.data };
    } catch (e: any) { const error = e as AxiosError; const errM = (error.response?.data as any)?.message || error.message; console.error(`Neynar Error ${url.pathname}: ${errM}`); return { error: `Neynar: ${errM}` }; }
}

async function makeXaiRequest(prompt: string, searchParams?: object, maxTokens: number = 200, temperature: number = 0.5): Promise<{ content?: string; citations?: string[]; error?: string }> {
    try {
        const payload: any = { model: 'grok-3-latest', messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: temperature };
        if (searchParams) payload.search_parameters = searchParams;
        const response = await axios.post<XaiResponse>(`${xaiApiBaseUrl}/chat/completions`, payload, { headers: { 'Authorization': `Bearer ${xaiApiKey!}`, 'Content-Type': 'application/json' } });
        if (response.data.choices && response.data.choices.length > 0 && response.data.choices[0].message) {
            return { content: response.data.choices[0].message.content.trim(), citations: response.data.citations };
        }
        return { error: "xAI response invalid." };
    } catch (e: any) { const error = e as AxiosError; const errM = (error.response?.data as any)?.error?.message || (error.response?.data as any)?.message || error.message; console.error("xAI Error:", errM); return { error: `xAI: ${errM}` }; }
}

// --- CORE LOGIC FUNCTIONS ---
const fetchFarcasterUserData = async (fid: string): Promise<{ user?: NeynarUser; casts?: NeynarCast[]; error?: string }> => {
    const userResult = await makeNeynarRequest<{ users: NeynarUser[] }>(`/user/bulk`, { fids: fid });
    if (userResult.error || !userResult.responseData?.users || userResult.responseData.users.length === 0) {
        return { error: `Failed to fetch Farcaster user FID ${fid}: ${userResult.error || 'User not found'}` };
    }
    const castsResult = await makeNeynarRequest<{ casts: NeynarCast[] }>(`/feed/user/casts`, { fid, limit: FC_CAST_LIMIT_FOR_PERSONA, include_replies: 'false' });
    // castsResult.error is fine, user might have no casts
    return { user: userResult.responseData.users[0], casts: castsResult.responseData?.casts || [], error: castsResult.error };
};

const summarizeXUserActivity = async (xHandle: string): Promise<string> => {
    console.log(`Summarizing X activity for @${xHandle}`);
    const prompt = `Summarize the key topics, themes, and types of content recently posted (last ${X_ACTIVITY_DAYS_TO_SCAN} days) by the X user @${xHandle}. What are they actively discussing or sharing? Be concise (2-3 sentences).`;
    const result = await makeXaiRequest(prompt, { mode: "on", sources: [{ "type": "x", "x_handles": [xHandle] }] }, XAI_MAX_TOKENS_X_ACTIVITY, 0.4);
    return result.content || `Could not summarize X activity for @${xHandle}: ${result.error || 'No specific themes found.'}`;
};

const deriveCombinedInterests = async (fcBio: string | undefined, fcCastsSummary: string, xActivitySummary: string): Promise<string> => {
    console.log("Deriving combined interests...");
    const prompt = `
        Based on the following Farcaster profile, summary of recent Farcaster casts, and summary of recent X activity, identify the user's top 3-5 core interests or recurring themes.
        List them as concise, comma-separated keywords or short phrases.

        Farcaster Bio: ${fcBio || "Not available"}
        Farcaster Casts Themes: ${fcCastsSummary}
        X Activity Themes: ${xActivitySummary}

        Core Interests/Themes:
    `;
    const result = await makeXaiRequest(prompt, undefined, XAI_MAX_TOKENS_INTERESTS, 0.2);
    return result.content || `Could not derive combined interests: ${result.error || 'Analysis inconclusive.'}`;
};

const findRecentXEvents = async (interests: string): Promise<string> => {
    if (interests.toLowerCase().includes("could not derive") || interests.toLowerCase().includes("error")) {
        return "Cannot search for X events without derived interests.";
    }
    console.log(`Searching X for recent events related to interests: ${interests}`);
    const prompt = `
    For the following interests: "${interests}", find up to ${X_RECENT_EVENTS_LIMIT} distinct, specific, and significant events, announcements, product launches, or notable discussions that happened on X (Twitter) in the *last 24-48 hours*.
    For each, provide a very brief (1-2 sentence) summary of the event/announcement. Focus on concrete happenings.
    If no highly specific recent events are found for an interest, state that for that interest.
    Format as a list if multiple events are found.`;
    const result = await makeXaiRequest(prompt, { mode: "on", sources: [{ "type": "x" }] }, XAI_MAX_TOKENS_X_EVENTS, 0.5);
    return result.content || `Could not find recent X events for the given interests: ${result.error || 'No specific events found.'}`;
};

// --- AGENT CAPABILITY ---
agent.addCapability({
    name: 'suggestFarcasterCasts',
    description: 'Suggests 3-5 Farcaster cast ideas based on user\'s X & Farcaster persona and recent X happenings related to their interests.',
    schema: z.object({
        farcasterFid: z.string().regex(/^\d+$/).describe('User\'s Farcaster FID.'),
        xHandle: z.string().describe('User\'s X (Twitter) handle (without @).')
    }),
    async run({ args }) {
        const { farcasterFid, xHandle } = args;
        console.log(`Generating Farcaster cast suggestions for FC FID: ${farcasterFid}, X Handle: @${xHandle}`);

        const report: any = {
            farcasterFid, xHandle,
            timestamp: new Date().toISOString(),
            intermediate_data: {},
            cast_suggestions: "Could not generate suggestions.", // Default
            errors: []
        };

        // 1. Fetch Farcaster Data
        const fcData = await fetchFarcasterUserData(farcasterFid);
        if (fcData.error) report.errors.push(fcData.error);
        report.intermediate_data.farcaster_bio = fcData.user?.profile?.bio?.text;
        const fcCastsTextForSummary = (fcData.casts || []).map(c => c.text).filter(Boolean).join("\n").substring(0,1000);
        report.intermediate_data.farcaster_casts_summary_input = fcCastsTextForSummary.substring(0,100) + "...";


        // 2. Fetch & Summarize X Activity
        const xActivitySummary = await summarizeXUserActivity(xHandle);
        report.intermediate_data.x_activity_summary = xActivitySummary;
        if (xActivitySummary.toLowerCase().includes("could not summarize")) report.errors.push(xActivitySummary);

        // 3. Derive Combined Interests
        // For deriving interests, let's use a simpler summary of FC casts if available
        const simpleFcCastsSummary = fcCastsTextForSummary ? 
            `User often casts about: ${fcCastsTextForSummary.split('. ').slice(0,3).join('. ')}` // very basic summary
            : "No recent Farcaster casts available for theme extraction.";

        const combinedInterests = await deriveCombinedInterests(
            report.intermediate_data.farcaster_bio,
            simpleFcCastsSummary,
            xActivitySummary
        );
        report.intermediate_data.derived_interests = combinedInterests;
        if (combinedInterests.toLowerCase().includes("could not derive")) report.errors.push(combinedInterests);

        // 4. Find Recent Relevant X Happenings
        const recentXEvents = await findRecentXEvents(combinedInterests);
        report.intermediate_data.recent_x_events = recentXEvents;
        if (recentXEvents.toLowerCase().includes("cannot search") || recentXEvents.toLowerCase().includes("could not find")) report.errors.push(recentXEvents);
        
        // 5. Generate Farcaster Cast Suggestions (Final Synthesis)
        const synthesisPrompt = `
        You are a Farcaster content strategist helping user @${fcData.user?.username || `FID ${farcasterFid}`} (X: @${xHandle}) craft engaging Farcaster casts.

        User's Farcaster Profile:
        - Bio: ${report.intermediate_data.farcaster_bio || "Not provided."}
        - Inferred Core Interests (from FC & X activity): ${combinedInterests}

        User's Recent X (Twitter) Activity Themes: 
        ${xActivitySummary}

        Recent (Last 24-48 Hours) Noteworthy Events/Discussions on X (Twitter) related to their interests:
        ${recentXEvents}

        Based on ALL this information, generate 3-5 distinct Farcaster cast suggestions (under 320 characters each). Each suggestion should:
        1.  Be actionable (full cast text).
        2.  Clearly tie into the user's interests OR a recent X event. If referencing an X event, make it Farcaster-native.
        3.  Sound authentic to someone with these interests and cross-platform activity.
        4.  Ideally, invite discussion or share a unique perspective.
        
        For each cast suggestion, provide a 1-sentence rationale explaining *why* it's a good idea for this user (e.g., "Mirrors your X thoughts on [topic] for your Farcaster audience," or "Connects your interest in [interest] to the recent X event about [X event], offering a Farcaster take.").

        Output format:
        **Cast Suggestion 1:**
        [Cast Text Here]
        Rationale: [Rationale Here]

        **Cast Suggestion 2:**
        [Cast Text Here]
        Rationale: [Rationale Here]
        ...and so on.
        `;

        const suggestionsResult = await makeXaiRequest(synthesisPrompt, undefined, XAI_MAX_TOKENS_CAST_SUGGESTIONS, 0.7);
        if (suggestionsResult.content && !suggestionsResult.content.toLowerCase().includes("error")) {
            report.cast_suggestions = suggestionsResult.content;
        } else {
            report.errors.push(`Failed to generate cast suggestions: ${suggestionsResult.error || "LLM synthesis issue."}`);
            report.cast_suggestions = "Could not generate cast suggestions due to an error. " + (suggestionsResult.error || "");
        }

        if (report.errors.length > 0) console.warn(`Cast Crafter for FID ${farcasterFid} completed with errors:`, report.errors);
        else console.log(`Cast Crafter for FID ${farcasterFid} completed successfully.`);

        return JSON.stringify(report);
    }
});

agent.start()
  .then(() => {

    console.log(`Farcaster Cast Crafter Agent server started. Listening on port ${portToUse}.`);
  })
  .catch(error => {
    console.error('Error starting Farcaster Cast Crafter agent server:', error);
  });
