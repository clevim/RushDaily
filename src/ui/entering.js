// Animação de entrada na arena (antes era <script> inline em duel.html; a CSP não aceita inline).
try { if (sessionStorage.getItem('rushdaily-entering')) { sessionStorage.removeItem('rushdaily-entering'); document.body.classList.add('entering'); } } catch {}
