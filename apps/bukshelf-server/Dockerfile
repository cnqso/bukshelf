FROM docker.io/library/node:24-slim@sha256:24dc26ef1e3c3690f27ebc4136c9c186c3133b25563ae4d7f0692e4d1fe5db0e AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.1.1 --activate

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY apps/bukshelf-server/package.json ./apps/bukshelf-server/
COPY apps/readest-app/package.json ./apps/readest-app/
COPY packages ./packages
RUN --mount=type=cache,id=bukshelf-pnpm,sharing=locked,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN test -f packages/foliate-js/vendor/pdfjs/annotation_layer_builder.css \
    && test -d packages/simplecc-wasm/dist/web \
    || { printf '\nRequired git submodules are missing. Run: git submodule update --init packages/foliate-js packages/simplecc-wasm\n'; exit 1; }
RUN pnpm --filter @readest/readest-app setup-vendors

FROM dependencies AS build
COPY . .
ENV NEXT_PUBLIC_APP_PLATFORM=web
RUN pnpm --filter @readest/readest-app build-web
# Portable production dependency trees. The Next tree is intentionally retained
# until its remaining API routes have moved to Bun; afterward this collapses to
# a static frontend bundle with no Next runtime.
RUN pnpm --filter @bukshelf/server deploy --prod --legacy /deploy/bukshelf-server \
    && pnpm --filter @readest/readest-app deploy --prod --legacy /deploy/readest-app

FROM docker.io/oven/bun:1.3.1 AS runtime

ENV NODE_ENV=production
ENV NEXT_PUBLIC_APP_PLATFORM=web
ENV BUKSHELF_HOST=0.0.0.0
ENV BUKSHELF_PORT=43175
ENV BUKSHELF_DATA_DIR=/data
ENV BUKSHELF_DATABASE_PATH=/data/bukshelf.sqlite
ENV BUKSHELF_NEXT_DIR=/app/apps/readest-app

WORKDIR /app/apps/bukshelf-server
COPY --from=build --chown=bun:bun /deploy/bukshelf-server ./
COPY --from=build --chown=bun:bun /deploy/readest-app/node_modules /app/apps/readest-app/node_modules
COPY --from=build --chown=bun:bun /repo/apps/readest-app/.next /app/apps/readest-app/.next
COPY --from=build --chown=bun:bun /repo/apps/readest-app/public /app/apps/readest-app/public
COPY --from=build --chown=bun:bun /repo/apps/readest-app/package.json /app/apps/readest-app/package.json
COPY --from=build --chown=bun:bun /repo/apps/readest-app/next.config.mjs /app/apps/readest-app/next.config.mjs
RUN mkdir -p /data && chown bun:bun /data

USER bun
VOLUME ["/data"]
EXPOSE 43175
CMD ["bun", "src/server.ts"]
