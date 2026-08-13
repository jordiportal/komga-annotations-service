FROM node:20-slim

WORKDIR /app

# better-sqlite3 tiene binarios precompilados para glibc (Debian),
# así que npm ci no necesita compilar nada (a diferencia de Alpine/musl).

# Copiar package.json y lockfile primero para cachear capas de dependencias
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copiar el código fuente
COPY src/ ./src/

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "src/server.js"]
