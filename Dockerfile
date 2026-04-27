# Multi-stage build for the full monorepo.
# Runtime image serves the built SPA + /api + /mcp from one origin.

FROM node:20-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm -r build

FROM node:20-alpine AS runtime
RUN corepack enable pnpm
WORKDIR /app
ENV NODE_ENV=production
ENV HTTP_HOST=0.0.0.0
ENV HTTP_PORT=3000

COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps/server/package.json ./apps/server/
COPY --from=build /app/apps/server/build ./apps/server/build
COPY --from=build /app/apps/web/dist ./apps/web/dist
# eda-script source is read at runtime by /eda-script/pcbviber-easyeda.eext
# to build the EasyEDA Pro extension archive on first request.
COPY --from=build /app/eda-script ./eda-script
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/src ./packages/shared/src
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules

EXPOSE 3000
CMD ["node", "apps/server/build/index.js", "--transport=http"]
