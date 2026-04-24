# Debian-based: Playwright Chromium needs glibc + apt deps (Alpine is unsupported for bundled browsers).
FROM node:23-bookworm-slim

WORKDIR /app

# Fixed path so Chromium is always found at runtime (not only under ~/.cache).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Lock dependency layers: npm ci + Playwright browsers only re-run when package*.json changes.
# Application code is copied last so edits to sources (and files not in .dockerignore) do not reinstall Chromium.
COPY package*.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium

COPY . .

# No default CMD; docker-compose.yml will specify the command
