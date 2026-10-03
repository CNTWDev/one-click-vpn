FROM node:22-bookworm-slim
WORKDIR /site
COPY deploy/reality-target/server.mjs deploy/reality-target/index.html ./
USER node
EXPOSE 3300
CMD ["node", "server.mjs"]
