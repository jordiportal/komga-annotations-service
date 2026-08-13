FROM node:20-trixie-slim

WORKDIR /app

# node_modules ya viene precompilado (better-sqlite3 compilado para glibc 2.41/trixie).
# node:20-trixie-slim tiene glibc 2.41, compatible con el binario compilado.
# No hacemos npm ci: el build es instantáneo y no supera el timeout del proxy.

COPY node_modules/ ./node_modules/
COPY src/ ./src/
COPY package.json package-lock.json ./

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "src/server.js"]
