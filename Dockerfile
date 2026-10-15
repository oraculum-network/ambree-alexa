# Ambree for Alexa+: a small image that runs TypeScript directly (Node 22 type stripping).
# Nothing writes to disk at runtime, so the root filesystem can be read-only.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY data ./data
COPY skills ./skills
USER node
EXPOSE 8080
CMD ["node","src/server.ts"]
