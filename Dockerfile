# The nostro command line, with `nostro serve` as the default command.
#
#   docker build -t nostro .
#   docker run --rm -v nostro-data:/data nostro migrate
#   docker run --rm -v nostro-data:/data -p 127.0.0.1:8080:8080 -e NOSTRO_API_KEYS=acme:<key> nostro
#
# Both stages use the same base image, so better-sqlite3's native module is
# built for the Node it runs on.

FROM node:22.19.0-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
# Only @nostro-labs/cli and its production dependencies, workspace packages included.
RUN pnpm --filter @nostro-labs/cli deploy --prod --legacy /out

FROM node:22.19.0-bookworm-slim
ENV NODE_ENV=production \
    NOSTRO_DB=/data/nostro.db \
    NOSTRO_HOST=0.0.0.0 \
    NOSTRO_PORT=8080
WORKDIR /app
COPY --from=build /out .
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080
# nostro never signs a transaction and never needs a secret key.
ENTRYPOINT ["node", "/app/dist/bin.js"]
CMD ["serve"]
