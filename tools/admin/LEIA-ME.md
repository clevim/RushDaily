# Admin local do RushDaily

Painel para acompanhar o cache/dados do `npm run setup` e disparar tarefas sem o terminal.

## Uso

```bash
npm run admin                 # porta 4190; outra: ADMIN_PORT=4200 npm run admin
```

Abra a URL com token impressa no terminal (`http://127.0.0.1:4190/?t=...`). O token muda a cada início. Ctrl+C encerra o servidor e cancela a tarefa em andamento.

Sem dependências (só Node). Histórico e configuração ficam em `tools/setup/cache/admin/` (já ignorado pelo git).

## Tarefas (lista fechada, uma por vez, com fila e botão Cancelar)

- Setup completo (`--temporadas`, `--sem-render`)
- Setup de uma etapa (lista vinda de `setup.mjs --lista`), com "refazer" (`--force` só nela)
- Importar clássico: `fetch`, `decks`, `build --ate N`, `art`, `puzzles`
- Buscar puzzles (`puzzles --buscar --nos --meta`; padrão vem da configuração salva)
- Render das clássicas e das Rush (todas as que faltam, ou só os ids)
- Testes (`npm test`) e simulação (`simulate.mjs N T`)

O log aparece em tempo real (SSE); a barra de progresso lê as linhas `N/M` dos renders. As últimas 30 execuções ficam no histórico (clique para ver o final do log).

## Status e configuração

Por etapa: pronta/parcial/faltando, tamanho, data da última geração e contagens (artes, pré-desenhadas, Rush, puzzles, scripts Lua), mais o espaço dos `tools/*/cache`. Temporadas ativas mudam rodando `build --ate N` (com confirmação). "Invalidar cache no navegador" só mostra a instrução: subir `CACHE_VERSION` em `src/ui/classic-render.js`.

## Segurança

- Escuta somente em `127.0.0.1` (recusa iniciar com outro host). Toda a API exige o token no cabeçalho `x-admin-token` (comparação em tempo constante); Host e Origin só aceitos como `127.0.0.1`/`localhost` na porta (contra DNS rebinding).
- Executa apenas tarefas da lista, com argumentos em array (sem shell) e parâmetros validados. Só serve `public/index.html`.
- Quem tem o token roda comandos na sua máquina: trate a URL como senha e nunca a publique.
- **Nunca exponha pelo Cloudflare Tunnel.** Já há proteção em camadas: o `nginx.conf` bloqueia `/tools/` (location que devolve erro para `tools`, `docs`, `tests`...) e o `.dockerignore` exclui `tools`, então a imagem Docker nem contém o admin. Mantenha assim e não aponte o túnel para a porta 4190.
- Do celular, use túnel SSH em vez de abrir a porta: `ssh -L 4190:127.0.0.1:4190 homelab` e abra `http://127.0.0.1:4190/?t=...` no aparelho (ex.: Termux/cliente SSH com port forward).

## Integração

`package.json` já ganhou `"admin": "node tools/admin/server.mjs"`. Integre este texto ao README se quiser.

## Jogadores (acompanhamento de acessos)

A seção **Jogadores** mostra o total de chaves, ativos hoje/7/30 dias, gráficos de ativos e de chaves novas por dia (60 dias) e uma tabela ordenável e paginada, com busca por chave e painel de detalhe (primeiro/último acesso, acessos, dias ativos, tamanho, vitórias/derrotas, sequência, cartas, decks, PvP, peças do Enigma, boosters). O servidor de sync **não guarda IP, User-Agent, nome nem e-mail**: só a chave, o progresso e as datas de acesso.

### Configurar no homelab

1. No homelab, ao lado do `docker-compose.yml`, crie o `.env` (fora do git): `echo "ADMIN_TOKEN=$(openssl rand -base64 36 | tr -d '/+=\n')" > .env && chmod 600 .env` e suba: `docker compose up -d`. O compose publica a porta de estatísticas só em `127.0.0.1:4192` do host (nunca em `0.0.0.0`, nunca no cloudflared).
2. No seu computador, abra o túnel (4190 = este painel, caso o rode no homelab; 4192 = estatísticas): `ssh -L 4190:127.0.0.1:4190 -L 4192:127.0.0.1:4192 homelab`.
3. Rode o admin com o mesmo token: `SYNC_ADMIN_TOKEN='...' npm run admin` (e `SYNC_ADMIN_URL` se a URL não for o padrão `http://127.0.0.1:4192`). Em vez de variáveis, vale gravar em `tools/setup/cache/admin/config.json` (ignorado pelo git): `{"syncAdminUrl":"http://127.0.0.1:4192","syncAdminToken":"..."}`.
4. Se o admin roda no homelab, o túnel de 4190 leva o painel ao seu navegador; o token do sync fica só no servidor do admin e **nunca vai ao navegador**.

Sem `SYNC_ADMIN_TOKEN`, a seção explica como configurar. Para testar local: `ADMIN_TOKEN=<32+ caracteres> npm run sync` (estatísticas em `127.0.0.1:8788`) e `SYNC_ADMIN_URL=http://127.0.0.1:8788 SYNC_ADMIN_TOKEN=<o mesmo> npm run admin`.
