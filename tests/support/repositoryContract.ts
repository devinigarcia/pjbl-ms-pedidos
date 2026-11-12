// Contrato dos repositórios: os MESMOS testes rodam contra a implementação em memória (sempre)
// e contra o Azure SQL (quando SQL_TEST_CONNECTION_STRING está definida). É o que garante que
// as duas se comportam igual.
//
// Os testes só olham para os dados que eles mesmos criaram (identificados por `marker`),
// então podem rodar num banco que já tem pedidos.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { toOutboxMessages } from '../../src/application/events/OrderIntegrationEvent';
import type { OrderRepository } from '../../src/application/ports/OrderRepository';
import type { OutboxMessage, OutboxRepository } from '../../src/application/ports/OutboxRepository';
import { Order, type OrderItem } from '../../src/domain/order/Order';

export interface RepositoryFixture {
  orders: OrderRepository;
  outbox: OutboxRepository;
  /** Texto único desta execução, presente no nome e no e-mail de todo pedido criado pelos testes. */
  marker: string;
}

// Horário atual como base: num banco que já tem dados, os registros dos testes ficam entre os mais recentes.
const BASE_TIME = Date.now();

export function describeRepositoryContract(name: string, setup: () => Promise<RepositoryFixture> | RepositoryFixture): void {
  describe(`Contrato dos repositórios — ${name}`, () => {
    let orders: OrderRepository;
    let outbox: OutboxRepository;
    let marker: string;
    let sequence = 0;

    beforeAll(async () => {
      ({ orders, outbox, marker } = await setup());
    });

    /** Pedido novo, com horário crescente a cada chamada (para a ordenação ser previsível). */
    function newOrder(overrides: { customerName?: string; items?: OrderItem[]; notes?: string | null } = {}): Order {
      sequence += 1;
      return Order.create(
        {
          id: randomUUID(),
          customerName: overrides.customerName ?? `Cliente ${sequence} ${marker}`,
          customerEmail: `cliente${sequence}.${marker}@teste.local`,
          notes: overrides.notes,
          items: overrides.items ?? [
            { productId: 'prod-cafe', productName: 'Café torrado 500g', unitPrice: 24.9, quantity: 2 },
            { productId: 'prod-filtro', productName: 'Filtro de papel 103', unitPrice: 6.5, quantity: 1 },
          ],
        },
        new Date(BASE_TIME + sequence * 1000),
      );
    }

    async function createOrder(overrides: Parameters<typeof newOrder>[0] = {}): Promise<{ order: Order; messages: OutboxMessage[] }> {
      const order = newOrder(overrides);
      const messages = toOutboxMessages(order.pullEvents(), `corr-${marker}`);
      await orders.create(order, messages);
      return { order, messages };
    }

    async function findMessage(id: string): Promise<OutboxMessage | undefined> {
      const { items } = await outbox.listRecent(100);
      return items.find((message) => message.id === id);
    }

    async function messagesOf(orderId: string): Promise<OutboxMessage[]> {
      const { items } = await outbox.listRecent(100);
      return items.filter((message) => message.aggregateId === orderId);
    }

    it('grava e lê o pedido com os itens na ordem, valores decimais e datas preservados', async () => {
      const { order } = await createOrder({
        notes: 'Observação com acentuação: ção, é, ü',
        items: [
          { productId: 'prod-z', productName: 'Último da lista', unitPrice: 0.01, quantity: 999 },
          { productId: 'prod-a', productName: 'Primeiro em ordem alfabética', unitPrice: 1234.56, quantity: 1 },
        ],
      });

      const found = await orders.findById(order.id);

      expect(found).not.toBeNull();
      expect(found!.toProps()).toEqual(order.toProps());
      expect(found!.id).toBe(order.id.toLowerCase());
      expect(found!.items.map((item) => item.productId)).toEqual(['prod-z', 'prod-a']);
      expect(found!.total).toBe(1244.55);
      expect(found!.createdAt.toISOString()).toBe(order.createdAt.toISOString());
      expect(found!.pullEvents()).toEqual([]);
    });

    it('guarda observação vazia como null e devolve null para pedido que não existe', async () => {
      const { order } = await createOrder();

      expect((await orders.findById(order.id))!.notes).toBeNull();
      expect(await orders.findById(randomUUID())).toBeNull();
    });

    it('grava o evento no outbox junto com o pedido', async () => {
      const { order, messages } = await createOrder();

      const stored = await findMessage(messages[0]!.id);

      expect(stored).toBeDefined();
      expect(stored).toMatchObject({
        id: messages[0]!.id,
        type: 'order.created',
        aggregateId: order.id,
        processedAt: null,
        attempts: 0,
        lastError: null,
      });
      expect(stored!.occurredAt.toISOString()).toBe(order.createdAt.toISOString());
      expect(stored!.payload).toEqual(messages[0]!.payload);
    });

    it('transação: se o evento não grava, o pedido também não fica (nem a mudança de status)', async () => {
      const { order, messages } = await createOrder();
      const existingEvent = messages[0]!;

      // Pedido novo cujo evento repete o id de um evento que já existe: o INSERT do outbox falha
      // DEPOIS que o pedido e os itens já foram inseridos, então tudo precisa ser desfeito.
      const second = newOrder();
      second.pullEvents();
      await expect(orders.create(second, [{ ...existingEvent, aggregateId: second.id }])).rejects.toThrow();
      expect(await orders.findById(second.id)).toBeNull();

      // O mesmo vale para a mudança de status.
      const loaded = (await orders.findById(order.id))!;
      loaded.changeStatus('CANCELADO', new Date(BASE_TIME + 7_200_000));
      await expect(orders.save(loaded, 'PENDENTE', [{ ...existingEvent }])).rejects.toThrow();
      expect((await orders.findById(order.id))!.status).toBe('PENDENTE');
      expect(await messagesOf(order.id)).toHaveLength(1);
    });

    it('transação: se o pedido não grava, o evento também não fica', async () => {
      const { order, messages } = await createOrder();

      // Mesmo id de pedido de novo: a gravação falha (chave duplicada) e o evento novo não pode sobrar.
      const duplicate = Order.restore(order.toProps());
      const orphanMessages = toOutboxMessages(
        [{ type: 'order.created', occurredAt: new Date(), data: messages[0]!.payload.data }],
        `corr-${marker}`,
      );

      await expect(orders.create(duplicate, orphanMessages)).rejects.toThrow();
      expect(await findMessage(orphanMessages[0]!.id)).toBeUndefined();
      expect(await messagesOf(order.id)).toHaveLength(1);
    });

    it('lista com filtro, paginação e os mais recentes primeiro', async () => {
      const tag = `lista-${randomUUID().slice(0, 8)}`;
      const created: Order[] = [];
      for (let i = 1; i <= 5; i += 1) {
        created.push((await createOrder({ customerName: `Pedido ${i} ${tag}` })).order);
      }
      const newestFirst = [...created].reverse().map((order) => order.id);

      const firstPage = await orders.list({ search: tag, page: 1, pageSize: 2 });
      expect(firstPage.total).toBe(5);
      expect(firstPage.items.map((order) => order.id)).toEqual(newestFirst.slice(0, 2));
      // os itens de cada pedido da página vêm carregados, no pedido certo
      for (const order of firstPage.items) {
        expect(order.items.map((item) => item.productId)).toEqual(['prod-cafe', 'prod-filtro']);
        expect(order.total).toBe(56.3);
      }

      const lastPage = await orders.list({ search: tag, page: 3, pageSize: 2 });
      expect(lastPage.total).toBe(5);
      expect(lastPage.items.map((order) => order.id)).toEqual(newestFirst.slice(4));

      const beyond = await orders.list({ search: tag, page: 9, pageSize: 2 });
      expect(beyond).toEqual({ items: [], total: 5 });

      // filtro por status combinado com a busca
      const paid = created[2]!;
      paid.changeStatus('PAGO', new Date(BASE_TIME + 3_600_000));
      expect(await orders.save(paid, 'PENDENTE', [])).toBe(true);

      const onlyPaid = await orders.list({ status: 'PAGO', search: tag, page: 1, pageSize: 20 });
      expect(onlyPaid.items.map((order) => order.id)).toEqual([paid.id]);
      const onlyPending = await orders.list({ status: 'PENDENTE', search: tag, page: 1, pageSize: 20 });
      expect(onlyPending.total).toBe(4);
    });

    it('busca por nome ou e-mail sem diferenciar maiúsculas, e trata % _ [ como texto comum', async () => {
      const tag = `busca-${randomUUID().slice(0, 8)}`;
      const underscore = (await createOrder({ customerName: `A_B ${tag}` })).order;
      const letter = (await createOrder({ customerName: `AXB ${tag}` })).order;
      const percent = (await createOrder({ customerName: `100% [vip] ${tag}` })).order;

      const ids = async (search: string) =>
        (await orders.list({ search, page: 1, pageSize: 20 })).items.map((order) => order.id).sort();

      expect(await ids(tag.toUpperCase())).toEqual([underscore.id, letter.id, percent.id].sort());
      expect(await ids(`A_B ${tag}`)).toEqual([underscore.id]); // `_` não é curinga
      expect(await ids(`100% [vip] ${tag}`)).toEqual([percent.id]);
      expect(await ids(`%${tag}`)).toEqual([]); // `%` não é curinga
      expect(await ids(`${marker}@teste.local`)).not.toHaveLength(0); // também procura no e-mail
    });

    it('save atualiza o pedido e grava o evento quando o status esperado confere', async () => {
      const { order } = await createOrder();
      const loaded = (await orders.findById(order.id))!;
      loaded.changeStatus('CANCELADO', new Date(BASE_TIME + 7_200_000));
      const messages = toOutboxMessages(loaded.pullEvents(), `corr-${marker}`);

      expect(await orders.save(loaded, 'PENDENTE', messages)).toBe(true);

      const after = (await orders.findById(order.id))!;
      expect(after.status).toBe('CANCELADO');
      expect(after.updatedAt.toISOString()).toBe(new Date(BASE_TIME + 7_200_000).toISOString());
      expect(after.createdAt.toISOString()).toBe(order.createdAt.toISOString());
      expect((await messagesOf(order.id)).map((message) => message.type).sort()).toEqual(['order.cancelled', 'order.created']);
    });

    it('save não grava nada quando o status no banco é diferente do esperado', async () => {
      const { order } = await createOrder();
      const loaded = (await orders.findById(order.id))!;
      loaded.changeStatus('CANCELADO', new Date(BASE_TIME + 7_200_000));
      const messages = toOutboxMessages(loaded.pullEvents(), `corr-${marker}`);

      // o caso de uso "achava" que o pedido estava PAGO, mas no banco ele está PENDENTE
      expect(await orders.save(loaded, 'PAGO', messages)).toBe(false);

      expect((await orders.findById(order.id))!.status).toBe('PENDENTE');
      expect(await findMessage(messages[0]!.id)).toBeUndefined();
    });

    it('concorrência otimista: de dois cancelamentos simultâneos só um grava (um evento só)', async () => {
      const { order } = await createOrder();
      const cancel = (loaded: Order): Promise<boolean> => {
        const expectedStatus = loaded.status;
        loaded.changeStatus('CANCELADO', new Date(BASE_TIME + 7_200_000));
        return orders.save(loaded, expectedStatus, toOutboxMessages(loaded.pullEvents(), `corr-${marker}`));
      };

      // As duas "requisições" leem o pedido como PENDENTE antes de qualquer uma gravar...
      const [first, second] = await Promise.all([orders.findById(order.id), orders.findById(order.id)]);
      expect([first!.status, second!.status]).toEqual(['PENDENTE', 'PENDENTE']);
      // ...e as duas tentam gravar ao mesmo tempo.
      const results = await Promise.all([cancel(first!), cancel(second!)]);

      expect(results.filter(Boolean)).toHaveLength(1);
      const cancelled = (await messagesOf(order.id)).filter((message) => message.type === 'order.cancelled');
      expect(cancelled).toHaveLength(1);
      expect((await orders.findById(order.id))!.status).toBe('CANCELADO');
    });

    it('delete só exclui no status esperado; o pedido some e os eventos ficam', async () => {
      const { order } = await createOrder();

      expect(await orders.delete(order.id, 'CANCELADO')).toBe(false); // ainda está PENDENTE
      expect(await orders.findById(order.id)).not.toBeNull();

      const loaded = (await orders.findById(order.id))!;
      loaded.changeStatus('CANCELADO', new Date(BASE_TIME + 7_200_000));
      await orders.save(loaded, 'PENDENTE', toOutboxMessages(loaded.pullEvents(), `corr-${marker}`));

      expect(await orders.delete(order.id, 'CANCELADO')).toBe(true);
      expect(await orders.findById(order.id)).toBeNull();
      expect(await orders.delete(order.id, 'CANCELADO')).toBe(false); // já foi
      expect(await messagesOf(order.id)).toHaveLength(2);
    });

    it('outbox: falha soma tentativa e guarda o erro; publicação dá baixa e limpa o erro', async () => {
      const { messages } = await createOrder();
      const id = messages[0]!.id;
      const pendingBefore = await outbox.countPending();

      await outbox.markFailed(id, 'fila fora do ar');
      expect(await findMessage(id)).toMatchObject({ attempts: 1, lastError: 'fila fora do ar', processedAt: null });
      expect(await outbox.countPending()).toBe(pendingBefore); // falha continua pendente

      const processedAt = new Date(BASE_TIME + 9_000_000);
      await outbox.markProcessed(id, processedAt);
      const published = (await findMessage(id))!;
      expect(published).toMatchObject({ attempts: 2, lastError: null });
      expect(published.processedAt!.toISOString()).toBe(processedAt.toISOString());

      // dar baixa de novo não muda nada (a operação é idempotente)
      await outbox.markProcessed(id, new Date(BASE_TIME + 9_999_000));
      await outbox.markFailed(id, 'tarde demais');
      expect(await findMessage(id)).toMatchObject({ attempts: 2, lastError: null });
      expect((await findMessage(id))!.processedAt!.toISOString()).toBe(processedAt.toISOString());
    });

    it('outbox: fetchPending traz só o que não foi publicado, do mais antigo para o mais novo', async () => {
      const first = (await createOrder()).messages[0]!;
      const second = (await createOrder()).messages[0]!;
      await outbox.markProcessed(first.id, new Date());

      const pending = await outbox.fetchPending(100);

      expect(pending.every((message) => message.processedAt === null)).toBe(true);
      expect(pending.map((message) => message.id)).not.toContain(first.id);
      expect(pending.map((message) => message.id)).toContain(second.id);
      const times = pending.map((message) => message.occurredAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(await outbox.fetchPending(1)).toHaveLength(1);

      const recent = await outbox.listRecent(2);
      expect(recent.items).toHaveLength(2);
      expect(recent.total).toBeGreaterThanOrEqual(2);
    });
  });
}
