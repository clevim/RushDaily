# Admin do RushDaily

Painel para acompanhar os dados do setup, disparar tarefas sem o terminal, conferir cartas e o desafio do dia e ver os jogadores. Roda de dois jeitos: **local** (`npm run admin`, numa cópia do repositório) ou **em contêiner** no homelab (serviço `rushdaily-admin` do compose, sobre o volume de dados). Sem dependências (só Node) e sem etapa de build.

## Uso local

```bash
npm run admin                 # porta 4190; outra: ADMIN_PORT=4200 npm run admin
```

Abra a URL com token impressa no terminal (`http://127.0.0.1:4190/?t=...`). O token muda a cada início. Ctrl+C encerra o servidor e cancela a tarefa em andamento. Histórico, logs e configuração ficam em `tools/setup/cache/admin/` (ignorado pelo git).

## Em contêiner (homelab)

A imagem `ghcr.io/clevim/rushdaily-admin` (`tools/admin/Dockerfile`) tem o código do projeto e as ferramentas do setup (Node 24, Python com Pillow e numpy, git, curl, ImageMagick 7). Ela serve a dois serviços do `docker-compose.yml`:

- `rushdaily-dados` (sobe sempre, sem porta): copia o código para o volume `rushdaily-dados`, roda o setup lá (idempotente) e sai. É ele que gera os dados do site na primeira subida (veja o README, "Como publicar").
- `rushdaily-admin` (profile `admin`, só sobe quando pedido): o painel, sobre o mesmo volume.

A entrada é `tools/admin/conteiner.mjs`: o código fica imutável em `/opt/rushdaily` e é copiado para `/dados` a cada início (com trava, e removendo arquivos de código que saíram do projeto); o setup e as tarefas rodam em `/dados` sem nenhum desvio de caminho. `tools/classic/puzzle-solutions.json` é juntado em vez de sobrescrito (o setup acrescenta soluções).

```bash
# Uma vez, no .env ao lado do docker-compose.yml (fora do git, chmod 600):
echo "ADMIN_PANEL_TOKEN=$(openssl rand -hex 32)" >> .env
echo "ADMIN_TOKEN=$(openssl rand -hex 32)" >> .env   # estatísticas dos jogadores (o mesmo do rushdaily-sync)

docker compose --profile admin up -d                 # sobe o painel (e o resto, se ainda não estiver no ar)
docker compose --profile admin stop rushdaily-admin  # para só o painel
```

No seu computador: `ssh -L 4190:127.0.0.1:4190 homelab` e abra `http://127.0.0.1:4190/?t=<ADMIN_PANEL_TOKEN>` (o token sai da barra de endereço ao carregar e fica só na sessão da aba). Do celular, o mesmo túnel por um cliente SSH com port forward (ex.: Termux).

O painel detecta o modo (selo "Contêiner" no topo) e mostra o que funciona ali: tarefa sem o arquivo ou a ferramenta de que precisa aparece desabilitada com o motivo. As estatísticas vêm do `rushdaily-sync` pela rede interna `admin` (`http://rushdaily-sync:8788`, com o `ADMIN_TOKEN`), sem túnel extra. Enquanto o `rushdaily-dados` está rodando, o cartão "Inicialização dos dados" mostra o progresso e o final do log, e o painel recusa tarefas (as duas mexeriam no mesmo volume). Evite também `docker compose up` (que reinicia o `rushdaily-dados`) durante uma tarefa longa do painel.

## Seções

- **Visão geral:** próxima ação sugerida (rodar o setup ou uma etapa, ver o log de uma falha, rodar os testes), contagens (cartas Rush e em PT, artes e cartas montadas, clássicas, puzzles, scripts), espaço dos caches, jogadores ativos hoje/7 dias, saúde do setup (etapas prontas X/N, com o que falta e botão para rodar) e a última execução com o resumo.
- **Dados e setup:** cada etapa do `setup.mjs --lista` com estado (pronta/parcial/faltando), contagem, tamanho, data e as ações **Rodar** e **Refazer** (`--force` só nela), mais o setup completo e o espaço dos `tools/*/cache`.
- **Tarefas:** lista fechada, uma por vez, com fila (até 10) e cancelamento. Log ao vivo (SSE) com filtro por texto, "só erros e avisos" (linhas destacadas), rolagem automática com pausa, copiar e baixar. Ao terminar: resumo legível dos testes (total, ok, falhas e quais) e das simulações (duelos, turnos, vitórias, travados, erros de script), notificação do navegador (ative em Configuração) e o título da aba muda se ela estiver em segundo plano. A tarefa em andamento aparece no topo em qualquer seção, com progresso (linhas `N/M`) e Cancelar.
- **Cartas:** busca por id ou nome (sem acento) nas cartas Rush (`src/data/rush/cards.json`) e clássicas ativas (`src/data/classic/s*.json`); mostra a ficha, a arte e a carta montada, o que falta (arte, montagem, miniatura) e as ações só daquela carta (baixar a arte, montar/desenhar de novo).
- **Desafio do dia:** o desafio de qualquer data (padrão: hoje, na data do aparelho, como no jogo), gerado no servidor pelo mesmo `src/engine/daily-generator.mjs`: confronto, seu deck, o rival de cada dificuldade (PV, IA, força e deck) e os próximos 7 dias.
- **Jogadores:** total de chaves, ativos hoje/7/30 dias, gráficos de 60 dias, tabela ordenável e paginada com busca e detalhe por chave.
- **Histórico:** as últimas 30 execuções com filtro, log completo (até ~4.000 linhas por execução, em `tools/setup/cache/admin/logs/`) e **Repetir** com os mesmos parâmetros.
- **Configuração:** temporadas do clássico (`build --ate N`, com confirmação), teto de nós e meta da busca de puzzles, notificações, onde subir a `CACHE_VERSION` (clássicas e Rush) e o ambiente (modo, servidor de sync).

## Tarefas (lista fechada)

Setup completo (`--temporadas`, `--sem-render`); setup de uma etapa (com "refazer" = `--force`); importar clássico (`fetch`, `decks`, `build --ate N`, `art`, `puzzles`); artes clássicas em HD; buscar puzzles; render das clássicas; importar Rush (`fetch`, `build`); artes Rush; montar cartas Rush; simulação Rush (`todos`, `ia`, `aleatorio`, `diario`, `niveis`); testes (`npm test`); simulação clássica. Os ids opcionais aceitam até 100 números.

## Segurança

- **Local:** escuta somente em `127.0.0.1` (recusa iniciar com outro host); token aleatório a cada início.
- **Contêiner:** só com `ADMIN_CONTAINER=1` (posto pela entrada da imagem) ele escuta em `0.0.0.0` *dentro* do contêiner; o compose publica a porta **apenas** em `127.0.0.1:4190` do host (nunca `0.0.0.0`, nunca no cloudflared nem no nginx). O token é fixo, vem de `ADMIN_PANEL_TOKEN` (32+ caracteres; sem ele o painel não sobe). O contêiner roda sem root (usuário 1000), com raiz somente leitura (escreve só no volume e no `/tmp`), `cap_drop: ALL` e `no-new-privileges`.
- Toda a API e as imagens exigem o token no cabeçalho `x-admin-token` (comparação em tempo constante); as imagens são buscadas com o cabeçalho e viram `blob:`, então o token nunca vai para uma URL. Host e Origin só são aceitos como `127.0.0.1`/`localhost` na porta (contra DNS rebinding).
- Executa apenas tarefas da lista, com argumentos em array (sem shell) e parâmetros validados; tarefa ou parâmetro inválido = 400. As tarefas não herdam os tokens do painel nem do sync.
- Serve só uma lista fechada de arquivos (`index.html`, `admin.css`, `admin.js` e o logo), nunca um diretório. As rotas novas são só de leitura: `/api/carta` (busca nos JSON de dados), `/api/desafio` (data validada, até 14 dias à frente) e `/arquivo/<pasta>/<id>.webp|png`, restrita às pastas `src/assets/{rush-art,rush-cards,rush-cards-sm,classic-art,classic-cards,classic-cards-sm}` com nome numérico (caminhos com `..`, `%2e` ou `\` são recusados).
- O token do sync fica só no servidor do painel e **nunca vai ao navegador**.
- Quem tem o token roda as tarefas do setup (que baixam da internet e escrevem no volume): trate a URL como senha e nunca a publique. **Nunca exponha o painel pelo Cloudflare Tunnel.** O `nginx.conf` bloqueia `/tools/` e a imagem do site nem contém o admin.

## Jogadores (acompanhamento de acessos)

O servidor de sync **não guarda IP, User-Agent, nome nem e-mail**: só a chave, o progresso e as datas de acesso. Com `ADMIN_TOKEN` (32+ caracteres) no `.env`, o `rushdaily-sync` abre o listener de estatísticas (8788): o painel em contêiner o lê pela rede interna; para o `npm run admin` de fora do homelab, o compose também o publica em `127.0.0.1:4192` do host:

1. Abra o túnel: `ssh -L 4192:127.0.0.1:4192 homelab`.
2. Rode o admin com o mesmo token: `SYNC_ADMIN_TOKEN='...' npm run admin` (e `SYNC_ADMIN_URL` se não for `http://127.0.0.1:4192`), ou grave em `tools/setup/cache/admin/config.json` (ignorado pelo git): `{"syncAdminUrl":"http://127.0.0.1:4192","syncAdminToken":"..."}`.

Para testar local: `ADMIN_TOKEN=<32+ caracteres> npm run sync` (estatísticas em `127.0.0.1:8788`) e `SYNC_ADMIN_URL=http://127.0.0.1:8788 SYNC_ADMIN_TOKEN=<o mesmo> npm run admin`.
