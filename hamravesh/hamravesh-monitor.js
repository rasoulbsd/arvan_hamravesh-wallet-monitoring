import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import {
  getCheckMaxAttempts,
  getProviderHttpMode,
  mergeRequestConfig,
  withDirectThenProxy
} from "../lib/provider-http.js";
import { isTelegramEditMode } from "../lib/telegram-notify-mode.js";
import { formatWalletCheckFailureHtml } from "../lib/telegram-check-failure-html.js";
import { runPlaywrightHamraveshSessionSave } from "./playwright-hamravesh-login.mjs";

// ES module __dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const CACHE_PATH = path.join(__dirname, "token-cache.json");
const LOGIN_PATH = "/api/v1/users/login";
const PROFILE_PATH = "/api/v2/users/profile";
const DEFAULT_API_BASE = "https://api.hamravesh.com";

// Credentials from .env (optional if HAMRAVESH_ACCESS_TOKEN or HAMRAVESH_COOKIE with user= JWT is set)
const EMAIL = process.env.HAMRAVESH_EMAIL;
const PASSWORD = process.env.HAMRAVESH_PASSWORD;
const ACCESS_TOKEN_ENV = (process.env.HAMRAVESH_ACCESS_TOKEN || "").trim();
const COOKIE_FILE_RAW = (process.env.HAMRAVESH_COOKIE_FILE || "").trim();
const PLAYWRIGHT_STORAGE_RAW = (process.env.HAMRAVESH_PLAYWRIGHT_STORAGE || "").trim();
const BROWSER_LIKE_UA =
  (process.env.HAMRAVESH_USER_AGENT || "").trim() ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
const MANUAL_AUTH_ONLY = process.env.HAMRAVESH_MANUAL_AUTH_ONLY === "true";
/** When manual auth: auto-run Playwright if JWT missing or after API auth failure (disable with false) */
const PLAYWRIGHT_INTEGRATED =
  MANUAL_AUTH_ONLY && process.env.HAMRAVESH_PLAYWRIGHT_INTEGRATED !== "false";
const USE_MANUAL_BALANCE_FILE = process.env.HAMRAVESH_USE_MANUAL_BALANCE_FILE === "true";
const MANUAL_BALANCE_PATH_RAW = (process.env.HAMRAVESH_MANUAL_BALANCE_FILE || "manual-balance.json").trim();
const MANUAL_BALANCE_PATH = path.isAbsolute(MANUAL_BALANCE_PATH_RAW)
  ? MANUAL_BALANCE_PATH_RAW
  : path.join(__dirname, MANUAL_BALANCE_PATH_RAW.replace(/^\.?\//, ""));
const CUSTOM_LOGIN_URL = (process.env.HAMRAVESH_LOGIN_URL || "").trim();
const CUSTOM_PROFILE_URL = (process.env.HAMRAVESH_PROFILE_URL || "").trim();
const API_BASE_URL = (process.env.HAMRAVESH_API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, "");
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

function getProviderRequestConfig(config = {}, useProxy = false) {
  return mergeRequestConfig(config, useProxy, SOCKS5_PROXY_URL);
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

const DEFAULT_USER_AGENT = "insomnia/11.2.0";

function resolveProjectPath(relOrAbs) {
  if (!relOrAbs) return "";
  if (path.isAbsolute(relOrAbs)) return relOrAbs;
  return path.join(process.cwd(), relOrAbs.replace(/^\.?\//, ""));
}

function cookieHeaderFromPlaywrightStorage(storagePath) {
  const abs = resolveProjectPath(storagePath);
  if (!fs.existsSync(abs)) {
    debugLog("Playwright storage file not found:", abs);
    return "";
  }
  const state = JSON.parse(fs.readFileSync(abs, "utf8"));
  const cookies = state.cookies || [];
  const relevant = cookies.filter((c) => {
    const d = (c.domain || "").replace(/^\./, "");
    return d === "hamravesh.com" || d.endsWith(".hamravesh.com");
  });
  if (!relevant.length) return "";
  return relevant.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Cookie header: env > cookie file > Playwright storageState (see npm run hamravesh:export-session). */
function getCookieHeader() {
  const envCookie = (process.env.HAMRAVESH_COOKIE || "").trim();
  if (envCookie) return envCookie;
  if (COOKIE_FILE_RAW) {
    const fp = resolveProjectPath(COOKIE_FILE_RAW);
    if (fs.existsSync(fp)) {
      return fs.readFileSync(fp, "utf8").trim().replace(/\r?\n/g, "");
    }
    debugLog("HAMRAVESH_COOKIE_FILE not found:", fp);
  }
  if (PLAYWRIGHT_STORAGE_RAW) {
    const fromPw = cookieHeaderFromPlaywrightStorage(PLAYWRIGHT_STORAGE_RAW);
    if (fromPw) return fromPw;
  }
  const defaultPw = path.join(__dirname, "playwright-storage.json");
  if (fs.existsSync(defaultPw)) {
    return cookieHeaderFromPlaywrightStorage(defaultPw);
  }
  return "";
}

function buildCommonHeaders(extra = {}) {
  const cookie = getCookieHeader();
  const useBrowserUa = Boolean(cookie || ACCESS_TOKEN_ENV);
  const headers = {
    "User-Agent": useBrowserUa ? BROWSER_LIKE_UA : DEFAULT_USER_AGENT,
    ...extra
  };
  if (cookie) {
    headers.Cookie = cookie;
  }
  return headers;
}

/** Console stores auth in a `user` cookie: URL-encoded JSON with token, tokenType, refreshToken. */
function parseUserPayloadFromCookieHeader(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== "string") return null;
  const m = cookieHeader.match(/\buser=([^;]*)/);
  if (!m) return null;
  let raw = m[1].trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep raw if decode fails
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isLikelyJwt(value) {
  return typeof value === "string" && value.split(".").length === 3;
}

function authorizationHeaderForToken(token) {
  const scheme = isLikelyJwt(token) ? "Bearer" : "Token";
  return `${scheme} ${token}`;
}

function extractAccessTokenFromLoginBody(body) {
  if (!body || typeof body !== "object") return null;
  return (
    body.key ||
    body.token ||
    body.access_token ||
    body.accessToken ||
    body.data?.token ||
    body.data?.access_token ||
    body.data?.accessToken ||
    null
  );
}

function extractRefreshTokenFromLoginBody(body) {
  if (!body || typeof body !== "object") return null;
  return body.refresh_token || body.refreshToken || body.data?.refresh_token || body.data?.refreshToken || null;
}

function readTokenCache() {
  try {
    const data = fs.readFileSync(CACHE_PATH, "utf8");
    const json = JSON.parse(data);
    const accessToken = json.accessToken || json.token || null;
    const refreshToken = json.refreshToken || null;
    if (!accessToken) return null;
    return { accessToken, refreshToken };
  } catch {
    return null;
  }
}

function writeTokenCache(accessToken, refreshToken = null) {
  const payload = { accessToken };
  if (refreshToken) payload.refreshToken = refreshToken;
  fs.writeFileSync(CACHE_PATH, JSON.stringify(payload), "utf8");
}

function pickStaticAccessToken() {
  if (ACCESS_TOKEN_ENV) return ACCESS_TOKEN_ENV;
  const user = parseUserPayloadFromCookieHeader(getCookieHeader());
  if (user && typeof user.token === "string" && user.token) return user.token;
  return null;
}

function getPlaywrightStorageOutputPath() {
  if (PLAYWRIGHT_STORAGE_RAW) return resolveProjectPath(PLAYWRIGHT_STORAGE_RAW);
  return path.join(__dirname, "playwright-storage.json");
}

function isLikelyAuthFailure(err) {
  const s = err.response?.status;
  if (s === 401 || s === 403) return true;
  return /401|403|jwt|session|auth/i.test(String(err.message || ""));
}

/** Option A: fail fast if manual auth but no JWT and no way to refresh (no integrated Playwright / no credentials). */
function ensureManualAuthPrereqsOrExit() {
  if (!MANUAL_AUTH_ONLY || USE_MANUAL_BALANCE_FILE) return;
  if (PLAYWRIGHT_INTEGRATED && EMAIL && PASSWORD) return;
  const cookie = getCookieHeader();
  const jwtFromCookie = parseUserPayloadFromCookieHeader(cookie)?.token;
  if (ACCESS_TOKEN_ENV || jwtFromCookie) return;
  const pwDefault = path.join(__dirname, "playwright-storage.json");
  console.error("Hamravesh: HAMRAVESH_MANUAL_AUTH_ONLY=true but no JWT is available yet.");
  console.error("Enable integrated Playwright (default) with HAMRAVESH_EMAIL/PASSWORD, or run:");
  console.error("  npx playwright install chromium");
  console.error("  npm run hamravesh:export-session");
  console.error(`Creates (gitignored): ${pwDefault}`);
  process.exit(1);
}

function getLoginUrl() {
  if (CUSTOM_LOGIN_URL) return CUSTOM_LOGIN_URL;
  return `${API_BASE_URL}${LOGIN_PATH}`;
}

function getProfileUrl() {
  if (CUSTOM_PROFILE_URL) return CUSTOM_PROFILE_URL;
  return `${API_BASE_URL}${PROFILE_PATH}`;
}

/** console.hamravesh.com is the SPA shell; POST /api/... there returns S3/XML errors, not JSON. */
function explainHamraveshResponseError(err) {
  const data = err.response?.data;
  const status = err.response?.status;
  if (typeof data === "string") {
    const t = data.trim();
    if (t.startsWith("<?xml") || t.includes("<Error>") || t.includes("<Code>BadRequest</Code>")) {
      return `Hamravesh returned XML/HTML (HTTP ${status}) instead of a JSON API response — wrong host or path. Use api.hamravesh.com, or set HAMRAVESH_LOGIN_URL / HAMRAVESH_PROFILE_URL from DevTools. Do not use console.hamravesh.com for these API paths.`;
    }
  }
  return null;
}

function readManualBalanceIrr() {
  if (!fs.existsSync(MANUAL_BALANCE_PATH)) {
    throw new Error(
      `HAMRAVESH_USE_MANUAL_BALANCE_FILE=true but file missing: ${MANUAL_BALANCE_PATH}`
    );
  }
  const data = JSON.parse(fs.readFileSync(MANUAL_BALANCE_PATH, "utf8"));
  const balance = data.balanceIrr ?? data.balance ?? data.irr;
  if (typeof balance !== "number" || !Number.isFinite(balance)) {
    throw new Error(
      `${MANUAL_BALANCE_PATH}: expected numeric balanceIrr or balance (got ${typeof balance})`
    );
  }
  return balance;
}

async function loginAndGetToken(useProxy = false) {
  if (MANUAL_AUTH_ONLY) {
    throw new Error(
      "HAMRAVESH_MANUAL_AUTH_ONLY=true: password login is disabled. Set HAMRAVESH_ACCESS_TOKEN or HAMRAVESH_COOKIE (browser session JWT)."
    );
  }
  if (!EMAIL || !PASSWORD) {
    throw new Error(
      "No credentials: set HAMRAVESH_EMAIL and HAMRAVESH_PASSWORD, or use HAMRAVESH_ACCESS_TOKEN / HAMRAVESH_COOKIE (user JWT)."
    );
  }
  const url = getLoginUrl();
  debugLog("POST login", url, useProxy ? "(SOCKS5)" : "(direct)");
  try {
    const options = {
      method: "POST",
      url,
      headers: buildCommonHeaders({ "Content-Type": "application/json" }),
      data: {
        captcha: null,
        client_time: String(Date.now()),
        identity: EMAIL,
        password: PASSWORD
      }
    };
    const response = await axios.request(getProviderRequestConfig(options, useProxy));
    const access = extractAccessTokenFromLoginBody(response.data);
    const refresh = extractRefreshTokenFromLoginBody(response.data);
    if (access) {
      writeTokenCache(access, refresh);
      return access;
    }
    throw new Error("Login failed: No token in response (expected key, token, or access_token)");
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) {
      throw new Error(
        `Hamravesh login returned 404 (API removed). Use JWT auth: paste Cookie from DevTools that includes user=… (not only analytics cookies), or run npm run hamravesh:export-session. Or set HAMRAVESH_LOGIN_URL / HAMRAVESH_USE_MANUAL_BALANCE_FILE=true. URL tried: ${url}`
      );
    }
    const explained = explainHamraveshResponseError(err);
    if (explained) throw new Error(explained);
    throw err;
  }
}

async function fetchProfile(token, useProxy = false) {
  const url = getProfileUrl();
  debugLog("GET profile", url, useProxy ? "(SOCKS5)" : "(direct)");
  try {
    const options = {
      method: "GET",
      url,
      headers: buildCommonHeaders({
        Authorization: authorizationHeaderForToken(token)
      })
    };
    return await axios.request(getProviderRequestConfig(options, useProxy));
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) throw err;
    const explained = explainHamraveshResponseError(err);
    if (explained) throw new Error(explained);
    throw err;
  }
}

async function notifyTelegram(balance) {
  const editMode = isTelegramEditMode(process.env.HAMRAVESH_TELEGRAM_NOTIFY_MODE);
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
  const editMode = isTelegramEditMode(process.env.HAMRAVESH_TELEGRAM_NOTIFY_MODE);
  const detail =
    explainHamraveshResponseError(err) ||
    (err?.response?.data != null
      ? JSON.stringify(err.response.data).slice(0, 2000)
      : String(err?.message || err).slice(0, 2000));
  const text = formatWalletCheckFailureHtml({
    providerLabel: "Hamravesh",
    httpMode: getProviderHttpMode(),
    maxAttempts: getCheckMaxAttempts(),
    detail
  });
  const payload = { chat_id: CHAT_ID, text, parse_mode: "HTML" };
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
    console.warn("[WARN] Could not send failure Telegram:", e.message);
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

async function runHamraveshApiCheck(useProxy) {
  let token =
    pickStaticAccessToken() ||
    (MANUAL_AUTH_ONLY ? null : readTokenCache()?.accessToken) ||
    null;

  if (!token) {
    const cookieStr = getCookieHeader();
    if (
      cookieStr &&
      !parseUserPayloadFromCookieHeader(cookieStr) &&
      !ACCESS_TOKEN_ENV
    ) {
      throw new Error(
        "Hamravesh: cookie/Playwright storage has no user= JWT. Run npm run hamravesh:export-session or set HAMRAVESH_ACCESS_TOKEN."
      );
    }
    if (MANUAL_AUTH_ONLY) {
      throw new Error(
        "HAMRAVESH_MANUAL_AUTH_ONLY=true: set HAMRAVESH_ACCESS_TOKEN or JWT cookie, or run npm run hamravesh:export-session."
      );
    }
    token = await loginAndGetToken(useProxy);
  }

  let profile;
  try {
    const response = await fetchProfile(token, useProxy);
    profile = response.data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      debugLog("Auth rejected, clearing token cache");
      try {
        fs.unlinkSync(CACHE_PATH);
      } catch {
        // ignore
      }
      if (EMAIL && PASSWORD && !MANUAL_AUTH_ONLY) {
        token = await loginAndGetToken(useProxy);
        const retry = await fetchProfile(token, useProxy);
        profile = retry.data;
      } else {
        throw new Error(
          MANUAL_AUTH_ONLY
            ? "Hamravesh returned 401/403. Refresh session (export-session) or HAMRAVESH_ACCESS_TOKEN."
            : "Hamravesh returned 401/403. Refresh HAMRAVESH_ACCESS_TOKEN or HAMRAVESH_COOKIE, or fix login."
        );
      }
    } else {
      throw err;
    }
  }
  const org = profile.organizations && profile.organizations[0];
  const balance = org ? org.balance : null;
  console.log(
    `[${new Date().toISOString()}] Hamravesh Wallet Balance: ${balance?.toLocaleString("en-US") || "N/A"} IRR`
  );
  if (balance !== null && balance < THRESHOLD) {
    console.log(`❗ Balance below threshold (${THRESHOLD})`);
    await notifyTelegram(balance);
  } else {
    console.log(`✅ Balance is healthy. Deleting old alert messages if any.`);
    await deleteOldMessages();
  }
}

/** @param {{ notifyFailure?: boolean }} [opts] If false, skips Telegram after all HTTP retries (e.g. backoff re-runs between scheduled intervals). */
async function checkWalletOnce({ notifyFailure = true } = {}) {
  let lastErr;
  try {
    debugLog("Starting wallet check cycle");
    if (USE_MANUAL_BALANCE_FILE) {
      const balance = readManualBalanceIrr();
      console.log(
        `[${new Date().toISOString()}] Hamravesh Wallet Balance (manual file): ${balance.toLocaleString("en-US")} IRR`
      );
      if (balance < THRESHOLD) {
        console.log(`❗ Balance below threshold (${THRESHOLD})`);
        await notifyTelegram(balance);
      } else {
        console.log(`✅ Balance is healthy. Deleting old alert messages if any.`);
        await deleteOldMessages();
      }
      return true;
    }

    const storagePath = getPlaywrightStorageOutputPath();
    if (PLAYWRIGHT_INTEGRATED && EMAIL && PASSWORD && !pickStaticAccessToken()) {
      console.log("[hamravesh] No JWT yet; running integrated Playwright session save…");
      await runPlaywrightHamraveshSessionSave({
        outFile: storagePath,
        email: EMAIL,
        password: PASSWORD,
        maxRounds: 1,
        log: (m) => (m ? console.log(m) : undefined)
      });
    }

    const maxAttempts = getCheckMaxAttempts();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let playwrightRefreshDone = false;
      while (true) {
        try {
          await withDirectThenProxy(runHamraveshApiCheck, SOCKS5_PROXY_URL, debugLog);
          return true;
        } catch (err) {
          lastErr = err;
          const xmlHint = explainHamraveshResponseError(err);
          console.error(
            `[ERROR] Hamravesh attempt ${attempt}/${maxAttempts}`,
            xmlHint || err.response?.data || err.message
          );

          if (
            !playwrightRefreshDone &&
            PLAYWRIGHT_INTEGRATED &&
            EMAIL &&
            PASSWORD &&
            isLikelyAuthFailure(err)
          ) {
            playwrightRefreshDone = true;
            try {
              console.log("[hamravesh] Auth error; refreshing session via Playwright…");
              await runPlaywrightHamraveshSessionSave({
                outFile: storagePath,
                email: EMAIL,
                password: PASSWORD,
                maxRounds: 1,
                log: (m) => (m ? console.log(m) : undefined)
              });
              continue;
            } catch (pwErr) {
              lastErr = pwErr;
              console.error("[hamravesh] Playwright refresh failed:", pwErr.message);
            }
          }
          break;
        }
      }
      if (attempt < maxAttempts) {
        await sleep(RETRY_BASE_DELAY_MS);
      }
    }
    if (notifyFailure) await notifyTelegramCheckFailure(lastErr);
    return false;
  } catch (err) {
    const xmlHint = explainHamraveshResponseError(err);
    console.error("[ERROR]", xmlHint || err.response?.data || err.message);
    if (notifyFailure) await notifyTelegramCheckFailure(err);
    return false;
  }
}

async function startLoop() {
  ensureManualAuthPrereqsOrExit();
  console.log(`🔁 Starting Hamravesh wallet monitor. Interval: every ${CHECK_INTERVAL_HOURS}h`);
  if (USE_MANUAL_BALANCE_FILE) {
    console.log(`📄 Using manual balance file: ${MANUAL_BALANCE_PATH} (no Hamravesh API calls for balance).`);
  }
  if (
    !(process.env.HAMRAVESH_COOKIE || "").trim() &&
    !COOKIE_FILE_RAW &&
    (PLAYWRIGHT_STORAGE_RAW || fs.existsSync(path.join(__dirname, "playwright-storage.json")))
  ) {
    console.log(
      "🎭 Loading cookies from Playwright storage (HAMRAVESH_COOKIE unset). See npm run hamravesh:export-session."
    );
  }
  if (MANUAL_AUTH_ONLY) {
    console.log("🔐 HAMRAVESH_MANUAL_AUTH_ONLY: API password login disabled.");
    if (PLAYWRIGHT_INTEGRATED) {
      console.log("🎭 Integrated Playwright session refresh is ON (set HAMRAVESH_PLAYWRIGHT_INTEGRATED=false to disable).");
    }
  }
  console.log(`🌐 Provider HTTP mode: ${getProviderHttpMode()} (PROVIDER_HTTP_MODE=auto|direct|proxy)`);
  console.log(
    `💬 Telegram notify: ${isTelegramEditMode(process.env.HAMRAVESH_TELEGRAM_NOTIFY_MODE) ? "edit" : "new"} (HAMRAVESH_TELEGRAM_NOTIFY_MODE=edit|new)`
  );
  if (DEBUG_MODE) {
    console.log('🐛 DEBUG_MODE enabled: running immediately once with verbose logs.');
    await checkWalletOnce();
    return;
  }

  let consecutiveFailures = 0;
  while (true) {
    const cycleStart = Date.now();
    // One failure Telegram per outage streak: not on each backoff retry before the next success.
    const isSuccess = await checkWalletOnce({ notifyFailure: consecutiveFailures === 0 });

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