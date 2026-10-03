FROM node:24.7.0-bookworm-slim

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
USER node

# The lockfile pins JavaScript dependencies. Never copy operator .env files.
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["pnpm", "api"]
