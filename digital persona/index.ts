import { z } from 'zod'
import { Agent } from '@openserv-labs/sdk'
import 'dotenv/config'
import axios from 'axios'
const port = 10000
const xaiApiBaseUrl = 'https://api.x.ai/v1'
const neynarApiBaseUrl = 'https://api.neynar.com/v2/farcaster'

const xaiApiKey = process.env.XAI_API_KEY
const neynarApiKey = process.env.NEYNAR_API_KEY

if (!xaiApiKey) {
  console.error("ERROR: XAI_API_KEY environment variable is not set.")
  process.exit(1)
}
if (!neynarApiKey) {
  console.error("ERROR: NEYNAR_API_KEY environment variable is not set.")
  process.exit(1)
}

const agent = new Agent({
  systemPrompt: 'You are an AI agent that analyzes user personas by fetching data from X (via x.ai) and Farcaster (via Neynar API) and then synthesizing insights.'
})

// --- Helper Functions for API Calls ---

interface XaiApiResponse {
  content?: string;
  error?: string;
}

interface NeynarUserResponse {
  user?: any; // Define more specific type if needed
  error?: string;
}

interface NeynarCastsResponse {
  casts?: any[]; // Define more specific type if needed
  error?: string;
}

const fetchXUserData = async (xHandle: string): Promise<XaiApiResponse> => {
  const apiUrl = `${xaiApiBaseUrl}/chat/completions`
  const requestBody = {
    model: 'grok-3-latest',
    messages: [
      {
        role: 'user',
        content: `Please provide an analysis of the X user ${xHandle} based on their recent posts. What are their main interests, topics they discuss, and what is their general sentiment or tone? Extract key themes and patterns from their activity.`
      }
    ],
    search_parameters: {
      mode: 'on',
      sources: [{ type: 'x', x_handles: [xHandle] }]
    }
  }
  try {
    const response = await axios.post(apiUrl, requestBody, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiApiKey}` }
    })
    if (response.data.choices && response.data.choices.length > 0) {
      return { content: response.data.choices[0].message.content }
    }
    return { error: 'No content from xAI analysis or invalid response structure.' }
  } catch (error: any) {
    console.error(`Error fetching X user data for ${xHandle}:`, error.response?.data || error.message)
    return { error: `xAI API error: ${error.response?.data?.error?.message || error.message}` }
  }
}

const fetchFarcasterUserProfile = async (fid: string): Promise<NeynarUserResponse> => {
  const apiUrl = `${neynarApiBaseUrl}/user/bulk/?fids=${fid}`
  try {
    const response = await axios.get(apiUrl, {
      headers: { 'x-api-key': neynarApiKey, 'Accept': 'application/json' }
    })
    if (response.data.users && response.data.users.length > 0) {
      return { user: response.data.users[0] }
    }
    return { error: 'Farcaster user not found or invalid response structure.' }
  } catch (error: any) {
    console.error(`Error fetching Farcaster profile for FID ${fid}:`, error.response?.data || error.message)
    return { error: `Neynar API error (user profile): ${error.response?.data?.message || error.message}` }
  }
}

const fetchFarcasterUserCasts = async (fid: string, limit: number = 20): Promise<NeynarCastsResponse> => {
  const apiUrl = `${neynarApiBaseUrl}/feed/user/replies_and_recasts/?filter=all&limit=${limit}&fid=${fid}`
  try {
    const response = await axios.get(apiUrl, {
      headers: { 'x-api-key': neynarApiKey, 'Accept': 'application/json' }
    })
    return { casts: response.data.casts || [] }
  } catch (error: any) {
    console.error(`Error fetching Farcaster casts for FID ${fid}:`, error.response?.data || error.message)
    return { error: `Neynar API error (user casts): ${error.response?.data?.message || error.message}` }
  }
}

const synthesizePersona = async (
  xHandle: string,
  farcasterUsername: string,
  xAnalysis: string | undefined,
  farcasterProfile: any | undefined,
  farcasterCasts: any[] | undefined
): Promise<XaiApiResponse> => {
  let combinedData = `User X Handle: ${xHandle}\nFarcaster Username: ${farcasterUsername}\n\n`

  if (xAnalysis) {
    combinedData += `--- X Platform Analysis ---\n${xAnalysis}\n\n`
  } else {
    combinedData += `--- X Platform Analysis ---\nCould not retrieve X platform data or analysis.\n\n`
  }

  if (farcasterProfile) {
    combinedData += `--- Farcaster Profile Information ---\n`
    combinedData += `Display Name: ${farcasterProfile.display_name || 'N/A'}\n`
    combinedData += `Bio: ${farcasterProfile.profile?.bio?.text || 'N/A'}\n`
    combinedData += `Follower Count: ${farcasterProfile.follower_count || 0}\n`
    combinedData += `Following Count: ${farcasterProfile.following_count || 0}\n`
    combinedData += `Neynar Score: ${farcasterProfile.score || farcasterProfile.experimental?.neynar_user_score || 'N/A'}\n\n`
  } else {
     combinedData += `--- Farcaster Profile Information ---\nCould not retrieve Farcaster profile data.\n\n`
  }

  if (farcasterCasts && farcasterCasts.length > 0) {
    combinedData += `--- Recent Farcaster Casts (Summarized Themes) ---\n`
    const castTexts = farcasterCasts.slice(0, 10).map(cast => cast.text).filter(text => text && text.trim() !== '').join('\n---\n')
    if (castTexts) {
        combinedData += `Key themes from recent casts (up to 10):\n${castTexts}\n\n(Note: This is a sample of cast texts. The full analysis should consider the broader context of these casts if available from prior steps.)\n\n`
    } else {
        combinedData += `No recent cast text available or casts were empty.\n\n`
    }
  } else {
    combinedData += `--- Recent Farcaster Casts ---\nCould not retrieve Farcaster casts or no recent casts found.\n\n`
  }

  const synthesisPrompt = `Based on the following combined information from X and Farcaster for user ${xHandle} (Farcaster: ${farcasterUsername}), please create a comprehensive persona analysis.
Focus on:
1.  Key interests and topics of discussion across both platforms.
2.  General sentiment, tone, and communication style.
3.  Potential expertise or areas of focus.
4.  Community engagement patterns (if inferable).
5.  Any notable differences or consistencies between their X and Farcaster presence.
6.  Overall summary of their online persona.

Provide concise and sweet User Persona.

Combined Data:
${combinedData}
`
  const apiUrl = `${xaiApiBaseUrl}/chat/completions`
  const requestBody = {
    model: 'grok-3-latest', // Or another suitable model for synthesis
    messages: [{ role: 'user', content: synthesisPrompt }],
    // No search_parameters here as we are providing all data
  }
  try {
    const response = await axios.post(apiUrl, requestBody, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiApiKey}` }
    })
    if (response.data.choices && response.data.choices.length > 0) {
      return { content: response.data.choices[0].message.content }
    }
    return { error: 'No content from xAI synthesis or invalid response structure.' }
  } catch (error: any) {
    console.error(`Error synthesizing persona:`, error.response?.data || error.message)
    return { error: `xAI API error (synthesis): ${error.response?.data?.error?.message || error.message}` }
  }
}


// --- Agent Capability ---
agent.addCapability({
  name: 'analyzeUserPersona',
  description: 'Analyzes a user\'s persona using their X handle and Farcaster FID by fetching data from both platforms and synthesizing insights.',
  schema: z.object({
    xHandle: z.string().describe('The user\'s X (Twitter) handle (without @).'),
    farcasterFid: z.string().regex(/^\d+$/).describe('The user\'s Farcaster FID (e.g., "942471").')
  }),
  async run({ args }) {
    const { xHandle, farcasterFid } = args
    let farcasterUsername = `FID ${farcasterFid}` // Default

    console.log(`Starting persona analysis for X:${xHandle}, Farcaster FID:${farcasterFid}`)

    const xDataPromise = fetchXUserData(xHandle)
    const fcProfilePromise = fetchFarcasterUserProfile(farcasterFid)
    const fcCastsPromise = fetchFarcasterUserCasts(farcasterFid)

    const [xDataResult, fcProfileResult, fcCastsResult] = await Promise.all([
      xDataPromise,
      fcProfilePromise,
      fcCastsPromise
    ])

    let finalReport = {
      x_handle: xHandle,
      farcaster_fid: farcasterFid,
      x_analysis: xDataResult.content,
      x_error: xDataResult.error,
      farcaster_profile: fcProfileResult.user,
      farcaster_profile_error: fcProfileResult.error,
      farcaster_recent_casts_sample: fcCastsResult.casts?.slice(0,5).map(c => ({text: c.text, timestamp: c.timestamp})), // Sample for brevity
      farcaster_casts_error: fcCastsResult.error,
      synthesized_persona: '',
      synthesis_error: ''
    }
    
    if (fcProfileResult.user && fcProfileResult.user.username) {
        farcasterUsername = fcProfileResult.user.username
    }


    console.log("Data fetched. Synthesizing persona...")
    const synthesisResult = await synthesizePersona(
      xHandle,
      farcasterUsername,
      xDataResult.content,
      fcProfileResult.user,
      fcCastsResult.casts
    )

    finalReport.synthesized_persona = synthesisResult.content || ''
    finalReport.synthesis_error = synthesisResult.error || ''
    
    if (!synthesisResult.content && !synthesisResult.error) { // Ensure some error is populated if content is missing
        finalReport.synthesis_error = "Synthesis step did not produce content or an error."
    }
    
    console.log("Persona analysis complete.")
    return JSON.stringify(finalReport)
  }
})

agent.start()
  .then(() => { 
    console.log(`User Persona Analysis Agent server started. Listening on port ${port}`)
  })
  .catch(error => {
    console.error('Error starting agent server:', error)
  })
