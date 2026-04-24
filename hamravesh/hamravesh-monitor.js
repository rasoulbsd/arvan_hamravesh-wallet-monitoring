import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import { SocksProxyAgent } from 'socks-proxy-agent';

// ES module __dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const CACHE_PATH = path.join(__dirname, "token-cache.json");
const LOGIN_URL = "https://api.hamravesh.com/api/v1/users/login";
const PROFILE_URL = "https://api.hamravesh.com/api/v2/users/profile";

// Credentials from .env
const EMAIL = process.env.HAMRAVESH_EMAIL;
const PASSWORD = process.env.HAMRAVESH_PASSWORD;
const BOT_TOKEN = process.env.HAMRAVESH_TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.HAMRAVESH_TELEGRAM_CHAT_ID;
const TOPIC_ID = process.env.HAMRAVESH_TELEGRAM_TOPIC_ID;
const THRESHOLD = parseInt(process.env.HAMRAVESH_WALLET_THRESHOLD, 10);
const CHECK_INTERVAL_HOURS_RAW = Number.parseFloat(process.env.HAMRAVESH_CHECK_INTERVAL_HOURS || '6');
const CHECK_INTERVAL_HOURS = Number.isFinite(CHECK_INTERVAL_HOURS_RAW) && CHECK_INTERVAL_HOURS_RAW > 0 ? CHECK_INTERVAL_HOURS_RAW : 6;
const INTERVAL_MS = CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const RETRY_BASE_DELAY_SECONDS_RAW = Number.parseInt(process.env.RETRY_BASE_DELAY_SECONDS || '300', 10);
const RETRY_BASE_DELAY_SECONDS = Number.isFinite(RETRY_BASE_DELAY_SECONDS_RAW) && RETRY_BASE_DELAY_SECONDS_RAW > 0 ? RETRY_BASE_DELAY_SECONDS_RAW : 300;
const RETRY_BASE_DELAY_MS = RETRY_BASE_DELAY_SECONDS * 1000;
const MSG_LOG = './data/sent-messages.json';
const PROVIDER_KEY = 'hamravesh';
const SOCKS5_PROXY_URL = process.env.SOCKS5_PROXY_URL;

function debugLog(...args) {
  if (DEBUG_MODE) {
    console.log('[DEBUG][hamravesh]', ...args);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getProviderRequestConfig(config = {}) {
  if (!SOCKS5_PROXY_URL) return config;
  const agent = new SocksProxyAgent(SOCKS5_PROXY_URL);
  return {
    ...config,
    httpAgent: agent,
    httpsAgent: agent,
    proxy: false
  };
}

function saveMessageId(id) {
  try {
    // Ensure data directory exists
    const dataDir = './data';
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    let data = {};
    if (fs.existsSync(MSG_LOG)) {
      data = JSON.parse(fs.readFileSync(MSG_LOG));
    }
    if (!data[PROVIDER_KEY]) data[PROVIDER_KEY] = { ids: [] };
    if (!Array.isArray(data[PROVIDER_KEY].ids)) data[PROVIDER_KEY].ids = [];
    data[PROVIDER_KEY].ids.push(id);
    fs.writeFileSync(MSG_LOG, JSON.stringify(data), "utf8");
  } catch (err) {
    console.warn('[WARN] Could not save message ID:', err.message);
  }
}

function getSavedMessageIds() {
  try {
    if (!fs.existsSync(MSG_LOG)) return [];
    const data = JSON.parse(fs.readFileSync(MSG_LOG));
    return data[PROVIDER_KEY]?.ids || [];
  } catch (err) {
    console.warn('[WARN] Could not read message log:', err.message);
    return [];
  }
}

function clearMessageLog() {
  try {
    let data = {};
    if (fs.existsSync(MSG_LOG)) {
      data = JSON.parse(fs.readFileSync(MSG_LOG));
    }
    delete data[PROVIDER_KEY];
    fs.writeFileSync(MSG_LOG, JSON.stringify(data), "utf8");
  } catch (err) {
    console.warn('[WARN] Could not clear message log:', err.message);
  }
}

const COMMON_HEADERS = {
  cookie: process.env.HAMRAVESH_COOKIE,
  "User-Agent": "insomnia/11.2.0"
};

function readTokenCache() {
  try {
    const data = fs.readFileSync(CACHE_PATH, "utf8");
    const json = JSON.parse(data);
    return json.token || null;
  } catch {
    return null;
  }
}

function writeTokenCache(token) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify({ token }), "utf8");
}

async function loginAndGetToken() {
  debugLog('Calling Hamravesh login endpoint');
  const options = {
    method: "POST",
    url: LOGIN_URL,
    headers: { ...COMMON_HEADERS, "Content-Type": "application/json" },
    data: {
      captcha: null,
      client_time: String(Date.now()),
      identity: EMAIL,
      password: PASSWORD
    }
  };
  const response = await axios.request(getProviderRequestConfig(options));
  if (response.data && response.data.key) {
    writeTokenCache(response.data.key);
    return response.data.key;
  }
  throw new Error("Login failed: No token in response");
}

async function fetchProfile(token) {
  debugLog('Fetching Hamravesh profile');
  const options = {
    method: "GET",
    url: PROFILE_URL,
    headers: {
      ...COMMON_HEADERS,
      authorization: `Token ${token}`
    }
  };
  return axios.request(getProviderRequestConfig(options));
}

async function notifyTelegram(balance) {
  const formatted = Number(balance).toLocaleString('en-US');
  const thresholdFormatted = Number(THRESHOLD).toLocaleString('en-US');
  const msg = `*⚠️🟪 Hamravesh Wallet Low Balance*\n\n\`\`\`\nTreshold: ${thresholdFormatted} IRR\nCurrent Balance: ${formatted} IRR\n\`\`\``;
  const payload = {
    chat_id: CHAT_ID,
    text: msg,
    parse_mode: 'Markdown'
  };
  if (TOPIC_ID) payload.message_thread_id = parseInt(TOPIC_ID);

  const prevMsgIds = getSavedMessageIds();
  let messageId;
  if (prevMsgIds.length > 0) {
    // Try to edit the last message
    const prevMsgId = prevMsgIds[prevMsgIds.length - 1];
    try {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        ...payload,
        message_id: prevMsgId
      });
      messageId = prevMsgId;
    } catch (err) {
      // If edit fails (e.g., message deleted), send a new one
      const res = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, payload);
      messageId = res.data.result.message_id;
    }
  } else {
    const res = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, payload);
    messageId = res.data.result.message_id;
  }
  saveMessageId(messageId);
}

async function deleteOldMessages() {
  const msgIds = getSavedMessageIds();
  if (!msgIds.length) return;
  for (const msgId of msgIds) {
    try {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
        chat_id: CHAT_ID,
        message_id: msgId
      });
      console.log(`✅ Deleted alert message: ${msgId}`);
    } catch (err) {
      console.warn(`⚠️ Could not delete message ${msgId}:`, err.response?.data || err.message);
    }
  }
  clearMessageLog();
}

async function checkWalletOnce() {
  try {
    debugLog('Starting wallet check cycle');
    let token = readTokenCache();
    let triedLogin = false;
    let profile;
    while (true) {
      try {
        if (!token) {
          if (triedLogin) throw new Error("No token and login already tried.");
          token = await loginAndGetToken();
          triedLogin = true;
        }
        const response = await fetchProfile(token);
        profile = response.data;
        break; // Success!
      } catch (err) {
        if (!triedLogin) {
          token = null;
          continue;
        }
        throw err;
      }
    }
    // Assume balance is in profile.organizations[0].balance
    const org = profile.organizations && profile.organizations[0];
    const balance = org ? org.balance : null;
    console.log(`[${new Date().toISOString()}] Hamravesh Wallet Balance: ${balance?.toLocaleString('en-US') || 'N/A'} IRR`);
    if (balance !== null && balance < THRESHOLD) {
      console.log(`❗ Balance below threshold (${THRESHOLD})`);
      await notifyTelegram(balance);
    } else {
      console.log(`✅ Balance is healthy. Deleting old alert messages if any.`);
      await deleteOldMessages();
    }
    return true;
  } catch (err) {
    console.error('[ERROR]', err.response?.data || err.message);
    return false;
  }
}

async function startLoop() {
  console.log(`🔁 Starting Hamravesh wallet monitor. Interval: every ${CHECK_INTERVAL_HOURS}h`);
  if (DEBUG_MODE) {
    console.log('🐛 DEBUG_MODE enabled: running immediately once with verbose logs.');
    await checkWalletOnce();
    return;
  }

  let consecutiveFailures = 0;
  while (true) {
    const cycleStart = Date.now();
    const isSuccess = await checkWalletOnce();

    let delayMs = INTERVAL_MS;
    if (!isSuccess) {
      consecutiveFailures += 1;
      const backoffDelay = RETRY_BASE_DELAY_MS * (2 ** (consecutiveFailures - 1));
      delayMs = Math.min(INTERVAL_MS, backoffDelay);
      console.warn(`⚠️ Check failed (${consecutiveFailures} consecutive). Next retry in ${Math.round(delayMs / 1000)}s`);
    } else {
      consecutiveFailures = 0;
    }

    const elapsedMs = Date.now() - cycleStart;
    const waitMs = Math.max(0, delayMs - elapsedMs);
    debugLog(`Sleeping ${Math.round(waitMs / 1000)}s before next cycle`);
    await sleep(waitMs);
  }
}

startLoop(); 