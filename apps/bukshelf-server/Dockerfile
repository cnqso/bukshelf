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
# Turbopack's server build externalizes some dependencies instead of bundling
# them: .next/node_modules/<pkg>-<hash> becomes a symlink into this stage's
# pnpm content-addressed store. That store does not exist in the runtime
# image, so a plain `.next` copy would carry dangling symlinks into it —
# Next would boot, but SSR of any page touching an externalized package
# would fail at request time. `output: 'standalone'` (next.config.mjs, gated
# on BUILD_STANDALONE) runs Next's own dependency tracer and copies the real,
# resolved files for exactly this reason; use it instead of reinventing
# dependency resolution here.
ENV BUILD_STANDALONE=true
RUN pnpm --filter @readest/readest-app build-web
# Portable production dependency trees. The Next tree is intentionally retained
# until its remaining API routes have moved to Bun; afterward this collapses to
# a static frontend bundle with no Next runtime.
RUN pnpm --filter @bukshelf/server deploy --prod --legacy /deploy/bukshelf-server

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
# The standalone tree (see BUILD_STANDALONE above) is already a complete,
# traced, dereferenced copy of everything apps/readest-app needs to run:
# its own .next/server build, its own package.json, and node_modules split
# across a hoisted root (shared deps) and an app-local one (deps only it
# uses). Both pieces are required — copy the hoisted root to the same
# relative depth the standalone build assumed (one level above apps/), and
# the app-local piece to its normal path. Static assets and public/ are
# deliberately excluded from tracing (they're served as files, not required
# as modules) and must be copied alongside separately.
COPY --from=build --chown=bun:bun /repo/apps/readest-app/.next/standalone/node_modules /app/node_modules
COPY --from=build --chown=bun:bun /repo/apps/readest-app/.next/standalone/apps/readest-app /app/apps/readest-app
COPY --from=build --chown=bun:bun /repo/apps/readest-app/.next/static /app/apps/readest-app/.next/static
COPY --from=build --chown=bun:bun /repo/apps/readest-app/public /app/apps/readest-app/public
RUN mkdir -p /data && chown bun:bun /data

USER bun
VOLUME ["/data"]
EXPOSE 43175
CMD ["bun", "src/server.ts"]
