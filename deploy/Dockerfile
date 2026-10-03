# syntax=docker/dockerfile:1
FROM node:24.7.0-bookworm-slim

# Optional managed-environment trust is mounted only for networked build steps.
# Local Docker builds need no secret; TLS verification stays enabled in both.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    corepack enable && corepack prepare pnpm@11.25.0 --activate
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
USER node

# The lockfile pins JavaScript dependencies. Never copy operator .env files.
COPY --chown=node:node . .
RUN --mount=type=secret,id=proxy_ca,uid=1000 \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["pnpm", "api"]
