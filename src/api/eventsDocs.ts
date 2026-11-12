import type { Router } from 'express';
import type { AsyncApiDocument } from './asyncapi';

const ASYNCAPI_COMPONENT = 'https://unpkg.com/@asyncapi/react-component@2.6.5';

// Página simples: carrega o componente oficial do AsyncAPI (versão "standalone", sem build)
// e manda ele renderizar o JSON servido logo ao lado, em /events/asyncapi.json.
const EVENTS_DOCS_PAGE = `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ms-pedidos — Eventos (AsyncAPI)</title>
    <link rel="stylesheet" href="${ASYNCAPI_COMPONENT}/styles/default.min.css" />
    <style>
      body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
      .topbar { background: #1f2937; color: #fff; padding: 10px 24px; font-size: 14px; }
      .topbar a { color: #93c5fd; margin-left: 16px; text-decoration: none; }
      .topbar a:hover { text-decoration: underline; }
      #status { padding: 24px; color: #4b5563; }
    </style>
  </head>
  <body>
    <div class="topbar">
      <strong>ms-pedidos</strong> — documentação dos eventos
      <a href="asyncapi.yaml">asyncapi.yaml</a>
      <a href="asyncapi.json">asyncapi.json</a>
      <a href="../docs">Swagger da API HTTP</a>
    </div>
    <div id="status">Carregando a especificação dos eventos...</div>
    <div id="asyncapi"></div>

    <script src="${ASYNCAPI_COMPONENT}/browser/standalone/index.js"></script>
    <script>
      (function () {
        var status = document.getElementById('status');
        // funciona com ou sem barra no final (/events/docs e /events/docs/)
        var base = window.location.pathname.replace(/\\/docs\\/?$/, '');
        if (!window.AsyncApiStandalone) {
          status.textContent = 'Não foi possível carregar o visualizador (unpkg.com). A especificação está em ' + base + '/asyncapi.yaml';
          return;
        }
        fetch(base + '/asyncapi.json')
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.text();
          })
          .then(function (schema) {
            status.remove();
            window.AsyncApiStandalone.render(
              { schema: schema, config: { show: { sidebar: true } } },
              document.getElementById('asyncapi')
            );
          })
          .catch(function (error) {
            status.textContent = 'Erro ao carregar a especificação: ' + error.message;
          });
      })();
    </script>
  </body>
</html>
`;

/** Rotas públicas do "Swagger de eventos": a especificação AsyncAPI e a página que a renderiza. */
export function mapEventsDocs(router: Router, asyncApi: AsyncApiDocument): void {
  router.get('/events/asyncapi.yaml', (_req, res) => {
    res.type('text/yaml').send(asyncApi.yaml);
  });

  router.get('/events/asyncapi.json', (_req, res) => {
    res.json(asyncApi.json);
  });

  router.get('/events/docs', (_req, res) => {
    res.type('html').send(EVENTS_DOCS_PAGE);
  });
}
