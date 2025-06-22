import os
import logging
import asyncio
import httpx
import re
import urllib.parse
import uuid
from datetime import datetime
from typing import Dict, Any, Optional

import google.generativeai as genai
import uvicorn
from dotenv import load_dotenv
from supabase import create_client, Client
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
    ConversationHandler,
)
from telegram.constants import ParseMode, ChatAction

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

class AppConfig:
    def __init__(self):
        load_dotenv()
        self.telegram_bot_token = self._get_env("TELEGRAM_BOT_TOKEN")
        self.gemini_api_key = self._get_env("GEMINI_API_KEY")
        self.supabase_url = self._get_env("SUPABASE_URL")
        self.supabase_key = self._get_env("SUPABASE_KEY")
        self.webhook_base_url = self._get_env("BOT_WEBHOOK_BASE_URL")
        self.webhook_secret = self._get_env("WEBHOOK_URL_SECRET")
        self.server_port = int(self._get_env("SERVER_PORT", "8000"))
        self.openserv_triggers = {
            "persona": self._get_env("OPENSERV_PERSONA_TRIGGER_URL"),
            "report": self._get_env("OPENSERV_REPORT_TRIGGER_URL"),
            "trending": self._get_env("OPENSERV_TRENDING_TRIGGER_URL"),
            "fans": self._get_env("OPENSERV_FANS_TRIGGER_URL"),
            "cast": self._get_env("OPENSERV_CAST_TRIGGER_URL"),
            "optimal": self._get_env("OPENSERV_OPTIMAL_TRIGGER_URL"),
        }
        genai.configure(api_key=self.gemini_api_key)

    def _get_env(self, name: str, default: Optional[str] = None) -> str:
        value = os.getenv(name, default)
        if value is None:
            raise ValueError(f"CRITICAL: Environment variable '{name}' is not set.")
        return value

class DatabaseService:
    def __init__(self, url: str, key: str):
        self.client: Client = create_client(url, key)

    async def get_or_create_user(self, telegram_id: int) -> Dict[str, Any]:
        res = self.client.table("users").select("*").eq("telegram_id", telegram_id).execute()
        if res.data:
            return res.data[0]
        new_user_res = self.client.table("users").insert({"telegram_id": telegram_id}).execute()
        return new_user_res.data[0]

    async def update_user_details(self, telegram_id: int, x_handle: str, fc_id: int) -> Dict[str, Any]:
        update_data = {
            "x_handle": x_handle,
            "fc_id": fc_id,
            "updated_at": datetime.utcnow().isoformat()
        }
        res = self.client.table("users").update(update_data).eq("telegram_id", telegram_id).execute()
        return res.data[0]

    async def create_job(self, user_id: int, task_type: str) -> str:
        job_id = str(uuid.uuid4())
        self.client.table("jobs").insert({
            "job_id": job_id,
            "user_id": user_id,
            "task_type": task_type,
            "status": "pending",
        }).execute()
        return job_id

    async def update_job_with_result(self, job_id: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        update_data = {
            "status": "completed",
            "result_payload": payload,
            "completed_at": datetime.utcnow().isoformat(),
        }
        res = self.client.table("jobs").update(update_data).eq("job_id", job_id).execute()
        if not res.data:
            return None
        job_data_res = self.client.table("jobs").select("user_id").eq("job_id", job_id).single().execute()
        return job_data_res.data

class ApiService:
    def __init__(self, config: AppConfig):
        self.config = config
        self.gemini_model = genai.GenerativeModel('gemini-1.5-flash')

    async def trigger_openserv_task(self, task_type: str, user: Dict[str, Any], job_id: str):
        trigger_url = self.config.openserv_triggers.get(task_type)
        if not trigger_url:
            raise ValueError(f"Invalid task type: {task_type}")

        payload = {
            "x_handle": user.get("x_handle"),
            "farcaster_id": user.get("fc_id"),
            "viewer_id": user.get("fc_id"),
            "callback_url": f"{self.config.webhook_base_url}/openserv_webhook",
            "callback_metadata": {
                "job_id": job_id,
                "user_id": user.get("telegram_id"),
                "task_type": task_type,
            }
        }
        async with httpx.AsyncClient() as client:
            await client.post(trigger_url, json=payload, timeout=20)

    async def format_response(self, task_type: str, raw_data: str, user: Optional[Dict[str, Any]] = None) -> str:
        prompts = {
            "persona": f"You are YAN, an AI wingman. Your new user, @{user.get('x_handle')}, signed up. Rephrase this technical persona analysis into a warm, welcoming message. Highlight 2-3 key interests and their positive communication style. End with an enthusiastic call to action. Use emojis (🚀, ✨, 👋).",
            "report": "You are YAN. Format this weekly Farcaster data into a visually appealing summary. Use Markdown and emojis (📈, 🔥, ⭐). Start with '📈 Your Weekly Farcaster Report'. Group new power followers, provide an actionable tip, and list trending topics as 'Conversation Starters'.",
            "trending": "You are YAN. Format this raw trending data into a clear summary. Use a '🔥 Trending on Farcaster' heading. For each topic, provide a brief summary, the 'Why Now?' context, and an 'Actionable Insight' on how to engage. Use emojis and markdown.",
            "fans": "You are YAN. Format this raw follower data into a '🏆 Your Top Fans' leaderboard. List the top 5-7 followers with emojis (🥇, 🥈, etc.), showing their username and follower count. End with a sentence encouraging engagement.",
            "cast": "You are YAN. The user wants 5 cast ideas. Format the provided raw text into a clean, numbered list. Each idea should be bolded. Do not add any extra intro or outro text, just the formatted list of 5 suggestions.",
            "optimal": "You are YAN. Format this timing data into a clear summary. Use a '⏰ Your Optimal Casting Times' heading. Create a '🎯 Sweet Spot' section for the best day/hour. List top time blocks under 'Peak Activity Windows (UTC)'. Add a friendly disclaimer about experimenting.",
        }
        prompt = prompts.get(task_type)
        if not prompt:
            return "I received the data, but I'm not sure how to format it."

        full_prompt = f"{prompt}\n\nHere is the raw data:\n---\n{raw_data}\n---"
        response = await self.gemini_model.generate_content_async(full_prompt)
        return response.text

class TelegramHandlers:
    GET_X_HANDLE, GET_FC_ID, CONFIRM_DETAILS = range(3)

    def __init__(self, db_service: DatabaseService, api_service: ApiService):
        self.db = db_service
        self.api = api_service

    def _escape_markdown(self, text: str) -> str:
        escape_chars = r'_*[]()~`>#+-=|{}.!'
        return re.sub(f'([{re.escape(escape_chars)}])', r'\\\1', text)

    async def start_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
        await self.db.get_or_create_user(update.effective_chat.id)
        await update.message.reply_text("👋 Welcome to YAN, your AI Wingman for SocialFi!\n\nTo get started, what's your X (Twitter) handle?")
        return self.GET_X_HANDLE

    async def receive_x_handle(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
        x_handle = update.message.text.strip().lstrip('@')
        context.user_data['x_handle'] = x_handle
        await update.message.reply_text(f"Got it, @{x_handle}!\n\nNow, please enter your numeric Farcaster ID (FID).")
        return self.GET_FC_ID

    async def receive_fc_id(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
        fc_id_text = update.message.text.strip()
        if not fc_id_text.isdigit():
            await update.message.reply_text("Hmm, that doesn't look like a valid Farcaster ID. It should only be numbers.\nPlease try entering your FID again.")
            return self.GET_FC_ID

        context.user_data['fc_id'] = int(fc_id_text)
        x_handle = context.user_data['x_handle']
        keyboard = [[InlineKeyboardButton("✅ Looks Good!", callback_data="confirm"), InlineKeyboardButton("✏️ Edit", callback_data="edit")]]
        await update.message.reply_text(
            f"Awesome\\! Just to confirm:\n\n🐦 **X Handle:** `{self._escape_markdown(x_handle)}`\n🆔 **Farcaster ID:** `{fc_id_text}`\n\nIs this correct?",
            reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.MARKDOWN_V2,
        )
        return self.CONFIRM_DETAILS

    async def handle_onboarding_confirmation(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
        query = update.callback_query
        await query.answer()

        user_id = update.effective_chat.id
        x_handle = context.user_data['x_handle']
        fc_id = context.user_data['fc_id']

        user_details = await self.db.update_user_details(user_id, x_handle, fc_id)
        job_id = await self.db.create_job(user_id, "persona")
        await self.api.trigger_openserv_task("persona", user_details, job_id)

        await query.edit_message_text(text=f"Perfect! I'm now analyzing your online persona as @{x_handle}. I'll send you the summary as soon as it's ready. This usually takes about a minute. 🤖✨")
        return ConversationHandler.END

    async def restart_onboarding(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
        query = update.callback_query
        await query.answer()
        await query.edit_message_text(text="No problem! Let's start over.\n\nWhat is your X (Twitter) handle?")
        return self.GET_X_HANDLE

    async def cancel_onboarding(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
        await update.message.reply_text("Okay, cancelled. You can start over anytime with /start.")
        return ConversationHandler.END

    async def generic_command_handler(self, update: Update, context: ContextTypes.DEFAULT_TYPE, task_type: str):
        user_id = update.effective_chat.id
        user = await self.db.get_or_create_user(user_id)

        if not user.get("fc_id"):
            await update.message.reply_text("I don't have your Farcaster details yet. Please run /start to get set up first.")
            return

        await update.message.reply_text(f"On it! I'm generating your {task_type} analysis. I'll message you here when it's ready. 🚀")
        job_id = await self.db.create_job(user_id, task_type)
        await self.api.trigger_openserv_task(task_type, user, job_id)
        
    async def report_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        await self.generic_command_handler(update, context, "report")

    async def trending_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        await self.generic_command_handler(update, context, "trending")

    async def fans_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        await self.generic_command_handler(update, context, "fans")

    async def cast_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        await self.generic_command_handler(update, context, "cast")

    async def optimal_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        await self.generic_command_handler(update, context, "optimal")

class WebhookManager:
    def __init__(self, db_service: DatabaseService, api_service: ApiService, bot):
        self.db = db_service
        self.api = api_service
        self.bot = bot
        self.config = AppConfig()

    async def handle_openserv_webhook(self, request: Request) -> JSONResponse:
        if request.headers.get("x-yan-secret") != self.config.webhook_secret:
            return JSONResponse({"status": "error", "message": "Forbidden"}, status_code=403)
        
        try:
            data = await request.json()
            metadata = data.get("callback_metadata", {})
            job_id = metadata.get("job_id")
            user_id = metadata.get("user_id")
            task_type = metadata.get("task_type")
            raw_result = data.get("result_markdown")

            if not all([job_id, user_id, task_type, raw_result]):
                return JSONResponse({"status": "error", "message": "Missing data"}, status_code=400)

            job_info = await self.db.update_job_with_result(job_id, {"result_markdown": raw_result})
            if not job_info:
                 return JSONResponse({"status": "error", "message": "Job not found"}, status_code=404)

            user_data = await self.db.get_or_create_user(user_id)
            formatted_message = await self.api.format_response(task_type, raw_result, user_data)
            
            await self.send_formatted_result(user_id, task_type, formatted_message, raw_result)
            return JSONResponse({"status": "success"})

        except Exception as e:
            logger.error(f"Webhook processing error: {e}")
            return JSONResponse({"status": "error", "message": "Internal server error"}, status_code=500)

    async def send_formatted_result(self, user_id: int, task_type: str, formatted_message: str, raw_result: str):
        reply_markup = None
        if task_type == "fans":
            usernames = re.findall(r'Username: (\S+)', raw_result)
            buttons = []
            for username in usernames[:5]:
                tip_text = urllib.parse.quote_plus(f"Great content! @{username} 100 $DEGEN")
                tip_url = f"https://warpcast.com/~/compose?text={tip_text}"
                buttons.append([InlineKeyboardButton(f"💸 Tip @{username} 100 $DEGEN", url=tip_url)])
            if buttons:
                reply_markup = InlineKeyboardMarkup(buttons)

        elif task_type == "cast":
            suggestions = re.split(r'\d+\.\s', formatted_message)[1:]
            buttons = []
            intro = "Here are a few ideas to get you started\\. Click any button to open it directly in Warpcast\\!\n\n---\n\n"
            full_message = intro
            for i, sug in enumerate(suggestions, 1):
                cast_text = sug.strip()
                if not cast_text: continue
                url_text = urllib.parse.quote_plus(cast_text)
                cast_url = f"https://warpcast.com/~/compose?text={url_text}"
                full_message += f"**Idea {i}**\n_{self._escape_markdown(cast_text)}_\n\n"
                buttons.append([InlineKeyboardButton(f"✍️ Use Idea {i}", url=cast_url)])
            await self.bot.send_message(user_id, full_message, reply_markup=InlineKeyboardMarkup(buttons), parse_mode=ParseMode.MARKDOWN_V2)
            return

        await self.bot.send_message(user_id, formatted_message, reply_markup=reply_markup, parse_mode=ParseMode.MARKDOWN_V2)

async def main() -> None:
    config = AppConfig()
    db = DatabaseService(config.supabase_url, config.supabase_key)
    api = ApiService(config)
    
    application = Application.builder().token(config.telegram_bot_token).build()
    
    handlers = TelegramHandlers(db, api)
    onboarding_handler = ConversationHandler(
        entry_points=[CommandHandler("start", handlers.start_command)],
        states={
            handlers.GET_X_HANDLE: [MessageHandler(filters.TEXT & ~filters.COMMAND, handlers.receive_x_handle)],
            handlers.GET_FC_ID: [MessageHandler(filters.TEXT & ~filters.COMMAND, handlers.receive_fc_id)],
            handlers.CONFIRM_DETAILS: [
                CallbackQueryHandler(handlers.handle_onboarding_confirmation, pattern="^confirm$"),
                CallbackQueryHandler(handlers.restart_onboarding, pattern="^edit$"),
            ],
        },
        fallbacks=[CommandHandler("cancel", handlers.cancel_onboarding)],
    )

    application.add_handler(onboarding_handler)
    application.add_handler(CommandHandler("report", handlers.report_command))
    application.add_handler(CommandHandler("trending", handlers.trending_command))
    application.add_handler(CommandHandler("fans", handlers.fans_command))
    application.add_handler(CommandHandler("cast", handlers.cast_command))
    application.add_handler(CommandHandler("optimal", handlers.optimal_command))

    await application.bot.set_webhook(
        url=f"{config.webhook_base_url}/telegram/{config.telegram_bot_token}",
        secret_token=config.webhook_secret
    )

    webhook_manager = WebhookManager(db, api, application.bot)

    async def telegram_endpoint(request: Request) -> JSONResponse:
        if request.headers.get("x-telegram-bot-api-secret-token") != config.webhook_secret:
            return JSONResponse({}, status_code=403)
        await application.update_queue.put(Update.de_json(await request.json(), application.bot))
        return JSONResponse({}, status_code=200)
    
    starlette_app = Starlette(routes=[
        Route(f"/telegram/{config.telegram_bot_token}", telegram_endpoint, methods=["POST"]),
        Route("/openserv_webhook", webhook_manager.handle_openserv_webhook, methods=["POST"]),
    ])

    webserver = uvicorn.Server(
        config=uvicorn.Config(
            app=starlette_app,
            port=config.server_port,
            host="0.0.0.0"
        )
    )

    async with application:
        await application.start()
        await webserver.serve()
        await application.stop()

if __name__ == "__main__":
    logger.info("Starting YAN Production Bot...")
    asyncio.run(main())
