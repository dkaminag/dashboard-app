FROM node:22-bookworm-slim
WORKDIR /app
COPY runtime.bundle.*.b64 ./
COPY railway-unpack.mjs railway-launcher.mjs ./
RUN node railway-unpack.mjs \
 && cd runtime \
 && npm install --omit=dev --no-audit --no-fund
ENV CJ_ENV=production
ENV HOST=0.0.0.0
ENV CJ_SERVE_STATIC_FROM_FUNCTION=true
EXPOSE 8787
CMD ["node","railway-launcher.mjs"]
