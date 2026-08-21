FROM docker.io/library/node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.1.1 --activate

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY apps/bukshelf-server/package.json ./apps/bukshelf-server/
RUN --mount=type=cache,id=bukshelf-pnpm,sharing=locked,target=/pnpm/store \
    pnpm install --filter @bukshelf/server --prod --frozen-lockfile --ignore-scripts
COPY apps/bukshelf-server ./apps/bukshelf-server

FROM docker.io/oven/bun:1.3.1-alpine@sha256:514fe15804f8ad3772ba323c2298daf121bb4b42386e2522998de5e87f16a94c AS runtime

ENV NODE_ENV=production
ENV BUKSHELF_HOST=0.0.0.0
ENV BUKSHELF_PORT=43175
ENV BUKSHELF_DATA_DIR=/data
ENV BUKSHELF_DATABASE_PATH=/data/bukshelf.sqlite

WORKDIR /app/apps/bukshelf-server
COPY --from=dependencies --chown=bun:bun /repo/node_modules /app/node_modules
COPY --from=dependencies --chown=bun:bun /repo/apps/bukshelf-server ./
RUN mkdir -p /data && chown bun:bun /data

USER bun
VOLUME ["/data"]
EXPOSE 43175
CMD ["bun", "src/server.ts"]
