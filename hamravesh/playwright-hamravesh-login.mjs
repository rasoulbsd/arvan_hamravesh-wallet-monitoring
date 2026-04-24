/**
 * Shared Hamravesh console login via Playwright → storageState JSON.
 * Used by export-hamravesh-session.mjs and hamravesh-monitor.js (integrated refresh).
 */
import { chromium } from "playwright";
import { anonymizeProxy, closeAnonymizedProxy } from "proxy-chain";
import { sleep, getPlaywrightProxyMode } from "../lib/provider-http.js";

const LOGIN_URL = "https://console.hamravesh.com/login";

function loginButtonLocator(page) {
  return page.locator('button[name="login"]').first();
}

async function waitForLoggedIn(page, navMs) {
  await page.waitForFunction(
    () =>
      !window.location.pathname.includes("/login") ||
      document.cookie.includes("user="),
    { timeout: navMs }
  );
}

/**
 * Click submit and wait for redirect off /login or user= cookie; retry submit if not.
 */
async function submitLoginUntilRedirect(page, navMs, actionMs, submitRounds, log) {
  const btn = loginButtonLocator(page);
  const perWait = navMs;
  for (let s = 0; s < submitRounds; s++) {
    for (let c = 0; c < 2; c++) {
      try {
        await btn.click({ timeout: actionMs });
        break;
      } catch {
        if (c === 1) throw new Error('Could not click button[name="login"]');
        await sleep(1500);
      }
    }
    try {
      await waitForLoggedIn(page, perWait);
      return;
    } catch {
      log?.(`[playwright] No redirect after submit ${s + 1}/${submitRounds}, retrying submit…`);
      await sleep(2000);
    }
  }
  throw new Error("Hamravesh login did not redirect after submit retries");
}

async function runBrowserOnce(anonymizedUrl, options) {
  const {
    email,
    password,
    outFile,
    headless,
    navMs,
    actionMs,
    submitRounds = 3,
    log = () => {}
  } = options;

  const launchOpts = {
    headless,
    args: headless ? ["--disable-dev-shm-usage"] : []
  };
  if (headless && process.env.PLAYWRIGHT_NO_SANDBOX === "true") {
    launchOpts.args.push("--no-sandbox");
  }
  if (anonymizedUrl) {
    launchOpts.proxy = { server: anonymizedUrl };
  }

  const browser = await chromium.launch(launchOpts);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(navMs);
    page.setDefaultTimeout(actionMs);

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.locator("#email").waitFor({ state: "visible", timeout: actionMs });
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);

    await submitLoginUntilRedirect(page, navMs, actionMs, submitRounds, log);
    await sleep(3000);
    await context.storageState({ path: outFile });
  } finally {
    await browser.close();
  }
}

/**
 * One round: respects PLAYWRIGHT_PROXY_MODE / PROVIDER_HTTP_MODE (auto | proxy | direct).
 */
export async function runPlaywrightHamraveshRound(options) {
  const {
    socks5Url = (process.env.SOCKS5_PROXY_URL || "").trim(),
    proxyMode = getPlaywrightProxyMode()
  } = options;

  if (proxyMode === "proxy") {
    if (!socks5Url) throw new Error("PLAYWRIGHT_PROXY_MODE=proxy requires SOCKS5_PROXY_URL");
    let relay = null;
    try {
      relay = await anonymizeProxy(socks5Url);
      await runBrowserOnce(relay, options);
    } finally {
      if (relay) await closeAnonymizedProxy(relay, true).catch(() => {});
    }
    return;
  }

  if (proxyMode === "direct") {
    await runBrowserOnce(null, options);
    return;
  }

  // auto
  try {
    options.log?.("[playwright] Attempt without proxy…");
    await runBrowserOnce(null, options);
  } catch (e) {
    options.log?.(`[playwright] Direct failed: ${e.message}`);
    if (!socks5Url) throw e;
    let relay = null;
    try {
      options.log?.("[playwright] Attempt with SOCKS5 relay…");
      relay = await anonymizeProxy(socks5Url);
      await runBrowserOnce(relay, options);
    } finally {
      if (relay) await closeAnonymizedProxy(relay, true).catch(() => {});
    }
  }
}

/**
 * Full export: multiple rounds (export script) or single round (monitor refresh).
 */
export async function runPlaywrightHamraveshSessionSave({
  outFile,
  email,
  password,
  headless = process.env.HAMRAVESH_PLAYWRIGHT_HEADLESS !== "false",
  navMs = Number.parseInt(process.env.PLAYWRIGHT_NAV_TIMEOUT_MS || "180000", 10),
  actionMs = Number.parseInt(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS || "90000", 10),
  maxRounds = 1,
  betweenRoundsMs = Number.parseInt(process.env.HAMRAVESH_EXPORT_RETRY_DELAY_MS || "10000", 10),
  submitRounds = Number.parseInt(process.env.HAMRAVESH_LOGIN_SUBMIT_RETRIES || "3", 10),
  log = console.log
} = {}) {
  if (!email?.trim() || !password) {
    throw new Error("runPlaywrightHamraveshSessionSave: email and password required");
  }
  let lastErr;
  for (let r = 1; r <= maxRounds; r++) {
    try {
      await runPlaywrightHamraveshRound({
        socks5Url: (process.env.SOCKS5_PROXY_URL || "").trim(),
        proxyMode: getPlaywrightProxyMode(),
        email: email.trim(),
        password,
        outFile,
        headless,
        navMs,
        actionMs,
        submitRounds,
        log
      });
      return;
    } catch (e) {
      lastErr = e;
      log?.(`[playwright] Round ${r}/${maxRounds} failed: ${e.message}`);
      if (r < maxRounds) await sleep(betweenRoundsMs);
    }
  }
  throw lastErr;
}
