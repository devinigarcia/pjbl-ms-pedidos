import { describe, expect, it } from 'vitest';
import type { OrderIntegrationEvent } from '../../../src/application/events/OrderIntegrationEvent';
import { DispatchOrderEventsHandler } from '../../../src/application/features/DispatchOrderEvents/DispatchOrderEvents';
import type { EventPublisher } from '../../../src/application/ports/EventPublisher';
import { ValidationError } from '../../../src/domain/errors';
import { captureError, CONTEXT, createTestApplication, orderBody } from '../../support/testKit';

describe('DispatchOrderEvents (relay do outbox)', () => {
  it('publica os eventos pendentes na ordem em que aconteceram e marca como processados', async () => {
    const { handlers, publisher, database } = createTestApplication();
    const order = await handlers.createOrder.execute(orderBody(), CONTEXT);
    await handlers.changeOrderStatus.execute(order.id, { status: 'CANCELADO' }, CONTEXT);

    const result = await handlers.dispatchOrderEvents.execute();

    expect(result).toEqual({ published: 2, failed: 0, pending: 0 });
    expect(publisher.published.map((event) => event.type)).toEqual(['order.created', 'order.cancelled']);
    for (const { message } of database.outbox) {
      expect(message.processedAt).toBeInstanceOf(Date);
      expect(message.attempts).toBe(1);
      expect(message.lastError).toBeNull();
    }
  });

  it('não publica de novo o que já foi publicado', async () => {
    const { handlers, publisher } = createTestApplication();
    await handlers.createOrder.execute(orderBody(), CONTEXT);

    await handlers.dispatchOrderEvents.execute();
    const second = await handlers.dispatchOrderEvents.execute();

    expect(second).toEqual({ published: 0, failed: 0, pending: 0 });
    expect(publisher.published).toHaveLength(1);
  });

  it('falha de publicação: registra o erro, conta a tentativa e deixa a mensagem como FALHOU', async () => {
    const { handlers, publisher } = createTestApplication();
    await handlers.createOrder.execute(orderBody(), CONTEXT);
    publisher.failNext(1, 'fila fora do ar');

    const result = await handlers.dispatchOrderEvents.execute();

    expect(result).toEqual({ published: 0, failed: 1, pending: 1 });
    const { items } = await handlers.listOrderEvents.execute({});
    expect(items[0]).toMatchObject({
      status: 'FALHOU',
      attempts: 1,
      lastError: 'fila fora do ar',
      processedAt: null,
    });
  });

  it('nova tentativa depois da falha: publica, limpa o erro e soma a tentativa', async () => {
    const { handlers, publisher } = createTestApplication();
    const order = await handlers.createOrder.execute(orderBody(), CONTEXT);
    publisher.failNext(2);

    await handlers.dispatchOrderEvents.execute();
    await handlers.dispatchOrderEvents.execute();
    const third = await handlers.dispatchOrderEvents.execute();

    expect(third).toEqual({ published: 1, failed: 0, pending: 0 });
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0]!.data.orderId).toBe(order.id);
    const { items } = await handlers.listOrderEvents.execute({});
    expect(items[0]).toMatchObject({ status: 'PUBLICADO', attempts: 3, lastError: null });
    expect(items[0]!.processedAt).not.toBeNull();
  });

  it('uma mensagem com problema não trava as outras da rodada', async () => {
    const { handlers, publisher } = createTestApplication();
    const first = await handlers.createOrder.execute(orderBody(), CONTEXT);
    const second = await handlers.createOrder.execute(orderBody({ customerName: 'Bruno Lima' }), CONTEXT);
    publisher.failNext(1);

    const result = await handlers.dispatchOrderEvents.execute();

    expect(result).toEqual({ published: 1, failed: 1, pending: 1 });
    expect(publisher.published.map((event) => event.data.orderId)).toEqual([second.id]);
    const { items } = await handlers.listOrderEvents.execute({});
    expect(items.find((item) => item.aggregateId === first.id)?.status).toBe('FALHOU');
    expect(items.find((item) => item.aggregateId === second.id)?.status).toBe('PUBLICADO');
  });

  it('respeita o tamanho do lote e informa quantas ficaram pendentes', async () => {
    const { handlers, outbox, publisher } = createTestApplication();
    for (let i = 0; i < 5; i += 1) {
      await handlers.createOrder.execute(orderBody(), CONTEXT);
    }
    const smallBatches = new DispatchOrderEventsHandler(outbox, publisher, { batchSize: 2 });

    expect(await smallBatches.execute()).toEqual({ published: 2, failed: 0, pending: 3 });
    expect(await smallBatches.execute()).toEqual({ published: 2, failed: 0, pending: 1 });
    expect(await smallBatches.execute()).toEqual({ published: 1, failed: 0, pending: 0 });
  });

  it('nunca roda duas vezes ao mesmo tempo: chamadas simultâneas compartilham a mesma rodada', async () => {
    const { handlers, outbox } = createTestApplication();
    await handlers.createOrder.execute(orderBody(), CONTEXT);

    // publisher lento, que só termina quando o teste mandar
    const published: OrderIntegrationEvent[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowPublisher: EventPublisher = {
      kind: 'log',
      publish: async (event) => {
        await gate;
        published.push(event);
      },
    };
    const dispatch = new DispatchOrderEventsHandler(outbox, slowPublisher);

    const first = dispatch.execute();
    const second = dispatch.execute();
    release();

    expect(await first).toEqual({ published: 1, failed: 0, pending: 0 });
    expect(await second).toEqual({ published: 1, failed: 0, pending: 0 });
    expect(published).toHaveLength(1); // o evento saiu uma vez só

    // terminada a rodada, a próxima chamada começa outra normalmente
    expect(await dispatch.execute()).toEqual({ published: 0, failed: 0, pending: 0 });
  });

  it('limita o texto do erro ao tamanho da coluna LastError', async () => {
    const { handlers, publisher, database } = createTestApplication();
    await handlers.createOrder.execute(orderBody(), CONTEXT);
    publisher.failNext(1, 'x'.repeat(5000));

    await handlers.dispatchOrderEvents.execute();

    expect(database.outbox[0]!.message.lastError).toHaveLength(1000);
  });
});

describe('ListOrderEvents', () => {
  it('lista o outbox do mais recente para o mais antigo, com o status de cada mensagem', async () => {
    const { handlers } = createTestApplication();
    const order = await handlers.createOrder.execute(orderBody(), { correlationId: 'corr-1' });
    await handlers.dispatchOrderEvents.execute();
    await handlers.changeOrderStatus.execute(order.id, { status: 'CANCELADO' }, { correlationId: 'corr-2' });

    const { items, total } = await handlers.listOrderEvents.execute({});

    expect(total).toBe(2);
    expect(items.map((item) => [item.type, item.status])).toEqual([
      ['order.cancelled', 'PENDENTE'],
      ['order.created', 'PUBLICADO'],
    ]);
    const created = items[1]!;
    expect(created.id).toBe(created.payload.eventId);
    expect(created.aggregateId).toBe(order.id);
    expect(created.payload.correlationId).toBe('corr-1');
    expect(created.attempts).toBe(1);
    expect(typeof created.occurredAt).toBe('string');
    expect(typeof created.processedAt).toBe('string');
    expect(items[0]!.processedAt).toBeNull();
  });

  it('respeita o limit, mas total continua sendo o total do outbox', async () => {
    const { handlers } = createTestApplication();
    for (let i = 0; i < 3; i += 1) {
      await handlers.createOrder.execute(orderBody(), CONTEXT);
    }

    const { items, total } = await handlers.listOrderEvents.execute({ limit: '2' });

    expect(items).toHaveLength(2);
    expect(total).toBe(3);
  });

  it.each(['0', '101', 'muitos'])('recusa limit=%s', async (limit) => {
    const { handlers } = createTestApplication();
    expect(await captureError(handlers.listOrderEvents.execute({ limit }))).toBeInstanceOf(ValidationError);
  });
});
