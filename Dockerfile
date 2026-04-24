# Debian-based: Playwright Chromium needs glibc + apt deps (Alpine is unsupported for bundled browsers).
FROM node:23-bookworm-slim

WORKDIR /app

# Fixed path so Chromium is always found at runtime (not only under ~/.cache).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./
RUN npm ci

COPY . .

# Must run after COPY so browser revision matches the Playwright version in node_modules.
RUN npx playwright install --with-deps chromium

# No default CMD; docker-compose.yml will specify the command
