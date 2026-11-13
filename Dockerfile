FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only. Node runs the TypeScript sources directly (type stripping), so
# there is no build step and no dev dependency is needed at runtime.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "src/main.ts"]
