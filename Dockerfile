# Portable single-container build (works on Render, Railway, Fly.io, Koyeb,
# Google Cloud Run, or any VPS). The API serves the built client on $PORT.
FROM node:22-slim AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production PORT=4000 TRUST_PROXY=1
WORKDIR /app/server
COPY --chown=node:node server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server/ ./
COPY --chown=node:node --from=client /app/client/dist /app/client/dist
# Not as root: the image's own unprivileged user. It owns /app, where the OCR
# reader caches its language file and the local database file (when there is
# no MONGODB_URI) is written.
RUN chown node:node /app
USER node
EXPOSE 4000
# The container stops cleanly on SIGTERM (src/index.js finishes requests in flight).
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
