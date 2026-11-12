import { describe, expect, it } from 'vitest';
import { UpdateOrderHandler } from '../../../src/application/features/UpdateOrder/UpdateOrder';
import type { OrderRepository } from '../../../src/application/ports/OrderRepository';
import { ConflictError, DomainError, NotFoundError, ValidationError } from '../../../src/domain/errors';
import { Order } from '../../../src/domain/order/Order';
import {
  captureError,
  coffee,
  CONTEXT,
  createTestApplication,
  filter,
  newOrderInput,
  orderBody,
  UNKNOWN_ORDER_ID,
} from '../../support/testKit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('CreateOrder', () => {
  it('grava o pedido e o evento order.created no outbox, juntos, e avisa o relay', async () => {
    const { handlers, database, signal } = createTestApplication();

    const order = await handlers.createOrder.execute(orderBody(), CONTEXT);

    expect(order).toMatchObject({
      customerName: 'Ana Souza',
      customerEmail: 'ana@exemplo.com',
      status: 'PENDENTE',
      total: 56.3,
      itemCount: 3,
      notes: 'Entregar no período da tarde.',
      allowedTransitions: ['PAGO', 'CANCELADO'],
    });
    expect(order.id).toMatch(UUID);
    expect(order.items[0]).toEqual({ ...coffee(), subtotal: 49.8 });

    expect(database.orders.has(order.id)).toBe(true);
    expect(database.outbox).toHaveLength(1);
    const message = database.outbox[0]!.message;
    expect(message).toMatchObject({ type: 'order.created', aggregateId: order.id, processedAt: null, attempts: 0, lastError: null });
    expect(signal.notifications).toBe(1);
  });

  it('monta o evento exatamente no formato do contrato', async () => {
    const { handlers, database } = createTestApplication();

    const order = await handlers.createOrder.execute(orderBody(), { correlationId: 'corr-123' });

    const { payload, id } = database.outbox[0]!.message;
    expect(payload).toEqual({
      eventId: id,
      type: 'order.created',
      version: 1,
      source: 'ms-pedidos',
      occurredAt: order.createdAt,
      correlationId: 'corr-123',
      data: {
        orderId: order.id,
        customerName: 'Ana Souza',
        customerEmail: 'ana@exemplo.com',
        status: 'PENDENTE',
        total: 56.3,
        items: [
          { productId: coffee().productId, productName: 'Café torrado 500g', quantity: 2, unitPrice: 24.9 },
          { productId: filter().productId, productName: 'Filtro de papel 103', quantity: 1, unitPrice: 6.5 },
        ],
      },
    });
    expect(payload.eventId).toMatch(UUID);
  });

  it('devolve ValidationError com a lista de campos quando a entrada é inválida', async () => {
    const { handlers, database, signal } = createTestApplication();

    const error = await captureError(
      handlers.createOrder.execute(
        { customerName: 'A', customerEmail: 'nao-e-email', items: [coffee({ quantity: 0, unitPrice: -1 })] },
        CONTEXT,
      ),
    );

    expect(error).toBeInstanceOf(ValidationError);
    const details = (error as ValidationError).details as Array<{ field: string; message: string }>;
    expect(details.map((detail) => detail.field).sort()).toEqual([
      'customerEmail',
      'customerName',
      'items.0.quantity',
      'items.0.unitPrice',
    ]);
    expect(details.find((detail) => detail.field === 'customerEmail')?.message).toBe('E-mail inválido.');
    expect(database.orders.size).toBe(0);
    expect(database.outbox).toHaveLength(0);
    expect(signal.notifications).toBe(0);
  });

  it('exige os campos obrigatórios e pelo menos 1 item', async () => {
    const { handlers } = createTestApplication();

    const missing = (await captureError(handlers.createOrder.execute(undefined, CONTEXT))) as ValidationError;
    expect((missing.details as Array<{ field: string }>).map((detail) => detail.field).sort()).toEqual([
      'customerEmail',
      'customerName',
      'items',
    ]);

    const empty = (await captureError(handlers.createOrder.execute(orderBody({ items: [] }), CONTEXT))) as ValidationError;
    expect(empty.details).toEqual([{ field: 'items', message: 'O pedido precisa de pelo menos 1 item.' }]);
  });

  it('recusa produto repetido com DUPLICATED_ITEM e não grava nada (nem pedido, nem evento)', async () => {
    const { handlers, database, signal } = createTestApplication();

    const error = await captureError(
      handlers.createOrder.execute(orderBody({ items: [coffee(), coffee({ quantity: 5 })] }), CONTEXT),
    );

    expect(error).toBeInstanceOf(DomainError);
    expect(error).not.toBeInstanceOf(ValidationError);
    expect((error as DomainError).code).toBe('DUPLICATED_ITEM');
    expect(database.orders.size).toBe(0);
    expect(database.outbox).toHaveLength(0);
    expect(signal.notifications).toBe(0);
  });
});

describe('GetOrder', () => {
  it('devolve o pedido com allowedTransitions', async () => {
    const { handlers } = createTestApplication();
    const created = await handlers.createOrder.execute(orderBody(), CONTEXT);

    expect(await handlers.getOrder.execute(created.id)).toEqual(created);
    // o id é aceito em maiúsculas também (o SQL Server devolve assim)
    expect((await handlers.getOrder.execute(created.id.toUpperCase())).id).toBe(created.id);
  });

  it.each([UNKNOWN_ORDER_ID, 'abc', '123', "' OR 1=1 --"])('responde ORDER_NOT_FOUND para o id "%s"', async (id) => {
    const { handlers } = createTestApplication();

    const error = await captureError(handlers.getOrder.execute(id));

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).code).toBe('ORDER_NOT_FOUND');
  });
});

describe('ListOrders', () => {
  async function seed() {
    const app = createTestApplication();
    const create = (name: string, email: string) =>
      app.handlers.createOrder.execute(orderBody({ customerName: name, customerEmail: email }), CONTEXT);

    const ana = await create('Ana Souza', 'ana@exemplo.com');
    const bruno = await create('Bruno Lima', 'bruno@exemplo.com');
    const carla = await create('Carla Dias', 'carla@outro.com');
    await app.handlers.changeOrderStatus.execute(bruno.id, { status: 'PAGO' }, CONTEXT);
    return { ...app, ana, bruno, carla };
  }

  it('lista os mais recentes primeiro, com paginação', async () => {
    const { handlers, ana, bruno, carla } = await seed();

    const firstPage = await handlers.listOrders.execute({ page: '1', pageSize: '2' });
    expect(firstPage).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(firstPage.items.map((order) => order.id)).toEqual([carla.id, bruno.id]);

    const secondPage = await handlers.listOrders.execute({ page: '2', pageSize: '2' });
    expect(secondPage.items.map((order) => order.id)).toEqual([ana.id]);
    expect(secondPage.items[0]!.items).toHaveLength(2); // os itens vêm junto na listagem
    expect(secondPage.items[0]!.allowedTransitions).toEqual(['PAGO', 'CANCELADO']);
  });

  it('filtra por status e por trecho do nome ou do e-mail', async () => {
    const { handlers, ana, bruno, carla } = await seed();

    const paid = await handlers.listOrders.execute({ status: 'PAGO' });
    expect(paid.items.map((order) => order.id)).toEqual([bruno.id]);
    expect(paid.total).toBe(1);

    const byName = await handlers.listOrders.execute({ search: 'ANA' });
    expect(byName.items.map((order) => order.id)).toEqual([ana.id]);

    const byEmail = await handlers.listOrders.execute({ search: '@outro' });
    expect(byEmail.items.map((order) => order.id)).toEqual([carla.id]);

    const combined = await handlers.listOrders.execute({ status: 'PENDENTE', search: 'exemplo.com' });
    expect(combined.items.map((order) => order.id)).toEqual([ana.id]);
  });

  it('usa página 1 e 20 itens por padrão e trata filtro vazio como não informado', async () => {
    const { handlers } = await seed();

    const result = await handlers.listOrders.execute({ status: '', search: '' });

    expect(result).toMatchObject({ total: 3, page: 1, pageSize: 20 });
  });

  it.each([
    [{ pageSize: '101' }, 'pageSize'],
    [{ pageSize: '0' }, 'pageSize'],
    [{ page: '0' }, 'page'],
    [{ page: 'abc' }, 'page'],
    [{ status: 'DESCONHECIDO' }, 'status'],
  ])('recusa a consulta %j', async (query, field) => {
    const { handlers } = createTestApplication();

    const error = await captureError(handlers.listOrders.execute(query));

    expect(error).toBeInstanceOf(ValidationError);
    expect(((error as ValidationError).details as Array<{ field: string }>)[0]!.field).toBe(field);
  });
});

describe('UpdateOrder', () => {
  it('edita os dados do cliente de um pedido PENDENTE e não gera evento', async () => {
    const { handlers, database } = createTestApplication();
    const created = await handlers.createOrder.execute(orderBody(), CONTEXT);

    const updated = await handlers.updateOrder.execute(created.id, {
      customerName: 'Ana Souza Lima',
      customerEmail: 'Ana.Lima@Exemplo.com',
      notes: 'Portaria 2',
    });

    expect(updated).toMatchObject({
      id: created.id,
      customerName: 'Ana Souza Lima',
      customerEmail: 'ana.lima@exemplo.com',
      notes: 'Portaria 2',
      status: 'PENDENTE',
      total: 56.3,
    });
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
    expect(await handlers.getOrder.execute(created.id)).toEqual(updated);
    expect(database.outbox).toHaveLength(1); // continua só o order.created
  });

  it('apaga a observação quando notes não é enviado (PUT substitui tudo)', async () => {
    const { handlers } = createTestApplication();
    const created = await handlers.createOrder.execute(orderBody(), CONTEXT);

    const updated = await handlers.updateOrder.execute(created.id, {
      customerName: 'Ana Souza',
      customerEmail: 'ana@exemplo.com',
    });

    expect(updated.notes).toBeNull();
  });

  it('recusa editar pedido que não está PENDENTE (ORDER_NOT_EDITABLE)', async () => {
    const { handlers } = createTestApplication();
    const created = await handlers.createOrder.execute(orderBody(), CONTEXT);
    await handlers.changeOrderStatus.execute(created.id, { status: 'PAGO' }, CONTEXT);

    const error = await captureError(
      handlers.updateOrder.execute(created.id, { customerName: 'Outro Nome', customerEmail: 'outro@exemplo.com' }),
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe('ORDER_NOT_EDITABLE');
    expect((await handlers.getOrder.execute(created.id)).customerName).toBe('Ana Souza');
  });

  it('também responde ORDER_NOT_EDITABLE se o status mudar entre a leitura e a gravação', async () => {
    // repositório que simula a corrida: lê PENDENTE, mas na hora de gravar o status já é outro
    const pending = Order.create(newOrderInput(), new Date());
    const racingRepository: OrderRepository = {
      create: async () => undefined,
      findById: async () => pending,
      list: async () => ({ items: [], total: 0 }),
      save: async () => false,
      delete: async () => false,
    };
    const handler = new UpdateOrderHandler(racingRepository);

    const error = await captureError(
      handler.execute(pending.id, { customerName: 'Ana Souza', customerEmail: 'ana@exemplo.com' }),
    );

    expect((error as ConflictError).code).toBe('ORDER_NOT_EDITABLE');
  });

  it('valida a entrada e responde ORDER_NOT_FOUND para pedido inexistente', async () => {
    const { handlers } = createTestApplication();

    expect(await captureError(handlers.updateOrder.execute(UNKNOWN_ORDER_ID, { customerName: 'A' }))).toBeInstanceOf(
      ValidationError,
    );
    const notFound = await captureError(
      handlers.updateOrder.execute(UNKNOWN_ORDER_ID, { customerName: 'Ana Souza', customerEmail: 'ana@exemplo.com' }),
    );
    expect((notFound as NotFoundError).code).toBe('ORDER_NOT_FOUND');
  });
});

describe('ChangeOrderStatus', () => {
  it('pagar muda o status e não gera evento nem acorda o relay', async () => {
    const { handlers, database, signal } = createTestApplication();
    const created = await handlers.createOrder.execute(orderBody(), CONTEXT);

    const paid = await handlers.changeOrderStatus.execute(created.id, { status: 'PAGO' }, CONTEXT);

    expect(paid.status).toBe('PAGO');
    expect(paid.allowedTransitions).toEqual(['ENVIADO', 'CANCELADO']);
    expect(database.outbox.map(({ message }) => message.type)).toEqual(['order.created']);
    expect(signal.notifications).toBe(1); // só o da criação
  });

  it('cancelar grava order.cancelled no outbox junto com o novo status e avisa o relay', async () => {
    const { handlers, database, signal } = createTestApplication();
    const created = await handlers.createOrder.execute(orderBody(), CONTEXT);

    const cancelled = await handlers.changeOrderStatus.execute(
      created.id,
      { status: 'cancelado' }, // aceita minúsculas
      { correlationId: 'corr-cancelamento' },
    );

    expect(cancelled.status).toBe('CANCELADO');
    expect(cancelled.allowedTransitions).toEqual([]);
    expect(database.outbox.map(({ message }) => message.type)).toEqual(['order.created', 'order.cancelled']);
    const event = database.outbox[1]!.message.payload;
    expect(event).toMatchObject({
      type: 'order.cancelled',
      correlationId: 'corr-cancelamento',
      data: { orderId: created.id, status: 'CANCELADO', total: 56.3 },
    });
    expect(event.data.items).toHaveLength(2);
    expect(signal.notifications).toBe(2);
  });

  it('recusa transição inválida com INVALID_STATUS_TRANSITION e não grava evento', async () => {
    const { handlers, database } = createTestApplication();
    const created = await handlers.createOrder.execute(orderBody(), CONTEXT);

    const error = await captureError(handlers.changeOrderStatus.execute(created.id, { status: 'ENTREGUE' }, CONTEXT));

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe('INVALID_STATUS_TRANSITION');
    expect((await handlers.getOrder.execute(created.id)).status).toBe('PENDENTE');
    expect(database.outbox).toHaveLength(1);
  });

  it('concorrência otimista: dois cancelamentos simultâneos geram um único evento', async () => {
    const { handlers, database, signal } = createTestApplication();
    const created = await handlers.createOrder.execute(orderBody(), CONTEXT);

    // As duas requisições leem o pedido como PENDENTE antes de qualquer uma gravar.
    const results = await Promise.allSettled([
      handlers.changeOrderStatus.execute(created.id, { status: 'CANCELADO' }, CONTEXT),
      handlers.changeOrderStatus.execute(created.id, { status: 'CANCELADO' }, CONTEXT),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictError);
    expect((rejected[0]!.reason as ConflictError).code).toBe('CONCURRENT_UPDATE');

    const cancelledEvents = database.outbox.filter(({ message }) => message.type === 'order.cancelled');
    expect(cancelledEvents).toHaveLength(1); // senão o estoque seria devolvido em dobro
    expect(signal.notifications).toBe(2); // criação + um cancelamento
  });

  it('concorrência otimista: pagar e cancelar ao mesmo tempo, só um vence', async () => {
    const { handlers, database } = createTestApplication();
    const created = await handlers.createOrder.execute(orderBody(), CONTEXT);

    const results = await Promise.allSettled([
      handlers.changeOrderStatus.execute(created.id, { status: 'PAGO' }, CONTEXT),
      handlers.changeOrderStatus.execute(created.id, { status: 'CANCELADO' }, CONTEXT),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((await handlers.getOrder.execute(created.id)).status).toBe('PAGO');
    expect(database.outbox.filter(({ message }) => message.type === 'order.cancelled')).toHaveLength(0);
  });

  it('valida o corpo e responde ORDER_NOT_FOUND para pedido inexistente ou id que não é UUID', async () => {
    const { handlers } = createTestApplication();

    const invalid = await captureError(handlers.changeOrderStatus.execute(UNKNOWN_ORDER_ID, { status: 'FOO' }, CONTEXT));
    expect(invalid).toBeInstanceOf(ValidationError);

    for (const id of [UNKNOWN_ORDER_ID, 'nao-e-uuid']) {
      const error = await captureError(handlers.changeOrderStatus.execute(id, { status: 'PAGO' }, CONTEXT));
      expect((error as NotFoundError).code).toBe('ORDER_NOT_FOUND');
    }
  });
});

describe('DeleteOrder', () => {
  it('exclui pedido CANCELADO e mantém os eventos no outbox como histórico', async () => {
    const { handlers, database } = createTestApplication();
    const created = await handlers.createOrder.execute(orderBody(), CONTEXT);
    await handlers.changeOrderStatus.execute(created.id, { status: 'CANCELADO' }, CONTEXT);

    await handlers.deleteOrder.execute(created.id);

    expect(database.orders.size).toBe(0);
    expect(database.outbox).toHaveLength(2);
    const error = await captureError(handlers.getOrder.execute(created.id));
    expect((error as NotFoundError).code).toBe('ORDER_NOT_FOUND');
  });

  it.each(['PENDENTE', 'PAGO'] as const)('recusa excluir pedido %s (ORDER_NOT_DELETABLE)', async (status) => {
    const { handlers, database } = createTestApplication();
    const created = await handlers.createOrder.execute(orderBody(), CONTEXT);
    if (status === 'PAGO') {
      await handlers.changeOrderStatus.execute(created.id, { status }, CONTEXT);
    }

    const error = await captureError(handlers.deleteOrder.execute(created.id));

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe('ORDER_NOT_DELETABLE');
    expect(database.orders.size).toBe(1);
  });

  it('responde ORDER_NOT_FOUND para pedido inexistente', async () => {
    const { handlers } = createTestApplication();
    const error = await captureError(handlers.deleteOrder.execute(UNKNOWN_ORDER_ID));
    expect((error as NotFoundError).code).toBe('ORDER_NOT_FOUND');
  });
});
