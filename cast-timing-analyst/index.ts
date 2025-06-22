import { z } from 'zod'
import { Agent } from '@openserv-labs/sdk'
import 'dotenv/config'
import axios from 'axios'
const port = 10000
const neynarHubApiBaseUrl = 'https://hub-api.neynar.com/v1'
const neynarApiKey = process.env.NEYNAR_API_KEY

const MAX_CASTS_TO_FETCH_FOR_POST_TIME_ANALYSIS = 500;
const CAST_FETCH_PAGE_SIZE = 100;
// const IST_TIMEZONE = 'Asia/Kolkata'; // Removed

if (!neynarApiKey) {
  console.error("ERROR: NEYNAR_API_KEY environment variable is not set.")
  process.exit(1)
}

const agent = new Agent({
  systemPrompt: `You are an AI agent that analyzes a Farcaster user's casting history to determine their most frequent posting times (reported in UTC).`
})

interface FarcasterMessage {
  data: {
    type: string;
    fid: number;
    timestamp: number; // Farcaster epoch timestamp (seconds since Jan 1, 2021)
    network: string;
    castAddBody?: {
      text?: string;
    };
  };
  hash: string;
}

interface FetchCastsByFidResponse {
  messages?: FarcasterMessage[];
  nextPageToken?: string;
  error?: string;
}

const farcasterEpochToDate = (fcTimestamp: number): Date => {
  const FARCASTER_EPOCH_MS = 1609459200000; // January 1, 2021 UTC in milliseconds
  return new Date(FARCASTER_EPOCH_MS + fcTimestamp * 1000);
}

const fetchAllUserCasts = async (fid: string): Promise<{ casts: FarcasterMessage[], error?: string }> => {
  let allCasts: FarcasterMessage[] = []
  let nextPageToken: string | undefined = undefined
  let error: string | undefined = undefined
  // let fetchedCount = 0; // Not strictly needed if we check allCasts.length

  console.log(`Fetching all casts for FID: ${fid}`)

  do {
    let apiUrl = `${neynarHubApiBaseUrl}/castsByFid?fid=${fid}&pageSize=${CAST_FETCH_PAGE_SIZE}`
    if (nextPageToken) {
      apiUrl += `&pageToken=${nextPageToken}`
    }

    try {
      console.log(`Fetching casts page for FID ${fid}, token: ${nextPageToken || 'N/A'}`)
      const response = await axios.get<FetchCastsByFidResponse>(apiUrl, {
        headers: { 'api_key': neynarApiKey, 'Accept': 'application/json' }
      })

      const messages = response.data.messages || []
      const castAddMessages = messages.filter(msg => msg.data?.type === "MESSAGE_TYPE_CAST_ADD" && msg.data.castAddBody);
      
      allCasts.push(...castAddMessages)
      // fetchedCount += castAddMessages.length; // Keep track if needed for strict limits
      nextPageToken = response.data.nextPageToken

      if (allCasts.length >= MAX_CASTS_TO_FETCH_FOR_POST_TIME_ANALYSIS) {
        console.log(`Reached or exceeded MAX_CASTS_TO_FETCH limit (${MAX_CASTS_TO_FETCH_FOR_POST_TIME_ANALYSIS}). Current: ${allCasts.length}`)
        allCasts = allCasts.slice(0, MAX_CASTS_TO_FETCH_FOR_POST_TIME_ANALYSIS);
        nextPageToken = undefined; 
      }

    } catch (err: any) {
      console.error(`Error fetching casts for FID ${fid}:`, err.response?.data || err.message)
      error = `Neynar Hub API error (castsByFid): ${err.response?.data?.message || err.message}`
      break
    }
  } while (nextPageToken)

  console.log(`Fetched a total of ${allCasts.length} cast add messages for FID ${fid}.`)
  return { casts: allCasts, error }
}


const analyzeOptimalPostingTimesUTC = (casts: FarcasterMessage[]) => {
  if (casts.length === 0) {
    return {
      summary: "No cast data available to analyze posting times.",
      hourly_activity_utc: {},
      daily_activity_utc: {}
    };
  }

  const hourlyActivity: Record<string, { cast_count: number }> = {}; // 0-23 UTC
  const dailyActivity: Record<string, { cast_count: number }> = {}; // 0 (Sun) - 6 (Sat) UTC
  const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  for (const cast of casts) {
    if (cast.data.type === "MESSAGE_TYPE_CAST_ADD") {
      const utcDate = farcasterEpochToDate(cast.data.timestamp);
      
      // Get UTC hours and day
      const hour = utcDate.getUTCHours(); 
      const dayOfWeek = utcDate.getUTCDay();

      const hourKey = hour.toString().padStart(2, '0');
      const dayKey = dayOfWeek.toString();

      hourlyActivity[hourKey] = { cast_count: (hourlyActivity[hourKey]?.cast_count || 0) + 1 };
      dailyActivity[dayKey] = { cast_count: (dailyActivity[dayKey]?.cast_count || 0) + 1 };
    }
  }

  let peakHoursUTC: string[] = [];
  let maxCastsInHour = 0;
  Object.entries(hourlyActivity).forEach(([hour, data]) => {
    if (data.cast_count > maxCastsInHour) {
      maxCastsInHour = data.cast_count;
      peakHoursUTC = [hour];
    } else if (data.cast_count === maxCastsInHour) {
      peakHoursUTC.push(hour);
    }
  });

  let peakDaysUTC: string[] = [];
  let maxCastsInDay = 0;
  Object.entries(dailyActivity).forEach(([dayIndex, data]) => {
    const dayName = daysOfWeek[parseInt(dayIndex)];
    if (data.cast_count > maxCastsInDay) {
      maxCastsInDay = data.cast_count;
      peakDaysUTC = [dayName];
    } else if (data.cast_count === maxCastsInDay) {
      peakDaysUTC.push(dayName);
    }
  });
  
  const formattedHourlyActivityUTC = Object.fromEntries(
    Object.entries(hourlyActivity).map(([hour, data]) => [`${hour}:00-${hour}:59 UTC`, data])
  );
  const formattedDailyActivityUTC = Object.fromEntries(
    Object.entries(dailyActivity).map(([dayIndex, data]) => [daysOfWeek[parseInt(dayIndex)] + " (UTC)", data])
  );

  let summary = `Based on ${casts.length} of their recent casts (up to ${MAX_CASTS_TO_FETCH_FOR_POST_TIME_ANALYSIS} analyzed), times reported in UTC: `;
  if (peakDaysUTC.length > 0 && peakHoursUTC.length > 0) {
    summary += `This user most frequently posts on ${peakDaysUTC.join(', ')} (UTC), particularly around ${peakHoursUTC.map(h => `${h}:00`).join(', ')} UTC. `;
  } else {
    summary += "Could not determine clear peak posting times from the available cast data.";
  }
  summary += " (Note: This analysis is based on the user's own posting frequency in UTC. Convert to local timezone (e.g., IST is UTC+5:30) for local insights. True optimal times would correlate this with audience engagement.)";

  return {
    summary,
    reference_timezone: "UTC",
    peak_posting_hours_utc: peakHoursUTC.map(h => `${h}:00 UTC`),
    peak_posting_days_utc: peakDaysUTC,
    hourly_activity_utc: formattedHourlyActivityUTC,
    daily_activity_utc: formattedDailyActivityUTC,
    total_casts_analyzed: casts.length
  };
}

agent.addCapability({
  name: 'analyzeOptimalPostingTime',
  description: `Analyzes a Farcaster user's cast history (up to ${MAX_CASTS_TO_FETCH_FOR_POST_TIME_ANALYSIS} casts) to suggest most frequent posting times, reported in UTC.`,
  schema: z.object({
    fid: z.string().regex(/^\d+$/).describe('The Farcaster FID of the user (e.g., "942471").')
  }),
  async run({ args }) {
    const { fid } = args;
    console.log(`Starting Optimal Posting Time analysis for FID: ${fid}, reporting in UTC.`);

    const { casts, error: fetchCastsError } = await fetchAllUserCasts(fid);

    if (fetchCastsError) {
      return JSON.stringify({
        error: `Failed to fetch casts: ${fetchCastsError}`,
        analysis: null,
        target_fid: fid,
        reference_timezone: "UTC"
      });
    }

    if (casts.length === 0) {
      return JSON.stringify({
        summary: `No casts found for FID ${fid} to analyze.`,
        target_fid: fid,
        reference_timezone: "UTC",
        hourly_activity_utc: {},
        daily_activity_utc: {},
        total_casts_analyzed: 0
      });
    }
    
    const analysisResult = analyzeOptimalPostingTimesUTC(casts);

    return JSON.stringify({
        target_fid: fid,
        ...analysisResult
    });
  }
})

agent.start()
  .then(() => {

    console.log(`Farcaster Optimal Posting Time Agent server started. Listening on port ${port}. Max casts to analyze: ${MAX_CASTS_TO_FETCH_FOR_POST_TIME_ANALYSIS}. Reporting in UTC.`);
  })
  .catch(error => {
    console.error('Error starting agent server:', error);
  });
