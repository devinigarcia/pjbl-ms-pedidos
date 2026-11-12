import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, type AppDependencies } from '../../src/api/app';
import { loadAsyncApiDocument } from '../../src/api/asyncapi';
import { ServiceUnavailableError } from '../../src/application/errors';
import { coffee, createTestApplication, filter, orderBody, UNKNOWN_ORDER_ID } from '../support/testKit';

const asyncApi = loadAsyncApiDocument();
const logger = pino({ level: 'silent' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Sobe a aplicação Express inteira em cima do repositório em memória (sem abrir porta: o supertest cuida disso). */
function buildApp(overrides: Partial<AppDependencies> = {}) {
  const application = createTestApplication();
  const app = createApp({
    handlers: application.handlers,
    logger,
    asyncApi,
    health: { database: 'memory', publisher: 'log' },
    ...overrides,
  });
  return { app, ...application };
}

describe('HTTP — rotas de infraestrutura e documentação', () => {
  it('GET /health responde no formato do contrato', async () => {
    const { app } = buildApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', service: 'ms-pedidos', database: 'memory', publisher: 'log' });
    expect(typeof response.body.uptime).toBe('number');
    expect(new Date(response.body.timestamp).toISOString()).toBe(response.body.timestamp);
  });

  it('GET / redireciona para /docs, que abre o Swagger UI', async () => {
    const { app } = buildApp();

    const root = await request(app).get('/');
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe('/docs');

    const docs = await request(app).get('/docs/');
    expect(docs.status).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    expect(docs.text).toContain('swagger-ui');
  });

  it('GET /openapi.json documenta todas as rotas e aponta para a documentação de eventos', async () => {
    const { app } = buildApp();

    const response = await request(app).get('/openapi.json');

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.0.3');
    expect(Object.keys(response.body.paths).sort()).toEqual([
      '/events',
      '/events/asyncapi.json',
      '/events/asyncapi.yaml',
      '/events/dispatch',
      '/events/docs',
      '/health',
      '/orders',
      '/orders/{id}',
      '/orders/{id}/status',
    ]);
    expect(Object.keys(response.body.paths['/orders/{id}'])).toEqual(['get', 'put', 'delete']);
    expect(response.body.externalDocs.url).toBe('/events/docs');
    expect(response.body.info.description).toContain('/events/docs');
    expect(response.body.components.responses.DatabaseUnavailable).toBeDefined();
  });

  it('com PUBLIC_URL, o OpenAPI usa o endereço público no servidor e nos links', async () => {
    const { app } = buildApp({ publicUrl: 'https://pedidos.exemplo.com' });

    const response = await request(app).get('/openapi.json');

    expect(response.body.servers).toEqual([{ url: 'https://pedidos.exemplo.com', description: 'Ambiente publicado' }]);
    expect(response.body.externalDocs.url).toBe('https://pedidos.exemplo.com/events/docs');
  });

  it('GET /events/asyncapi.yaml e .json servem a especificação AsyncAPI 2.6.0 com os dois eventos', async () => {
    const { app } = buildApp();

    const yaml = await request(app).get('/events/asyncapi.yaml');
    expect(yaml.status).toBe(200);
    expect(yaml.headers['content-type']).toContain('yaml');
    expect(yaml.text).toMatch(/^asyncapi: 2\.6\.0/);

    const json = await request(app).get('/events/asyncapi.json');
    expect(json.status).toBe(200);
    expect(json.body.asyncapi).toBe('2.6.0');
    expect(Object.keys(json.body.channels)).toEqual(['order-events']);
    expect(Object.keys(json.body.components.messages)).toEqual(['OrderCreated', 'OrderCancelled']);
    expect(json.body.channels['order-events'].bindings['x-azure-storage-queue']).toMatchObject({
      queueName: 'order-events',
      messageEncoding: 'base64',
    });
  });

  it('GET /events/docs devolve a página que renderiza o AsyncAPI', async () => {
    const { app } = buildApp();

    const response = await request(app).get('/events/docs');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('@asyncapi/react-component@2.6.5');
    expect(response.text).toContain('AsyncApiStandalone.render');
    expect(response.text).toContain('/asyncapi.json');
  });
});

describe('HTTP — fluxo completo do pedido', () => {
  it('criar → evento no outbox → publicar → cancelar → novo evento → excluir', async () => {
    const { app, publisher } = buildApp();

    // cria
    const created = await request(app).post('/orders').set('x-correlation-id', 'fluxo-123').send(orderBody());
    expect(created.status).toBe(201);
    expect(created.headers.location).toBe(`/orders/${created.body.id}`);
    expect(created.headers['x-correlation-id']).toBe('fluxo-123');
    expect(created.body).toEqual({
      id: expect.stringMatching(UUID),
      customerName: 'Ana Souza',
      customerEmail: 'ana@exemplo.com',
      status: 'PENDENTE',
      items: [
        { ...coffee(), subtotal: 49.8 },
        { ...filter(), subtotal: 6.5 },
      ],
      total: 56.3,
      itemCount: 3,
      notes: 'Entregar no período da tarde.',
      allowedTransitions: ['PAGO', 'CANCELADO'],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const id: string = created.body.id;

    // o evento order.created está no outbox, ainda pendente, com o correlation id da requisição
    const pendingEvents = await request(app).get('/events');
    expect(pendingEvents.status).toBe(200);
    expect(pendingEvents.body.total).toBe(1);
    expect(pendingEvents.body.items[0]).toMatchObject({
      type: 'order.created',
      aggregateId: id,
      status: 'PENDENTE',
      attempts: 0,
      processedAt: null,
      lastError: null,
      payload: { type: 'order.created', version: 1, source: 'ms-pedidos', correlationId: 'fluxo-123', data: { orderId: id } },
    });
    expect(pendingEvents.body.items[0].id).toBe(pendingEvents.body.items[0].payload.eventId);

    // força a publicação
    const dispatched = await request(app).post('/events/dispatch');
    expect(dispatched.status).toBe(200);
    expect(dispatched.body).toEqual({ published: 1, failed: 0, pending: 0 });
    expect(publisher.published).toHaveLength(1);
    expect((await request(app).get('/events')).body.items[0].status).toBe('PUBLICADO');

    // consulta e listagem
    const fetched = await request(app).get(`/orders/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(created.body);
    const listed = await request(app).get('/orders?status=PENDENTE&search=ana&page=1&pageSize=10');
    expect(listed.body).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(listed.body.items[0]).toEqual(created.body);

    // cancela
    const cancelled = await request(app).patch(`/orders/${id}/status`).send({ status: 'CANCELADO' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ id, status: 'CANCELADO', allowedTransitions: [] });

    const events = await request(app).get('/events?limit=10');
    expect(events.body.items.map((item: { type: string; status: string }) => [item.type, item.status])).toEqual([
      ['order.cancelled', 'PENDENTE'],
      ['order.created', 'PUBLICADO'],
    ]);
    expect(events.body.items[0].payload.data.status).toBe('CANCELADO');

    // exclui
    const deleted = await request(app).delete(`/orders/${id}`);
    expect(deleted.status).toBe(204);
    expect(deleted.text).toBe('');
    expect((await request(app).get(`/orders/${id}`)).status).toBe(404);
    expect((await request(app).get('/events')).body.total).toBe(2); // os eventos ficam como histórico
  });

  it('PUT edita os dados do cliente enquanto o pedido está PENDENTE', async () => {
    const { app } = buildApp();
    const { body: created } = await request(app).post('/orders').send(orderBody());

    const updated = await request(app)
      .put(`/orders/${created.id}`)
      .send({ customerName: 'Ana Souza Lima', customerEmail: 'ANA.LIMA@exemplo.com' });

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id: created.id,
      customerName: 'Ana Souza Lima',
      customerEmail: 'ana.lima@exemplo.com',
      notes: null,
      status: 'PENDENTE',
    });
  });

  it('gera um x-correlation-id quando a requisição não manda (ou manda algo estranho)', async () => {
    const { app } = buildApp();

    const withoutHeader = await request(app).post('/orders').send(orderBody());
    expect(withoutHeader.headers['x-correlation-id']).toMatch(UUID);
    const events = await request(app).get('/events');
    expect(events.body.items[0].payload.correlationId).toBe(withoutHeader.headers['x-correlation-id']);

    const weird = await request(app).get('/health').set('x-correlation-id', 'valor com espaço <script>');
    expect(weird.headers['x-correlation-id']).toMatch(UUID);
  });
});

describe('HTTP — erros no formato padrão', () => {
  function expectError(response: request.Response, status: number, code: string): void {
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    expect(typeof response.body.error.message).toBe('string');
    expect(response.body.error.correlationId).toBe(response.headers['x-correlation-id']);
    expect(Object.keys(response.body)).toEqual(['error']);
  }

  it('400 VALIDATION_ERROR com details por campo', async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post('/orders')
      .send(orderBody({ customerEmail: 'sem-arroba', items: [coffee({ quantity: 1000 })] }));

    expectError(response, 400, 'VALIDATION_ERROR');
    expect(response.body.error.message).toBe('Dados inválidos.');
    expect(response.body.error.details).toEqual([
      { field: 'customerEmail', message: 'E-mail inválido.' },
      { field: 'items.0.quantity', message: 'Deve ser no máximo 999.' },
    ]);
  });

  it('400 VALIDATION_ERROR para corpo ausente e para parâmetro de consulta inválido', async () => {
    const { app } = buildApp();

    expectError(await request(app).post('/orders'), 400, 'VALIDATION_ERROR');
    expectError(await request(app).get('/orders?pageSize=500'), 400, 'VALIDATION_ERROR');
    expectError(await request(app).get('/events?limit=0'), 400, 'VALIDATION_ERROR');
  });

  it('400 INVALID_JSON para JSON malformado', async () => {
    const { app } = buildApp();

    const response = await request(app).post('/orders').set('content-type', 'application/json').send('{ "customerName": ');

    expectError(response, 400, 'INVALID_JSON');
  });

  it('422 DUPLICATED_ITEM para produto repetido', async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post('/orders')
      .send(orderBody({ items: [coffee(), coffee({ quantity: 3 })] }));

    expectError(response, 422, 'DUPLICATED_ITEM');
    expect((await request(app).get('/orders')).body.total).toBe(0);
  });

  it('404 ORDER_NOT_FOUND para pedido inexistente e para id que não é UUID', async () => {
    const { app } = buildApp();

    expectError(await request(app).get(`/orders/${UNKNOWN_ORDER_ID}`), 404, 'ORDER_NOT_FOUND');
    expectError(await request(app).get('/orders/123'), 404, 'ORDER_NOT_FOUND');
    expectError(await request(app).delete('/orders/abc'), 404, 'ORDER_NOT_FOUND');
    expectError(await request(app).patch('/orders/abc/status').send({ status: 'PAGO' }), 404, 'ORDER_NOT_FOUND');
    expectError(
      await request(app).put('/orders/abc').send({ customerName: 'Ana Souza', customerEmail: 'ana@exemplo.com' }),
      404,
      'ORDER_NOT_FOUND',
    );
  });

  it('404 ROUTE_NOT_FOUND para rota que não existe', async () => {
    const { app } = buildApp();

    expectError(await request(app).get('/pedidos'), 404, 'ROUTE_NOT_FOUND');
    expectError(await request(app).post('/orders/abc/cancel'), 404, 'ROUTE_NOT_FOUND');
  });

  it('409 INVALID_STATUS_TRANSITION, ORDER_NOT_EDITABLE e ORDER_NOT_DELETABLE', async () => {
    const { app } = buildApp();
    const { body: order } = await request(app).post('/orders').send(orderBody());

    expectError(await request(app).delete(`/orders/${order.id}`), 409, 'ORDER_NOT_DELETABLE');
    expectError(
      await request(app).patch(`/orders/${order.id}/status`).send({ status: 'ENTREGUE' }),
      409,
      'INVALID_STATUS_TRANSITION',
    );

    await request(app).patch(`/orders/${order.id}/status`).send({ status: 'PAGO' }).expect(200);
    expectError(
      await request(app).put(`/orders/${order.id}`).send({ customerName: 'Outro Nome', customerEmail: 'outro@exemplo.com' }),
      409,
      'ORDER_NOT_EDITABLE',
    );
  });

  it('409 CONCURRENT_UPDATE quando duas requisições cancelam o mesmo pedido ao mesmo tempo', async () => {
    const { app } = buildApp();
    const { body: order } = await request(app).post('/orders').send(orderBody());

    const cancel = () => request(app).patch(`/orders/${order.id}/status`).send({ status: 'CANCELADO' });
    const responses = await Promise.all([cancel(), cancel()]);

    // Uma vence. A outra recebe 409: CONCURRENT_UPDATE se as duas leram o pedido antes da gravação,
    // ou INVALID_STATUS_TRANSITION se ela só leu depois. Nos dois casos, um evento só.
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409)!;
    expect(['CONCURRENT_UPDATE', 'INVALID_STATUS_TRANSITION']).toContain(loser.body.error.code);
    const events = await request(app).get('/events');
    expect(events.body.items.filter((item: { type: string }) => item.type === 'order.cancelled')).toHaveLength(1);
  });

  it('500 INTERNAL_ERROR sem vazar detalhes do erro', async () => {
    const application = createTestApplication();
    const broken = {
      ...application.handlers,
      listOrders: { execute: async () => Promise.reject(new Error('senha do banco: segredo123')) },
    } as unknown as AppDependencies['handlers'];
    const { app } = buildApp({ handlers: broken });

    const response = await request(app).get('/orders');

    expectError(response, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('segredo123');
  });

  it('503 DATABASE_UNAVAILABLE com Retry-After quando o banco está acordando', async () => {
    const application = createTestApplication();
    const sleeping = {
      ...application.handlers,
      listOrders: {
        execute: async () =>
          Promise.reject(new ServiceUnavailableError('DATABASE_UNAVAILABLE', 'O banco de dados está temporariamente indisponível.', 10)),
      },
    } as unknown as AppDependencies['handlers'];
    const { app } = buildApp({ handlers: sleeping });

    const response = await request(app).get('/orders');

    expectError(response, 503, 'DATABASE_UNAVAILABLE');
    expect(response.headers['retry-after']).toBe('10');
    expect(response.body.error.message).toContain('temporariamente indisponível');

    // o /health continua respondendo, porque não depende do banco
    expect((await request(app).get('/health')).status).toBe(200);
  });
});

describe('HTTP — chave interna (INTERNAL_API_KEY)', () => {
  const KEY = 'chave-de-teste-123';

  it('exige x-api-key nas rotas de pedidos e eventos', async () => {
    const { app } = buildApp({ internalApiKey: KEY });

    const semChave = await request(app).get('/orders');
    expect(semChave.status).toBe(401);
    expect(semChave.body.error.code).toBe('UNAUTHORIZED');

    expect((await request(app).get('/orders').set('x-api-key', 'errada')).status).toBe(401);
    expect((await request(app).post('/orders').send(orderBody())).status).toBe(401);
    expect((await request(app).get('/events')).status).toBe(401);
    expect((await request(app).post('/events/dispatch')).status).toBe(401);

    expect((await request(app).get('/orders').set('x-api-key', KEY)).status).toBe(200);
    expect((await request(app).post('/orders').set('x-api-key', KEY).send(orderBody())).status).toBe(201);
  });

  it('deixa abertas as rotas públicas: health, Swagger, OpenAPI e documentação de eventos', async () => {
    const { app } = buildApp({ internalApiKey: KEY });

    for (const path of ['/health', '/docs/', '/openapi.json', '/events/docs', '/events/asyncapi.yaml', '/events/asyncapi.json']) {
      expect((await request(app).get(path)).status, path).toBe(200);
    }
    expect((await request(app).get('/')).status).toBe(302);
  });

  it('sem a variável definida, não exige chave nenhuma', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/orders')).status).toBe(200);
  });
});
