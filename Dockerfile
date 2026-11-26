# Development image — used by docker-compose.yml for local iteration.
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so a code-only change reuses the layer cache.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .

VOLUME ["/app/logs"]

EXPOSE 3000

CMD ["npm", "run", "start:dev"]
