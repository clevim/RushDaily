# Bases fixadas por digest (reprodutível). Para atualizar: docker pull <tag> e trocar o sha256 abaixo.
# Teste: a mesma base do servidor de sincronização (node:sqlite sem aviso). Só os 3 arquivos de tools/ que os testes importam.
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS test
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY server ./server
COPY tests ./tests
COPY tools/setup/patch-ocgcore.mjs ./tools/setup/
COPY tools/classic/puzzle-check.mjs tools/classic/puzzle-solutions.json ./tools/classic/
RUN npm test

# nginx sem privilégios (usuário 101, porta 8080). docs/, PRODUCT.md e tools/ não entram na imagem.
FROM nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx-security.conf /etc/nginx/rushdaily-security.conf
COPY index.html duel.html screens.html arena.html /usr/share/nginx/html/
COPY src /usr/share/nginx/html/src
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
