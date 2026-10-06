FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG VEILBIRD_BUILD_REV=unknown
ENV VEILBIRD_BUILD_REV=$VEILBIRD_BUILD_REV
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:controller

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ARG VEILBIRD_BUILD_REV=unknown
ENV VEILBIRD_BUILD_REV=$VEILBIRD_BUILD_REV
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/agent ./agent
COPY --from=build /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY docker-entrypoint.sh ./docker-entrypoint.sh
# Code stays root-owned and read-only for the runtime user; only data and the Next cache are writable.
RUN chmod 755 ./docker-entrypoint.sh && mkdir -p /app/data/client-releases /app/.next/cache && chown -R node:node /app/data /app/.next/cache
USER node
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
