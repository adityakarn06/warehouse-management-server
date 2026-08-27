FROM node:24-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# `pnpm build` is `prisma generate && tsc`, and prisma.config.ts resolves
# env('DATABASE_URL') while loading. Nothing connects during generate, this is a
# throwaway value so the config parses, never a real database.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN pnpm run build

FROM node:24-alpine AS runner
WORKDIR /app

RUN apk add --no-cache dumb-init \
    && addgroup -S nodejs && adduser -S nodejs -G nodejs

# pnpm's store symlinks do not survive a COPY between stages. that's why installing again
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate \
    && pnpm install --frozen-lockfile --prod \
    && pnpm store prune

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 4000
USER nodejs

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-4000}/health" || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
