/**
 * CLI: Hamravesh Playwright session → storageState JSON
 * Uses hamravesh/playwright-hamravesh-login.mjs (same logic as integrated monitor refresh).
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import axios from "axios";
import { runPlaywrightHamraveshSessionSave } from "./playwright-hamravesh-login.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const outFile =
  (process.env.HAMRAVESH_PLAYWRIGHT_STORAGE || "").trim() ||
  path.join(__dirname, "playwright-storage.json");

const EMAIL = (process.env.HAMRAVESH_EMAIL || "").trim();
const PASSWORD = process.env.HAMRAVESH_PASSWORD || "";
const HEADLESS = process.env.HAMRAVESH_PLAYWRIGHT_HEADLESS !== "false";
const EXPORT_ROUNDS_RAW = Number.parseInt(
  process.env.HAMRAVESH_EXPORT_MAX_ATTEMPTS || process.env.CHECK_MAX_ATTEMPTS || "3",
  10
);
const EXPORT_ROUNDS =
  Number.isFinite(EXPORT_ROUNDS_RAW) && EXPORT_ROUNDS_RAW > 0 ? EXPORT_ROUNDS_RAW : 3;

const BOT_TOKEN = process.env.HAMRAVESH_TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.HAMRAVESH_TELEGRAM_CHAT_ID;
const TOPIC_ID = process.env.HAMRAVESH_TELEGRAM_TOPIC_ID;

async function notifyExportFailure(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("[export] No Telegram credentials; skipping failure notification.");
    return;
  }
  const payload = {
    chat_id: CHAT_ID,
    text: String(message).slice(0, 4000)
  };
  if (TOPIC_ID) payload.message_thread_id = parseInt(TOPIC_ID, 10);
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, payload, { timeout: 60000 });
  } catch (e) {
    console.warn("[export] Telegram notify failed:", e.message);
  }
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error("Set HAMRAVESH_EMAIL and HAMRAVESH_PASSWORD in .env");
    process.exit(1);
  }

  console.log("Hamravesh — automated session export");
  console.log("Output:", outFile);
  console.log("Headless:", HEADLESS);

  try {
    await runPlaywrightHamraveshSessionSave({
      outFile,
      email: EMAIL,
      password: PASSWORD,
      headless: HEADLESS,
      maxRounds: EXPORT_ROUNDS,
      log: console.log
    });
    console.log("Done. Monitor loads this file when HAMRAVESH_COOKIE is unset.");
  } catch (lastErr) {
    const msg = `Hamravesh export-session failed after ${EXPORT_ROUNDS} rounds.\nLast error: ${lastErr?.message || lastErr}`;
    await notifyExportFailure(msg);
    console.error(msg);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
