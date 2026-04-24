# Arvan & Hamravesh Wallet Monitor

This repository contains monitoring scripts for both ArvanCloud and Hamravesh wallets, organized in separate directories for clarity and maintainability.

## Structure

- `arvan/` - ArvanCloud wallet monitoring code
- `hamravesh/` - Hamravesh wallet monitoring code
- `data/` - Data storage directory
- `data/sent-messages.json` - Stores arrays of Telegram alert message IDs per provider (for deleting all alerts)

## Environment Variables

Create a `.env` file in the root with the following content:

```env
# ArvanCloud
ARVAN_EMAIL=your_arvancloud_email@example.com
ARVAN_PASSWORD=your_arvancloud_password
ARVAN_WALLET_THRESHOLD=1000000
ARVAN_TELEGRAM_BOT_TOKEN=your_arvancloud_telegram_bot_token
ARVAN_TELEGRAM_CHAT_ID=your_arvancloud_telegram_chat_id
ARVAN_TELEGRAM_TOPIC_ID=your_arvancloud_telegram_topic_id

# Optional SOCKS5 for provider APIs + Hamravesh browser export session
SOCKS5_PROXY_URL=socks5://username:password@127.0.0.1:1080
# Optional debug mode (runs immediately once with verbose logs)
DEBUG_MODE=false
# Base delay before retrying after errors (prevents request storms)
RETRY_BASE_DELAY_SECONDS=300

# Hamravesh
HAMRAVESH_EMAIL=your_hamravesh_email@example.com
HAMRAVESH_PASSWORD=your_hamravesh_password
HAMRAVESH_ACCESS_TOKEN=
HAMRAVESH_COOKIE=
HAMRAVESH_WALLET_THRESHOLD=1000000
HAMRAVESH_TELEGRAM_BOT_TOKEN=your_hamravesh_telegram_bot_token
HAMRAVESH_TELEGRAM_CHAT_ID=your_hamravesh_telegram_chat_id
HAMRAVESH_TELEGRAM_TOPIC_ID=your_hamravesh_telegram_topic_id
HAMRAVESH_CHECK_INTERVAL_HOURS=6

# Common (if your setup uses shared interval variables, adjust as needed)
ARVAN_CHECK_INTERVAL_HOURS=6
```

- Each provider can use a different Telegram bot, chat/group/channel, and threshold.
- If you use a group or channel, set the correct chat ID and bot permissions.
- `PROVIDER_HTTP_MODE` / `PLAYWRIGHT_PROXY_MODE`: **`auto`** (default) = try **direct** then SOCKS; **`direct`** = never use SOCKS; **`proxy`** = SOCKS only (`SOCKS5_PROXY_URL` required). Playwright defaults to `PLAYWRIGHT_PROXY_MODE` or falls back to `PROVIDER_HTTP_MODE`. Telegram is never proxied.
- `npm run start:hamravesh` runs the monitor with **integrated** Playwright refresh when `HAMRAVESH_MANUAL_AUTH_ONLY=true` (set `HAMRAVESH_PLAYWRIGHT_INTEGRATED=false` to disable). `npm run start:hamravesh:export` / `hamravesh:export-session` is the standalone browser export only.
- `CHECK_MAX_ATTEMPTS` (default 3): full check rounds per schedule; if all fail, a **Telegram error** is sent (Arvan/Hamravesh use their own bot/chat from `.env`). `HTTP_REQUEST_TIMEOUT_MS` defaults to 120s.
- **Playwright** (`playwright-hamravesh-login.mjs`): fills `#email` / `#password`, submits `button[name="login"]`, **re-clicks submit** up to `HAMRAVESH_LOGIN_SUBMIT_RETRIES` if the app does not leave `/login`. `HAMRAVESH_PLAYWRIGHT_HEADLESS` (default `true`). Any **uncaught** schedule failure in Arvan/Hamravesh ends with a **Telegram error** and then the normal next-interval wait.
- `DEBUG_MODE=true` runs one immediate check with detailed logs and exits.
- On errors, retries use exponential backoff starting from `RETRY_BASE_DELAY_SECONDS` up to your normal check interval.
- **Hamravesh auth:** The JSON API uses `api.hamravesh.com` (not the `console.hamravesh.com` HTML shell). Password login may return **404** if Hamravesh removed that endpoint. Use a JWT from the `user` cookie: paste the full `Cookie` header as `HAMRAVESH_COOKIE` (**must include `user=`** — a curl of `/login` before you are logged in often lacks it), or set `HAMRAVESH_ACCESS_TOKEN`. **Browser helper:** run `npm install`, `npx playwright install chromium`, then `npm run hamravesh:export-session` — log in once; cookies are saved to `hamravesh/playwright-storage.json` (gitignored) and loaded automatically when `HAMRAVESH_COOKIE` is empty. You can also set `HAMRAVESH_COOKIE_FILE` or `HAMRAVESH_PLAYWRIGHT_STORAGE`. If the login API is gone, use `HAMRAVESH_MANUAL_AUTH_ONLY=true` or `HAMRAVESH_USE_MANUAL_BALANCE_FILE=true` with `manual-balance.example.json`.

## Usage

### Locally

- **ArvanCloud:**
  ```bash
  node arvan/arvan-wallet-check.js
  ```
- **Hamravesh:**
  ```bash
  node hamravesh/hamravesh-monitor.js
  ```
  Export console cookies (after `npx playwright install chromium`): `npm run hamravesh:export-session` (uses `SOCKS5_PROXY_URL` when set)

### Docker Compose

To run both monitors in parallel:

```bash
docker-compose up --build -d
```

This will start two services:
- `arvan-monitor` (ArvanCloud)
- `hamravesh-monitor` (Hamravesh)

## Telegram Alerts

Each provider tracks all alert messages it sends in an array in `sent-messages.json`. If multiple alert messages are sent in a row (e.g., due to errors or retries), all are tracked and will be deleted when the balance is healthy.

The alert format is:

```
⚠️🟦 Arvan Wallet Low Balance
⚠️🟪 Hamravesh Wallet Low Balance
```
Treshold: 3,000,000 T (or IRR)
Current Balance: 2,382,784 T (or IRR)

The colored icon indicates the provider:
- 🟦 for Arvan
- 🟪 for Hamravesh

## Adding More Providers

To add more wallet monitors, create a new directory (e.g., `newprovider/`) and follow the same pattern with provider-specific environment variables.

## ⚙️ Features

- ✅ Periodic wallet balance checking (default: every 6 hours)
- ✅ Telegram alerts for low balance
- ✅ Configurable via `.env` file
- ✅ Self-contained, no external cron needed
- ✅ Deploy with a single Docker Compose command

---

## 📦 Requirements

- Docker
- Docker Compose
- A Telegram bot and chat ID (group or user)

---

## 🚀 Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/your-username/arvan-wallet-monitor.git
cd arvan-wallet-monitor
```

### 2. Create .env from Example
```bash
cp .env.example .env
```
Edit .env and fill in your ArvanCloud credentials and Telegram bot info.

### 3. Build and Run
```bash
docker-compose up --build -d
```
That's it. The monitor runs inside the container and checks your wallet every 6 hours by default.

## ⚙️ Environment Variables

| Variable              | Description                                                                 |
|-----------------------|-----------------------------------------------------------------------------|
| `ARVAN_EMAIL`         | Your ArvanCloud account email                                               |
| `ARVAN_PASSWORD`      | Your ArvanCloud account password                                            |
| `WALLET_THRESHOLD`    | Minimum acceptable balance in IRR (e.g., `10000000` for 1 million Toman)    |
| `CHECK_INTERVAL_HOURS`| Interval between wallet checks in hours (e.g., `6`)                         |
| `TELEGRAM_BOT_TOKEN`  | Telegram bot token from [@BotFather](https://t.me/BotFather)                |
| `TELEGRAM_CHAT_ID`    | Telegram group or user chat ID (can get from [@userinfobot](https://t.me/userinfobot)) |
| `TELEGRAM_TOPIC_ID`   | *(Optional)* Topic/thread ID if using a forum-style group                   |

## 💬 Example Telegram Message
```
⚠️🟦 Arvan Wallet Low Balance: 1,234,567 T
```
or
```
⚠️🟪 Hamravesh Wallet Low Balance: 1,234,567 IRR
```

## 🛠️ Development
To run locally without Docker:
```bash
npm install
node arvan-wallet-check.js
```

## 📄 License
This project is licensed for private/internal use only. Unauthorized distribution is prohibited.

