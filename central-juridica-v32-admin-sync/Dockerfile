FROM node:22-alpine
RUN apk add --no-cache tar gzip
WORKDIR /app

ARG RUNTIME_RELEASE=d507a9955be07ef710d410b5263686ac75caeeff
ARG WRAPPER_RELEASE=d76a2dbf257853d495c177f7930c20c5ce5278bc

RUN node -e "const fs=require('fs'); Promise.all([['runtime',process.env.RUNTIME_RELEASE],['wrapper',process.env.WRAPPER_RELEASE]].map(async ([name,sha])=>{const r=await fetch('https://codeload.github.com/dkaminag/dashboard-app/tar.gz/'+sha);if(!r.ok)throw new Error(name.toUpperCase()+'_FETCH_'+r.status);fs.writeFileSync('/tmp/'+name+'.tgz',Buffer.from(await r.arrayBuffer()))})).catch(e=>{console.error(e);process.exit(1)})" \
 && mkdir -p /tmp/runtime-src /tmp/wrapper-src \
 && tar -xzf /tmp/runtime.tgz -C /tmp/runtime-src --strip-components=1 \
 && tar -xzf /tmp/wrapper.tgz -C /tmp/wrapper-src --strip-components=1 \
 && test -f /tmp/runtime-src/central-juridica-railway-v3.2.0/package.json \
 && test -f /tmp/wrapper-src/dashboard-backend/patch-central-juridica-v32-audit-keyring-compat.mjs \
 && cp -a /tmp/runtime-src/central-juridica-railway-v3.2.0 /app/candidate-package \
 && cd /app/candidate-package \
 && node -e "const p=require('./package.json');if(p.version!=='3.2.0-preview')throw new Error('V32_RELEASE_VERSION_MISMATCH')" \
 && npm run build \
 && cp /tmp/wrapper-src/dashboard-backend/patch-central-juridica-v32-audit-keyring-compat.mjs ./patch-audit-keyring-compat.mjs \
 && node patch-audit-keyring-compat.mjs

COPY admin-sync-core.mjs /app/candidate-package/admin-sync-core.mjs
COPY sync-admin-user.mjs /app/candidate-package/sync-admin-user.mjs
COPY test-admin-sync-core.mjs /app/candidate-package/test-admin-sync-core.mjs
COPY test-admin-sync-guardrails.mjs /app/candidate-package/test-admin-sync-guardrails.mjs

RUN cd /app/candidate-package \
 && node --check admin-sync-core.mjs \
 && node --check sync-admin-user.mjs \
 && node --check test-admin-sync-core.mjs \
 && node --check test-admin-sync-guardrails.mjs \
 && node test-admin-sync-core.mjs \
 && node test-admin-sync-guardrails.mjs

WORKDIR /app/candidate-package
ENV NODE_ENV=production
CMD ["node","sync-admin-user.mjs"]
