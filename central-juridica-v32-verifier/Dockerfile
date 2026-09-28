FROM node:22-alpine
RUN apk add --no-cache tar gzip
WORKDIR /app
COPY central-juridica-v32-verifier/package.json ./package.json
COPY central-juridica-v32-verifier/smoke.mjs ./smoke.mjs
COPY central-juridica-v32-verifier/server.mjs ./server.mjs
COPY central-juridica-v32-verifier/audit-keyring-canary.mjs ./audit-keyring-canary.mjs
COPY central-juridica-v32-verifier/admin-credential-resync.mjs ./admin-credential-resync.mjs
COPY central-juridica-v32-verifier/canonical-user-sync.mjs ./canonical-user-sync.mjs
COPY central-juridica-v32-verifier/canonical-user-sync.contract.test.mjs ./canonical-user-sync.contract.test.mjs
COPY central-juridica-v32-verifier/central-lawyer-session-preflight.mjs ./central-lawyer-session-preflight.mjs
COPY central-juridica-v32-verifier/central-lawyer-session-preflight.contract.test.mjs ./central-lawyer-session-preflight.contract.test.mjs
RUN npm run build
CMD ["npm","start"]
