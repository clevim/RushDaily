#!/usr/bin/env python3
"""Servidor de desenvolvimento sem cache: o navegador sempre pega a versão atual dos arquivos.

Uso: python3 tools/serve.py [porta]   (padrão 4173, só em 127.0.0.1)
/api/* vai para o servidor de sincronização (npm run sync, 127.0.0.1:8787; outro endereço em SYNC_URL), como o nginx faz.
"""
import os
import sys
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SYNC_URL = os.environ.get('SYNC_URL', 'http://127.0.0.1:8787')


class NoCache(SimpleHTTPRequestHandler):
    def proxy(self):
        size = int(self.headers.get('Content-Length') or 0)
        if size > 1024 * 1024 + 4096:
            self.send_error(413)
            return
        body = self.rfile.read(size) if size else None
        headers = {name: self.headers[name] for name in ('Authorization', 'Content-Type') if self.headers.get(name)}
        headers['X-Real-IP'] = self.client_address[0]
        request = urllib.request.Request(SYNC_URL + self.path, data=body, method=self.command, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        except OSError:
            self.send_error(502, 'Servidor de sincronização fora do ar (npm run sync)')
            return
        data = response.read()
        self.send_response(response.status)
        for name in ('Content-Type', 'Retry-After', 'Cache-Control'):
            if response.headers.get(name):
                self.send_header(name, response.headers[name])
        self.send_header('Content-Length', str(len(data)))
        super().end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/api/'):
            return self.proxy()
        return super().do_GET()

    do_PUT = do_POST = do_DELETE = proxy

    def list_directory(self, path):
        # Sem listagem de pastas (tools/, caches, etc. não devem ser navegáveis).
        self.send_error(404, 'Not found')
        return None

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    root = Path(__file__).resolve().parents[1]
    print(f'RushDaily em http://127.0.0.1:{port}/ (sem cache)')
    ThreadingHTTPServer(('127.0.0.1', port), partial(NoCache, directory=str(root))).serve_forever()
