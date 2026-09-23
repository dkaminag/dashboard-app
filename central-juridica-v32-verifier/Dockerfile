FROM node:22-alpine
WORKDIR /app
COPY central-juridica-v32-verifier/package.json ./package.json
COPY central-juridica-v32-verifier/smoke.mjs ./smoke.mjs
COPY central-juridica-v32-verifier/server.mjs ./server.mjs
RUN npm run build
CMD ["npm","start"]
