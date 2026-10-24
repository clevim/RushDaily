# Servidor de sincronização (Node 24 LTS: node:sqlite sem flag e "release candidate" desde a 24.15).
# Build a partir da raiz do projeto: docker build -f server/Dockerfile -t rushdaily-sync .
# Base fixada por digest. Para atualizar: docker pull node:24-alpine e trocar o sha256 abaixo.
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
WORKDIR /app
# package.json só pelo "type": "module" do sync-merge.js; sem npm install (não há dependências).
COPY package.json ./
COPY src/ui/sync-merge.js ./src/ui/
COPY server/server.mjs ./server/
RUN mkdir -p /data/backup && chown -R node:node /data
USER node
ENV NODE_ENV=production SYNC_HOST=0.0.0.0 SYNC_PORT=8787 SYNC_DB=/data/sync.db SYNC_BACKUP_DIR=/data/backup SYNC_TRUST_PROXY=1 ADMIN_HOST=0.0.0.0 ADMIN_PORT=8788
VOLUME /data
EXPOSE 8787
# 8788 (estatísticas) só existe com ADMIN_TOKEN e é publicada apenas em 127.0.0.1 pelo compose; não passa pelo nginx.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "server/server.mjs"]
