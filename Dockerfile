FROM node:20-alpine

WORKDIR /app

# better-sqlite3 no tiene binarios precompilados para Alpine/musl:
# necesita compilarse con node-gyp (python3, make, g++).
# Instalamos las herramientas de build, compilamos y las limpiamos.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && apk add --no-cache sqlite

# Copiar package.json y lockfile primero para cachear capas de dependencias
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && apk del .build-deps

# Copiar el código fuente
COPY src/ ./src/

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "src/server.js"]
