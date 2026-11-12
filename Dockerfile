FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
COPY scripts/copy-skills.mjs ./scripts/copy-skills.mjs
COPY web ./web
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim
ENV NODE_ENV=production UNFOLD_CONTAINER=1 UNFOLD_HOME=/state UNFOLD_DATA_DIR=/state/data UNFOLD_CONNECTOR_SOCKET=/state/connector.sock UNFOLD_OWNER_PORT=8081 UNFOLD_SHARE_PORT=8080 UNFOLD_SHARE_LISTEN=0.0.0.0
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8081/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/cli.js", "serve"]
