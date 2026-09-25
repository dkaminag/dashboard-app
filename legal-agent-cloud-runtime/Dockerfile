FROM node:22-alpine

WORKDIR /app

COPY systems/legal-agent-cloud/package.json ./systems/legal-agent-cloud/package.json
RUN cd systems/legal-agent-cloud && npm install --omit=dev --no-audit --no-fund

COPY systems/legal-agent-cloud ./systems/legal-agent-cloud
COPY skills/legal-counsel-br/SKILL.md ./skills/legal-counsel-br/SKILL.md
RUN cd systems/legal-agent-cloud && npm run check

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "systems/legal-agent-cloud/server.mjs"]
