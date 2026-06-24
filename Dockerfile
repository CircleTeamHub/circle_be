# Development image — used by docker-compose.yml for local iteration.
FROM node:22-slim

WORKDIR /app

# Install deps first so a code-only change reuses the layer cache.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .

VOLUME ["/app/logs"]

EXPOSE 3000

CMD ["npm", "run", "start:dev"]
