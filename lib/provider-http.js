/**
 * Provider HTTP: auto = direct first then SOCKS5; proxy = SOCKS only; direct = never SOCKS.
 */
import { SocksProxyAgent } from "socks-proxy-agent";

function readTimeoutMs() {
  const raw = Number.parseInt(process.env.HTTP_REQUEST_TIMEOUT_MS || "120000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 120000;
}

/** Read after dotenv.config() in the monitor entrypoint */
export function getCheckMaxAttempts() {
  const raw = Number.parseInt(process.env.CHECK_MAX_ATTEMPTS || "3", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

/**
 * auto — try direct HTTP, then SOCKS on failure (if SOCKS5_PROXY_URL set)
 * proxy — only SOCKS (requires SOCKS5_PROXY_URL)
 * direct — never use SOCKS
 */
export function getProviderHttpMode() {
  const m = (process.env.PROVIDER_HTTP_MODE || "auto").toLowerCase().trim();
  if (m === "proxy" || m === "socks") return "proxy";
  if (m === "direct" || m === "none" || m === "no-proxy") return "direct";
  return "auto";
}

export function mergeRequestConfig(base = {}, useProxy, socks5Url, timeoutMs = readTimeoutMs()) {
  const config = { ...base, timeout: base.timeout ?? timeoutMs };
  if (useProxy && socks5Url) {
    const agent = new SocksProxyAgent(socks5Url);
    return { ...config, httpAgent: agent, httpsAgent: agent, proxy: false };
  }
  return config;
}

/**
 * Runs requestFn(useProxy) according to PROVIDER_HTTP_MODE.
 */
export async function withDirectThenProxy(requestFn, socks5Url, debugLog = () => {}) {
  const mode = getProviderHttpMode();
  if (mode === "proxy") {
    if (!socks5Url) {
      throw new Error("PROVIDER_HTTP_MODE=proxy requires SOCKS5_PROXY_URL");
    }
    debugLog("HTTP: proxy-only (SOCKS5)");
    return await requestFn(true);
  }
  if (mode === "direct") {
    debugLog("HTTP: direct-only (no SOCKS5)");
    return await requestFn(false);
  }
  try {
    debugLog("HTTP: direct (no SOCKS5)");
    return await requestFn(false);
  } catch (err) {
    if (!socks5Url) throw err;
    debugLog("HTTP: retry via SOCKS5", err.message);
    return await requestFn(true);
  }
}

export async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Playwright/browser: defaults to PROVIDER_HTTP_MODE if PLAYWRIGHT_PROXY_MODE unset */
export function getPlaywrightProxyMode() {
  const raw = (process.env.PLAYWRIGHT_PROXY_MODE || process.env.PROVIDER_HTTP_MODE || "auto")
    .toLowerCase()
    .trim();
  if (raw === "proxy" || raw === "socks") return "proxy";
  if (raw === "direct" || raw === "none" || raw === "no-proxy") return "direct";
  return "auto";
}
