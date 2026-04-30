const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");
const crypto = require("crypto");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const OKX_API_KEY = process.env.OKX_API_KEY;
const OKX_SECRET = process.env.OKX_SECRET;
const OKX_PASSPHRASE = process.env.OKX_PASSPHRASE;
const DEFAULT_ORDER_SIZE = process.env.DEFAULT_ORDER_SIZE || "20"; // USDT

// 待確認開單
const pendingOrders = {};
// 對話紀錄
const conversations = {};

// 市值前30幣種
const TOP_COINS = [
  "BTC","ETH","BNB","SOL","XRP","USDC","ADA","AVAX","DOGE","TRX",
  "TON","LINK","MATIC","DOT","SHIB","LTC","BCH","UNI","ATOM","XLM",
  "ETC","APT","FIL","NEAR","ARB","OP","INJ","IMX","SUI","RNDR"
];

console.log("🤖 AI 投資助手已啟動！");

// ===== OKX API =====
function okxSign(timestamp, method, path, body = "") {
  const msg = timestamp + method + path + body;
  return crypto.createHmac("sha256", OKX_SECRET).update(msg).digest("base64");
}

async function okxRequest(method, path, body = null) {
  const timestamp = new Date().toISOString();
  const bodyStr = body ? JSON.stringify(body) : "";
  const sign = okxSign(timestamp, method, path, bodyStr);
  const headers = {
    "OK-ACCESS-KEY": OKX_API_KEY,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": OKX_PASSPHRASE,
    "Content-Type": "application/json",
  };
  const res = await axios({ method, url: `https://www.okx.com${path}`, headers, data: body });
  return res.data;
}

// ===== 取得市場資料 =====
async function getMarketData() {
  const results = [];
  // 抓前30幣種的ticker
  const res = await axios.get("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
  const tickers = res.data.data;

  for (const coin of TOP_COINS) {
    const instId = `${coin}-USDT`;
    const ticker = tickers.find(t => t.instId === instId);
    if (!ticker) continue;

    // 抓K線 (15分鐘)
    const klineRes = await axios.get(
      `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=15m&limit=50`
    );
    const candles = klineRes.data.data || [];

    const closes = candles.map(c => parseFloat(c[4])).reverse();
    const rsi = calculateRSI(closes);
    const { macd, signal } = calculateMACD(closes);
    const price = parseFloat(ticker.last);
    const change24h = parseFloat(ticker.chg24h) * 100;
    const vol24h = parseFloat(ticker.volCcy24h);

    results.push({ coin, instId, price, change24h, vol24h, rsi, macd, signal });
  }
  return results;
}

// ===== 技術指標 =====
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / (losses || 0.001);
  return 100 - 100 / (1 + rs);
}

function calculateEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calculateMACD(closes) {
  if (closes.length < 26) return { macd: 0, signal: 0 };
  const ema12 = calculateEMA(closes.slice(-12), 12);
  const ema26 = calculateEMA(closes.slice(-26), 26);
  const macd = ema12 - ema26;
  const signal = macd * 0.2; // 簡化版
  return { macd, signal };
}

// ===== 抓新聞 =====
async function getNews() {
  try {
    const res = await axios.get(
      "https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=BTC,ETH,Trading&api_key=&limit=10"
    );
    return res.data.Data.slice(0, 5).map(n => `• ${n.title}`).join("\n");
  } catch {
    return "（無法取得新聞）";
  }
}

// ===== AI 分析 =====
async function analyzeMarket(marketData, news) {
  const summary = marketData.map(d =>
    `${d.coin}: $${d.price.toFixed(4)} | 24h: ${d.change24h.toFixed(2)}% | RSI: ${d.rsi.toFixed(1)} | MACD: ${d.macd.toFixed(4)}`
  ).join("\n");

  const prompt = `你是一位專業的加密貨幣交易員，請分析以下市場數據並找出最佳開單機會。

【市場數據（市值前30幣種）】
${summary}

【最新消息】
${news}

請按照以下格式回覆：

1. 市場總結（2-3句話）
2. 最佳機會（最多2個幣種）：
   - 幣種：
   - 方向：做多 或 做空
   - 信心度：1-10分
   - 理由：（技術面+消息面）
   - 建議進場價：
   - 止損價：
   - 目標價：
3. 風險提示

如果沒有明確機會，請說「目前市場無明確開單機會，建議觀望」。
信心度需達到7分以上才建議開單。`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content[0].text;
}

// ===== 判斷是否有開單機會 =====
function hasTradeSignal(analysis) {
  return analysis.includes("做多") || analysis.includes("做空");
}

function extractTradeInfo(analysis, marketData) {
  // 找出分析中提到的幣種和方向
  let coin = null, side = null;
  for (const d of marketData) {
    if (analysis.includes(d.coin)) {
      coin = d.coin;
      break;
    }
  }
  if (analysis.includes("做多")) side = "buy";
  if (analysis.includes("做空")) side = "sell";
  return { coin, side };
}

// ===== 下單 =====
async function placeOrder(instId, side, sizeUsdt) {
  try {
    // 取得當前價格
    const ticker = await axios.get(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`);
    const price = parseFloat(ticker.data.data[0].last);
    const sz = (parseFloat(sizeUsdt) / price).toFixed(6);

    const result = await okxRequest("POST", "/api/v5/trade/order", {
      instId,
      tdMode: "cash",
      side,
      ordType: "market",
      sz,
    });
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

// ===== 定時分析 =====
async function runAnalysis() {
  if (!OWNER_CHAT_ID) return;
  try {
    await bot.sendMessage(OWNER_CHAT_ID, "🔍 正在分析市場中...");
    const [marketData, news] = await Promise.all([getMarketData(), getNews()]);
    const analysis = await analyzeMarket(marketData, news);

    if (hasTradeSignal(analysis)) {
      const { coin, side } = extractTradeInfo(analysis, marketData);
      const orderId = Date.now().toString();

      if (coin && side) {
        pendingOrders[orderId] = { coin, side, instId: `${coin}-USDT`, size: DEFAULT_ORDER_SIZE };

        await bot.sendMessage(OWNER_CHAT_ID,
          `📊 *市場分析報告*\n\n${analysis}\n\n---\n💡 *發現開單機會！*\n幣種：${coin}-USDT\n方向：${side === "buy" ? "📈 做多" : "📉 做空"}\n金額：$${DEFAULT_ORDER_SIZE} USDT\n\n是否要開單？`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ 確認開單", callback_data: `confirm_${orderId}` },
                { text: "❌ 取消", callback_data: `cancel_${orderId}` }
              ]]
            }
          }
        );
      } else {
        await bot.sendMessage(OWNER_CHAT_ID, `📊 *市場分析報告*\n\n${analysis}`, { parse_mode: "Markdown" });
      }
    } else {
      await bot.sendMessage(OWNER_CHAT_ID, `📊 *市場分析報告*\n\n${analysis}`, { parse_mode: "Markdown" });
    }
  } catch (e) {
    console.error("分析錯誤：", e.message);
    await bot.sendMessage(OWNER_CHAT_ID, `❌ 分析時發生錯誤：${e.message}`);
  }
}

// ===== 處理確認/取消按鈕 =====
bot.on("callback_query", async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;

  if (data.startsWith("confirm_")) {
    const orderId = data.replace("confirm_", "");
    const order = pendingOrders[orderId];
    if (!order) return bot.answerCallbackQuery(query.id, { text: "此訂單已過期" });

    await bot.answerCallbackQuery(query.id, { text: "⏳ 下單中..." });
    await bot.sendMessage(chatId, `⏳ 正在為您開單 ${order.instId} ${order.side === "buy" ? "做多" : "做空"} $${order.size} USDT...`);

    const result = await placeOrder(order.instId, order.side, order.size);
    delete pendingOrders[orderId];

    if (result.error) {
      await bot.sendMessage(chatId, `❌ 開單失敗：${result.error}\n\n請確認 OKX API 設定是否正確。`);
    } else if (result.data && result.data[0]) {
      const r = result.data[0];
      await bot.sendMessage(chatId, `✅ *開單成功！*\n幣種：${order.instId}\n方向：${order.side === "buy" ? "📈 做多" : "📉 做空"}\n訂單ID：${r.ordId}\n狀態：${r.sCode === "0" ? "成功" : r.sMsg}`, { parse_mode: "Markdown" });
    } else {
      await bot.sendMessage(chatId, `⚠️ 開單結果：${JSON.stringify(result)}`);
    }
  }

  if (data.startsWith("cancel_")) {
    const orderId = data.replace("cancel_", "");
    delete pendingOrders[orderId];
    await bot.answerCallbackQuery(query.id, { text: "已取消" });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
    await bot.sendMessage(chatId, "❌ 已取消開單。");
  }
});

// ===== 一般聊天 =====
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  if (text === "/start") {
    return bot.sendMessage(chatId,
      `👋 *Ai投資助手* 已啟動！\n\n我會每 15 分鐘自動分析市值前 30 幣種，發現機會時通知您。\n\n📌 *指令：*\n/analyze - 立即分析\n/status - 查看狀態\n/setid - 設定通知帳號\n/clear - 清除對話\n\n直接輸入問題也可以跟我聊天！`,
      { parse_mode: "Markdown" }
    );
  }

  if (text === "/analyze") {
    await runAnalysis();
    return;
  }

  if (text === "/status") {
    return bot.sendMessage(chatId,
      `✅ *系統狀態*\n\n監控幣種：前30大市值\n分析頻率：每15分鐘\n預設開單金額：$${DEFAULT_ORDER_SIZE} USDT\n待確認訂單：${Object.keys(pendingOrders).length} 筆\nOwner ID：${OWNER_CHAT_ID || "未設定"}`,
      { parse_mode: "Markdown" }
    );
  }

  if (text === "/setid") {
    return bot.sendMessage(chatId, `您的 Chat ID 是：\`${chatId}\`\n\n請將此 ID 設定為 Railway 的 OWNER_CHAT_ID 環境變數。`, { parse_mode: "Markdown" });
  }

  if (text === "/clear") {
    conversations[chatId] = [];
    return bot.sendMessage(chatId, "✅ 對話紀錄已清除！");
  }

  // 一般對話
  if (!conversations[chatId]) conversations[chatId] = [];
  conversations[chatId].push({ role: "user", content: text });
  bot.sendChatAction(chatId, "typing");

  try {
    const res = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 800,
      system: "你是一位專業的加密貨幣投資顧問和AI助理，用繁體中文回答，回答要簡潔專業。",
      messages: conversations[chatId],
    });
    const reply = res.content[0].text;
    conversations[chatId].push({ role: "assistant", content: reply });
    if (conversations[chatId].length > 20) conversations[chatId] = conversations[chatId].slice(-20);
    bot.sendMessage(chatId, reply);
  } catch (e) {
    bot.sendMessage(chatId, "❌ 發生錯誤，請稍後再試。");
  }
});

// ===== 每15分鐘自動分析 =====
setInterval(runAnalysis, 60 * 60 * 1000);
// 啟動時先分析一次
setTimeout(runAnalysis, 5000);
