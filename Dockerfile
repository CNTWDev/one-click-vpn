FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG NORTHSTAR_BUILD_REV=unknown
ENV NORTHSTAR_BUILD_REV=$NORTHSTAR_BUILD_REV
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ARG NORTHSTAR_BUILD_REV=unknown
ENV NORTHSTAR_BUILD_REV=$NORTHSTAR_BUILD_REV
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/agent ./agent
COPY --from=build /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod 700 ./docker-entrypoint.sh && mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
