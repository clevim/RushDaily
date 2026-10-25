# Imagem do site (ghcr.io/clevim/rushdaily): SÓ código (páginas, src/ui, src/engine, estilos e os assets próprios do projeto).
# Os dados gerados pelo setup (src/vendor, src/data/rush, src/data/classic/*.json, cartas, artes e o Enigma) vêm do volume
# rushdaily-dados, montado em /dados somente leitura e gerado no homelab pelo serviço rushdaily-dados (tools/admin/Dockerfile).
# Bases fixadas por digest (reprodutível). Para atualizar: docker pull <tag> e trocar o sha256 abaixo.

# Teste (opcional: docker build --target test .): baixa só o que é barato e vem do GitHub/npm (ocgcore e Rush do EDOPro, sem
# ImageMagick nem artes) e roda os testes que não dependem do pool clássico (npm run test:deploy, os mesmos do workflow).
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS test
RUN apk add --no-cache python3 git curl
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY server ./server
COPY tests ./tests
COPY tools ./tools
RUN node tools/setup/setup.mjs --so ocgcore,rush-ocg && npm run test:deploy

# nginx sem privilégios (usuário 101, porta 8080). docs/, PRODUCT.md e tools/ não entram na imagem.
FROM nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx-security.conf /etc/nginx/rushdaily-security.conf
COPY index.html duel.html screens.html arena.html preparando.html /usr/share/nginx/html/
COPY src /usr/share/nginx/html/src
# Caminhos de dados viram links para o volume (/dados/src/...). Em src/data/classic só os JSON gerados viram link: o
# strings-pt.mjs (código) continua o da imagem. Link sem alvo (dado ainda não gerado) responde 404, como antes do setup.
USER root
RUN set -eu; h=/usr/share/nginx/html/src; d=/dados/src; \
    ln -s "$d/vendor" "$h/vendor"; \
    ln -s "$d/data/rush" "$h/data/rush"; \
    for a in rush-art rush-cards rush-cards-sm classic-art classic-cards classic-cards-sm puzzle; do ln -s "$d/assets/$a" "$h/assets/$a"; done; \
    for f in seasons tokens puzzles; do ln -s "$d/data/classic/$f.json" "$h/data/classic/$f.json"; done; \
    for n in 1 2 3 4 5; do for f in s synergy-s templates-s; do ln -s "$d/data/classic/$f$n.json" "$h/data/classic/$f$n.json"; done; done; \
    mkdir -p /dados && chown 1000:1000 /dados
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
