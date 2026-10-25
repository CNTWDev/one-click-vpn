FROM node:22-bookworm-slim AS build
# Quiet build output: no "new npm major" notice, funding or audit summaries.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
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
# Skipping debconf preconfiguration avoids the harmless "apt-utils is not installed" warning.
RUN printf '#clear DPkg::Pre-Install-Pkgs;\n' > /etc/apt/apt.conf.d/99-no-preconfigure \
  && apt-get update -qq \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Use-Pty=0 --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99-no-preconfigure
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
