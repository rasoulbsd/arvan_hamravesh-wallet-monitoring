/**
 * Telegram delivery style from env (per provider).
 * edit — try editMessageText on the last / sticky message (default)
 * new, always, always_new — always sendMessage
 */
export function isTelegramEditMode(envValue) {
  const v = String(envValue ?? "edit").toLowerCase().trim();
  if (v === "new" || v === "always" || v === "always_new" || v === "each" || v === "send") {
    return false;
  }
  return true;
}
