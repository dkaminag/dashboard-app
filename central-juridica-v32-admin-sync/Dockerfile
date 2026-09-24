FROM node:22-alpine
RUN apk add --no-cache tar gzip
WORKDIR /app

ARG SOURCE_COMMIT=d76a2dbf257853d495c177f7930c20c5ce5278bc
RUN node -e "const fs=require('fs'); fetch('https://codeload.github.com/dkaminag/dashboard-app/tar.gz/' + process.env.SOURCE_COMMIT).then(r=>{if(!r.ok) throw new Error('SOURCE_FETCH_'+r.status); return r.arrayBuffer()}).then(b=>fs.writeFileSync('/tmp/source.tgz',Buffer.from(b)))" \
 && mkdir -p /tmp/source \
 && tar -xzf /tmp/source.tgz -C /tmp/source --strip-components=1 \
 && cp -a /tmp/source/central-juridica-railway-v3.2.0 /app/candidate-package \
 && cd /app/candidate-package \
 && npm run build \
 && cp /tmp/source/dashboard-backend/patch-central-juridica-v32-audit-keyring-compat.mjs ./patch-audit-keyring-compat.mjs \
 && node patch-audit-keyring-compat.mjs

COPY admin-sync-core.mjs /app/candidate-package/admin-sync-core.mjs
COPY sync-admin-user.mjs /app/candidate-package/sync-admin-user.mjs
COPY test-admin-sync-core.mjs /app/candidate-package/test-admin-sync-core.mjs

RUN cd /app/candidate-package \
 && node --check admin-sync-core.mjs \
 && node --check sync-admin-user.mjs \
 && node --check test-admin-sync-core.mjs \
 && node test-admin-sync-core.mjs

WORKDIR /app/candidate-package
ENV NODE_ENV=production
CMD ["node","sync-admin-user.mjs"]
