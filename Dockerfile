# Development image — used by docker-compose.yml for local iteration.
FROM node:22-slim

WORKDIR /app

RUN corepack enable

# Install deps first so a code-only change reuses the layer cache.
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

COPY . .

VOLUME ["/app/logs"]

EXPOSE 3000

CMD ["pnpm", "run", "start:dev"]
