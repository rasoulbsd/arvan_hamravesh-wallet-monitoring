import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import { SocksProxyAgent } from 'socks-proxy-agent';

dotenv.config();

const EMAIL = process.env.ARVAN_EMAIL;
const PASSWORD = process.env.ARVAN_PASSWORD;
const THRESHOLD = parseInt(process.env.ARVAN_WALLET_THRESHOLD, 10);
const BOT_TOKEN = process.env.ARVAN_TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.ARVAN_TELEGRAM_CHAT_ID;
const TOPIC_ID = process.env.ARVAN_TELEGRAM_TOPIC_ID;
const CHECK_INTERVAL_HOURS_RAW = Number.parseFloat(process.env.ARVAN_CHECK_INTERVAL_HOURS || '6');
const CHECK_INTERVAL_HOURS = Number.isFinite(CHECK_INTERVAL_HOURS_RAW) && CHECK_INTERVAL_HOURS_RAW > 0 ? CHECK_INTERVAL_HOURS_RAW : 6;
const INTERVAL_MS = CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const RETRY_BASE_DELAY_SECONDS_RAW = Number.parseInt(process.env.RETRY_BASE_DELAY_SECONDS || '300', 10);
const RETRY_BASE_DELAY_SECONDS = Number.isFinite(RETRY_BASE_DELAY_SECONDS_RAW) && RETRY_BASE_DELAY_SECONDS_RAW > 0 ? RETRY_BASE_DELAY_SECONDS_RAW : 300;
const RETRY_BASE_DELAY_MS = RETRY_BASE_DELAY_SECONDS * 1000;
const MSG_LOG = './data/sent-messages.json';
const PROVIDER_KEY = 'arvan';
const SOCKS5_PROXY_URL = process.env.SOCKS5_PROXY_URL;

function debugLog(...args) {
  if (DEBUG_MODE) {
    console.log('[DEBUG][arvan]', ...args);
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

async function login() {
  debugLog('Calling Arvan login endpoint');
  const res = await axios.post('https://dejban.arvancloud.ir/v1/auth/login', {
    email: EMAIL,
    password: PASSWORD,
    captcha: 'v3.undefined'
  }, getProviderRequestConfig({
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://accounts.arvancloud.ir',
      'Referer': 'https://accounts.arvancloud.ir/',
      'x-redirect-uri': 'https://panel.arvancloud.ir/',
      'user-agent': 'Mozilla/5.0'
    }
  }));
  return res.data.data;
}

async function refreshTokenPair(accessToken, refreshToken, defaultAccount) {
  debugLog('Refreshing Arvan token pair');
  const authHeader = `Bearer ${accessToken}.${defaultAccount}`;
  const res = await axios.post('https://dejban.arvancloud.ir/v1/auth/refresh-token', {
    refreshToken
  }, getProviderRequestConfig({
    headers: {
      Authorization: authHeader,
      'Accept-Language': 'en'
    }
  }));
  return res.data.data.accessToken;
}

async function queryWallet(bearerToken) {
  debugLog('Fetching Arvan wallet balance');
  const res = await axios.get('https://napi.arvancloud.ir/resid/v1/wallets/me', getProviderRequestConfig({
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'User-Agent': 'Mozilla/5.0',
      Origin: 'https://panel.arvancloud.ir',
      Referer: 'https://panel.arvancloud.ir/'
    }
  }));
  return res.data.data;
}

async function notifyTelegram(balance) {
  const formatted = (Number(balance) / 10).toLocaleString('en-US');
  const thresholdFormatted = (Number(THRESHOLD) / 10).toLocaleString('en-US');
  const msg = `*⚠️🟦 Arvan Wallet Low Balance*\n\n\`\`\`\nTreshold: ${thresholdFormatted} T\nCurrent Balance: ${formatted} T\n\`\`\``;
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
    const { accessToken, refreshToken, defaultAccount } = await login();
    const newAccessToken = await refreshTokenPair(accessToken, refreshToken, defaultAccount);
    const wallet = await queryWallet(`${newAccessToken}.${defaultAccount}`);
    const balance = parseInt(wallet.totalBalance, 10);
    console.log(`[${new Date().toISOString()}] Arvan Wallet Balance: ${balance.toLocaleString('en-US')} IRR`);

    if (balance < THRESHOLD) {
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
  console.log(`🔁 Starting Arvan wallet monitor. Interval: every ${CHECK_INTERVAL_HOURS}h`);
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