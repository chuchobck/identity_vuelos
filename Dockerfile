# syntax=docker/dockerfile:1
# Imagen del servicio de identidad. No lleva credenciales ni claves: todo llega por variables de
# entorno (ver docs/DEPLOY.md). Corre como el usuario node, sin privilegios.
#
#   docker build -t quinde-identity .
#   docker run --rm -p 3001:3001 --env-file .env.produccion quinde-identity

ARG NODE_VERSION=22

# --- 1. compilación: dependencias completas, cliente de Prisma y dist/ ---------
FROM node:${NODE_VERSION}-bookworm-slim AS compilacion
WORKDIR /app

# El postinstall corre "prisma generate", que necesita el esquema y su configuración.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# --- 2. ejecución: solo dependencias de producción y lo compilado --------------
FROM node:${NODE_VERSION}-bookworm-slim AS ejecucion
ENV NODE_ENV=production
WORKDIR /app

# --ignore-scripts: el cliente de Prisma ya viene compilado en dist/generated, y husky y el CLI
# de prisma son dependencias de desarrollo. --omit=optional: @prisma/client declara prisma y
# typescript como peers opcionales; sin esto entran ~250 MB del CLI (lo mismo que en el core).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force

COPY --from=compilacion /app/dist ./dist

# Sin privilegios: el usuario node de la imagen oficial (uid 1000). Nada en /app es suyo, así
# que el proceso no puede reescribir su propio código.
USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3001) + '/identity/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
