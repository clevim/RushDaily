// PWA: registra o service worker e oferece a carga do pool do Rush com tratamento de falta de rede.
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

/** Baixa o cards.json do Rush. Sem rede (e sem cache): mostra aviso com "Tentar de novo" e não segue. */
export async function loadPool() {
  try {
    const response = await fetch('src/data/rush/cards.json');
    if (!response.ok) throw new Error(String(response.status));
    return await response.json();
  } catch {
    const box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;inset:0;z-index:99999;display:grid;place-content:center;gap:1rem;padding:1.5rem;text-align:center;background:#0a0807;color:#f3ead8;font:600 1rem system-ui,sans-serif';
    box.innerHTML = '<p>Sem conexão. Conecte-se uma vez para baixar os dados do jogo.</p><button type="button" style="justify-self:center;padding:.7rem 1.4rem;font:inherit;cursor:pointer">Tentar de novo</button>';
    box.querySelector('button').addEventListener('click', () => location.reload());
    document.body.append(box);
    return new Promise(() => {}); // ponytail: a página fica parada até recarregar
  }
}
