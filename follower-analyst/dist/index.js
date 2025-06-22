"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const sdk_1 = require("@openserv-labs/sdk");
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const xaiApiBaseUrl = 'https://api.x.ai/v1';
const xaiApiKey = process.env.XAI_API_KEY;
if (!xaiApiKey) {
    console.error("ERROR: XAI_API_KEY environment variable is not set.");
    process.exit(1);
}
const agent = new sdk_1.Agent({
    systemPrompt: 'You are an AI agent equipped with advanced search capabilities using the x.ai API. You can search X (formerly Twitter), specific RSS feeds, or the general web to answer user queries.'
});
const commonXaiRequest = async (query, searchType, rssUrl) => {
    const apiUrl = `${xaiApiBaseUrl}/chat/completions`;
    const enhancedQuery = `${query} Please provide the most detailed, error-free, and bias-free information, including all relevant detailed research.`;
    const requestBody = {
        messages: [{ role: 'user', content: enhancedQuery }],
        search_parameters: {
            mode: 'on',
            sources: []
        },
        model: 'grok-3-latest'
    };
    if (searchType === 'x') {
        requestBody.search_parameters.sources.push({ type: 'x' });
    }
    else if (searchType === 'web') {
        requestBody.search_parameters.sources.push({ type: 'web' });
    }
    else if (searchType === 'rss' && rssUrl) {
        requestBody.search_parameters.sources.push({ type: 'rss', links: [rssUrl] });
    }
    else if (searchType === 'rss' && !rssUrl) {
        return 'Error: RSS URL is required for RSS search.';
    }
    console.log(`Sending request to x.ai: Type=${searchType}, Query=${query}${rssUrl ? `, RSS=${rssUrl}` : ''}`);
    try {
        const response = await axios_1.default.post(apiUrl, requestBody, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${xaiApiKey}`
            }
        });
        const responseData = response.data;
        if (responseData.error) {
            console.error('x.ai API returned an error:', responseData.error);
            return `Error from x.ai API: ${responseData.error.message || 'Unknown API error'}`;
        }
        if (responseData.choices && responseData.choices.length > 0 && responseData.choices[0].message) {
            return responseData.choices[0].message.content;
        }
        else {
            console.error('Invalid response structure from x.ai API:', responseData);
            return 'Error: Received an invalid response structure from the x.ai API.';
        }
    }
    catch (error) {
        console.error(`Error calling x.ai API for ${searchType} search:`, error);
        if (axios_1.default.isAxiosError(error)) {
            const status = error.response?.status;
            const apiMessage = error.response?.data?.error?.message || error.response?.data?.message || 'No specific message from API.';
            if (status === 401) {
                return `Error: Authentication failed with x.ai API. Please check your XAI_API_KEY. (Status: ${status})`;
            }
            else if (status === 429) {
                return `Error: x.ai API rate limit exceeded. Please wait and try again later. (Status: ${status})`;
            }
            else {
                return `Error: An API error occurred with x.ai. Status: ${status || 'N/A'}, Message: ${apiMessage}`;
            }
        }
        return `Error: An unexpected error occurred while contacting the x.ai API: ${error.message}`;
    }
};
agent.addCapability({
    name: 'searchXPlatform',
    description: 'Searches the X platform (formerly Twitter) for information related to the user query.',
    schema: zod_1.z.object({
        query: zod_1.z.string().describe('The search query for the X platform.')
    }),
    async run({ args }) {
        return commonXaiRequest(args.query, 'x');
    }
});
agent.addCapability({
    name: 'searchRssFeed',
    description: 'Searches a specific RSS feed for information related to the user query.',
    schema: zod_1.z.object({
        query: zod_1.z.string().describe('The search query to apply to the RSS feed content.'),
        rssUrl: zod_1.z.string().url().describe('The URL of the RSS feed to search (e.g., https://cointelegraph.com/rss).')
    }),
    async run({ args }) {
        return commonXaiRequest(args.query, 'rss', args.rssUrl);
    }
});
agent.addCapability({
    name: 'searchWeb',
    description: 'Performs a general web search for information related to the user query.',
    schema: zod_1.z.object({
        query: zod_1.z.string().describe('The general web search query.')
    }),
    async run({ args }) {
        return commonXaiRequest(args.query, 'web');
    }
});
agent.start()
    .then(() => {
    const port = process.env.PORT || 7378;
    console.log(`X.AI Search Agent server started. Listening for requests on port ${port}`);
})
    .catch(error => {
    console.error('Error starting agent server:', error);
});
