# ---------- etapa 1: instala tudo, compila o TypeScript e descarta as dependências de desenvolvimento ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- etapa 2: imagem final, só com o necessário para rodar ----------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3002
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# o asyncapi.yaml é lido na subida e servido em /events/asyncapi.yaml, /events/asyncapi.json e /events/docs
COPY --chown=node:node docs ./docs

# não roda como root
USER node
EXPOSE 3002

# O /health não consulta o banco, então responde mesmo com o Azure SQL pausado.
# O start-period é generoso porque, na subida, o serviço espera o banco gratuito "acordar".
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "dist/main.js"]
