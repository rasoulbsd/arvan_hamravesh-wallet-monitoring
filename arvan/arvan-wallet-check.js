import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import {
  getCheckMaxAttempts,
  getProviderHttpMode,
  mergeRequestConfig,
  withDirectThenProxy,
  sleep
} from '../lib/provider-http.js';
import { isTelegramEditMode } from '../lib/telegram-notify-mode.js';
import { formatWalletCheckFailureHtml } from '../lib/telegram-check-failure-html.js';

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

function getProviderRequestConfig(extra = {}, useProxy) {
  return mergeRequestConfig(extra, useProxy, SOCKS5_PROXY_URL);
}

function saveMessageId(id) {
  try {
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

function loadMsgLog() {
  try {
    if (!fs.existsSync(MSG_LOG)) return {};
    return JSON.parse(fs.readFileSync(MSG_LOG, "utf8"));
  } catch {
    return {};
  }
}

function getFailureMessageId() {
  return loadMsgLog()[PROVIDER_KEY]?.failureMessageId ?? null;
}

function setFailureMessageId(id) {
  const data = loadMsgLog();
  if (!data[PROVIDER_KEY]) data[PROVIDER_KEY] = { ids: [] };
  if (!Array.isArray(data[PROVIDER_KEY].ids)) data[PROVIDER_KEY].ids = [];
  data[PROVIDER_KEY].failureMessageId = id;
  fs.writeFileSync(MSG_LOG, JSON.stringify(data), "utf8");
}

async function login(useProxy) {
  debugLog('Calling Arvan login endpoint', useProxy ? '(SOCKS5)' : '(direct)');
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
  }, useProxy));
  return res.data.data;
}

async function refreshTokenPair(accessToken, refreshToken, defaultAccount, useProxy) {
  debugLog('Refreshing Arvan token pair');
  const authHeader = `Bearer ${accessToken}.${defaultAccount}`;
  const res = await axios.post('https://dejban.arvancloud.ir/v1/auth/refresh-token', {
    refreshToken
  }, getProviderRequestConfig({
    headers: {
      Authorization: authHeader,
      'Accept-Language': 'en'
    }
  }, useProxy));
  return res.data.data.accessToken;
}

async function queryWallet(bearerToken, useProxy) {
  debugLog('Fetching Arvan wallet balance');
  const res = await axios.get('https://napi.arvancloud.ir/resid/v1/wallets/me', getProviderRequestConfig({
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'User-Agent': 'Mozilla/5.0',
      Origin: 'https://panel.arvancloud.ir',
      Referer: 'https://panel.arvancloud.ir/'
    }
  }, useProxy));
  return res.data.data;
}

async function notifyTelegram(balance) {
  const editMode = isTelegramEditMode(process.env.ARVAN_TELEGRAM_NOTIFY_MODE);
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
  if (editMode && prevMsgIds.length > 0) {
    const prevMsgId = prevMsgIds[prevMsgIds.length - 1];
    try {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        ...payload,
        message_id: prevMsgId
      });
      return;
    } catch {
      // fall through to new message
    }
  }
  const res = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, payload);
  saveMessageId(res.data.result.message_id);
}

async function notifyTelegramCheckFailure(err) {
  const editMode = isTelegramEditMode(process.env.ARVAN_TELEGRAM_NOTIFY_MODE);
  const detail = err?.response?.data
    ? JSON.stringify(err.response.data).slice(0, 2000)
    : String(err?.message || err).slice(0, 2000);
  const text = formatWalletCheckFailureHtml({
    providerLabel: "Arvan",
    httpMode: getProviderHttpMode(),
    maxAttempts: getCheckMaxAttempts(),
    detail
  });
  const payload = {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML"
  };
  if (TOPIC_ID) payload.message_thread_id = parseInt(TOPIC_ID, 10);
  try {
    const fid = getFailureMessageId();
    if (editMode && fid) {
      try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
          ...payload,
          message_id: fid
        });
        return;
      } catch {
        // send new below
      }
    }
    const res = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, payload);
    setFailureMessageId(res.data.result.message_id);
  } catch (e) {
    console.warn('[WARN] Could not send failure Telegram:', e.message);
  }
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

async function runArvanCheckWithProxy(useProxy) {
  const { accessToken, refreshToken, defaultAccount } = await login(useProxy);
  const newAccessToken = await refreshTokenPair(accessToken, refreshToken, defaultAccount, useProxy);
  const wallet = await queryWallet(`${newAccessToken}.${defaultAccount}`, useProxy);
  const balance = parseInt(wallet.totalBalance, 10);
  console.log(`[${new Date().toISOString()}] Arvan Wallet Balance: ${balance.toLocaleString('en-US')} IRR`);

  if (balance < THRESHOLD) {
    console.log(`❗ Balance below threshold (${THRESHOLD})`);
    await notifyTelegram(balance);
  } else {
    console.log(`✅ Balance is healthy. Deleting old alert messages if any.`);
    await deleteOldMessages();
  }
}

async function checkWalletOnce() {
  try {
    const maxAttempts = getCheckMaxAttempts();
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await withDirectThenProxy(runArvanCheckWithProxy, SOCKS5_PROXY_URL, debugLog);
        return true;
      } catch (err) {
        lastErr = err;
        console.error(`[ERROR] Arvan attempt ${attempt}/${maxAttempts}`, err.response?.data || err.message);
        if (attempt < maxAttempts) {
          await sleep(RETRY_BASE_DELAY_MS);
        }
      }
    }
    await notifyTelegramCheckFailure(lastErr);
    return false;
  } catch (err) {
    await notifyTelegramCheckFailure(err);
    return false;
  }
}

async function startLoop() {
  console.log(`🔁 Starting Arvan wallet monitor. Interval: every ${CHECK_INTERVAL_HOURS}h`);
  console.log(`🌐 Provider HTTP mode: ${getProviderHttpMode()} (PROVIDER_HTTP_MODE=auto|direct|proxy)`);
  console.log(
    `💬 Telegram notify: ${isTelegramEditMode(process.env.ARVAN_TELEGRAM_NOTIFY_MODE) ? "edit" : "new"} (ARVAN_TELEGRAM_NOTIFY_MODE=edit|new)`
  );
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
