FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The lockfile, not a fresh resolve: the autoroll deploys every main build, so two builds
# of one commit must carry the same dependency tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY bin/ ./bin/

USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
