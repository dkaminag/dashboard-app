FROM node:22-bookworm-slim

WORKDIR /workspace

COPY dashboard-backend/central-legal-agent-staging-bridge.mjs /workspace/dashboard-backend/central-legal-agent-staging-bridge.mjs
COPY central-legal-agent-staging-runtime/package.json /workspace/central-legal-agent-staging-runtime/package.json
COPY central-legal-agent-staging-runtime/server.mjs /workspace/central-legal-agent-staging-runtime/server.mjs

WORKDIR /workspace/central-legal-agent-staging-runtime

ENV NODE_ENV=staging
ENV PORT=8080

USER node

EXPOSE 8080

CMD ["node", "server.mjs"]
