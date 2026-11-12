// Documento OpenAPI 3 do serviço, escrito à mão para ficar igual ao contrato combinado com o BFF.
// É servido em /openapi.json e renderizado pelo Swagger UI em /docs.

const ORDER_ID = '7f9c2b1e-4d3a-4c8e-9b2f-1a2b3c4d5e6f';
const EVENT_ID = '0b6f3c52-8a41-4f0e-9a57-3d2c1b0a9e8d';
const CORRELATION_ID = '5d1c7a90-2b7e-4d55-8f0a-6c1e2d3f4a5b';
const PRODUCT_ID_1 = 'c0ffee00-1111-4222-8333-444455556666';
const PRODUCT_ID_2 = 'badc0de0-7777-4888-9999-aaaabbbbcccc';

const orderExample = {
  id: ORDER_ID,
  customerName: 'Ana Souza',
  customerEmail: 'ana@exemplo.com',
  status: 'PENDENTE',
  items: [
    { productId: PRODUCT_ID_1, productName: 'Café torrado 500g', unitPrice: 24.9, quantity: 2, subtotal: 49.8 },
    { productId: PRODUCT_ID_2, productName: 'Filtro de papel 103', unitPrice: 6.5, quantity: 1, subtotal: 6.5 },
  ],
  total: 56.3,
  itemCount: 3,
  notes: 'Entregar no período da tarde.',
  allowedTransitions: ['PAGO', 'CANCELADO'],
  createdAt: '2025-06-10T14:30:00.000Z',
  updatedAt: '2025-06-10T14:30:00.000Z',
};

const eventExample = {
  eventId: EVENT_ID,
  type: 'order.created',
  version: 1,
  source: 'ms-pedidos',
  occurredAt: '2025-06-10T14:30:00.000Z',
  correlationId: CORRELATION_ID,
  data: {
    orderId: ORDER_ID,
    customerName: 'Ana Souza',
    customerEmail: 'ana@exemplo.com',
    status: 'PENDENTE',
    total: 56.3,
    items: [
      { productId: PRODUCT_ID_1, productName: 'Café torrado 500g', quantity: 2, unitPrice: 24.9 },
      { productId: PRODUCT_ID_2, productName: 'Filtro de papel 103', quantity: 1, unitPrice: 6.5 },
    ],
  },
};

const outboxItemExample = {
  id: EVENT_ID,
  type: 'order.created',
  aggregateId: ORDER_ID,
  occurredAt: '2025-06-10T14:30:00.000Z',
  processedAt: '2025-06-10T14:30:00.412Z',
  attempts: 1,
  lastError: null,
  status: 'PUBLICADO',
  payload: eventExample,
};

function errorExample(code: string, message: string, details?: unknown[]) {
  return { error: { code, message, ...(details ? { details } : {}), correlationId: CORRELATION_ID } };
}

function errorResponse(description: string, examples: Record<string, { summary?: string; value: unknown }>) {
  return {
    description,
    headers: { 'x-correlation-id': { $ref: '#/components/headers/CorrelationId' } },
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, examples } },
  };
}

const orderIdParameter = { $ref: '#/components/parameters/OrderId' };
const correlationHeader = { 'x-correlation-id': { $ref: '#/components/headers/CorrelationId' } };

const orderNotFoundResponse = errorResponse('Pedido não existe (um id que não é UUID também cai aqui).', {
  naoEncontrado: { value: errorExample('ORDER_NOT_FOUND', `Pedido ${ORDER_ID} não encontrado.`) },
});

const validationResponse = (field: string, message: string) =>
  errorResponse('Corpo ou parâmetros inválidos. `details` lista cada campo com problema.', {
    validacao: {
      summary: 'Campo inválido',
      value: errorExample('VALIDATION_ERROR', 'Dados inválidos.', [{ field, message }]),
    },
    jsonInvalido: {
      summary: 'JSON malformado',
      value: errorExample('INVALID_JSON', 'O corpo da requisição não é um JSON válido.'),
    },
  });

export function buildOpenApiDocument(options: { publicUrl?: string } = {}): Record<string, unknown> {
  // com PUBLIC_URL definida os links saem absolutos (ficam certos também fora do Swagger UI)
  const eventsDocsUrl = options.publicUrl ? `${options.publicUrl}/events/docs` : '/events/docs';

  return {
    openapi: '3.0.3',
    info: {
      title: 'Conecta Store — ms-pedidos',
      version: '1.0.0',
      description: [
        'Microserviço de **Pedidos** do Conecta Store (PJBL de Arquitetura). Guarda os pedidos no **Azure SQL** e avisa o resto do sistema por **eventos**.',
        '',
        '**Regras de negócio**',
        '- um pedido tem de 1 a 20 itens, sem produto repetido; quantidade de 1 a 999 e preço maior que zero;',
        '- o total é calculado pelo serviço (soma dos subtotais, arredondada em 2 casas);',
        '- máquina de estados: `PENDENTE → PAGO | CANCELADO`, `PAGO → ENVIADO | CANCELADO`, `ENVIADO → ENTREGUE`. `ENTREGUE` e `CANCELADO` são finais;',
        '- os dados do cliente só podem ser editados enquanto o pedido está `PENDENTE`; os itens nunca mudam;',
        '- só pedido `CANCELADO` pode ser excluído.',
        '',
        '**Eventos (Transactional Outbox)**',
        '',
        'Criar ou cancelar um pedido grava, na mesma transação, uma mensagem na tabela `OutboxMessages`. Um relay em background publica essas mensagens na fila `order-events` (Azure Storage Queue), e a Azure Function do projeto baixa ou devolve o estoque no ms-produtos.',
        '',
        'A documentação dos eventos (AsyncAPI) está em [/events/docs](' + eventsDocsUrl + ') — é o "Swagger de eventos" do projeto.',
        '',
        '**Erros**',
        '',
        'Todo erro segue o formato `{ "error": { "code", "message", "details?", "correlationId" } }`. O cabeçalho `x-correlation-id` é aceito na requisição, devolvido na resposta e copiado para dentro do evento publicado.',
      ].join('\n'),
    },
    externalDocs: {
      description: 'Documentação dos eventos (AsyncAPI) — /events/docs',
      url: eventsDocsUrl,
    },
    servers: [
      options.publicUrl
        ? { url: options.publicUrl, description: 'Ambiente publicado' }
        : { url: '/', description: 'Este servidor' },
    ],
    tags: [
      { name: 'Pedidos', description: 'CRUD de pedidos e mudança de status.' },
      {
        name: 'Eventos',
        description: 'Outbox: eventos gerados pelos pedidos e a publicação deles na fila.',
        externalDocs: { description: 'Formato das mensagens (AsyncAPI)', url: eventsDocsUrl },
      },
      { name: 'Infra', description: 'Verificação de saúde do serviço.' },
    ],
    security: [{ ApiKeyAuth: [] }],
    paths: {
      '/orders': {
        post: {
          tags: ['Pedidos'],
          operationId: 'createOrder',
          summary: 'Cria um pedido',
          description:
            'Cria o pedido com status `PENDENTE` e grava o evento `order.created` no outbox, na mesma transação. ' +
            'A baixa de estoque acontece depois, de forma assíncrona, quando a Azure Function consome o evento.\n\n' +
            'O nome e o preço de cada item vêm de quem chama (o BFF busca os valores oficiais no ms-produtos antes).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateOrderRequest' },
                examples: {
                  pedido: {
                    summary: 'Pedido com dois itens',
                    value: {
                      customerName: 'Ana Souza',
                      customerEmail: 'ana@exemplo.com',
                      notes: 'Entregar no período da tarde.',
                      items: [
                        { productId: PRODUCT_ID_1, productName: 'Café torrado 500g', unitPrice: 24.9, quantity: 2 },
                        { productId: PRODUCT_ID_2, productName: 'Filtro de papel 103', unitPrice: 6.5, quantity: 1 },
                      ],
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Pedido criado.',
              headers: {
                ...correlationHeader,
                Location: { description: 'Caminho do pedido criado.', schema: { type: 'string', example: `/orders/${ORDER_ID}` } },
              },
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' }, example: orderExample } },
            },
            '400': validationResponse('items.0.quantity', 'Deve ser no mínimo 1.'),
            '401': { $ref: '#/components/responses/Unauthorized' },
            '422': errorResponse('Regra de negócio violada.', {
              itemRepetido: {
                summary: 'Mesmo produto em dois itens',
                value: errorExample(
                  'DUPLICATED_ITEM',
                  `O produto ${PRODUCT_ID_1} aparece mais de uma vez no pedido. Some as quantidades em um único item.`,
                  [{ field: 'items.1.productId', message: 'Produto repetido no pedido.' }],
                ),
              },
            }),
            '503': { $ref: '#/components/responses/DatabaseUnavailable' },
          },
        },
        get: {
          tags: ['Pedidos'],
          operationId: 'listOrders',
          summary: 'Lista pedidos (mais recentes primeiro)',
          parameters: [
            {
              name: 'status',
              in: 'query',
              description: 'Filtra por status.',
              schema: { $ref: '#/components/schemas/OrderStatus' },
            },
            {
              name: 'search',
              in: 'query',
              description: 'Trecho do nome ou do e-mail do cliente.',
              schema: { type: 'string', maxLength: 100 },
              example: 'ana',
            },
            { name: 'page', in: 'query', description: 'Página (começa em 1).', schema: { type: 'integer', minimum: 1, default: 1 } },
            {
              name: 'pageSize',
              in: 'query',
              description: 'Itens por página.',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: {
            '200': {
              description: 'Página de pedidos.',
              headers: correlationHeader,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OrderList' },
                  example: { items: [orderExample], total: 1, page: 1, pageSize: 20 },
                },
              },
            },
            '400': errorResponse('Parâmetro de consulta inválido.', {
              validacao: {
                value: errorExample('VALIDATION_ERROR', 'Dados inválidos.', [
                  { field: 'pageSize', message: 'Deve ser no máximo 100.' },
                ]),
              },
            }),
            '401': { $ref: '#/components/responses/Unauthorized' },
            '503': { $ref: '#/components/responses/DatabaseUnavailable' },
          },
        },
      },
      '/orders/{id}': {
        get: {
          tags: ['Pedidos'],
          operationId: 'getOrder',
          summary: 'Busca um pedido pelo id',
          description: 'A resposta traz `allowedTransitions`, com os status para os quais o pedido pode ir agora.',
          parameters: [orderIdParameter],
          responses: {
            '200': {
              description: 'Pedido encontrado.',
              headers: correlationHeader,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' }, example: orderExample } },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': orderNotFoundResponse,
            '503': { $ref: '#/components/responses/DatabaseUnavailable' },
          },
        },
        put: {
          tags: ['Pedidos'],
          operationId: 'updateOrder',
          summary: 'Edita os dados do cliente',
          description:
            'Só funciona enquanto o pedido está `PENDENTE`. Os itens não podem ser alterados. ' +
            'É uma substituição completa: se `notes` não for enviado, a observação é apagada.',
          parameters: [orderIdParameter],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdateOrderRequest' },
                example: { customerName: 'Ana Souza Lima', customerEmail: 'ana.lima@exemplo.com', notes: 'Portaria 2.' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Pedido atualizado.',
              headers: correlationHeader,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Order' },
                  example: {
                    ...orderExample,
                    customerName: 'Ana Souza Lima',
                    customerEmail: 'ana.lima@exemplo.com',
                    notes: 'Portaria 2.',
                    updatedAt: '2025-06-10T15:02:11.000Z',
                  },
                },
              },
            },
            '400': validationResponse('customerEmail', 'E-mail inválido.'),
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': orderNotFoundResponse,
            '409': errorResponse('O pedido não está mais `PENDENTE`.', {
              naoEditavel: {
                value: errorExample(
                  'ORDER_NOT_EDITABLE',
                  'Só é possível editar pedidos com status PENDENTE (status atual: PAGO).',
                ),
              },
            }),
            '503': { $ref: '#/components/responses/DatabaseUnavailable' },
          },
        },
        delete: {
          tags: ['Pedidos'],
          operationId: 'deleteOrder',
          summary: 'Exclui um pedido cancelado',
          description:
            'Só pedidos `CANCELADO` podem ser excluídos. Os itens saem junto; os eventos já gerados continuam no outbox como histórico.',
          parameters: [orderIdParameter],
          responses: {
            '204': { description: 'Pedido excluído (sem corpo).', headers: correlationHeader },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': orderNotFoundResponse,
            '409': errorResponse('O pedido não está `CANCELADO`.', {
              naoExcluivel: {
                value: errorExample(
                  'ORDER_NOT_DELETABLE',
                  'Só é possível excluir pedidos com status CANCELADO (status atual: PENDENTE).',
                ),
              },
            }),
            '503': { $ref: '#/components/responses/DatabaseUnavailable' },
          },
        },
      },
      '/orders/{id}/status': {
        patch: {
          tags: ['Pedidos'],
          operationId: 'changeOrderStatus',
          summary: 'Muda o status do pedido',
          description:
            'Aplica uma transição da máquina de estados. Ir para `CANCELADO` grava o evento `order.cancelled` no outbox ' +
            '(a Function devolve o estoque).\n\n' +
            'A gravação usa concorrência otimista (`UPDATE ... WHERE Id = @id AND Status = @statusLido`): se duas requisições ' +
            'tentarem mudar o mesmo pedido ao mesmo tempo, só uma vence e a outra recebe `409 CONCURRENT_UPDATE`. ' +
            'Assim dois cancelamentos simultâneos nunca geram dois eventos de devolução.',
          parameters: [orderIdParameter],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChangeOrderStatusRequest' },
                examples: {
                  pagar: { summary: 'Marcar como pago', value: { status: 'PAGO' } },
                  cancelar: { summary: 'Cancelar (gera order.cancelled)', value: { status: 'CANCELADO' } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Status alterado.',
              headers: correlationHeader,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Order' },
                  example: {
                    ...orderExample,
                    status: 'PAGO',
                    allowedTransitions: ['ENVIADO', 'CANCELADO'],
                    updatedAt: '2025-06-10T15:10:00.000Z',
                  },
                },
              },
            },
            '400': validationResponse('status', 'Valor inválido. Use um destes: PENDENTE, PAGO, ENVIADO, ENTREGUE, CANCELADO.'),
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': orderNotFoundResponse,
            '409': errorResponse('Transição não permitida ou atualização concorrente.', {
              transicaoInvalida: {
                summary: 'Transição fora da máquina de estados',
                value: errorExample(
                  'INVALID_STATUS_TRANSITION',
                  'Não é possível mudar o pedido de ENVIADO para CANCELADO. Transições permitidas: ENTREGUE.',
                ),
              },
              concorrencia: {
                summary: 'Outra requisição mudou o pedido antes',
                value: errorExample(
                  'CONCURRENT_UPDATE',
                  'O pedido foi alterado por outra requisição ao mesmo tempo. Consulte o pedido e tente novamente.',
                ),
              },
            }),
            '503': { $ref: '#/components/responses/DatabaseUnavailable' },
          },
        },
      },
      '/events': {
        get: {
          tags: ['Eventos'],
          operationId: 'listOrderEvents',
          summary: 'Lista as mensagens do outbox (mais recentes primeiro)',
          description:
            'Mostra os eventos gerados pelos pedidos e a situação de cada um:\n' +
            '- `PUBLICADO`: já foi para a fila (`processedAt` preenchido);\n' +
            '- `FALHOU`: a última tentativa deu erro (`lastError`) e o relay vai tentar de novo;\n' +
            '- `PENDENTE`: ainda não houve tentativa.\n\n' +
            'O formato do `payload` está documentado em [/events/docs](' + eventsDocsUrl + ').',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              description: 'Quantidade máxima de mensagens.',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: {
            '200': {
              description: 'Mensagens do outbox. `total` é a quantidade total na tabela.',
              headers: correlationHeader,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OutboxList' },
                  example: { items: [outboxItemExample], total: 1 },
                },
              },
            },
            '400': errorResponse('Parâmetro de consulta inválido.', {
              validacao: {
                value: errorExample('VALIDATION_ERROR', 'Dados inválidos.', [
                  { field: 'limit', message: 'Deve ser no máximo 100.' },
                ]),
              },
            }),
            '401': { $ref: '#/components/responses/Unauthorized' },
            '503': { $ref: '#/components/responses/DatabaseUnavailable' },
          },
        },
      },
      '/events/dispatch': {
        post: {
          tags: ['Eventos'],
          operationId: 'dispatchOrderEvents',
          summary: 'Força a publicação dos eventos pendentes',
          description:
            'Executa agora uma rodada do relay do outbox. Normalmente não é necessário: o relay publica sozinho logo depois ' +
            'que um pedido é criado ou cancelado e, se a publicação falhar, tenta de novo a cada `OUTBOX_INTERVAL_MS`. ' +
            'Se já houver uma rodada em andamento, a chamada espera por ela e devolve o mesmo resultado (nunca rodam duas ao mesmo tempo).',
          responses: {
            '200': {
              description: 'Resultado da rodada.',
              headers: correlationHeader,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DispatchResult' },
                  example: { published: 2, failed: 0, pending: 0 },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '503': { $ref: '#/components/responses/DatabaseUnavailable' },
          },
        },
      },
      '/events/docs': {
        get: {
          tags: ['Eventos'],
          operationId: 'eventsDocs',
          summary: 'Página com a documentação dos eventos (AsyncAPI)',
          description: 'Página HTML que renderiza a especificação AsyncAPI. Não exige chave.',
          security: [],
          responses: { '200': { description: 'Página HTML.', content: { 'text/html': { schema: { type: 'string' } } } } },
        },
      },
      '/events/asyncapi.yaml': {
        get: {
          tags: ['Eventos'],
          operationId: 'asyncApiYaml',
          summary: 'Especificação AsyncAPI 2.6.0 (YAML)',
          security: [],
          responses: { '200': { description: 'Documento AsyncAPI.', content: { 'text/yaml': { schema: { type: 'string' } } } } },
        },
      },
      '/events/asyncapi.json': {
        get: {
          tags: ['Eventos'],
          operationId: 'asyncApiJson',
          summary: 'Especificação AsyncAPI 2.6.0 (JSON)',
          security: [],
          responses: {
            '200': { description: 'Documento AsyncAPI.', content: { 'application/json': { schema: { type: 'object' } } } },
          },
        },
      },
      '/health': {
        get: {
          tags: ['Infra'],
          operationId: 'health',
          summary: 'Saúde do serviço',
          description:
            'Responde na hora e **não consulta o banco** de propósito: a plataforma chama este endereço o tempo todo e, ' +
            'se ele tocasse no Azure SQL, o banco gratuito nunca conseguiria pausar. ' +
            '`database` e `publisher` só informam como o serviço foi configurado.',
          security: [],
          responses: {
            '200': {
              description: 'Serviço no ar.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Health' },
                  example: {
                    status: 'ok',
                    service: 'ms-pedidos',
                    database: 'sql',
                    publisher: 'azure-queue',
                    uptime: 1234,
                    timestamp: '2025-06-10T14:30:00.000Z',
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description:
            'Chave interna entre os serviços. Só é exigida quando o serviço sobe com `INTERNAL_API_KEY` definida ' +
            '(na nuvem, o BFF envia). Em desenvolvimento, sem a variável, não precisa informar nada.',
        },
      },
      parameters: {
        OrderId: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Identificador do pedido (UUID).',
          schema: { type: 'string', format: 'uuid' },
          example: ORDER_ID,
        },
      },
      headers: {
        CorrelationId: {
          description: 'Identificador de correlação da requisição (o mesmo recebido em `x-correlation-id`, ou um UUID gerado).',
          schema: { type: 'string', example: CORRELATION_ID },
        },
      },
      responses: {
        Unauthorized: errorResponse('Chave interna ausente ou errada (só quando `INTERNAL_API_KEY` está definida).', {
          semChave: {
            value: errorExample('UNAUTHORIZED', 'Chave de acesso ausente ou inválida (cabeçalho x-api-key).'),
          },
        }),
        DatabaseUnavailable: {
          description:
            'Banco temporariamente indisponível. O Azure SQL gratuito (serverless) pausa quando fica sem uso e leva cerca de ' +
            'um minuto para acordar. O serviço tenta de novo sozinho por até ~20 segundos antes de responder isto. ' +
            'Basta repetir a chamada depois do tempo indicado em `Retry-After`.',
          headers: {
            ...correlationHeader,
            'Retry-After': { description: 'Segundos para tentar de novo.', schema: { type: 'integer', example: 10 } },
          },
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              example: errorExample(
                'DATABASE_UNAVAILABLE',
                'O banco de dados está temporariamente indisponível. O Azure SQL gratuito pausa quando fica sem uso e leva cerca de um minuto para acordar. Tente novamente em alguns segundos.',
              ),
            },
          },
        },
      },
      schemas: {
        OrderStatus: {
          type: 'string',
          enum: ['PENDENTE', 'PAGO', 'ENVIADO', 'ENTREGUE', 'CANCELADO'],
          description: '`PENDENTE → PAGO | CANCELADO`, `PAGO → ENVIADO | CANCELADO`, `ENVIADO → ENTREGUE`.',
        },
        OrderItem: {
          type: 'object',
          required: ['productId', 'productName', 'unitPrice', 'quantity', 'subtotal'],
          properties: {
            productId: { type: 'string', description: 'Id do produto no ms-produtos.', example: PRODUCT_ID_1 },
            productName: { type: 'string', description: 'Nome do produto no momento da compra.', example: 'Café torrado 500g' },
            unitPrice: { type: 'number', format: 'double', description: 'Preço unitário no momento da compra.', example: 24.9 },
            quantity: { type: 'integer', minimum: 1, maximum: 999, example: 2 },
            subtotal: { type: 'number', format: 'double', description: '`unitPrice × quantity`, com 2 casas.', example: 49.8 },
          },
        },
        Order: {
          type: 'object',
          required: [
            'id',
            'customerName',
            'customerEmail',
            'status',
            'items',
            'total',
            'itemCount',
            'notes',
            'allowedTransitions',
            'createdAt',
            'updatedAt',
          ],
          properties: {
            id: { type: 'string', format: 'uuid', example: ORDER_ID },
            customerName: { type: 'string', example: 'Ana Souza' },
            customerEmail: { type: 'string', format: 'email', description: 'Sempre em minúsculas.', example: 'ana@exemplo.com' },
            status: { $ref: '#/components/schemas/OrderStatus' },
            items: { type: 'array', items: { $ref: '#/components/schemas/OrderItem' } },
            total: { type: 'number', format: 'double', description: 'Soma dos subtotais, com 2 casas.', example: 56.3 },
            itemCount: { type: 'integer', description: 'Soma das quantidades dos itens.', example: 3 },
            notes: { type: 'string', nullable: true, maxLength: 500, example: 'Entregar no período da tarde.' },
            allowedTransitions: {
              type: 'array',
              description: 'Status para os quais o pedido pode ir agora (vazio quando o status é final).',
              items: { $ref: '#/components/schemas/OrderStatus' },
              example: ['PAGO', 'CANCELADO'],
            },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        OrderList: {
          type: 'object',
          required: ['items', 'total', 'page', 'pageSize'],
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/Order' } },
            total: { type: 'integer', description: 'Total de pedidos que batem com o filtro.', example: 1 },
            page: { type: 'integer', example: 1 },
            pageSize: { type: 'integer', example: 20 },
          },
        },
        CreateOrderItem: {
          type: 'object',
          required: ['productId', 'productName', 'unitPrice', 'quantity'],
          properties: {
            productId: { type: 'string', minLength: 1, maxLength: 64, example: PRODUCT_ID_1 },
            productName: { type: 'string', minLength: 1, maxLength: 160, example: 'Café torrado 500g' },
            unitPrice: { type: 'number', format: 'double', exclusiveMinimum: true, minimum: 0, maximum: 100000, example: 24.9 },
            quantity: { type: 'integer', minimum: 1, maximum: 999, example: 2 },
          },
        },
        CreateOrderRequest: {
          type: 'object',
          required: ['customerName', 'customerEmail', 'items'],
          properties: {
            customerName: { type: 'string', minLength: 2, maxLength: 120, example: 'Ana Souza' },
            customerEmail: { type: 'string', format: 'email', maxLength: 160, example: 'ana@exemplo.com' },
            notes: { type: 'string', nullable: true, maxLength: 500, example: 'Entregar no período da tarde.' },
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              description: 'De 1 a 20 itens, sem repetir `productId`.',
              items: { $ref: '#/components/schemas/CreateOrderItem' },
            },
          },
        },
        UpdateOrderRequest: {
          type: 'object',
          required: ['customerName', 'customerEmail'],
          properties: {
            customerName: { type: 'string', minLength: 2, maxLength: 120, example: 'Ana Souza Lima' },
            customerEmail: { type: 'string', format: 'email', maxLength: 160, example: 'ana.lima@exemplo.com' },
            notes: { type: 'string', nullable: true, maxLength: 500, description: 'Ausente ou `null` apaga a observação.' },
          },
        },
        ChangeOrderStatusRequest: {
          type: 'object',
          required: ['status'],
          properties: { status: { $ref: '#/components/schemas/OrderStatus' } },
        },
        OrderEventItem: {
          type: 'object',
          required: ['productId', 'productName', 'quantity', 'unitPrice'],
          properties: {
            productId: { type: 'string', example: PRODUCT_ID_1 },
            productName: { type: 'string', example: 'Café torrado 500g' },
            quantity: { type: 'integer', example: 2 },
            unitPrice: { type: 'number', format: 'double', example: 24.9 },
          },
        },
        OrderEvent: {
          type: 'object',
          description: 'Evento do jeito que vai para a fila `order-events` (ver /events/docs).',
          required: ['eventId', 'type', 'version', 'source', 'occurredAt', 'correlationId', 'data'],
          properties: {
            eventId: { type: 'string', format: 'uuid', description: 'Identificador único do evento (usado na idempotência).' },
            type: { type: 'string', enum: ['order.created', 'order.cancelled'] },
            version: { type: 'integer', example: 1 },
            source: { type: 'string', example: 'ms-pedidos' },
            occurredAt: { type: 'string', format: 'date-time' },
            correlationId: { type: 'string', description: 'O `x-correlation-id` da requisição que gerou o evento.' },
            data: {
              type: 'object',
              required: ['orderId', 'customerName', 'customerEmail', 'status', 'total', 'items'],
              properties: {
                orderId: { type: 'string', format: 'uuid' },
                customerName: { type: 'string' },
                customerEmail: { type: 'string' },
                status: { $ref: '#/components/schemas/OrderStatus' },
                total: { type: 'number', format: 'double' },
                items: { type: 'array', items: { $ref: '#/components/schemas/OrderEventItem' } },
              },
            },
          },
          example: eventExample,
        },
        OutboxItem: {
          type: 'object',
          required: ['id', 'type', 'aggregateId', 'occurredAt', 'processedAt', 'attempts', 'lastError', 'status', 'payload'],
          properties: {
            id: { type: 'string', format: 'uuid', description: 'Igual ao `eventId` do payload.' },
            type: { type: 'string', enum: ['order.created', 'order.cancelled'] },
            aggregateId: { type: 'string', format: 'uuid', description: 'Id do pedido que gerou o evento.' },
            occurredAt: { type: 'string', format: 'date-time' },
            processedAt: { type: 'string', format: 'date-time', nullable: true, description: 'Quando foi publicado na fila.' },
            attempts: { type: 'integer', description: 'Tentativas de publicação.', example: 1 },
            lastError: { type: 'string', nullable: true, description: 'Erro da última tentativa que falhou.' },
            status: {
              type: 'string',
              enum: ['PUBLICADO', 'FALHOU', 'PENDENTE'],
              description:
                '`PUBLICADO` (tem `processedAt`), `FALHOU` (sem `processedAt` e com `lastError`), `PENDENTE` (o resto).',
            },
            payload: { $ref: '#/components/schemas/OrderEvent' },
          },
        },
        OutboxList: {
          type: 'object',
          required: ['items', 'total'],
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/OutboxItem' } },
            total: { type: 'integer', description: 'Total de mensagens no outbox.', example: 1 },
          },
        },
        DispatchResult: {
          type: 'object',
          required: ['published', 'failed', 'pending'],
          properties: {
            published: { type: 'integer', description: 'Mensagens publicadas nesta rodada.', example: 2 },
            failed: { type: 'integer', description: 'Mensagens que falharam nesta rodada.', example: 0 },
            pending: {
              type: 'integer',
              description: 'Mensagens que continuam sem publicar depois da rodada (inclui as que falharam).',
              example: 0,
            },
          },
        },
        Health: {
          type: 'object',
          required: ['status', 'service', 'database', 'publisher', 'uptime', 'timestamp'],
          properties: {
            status: { type: 'string', enum: ['ok'] },
            service: { type: 'string', enum: ['ms-pedidos'] },
            database: { type: 'string', enum: ['sql', 'memory'], description: 'Onde os pedidos estão sendo guardados.' },
            publisher: {
              type: 'string',
              enum: ['azure-queue', 'log'],
              description: '`azure-queue` publica na fila; `log` só escreve o evento no log (desenvolvimento).',
            },
            uptime: { type: 'integer', description: 'Segundos desde que o processo subiu.' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'correlationId'],
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string', example: 'Dados inválidos.' },
                details: {
                  type: 'array',
                  description: 'Presente nos erros de validação: um item por campo com problema.',
                  items: {
                    type: 'object',
                    properties: { field: { type: 'string' }, message: { type: 'string' } },
                  },
                },
                correlationId: { type: 'string', example: CORRELATION_ID },
              },
            },
          },
        },
      },
    },
  };
}
