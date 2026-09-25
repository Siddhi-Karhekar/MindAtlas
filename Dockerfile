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
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=client /app/client/dist /app/client/dist
EXPOSE 4000
CMD ["node", "src/index.js"]
