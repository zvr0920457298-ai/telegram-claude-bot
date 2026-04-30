const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 每個用戶的對話紀錄
const conversations = {};

console.log("🤖 Claude Telegram Bot 已啟動！");

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userText = msg.text;

  if (!userText) return;

  // 初始化對話紀錄
  if (!conversations[chatId]) conversations[chatId] = [];

  // /start 指令
  if (userText === "/start") {
    conversations[chatId] = [];
    return bot.sendMessage(
      chatId,
      "👋 你好！我是由 Claude AI 驅動的聊天機器人。\n\n直接輸入任何問題，我會盡力回答你！\n\n輸入 /clear 可以清除對話紀錄。"
    );
  }

  // /clear 指令
  if (userText === "/clear") {
    conversations[chatId] = [];
    return bot.sendMessage(chatId, "✅ 對話紀錄已清除！");
  }

  // 顯示「正在輸入...」
  bot.sendChatAction(chatId, "typing");

  // 加入用戶訊息
  conversations[chatId].push({ role: "user", content: userText });

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      system: "你是一個友善、聰明的 AI 助理。請用繁體中文回答，除非用戶用其他語言提問。回答要簡潔清楚。",
      messages: conversations[chatId],
    });

    const reply = response.content[0].text;

    // 儲存 AI 回覆
    conversations[chatId].push({ role: "assistant", content: reply });

    // 限制對話紀錄最多 20 輪，避免 token 超過
    if (conversations[chatId].length > 40) {
      conversations[chatId] = conversations[chatId].slice(-40);
    }

    bot.sendMessage(chatId, reply);
  } catch (error) {
    console.error("錯誤：", error.message);
    bot.sendMessage(chatId, "❌ 發生錯誤，請稍後再試。");
  }
});
