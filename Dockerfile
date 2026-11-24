FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only. Node runs the TypeScript sources directly (type stripping, with the
# "@open-payments-oidc/source" export condition), so there is no build step and no dev dependency
# is needed at runtime.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/wallet-login/package.json packages/wallet-login/
COPY packages/oidc/package.json packages/oidc/
COPY packages/server/package.json packages/server/
RUN pnpm install --prod --frozen-lockfile --filter @open-payments-oidc/server... \
  && pnpm store prune

COPY packages/wallet-login/src packages/wallet-login/src
COPY packages/oidc/src packages/oidc/src
COPY packages/server/src packages/server/src

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--conditions=@open-payments-oidc/source", "packages/server/src/bin.ts"]
