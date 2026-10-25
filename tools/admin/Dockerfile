# Imagem de ferramentas e do painel admin (ghcr.io/clevim/rushdaily-admin): só o código do projeto e as ferramentas do setup.
# Nenhum dado de cartas entra aqui: o setup roda no homelab, no volume rushdaily-dados (veja tools/admin/conteiner.mjs).
# Build a partir da raiz do projeto: docker build -f tools/admin/Dockerfile -t rushdaily-admin .
# Dois serviços do compose usam esta imagem: rushdaily-dados (setup no volume a cada subida) e rushdaily-admin (painel, profile admin).
# Mesma base Node do servidor de sincronização, fixada por digest. Para atualizar: docker pull node:24-alpine e trocar o sha256.
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
# O que o setup exige (tools/setup/setup.mjs): Python com Pillow, numpy e sqlite3, git, curl e ImageMagick 7 (comando magick,
# usado para reduzir as molduras PNG). O skia-canvas das cartas baixa o binário musl na primeira etapa de desenho.
RUN apk add --no-cache python3 py3-pillow py3-numpy git curl imagemagick \
 && magick -version | head -n 1 \
 && magick -list format | grep -qw PNG \
 && python3 -I -c 'import PIL, numpy, sqlite3; from PIL import features; assert features.check("webp")'
WORKDIR /opt/rushdaily
COPY package.json index.html duel.html screens.html arena.html ./
COPY src ./src
COPY server ./server
COPY tests ./tests
COPY tools ./tools
RUN mkdir -p /dados && chown node:node /dados
USER node
# Raiz somente leitura no compose: HOME e o cache do npm vão para o tmpfs; o resto do que se escreve fica no volume /dados.
ENV HOME=/tmp NPM_CONFIG_CACHE=/tmp/npm NPM_CONFIG_UPDATE_NOTIFIER=false NO_UPDATE_NOTIFIER=1 RUSHDAILY_RAIZ=/dados ADMIN_PORT=4190
VOLUME /dados
EXPOSE 4190
ENTRYPOINT ["node", "/opt/rushdaily/tools/admin/conteiner.mjs"]
CMD ["painel"]
