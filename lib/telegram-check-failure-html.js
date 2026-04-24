/** Telegram Bot API HTML parse_mode helpers for wallet check failure alerts. */

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const DETAIL_MAX = 1800;

/**
 * @param {{ providerLabel: string; httpMode: string; maxAttempts: number; detail: string }} opts
 */
export function formatWalletCheckFailureHtml(opts) {
  const { providerLabel, httpMode, maxAttempts, detail } = opts;
  const raw = String(detail ?? "").trim();
  const body = raw ? raw.slice(0, DETAIL_MAX) : "No error detail was available.";
  const escapedDetail = escapeHtml(body);
  const label = escapeHtml(providerLabel);
  const mode = escapeHtml(httpMode);
  const n = Number(maxAttempts);
  const attemptsLabel = Number.isFinite(n) && n > 0 ? String(n) : String(maxAttempts);

  return (
    `⚠️ <b>${label} wallet check failed</b>\n` +
    `HTTP mode: <code>${mode}</code> · max attempts per cycle: <b>${escapeHtml(attemptsLabel)}</b>\n\n` +
    `<blockquote>${escapedDetail}</blockquote>`
  );
}
