FROM node:20-slim

WORKDIR /app

# node_modules ya viene precompilado (better-sqlite3 compilado para glibc/Debian).
# No hacemos npm ci: el build es instantáneo y no supera el timeout del proxy.

COPY node_modules/ ./node_modules/
COPY src/ ./src/
COPY package.json package-lock.json ./

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "src/server.js"]
