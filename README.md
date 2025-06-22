# YAN - Your Onchain AI Friend

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/akash-mondal/YAN_mega_repo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

YAN is a comprehensive SocialFi sidekick designed to enhance the Farcaster experience. It acts as an AI-powered "wingman" through a user-friendly Telegram bot, helping users create engaging content, analyze their performance, and connect deeply with the community.

The system is built on a microservice-style architecture, with a Python-based Telegram bot acting as the user interface and a suite of specialized TypeScript-based AI agents performing a range of analytical tasks.

## 🏛️ Architecture Overview

YAN operates on a decoupled, event-driven architecture orchestrated by [OpenServ](https://www.openserv.ai/). This design ensures scalability and maintainability.

1.  **User Interaction**: A user sends a command (e.g., `/report`) to the Python **Telegram Bot**.
2.  **State Management**: The bot records the user's request and state in a **Supabase** PostgreSQL database.
3.  **Task Delegation**: The bot makes a secure API call to trigger the appropriate AI agent (e.g., the `performance-digest` agent) via an **OpenServ** webhook.
4.  **AI Agent Execution**: The specified TypeScript agent runs its task—scraping data, performing analysis, and generating a raw markdown result.
5.  **Asynchronous Callback**: Upon completion, the agent sends the result to a secure webhook endpoint on the Telegram bot's server.
6.  **Formatting & Delivery**: The bot receives the raw data, uses the **Google Gemini API** to format it into a beautiful, human-readable message, and delivers it to the user on Telegram.

## 🧩 Core Components

This repository is a monorepo containing all the services that constitute the YAN ecosystem.

-   `📁 /telegram-bot` (Python)
    -   The primary user-facing application.
    -   Handles all Telegram commands, conversations, and user state.
    -   Communicates with Supabase and triggers OpenServ workflows.
    -   Listens for webhooks to deliver results back to the user.

-   `📁 /digital-persona` (TypeScript)
    -   An AI agent that analyzes a user's X (Twitter) and Farcaster profiles to generate a comprehensive personality and interest summary.

-   `📁 /performance-digest` (TypeScript)
    -   Generates a weekly performance report, including new power followers, top-performing content, and actionable recommendations.

-   `📁 /whats-poppin-farcaster` (TypeScript)
    -   Monitors Farcaster for trending conversations, providing users with a summary and actionable insights on how to engage.

-   `📁 /follower-analyst` (TypeScript)
    -   Analyzes a user's follower base to identify "power followers" and high-engagement potential accounts.

-   `📁 /cast-researcher` (TypeScript)
    -   Generates personalized cast suggestions based on the user's persona, their recent activity, and trending topics.

-   `📁 /cast-timing-analyst` (TypeScript)
    -   Analyzes a user's post history to determine the optimal days and times for casting to maximize reach and engagement.

## 🛠️ Tech Stack

-   **Bot Framework**: [Python-Telegram-Bot](https://python-telegram-bot.org/)
-   **AI Agents**: [TypeScript](https://www.typescriptlang.org/), [Node.js](https://nodejs.org/)
-   **Database**: [Supabase](https://supabase.com/) (PostgreSQL)
-   **AI Orchestration**: [OpenServ](https://www.openserv.ai/)
-   **LLM / Formatting**: [Google Gemini API](https://ai.google.dev/)
-   **Deployment**: [Docker](https://www.docker.com/), Webhooks

## 🚀 Getting Started

To run this project locally for development, follow these steps.

### Prerequisites

-   Python 3.10+
-   Node.js v18+ and `pnpm`
-   Docker and Docker Compose
-   [Ngrok](https://ngrok.com/download) for exposing your local bot to public webhooks.
-   Access keys for Telegram, Google Gemini, and Supabase.

### 1. Clone the Repository

```bash
git clone https://github.com/akash-mondal/YAN_mega_repo.git
cd YAN_mega_repo
```

### 2. Environment Setup

Create a `.env` file in the `telegram-bot` directory and populate it with your credentials. Use the `.env.example` as a template.

```env
# .env file for telegram-bot

# --- Core APIs ---
TELEGRAM_BOT_TOKEN="YOUR_TELEGRAM_BOT_TOKEN_HERE"
GEMINI_API_KEY="YOUR_GEMINI_API_KEY_HERE"

# --- Supabase Database ---
SUPABASE_URL="https://your-project-ref.supabase.co"
SUPABASE_KEY="your-supabase-anon-key"

# --- Webhook Server Configuration ---
BOT_WEBHOOK_BASE_URL="https://your-ngrok-url.ngrok-free.app"
WEBHOOK_URL_SECRET="a-very-long-and-random-secret-string-for-security"
SERVER_PORT="8000"

# --- OpenServ AI Agent URLs ---
OPENSERV_PERSONA_TRIGGER_URL="..."
OPENSERV_REPORT_TRIGGER_URL="..."
# ... (and all other agent trigger URLs)
```

### 3. Database Schema

Connect to your Supabase project and run the following SQL queries to set up the necessary tables:

```sql
-- Create the users table
CREATE TABLE users (
    telegram_id BIGINT PRIMARY KEY,
    x_handle TEXT,
    fc_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create the jobs table
CREATE TABLE jobs (
    job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT REFERENCES users(telegram_id),
    task_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, completed, failed
    result_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
```

### 4. Run the Bot

First, start ngrok to get your public URL:

```bash
ngrok http 8000
```

Update the `BOT_WEBHOOK_BASE_URL` in your `.env` file with the URL provided by ngrok.

Now, start the Telegram bot server:

```bash
cd telegram-bot
pip install -r requirements.txt # Assuming a requirements.txt file exists
python bot.py
```

### 5. AI Agents

The AI agents are designed to be deployed on an orchestration platform like OpenServ. For local testing of a single agent:

```bash
cd follower-analyst
pnpm install
pnpm start # Or the relevant run script from its package.json
```

## 🤖 Usage

Interact with YAN on Telegram using these commands:

-   `/start` - Onboard and set up your profile.
-   `/report` - Get your weekly Farcaster performance summary.
-   `/trending` - See what's currently buzzing on Farcaster.
-   `/fans` - Discover your most influential followers.
-   `/cast` - Receive 5 personalized cast suggestions.
-   `/optimal` - Find out the best time for you to post.

## 🗺️ Roadmap

-   [ ] Implement intelligent tipping recommendations and budget management.
-   [ ] Add Farcaster channel discovery based on user interests.
-   [ ] Develop a web dashboard for more in-depth analytics.
-   [ ] Integrate more social platforms for a richer persona analysis.

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.
