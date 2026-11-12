// Peças reaproveitadas pelos testes: dados de exemplo, publisher/sinal de mentira
// e uma função que monta todos os casos de uso em cima do repositório em memória.

import type { OrderIntegrationEvent } from '../../src/application/events/OrderIntegrationEvent';
import { ChangeOrderStatusHandler } from '../../src/application/features/ChangeOrderStatus/ChangeOrderStatus';
import { CreateOrderHandler } from '../../src/application/features/CreateOrder/CreateOrder';
import { DeleteOrderHandler } from '../../src/application/features/DeleteOrder/DeleteOrder';
import { DispatchOrderEventsHandler } from '../../src/application/features/DispatchOrderEvents/DispatchOrderEvents';
import { GetOrderHandler } from '../../src/application/features/GetOrder/GetOrder';
import { ListOrderEventsHandler } from '../../src/application/features/ListOrderEvents/ListOrderEvents';
import { ListOrdersHandler } from '../../src/application/features/ListOrders/ListOrders';
import { UpdateOrderHandler } from '../../src/application/features/UpdateOrder/UpdateOrder';
import type { EventPublisher } from '../../src/application/ports/EventPublisher';
import type { OutboxSignal } from '../../src/application/ports/OutboxSignal';
import type { NewOrderInput, OrderItem } from '../../src/domain/order/Order';
import { InMemoryDatabase } from '../../src/infrastructure/memory/InMemoryDatabase';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/InMemoryOrderRepository';
import { InMemoryOutboxRepository } from '../../src/infrastructure/memory/InMemoryOutboxRepository';

export const PRODUCT_COFFEE = 'c0ffee00-1111-4222-8333-444455556666';
export const PRODUCT_FILTER = 'badc0de0-7777-4888-9999-aaaabbbbcccc';
export const UNKNOWN_ORDER_ID = '00000000-0000-4000-8000-000000000000';

export const CONTEXT = { correlationId: 'teste-correlation-id' };

export function coffee(overrides: Partial<OrderItem> = {}): OrderItem {
  return { productId: PRODUCT_COFFEE, productName: 'Café torrado 500g', unitPrice: 24.9, quantity: 2, ...overrides };
}

export function filter(overrides: Partial<OrderItem> = {}): OrderItem {
  return { productId: PRODUCT_FILTER, productName: 'Filtro de papel 103', unitPrice: 6.5, quantity: 1, ...overrides };
}

/** Corpo válido de POST /orders (total 56.30, 3 unidades). */
export function orderBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerName: 'Ana Souza',
    customerEmail: 'ana@exemplo.com',
    notes: 'Entregar no período da tarde.',
    items: [coffee(), filter()],
    ...overrides,
  };
}

/** Entrada válida para `Order.create`. */
export function newOrderInput(overrides: Partial<NewOrderInput> = {}): NewOrderInput {
  return {
    id: '7f9c2b1e-4d3a-4c8e-9b2f-1a2b3c4d5e6f',
    customerName: 'Ana Souza',
    customerEmail: 'ana@exemplo.com',
    items: [coffee(), filter()],
    ...overrides,
  };
}

/** Publisher de mentira: guarda o que foi publicado e pode ser programado para falhar. */
export class FakeEventPublisher implements EventPublisher {
  readonly kind = 'log' as const;
  readonly published: OrderIntegrationEvent[] = [];
  private failures: Error[] = [];

  /** As próximas `times` publicações vão falhar com esta mensagem. */
  failNext(times = 1, message = 'fila indisponível'): void {
    for (let i = 0; i < times; i += 1) {
      this.failures.push(new Error(message));
    }
  }

  async publish(event: OrderIntegrationEvent): Promise<void> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.published.push(event);
  }
}

export class FakeOutboxSignal implements OutboxSignal {
  notifications = 0;

  notify(): void {
    this.notifications += 1;
  }
}

/** Relógio controlado: cada chamada devolve um instante 1 segundo depois do anterior. */
export function tickingClock(start = '2025-06-10T12:00:00.000Z'): () => Date {
  let current = new Date(start).getTime() - 1000;
  return () => {
    current += 1000;
    return new Date(current);
  };
}

/** Monta os 8 casos de uso com repositório em memória, publisher e sinal de mentira. */
export function createTestApplication() {
  const database = new InMemoryDatabase();
  const orders = new InMemoryOrderRepository(database);
  const outbox = new InMemoryOutboxRepository(database);
  const publisher = new FakeEventPublisher();
  const signal = new FakeOutboxSignal();
  const now = tickingClock();

  const handlers = {
    createOrder: new CreateOrderHandler(orders, signal, now),
    listOrders: new ListOrdersHandler(orders),
    getOrder: new GetOrderHandler(orders),
    updateOrder: new UpdateOrderHandler(orders, now),
    changeOrderStatus: new ChangeOrderStatusHandler(orders, signal, now),
    deleteOrder: new DeleteOrderHandler(orders),
    listOrderEvents: new ListOrderEventsHandler(outbox),
    dispatchOrderEvents: new DispatchOrderEventsHandler(outbox, publisher, { now }),
  };

  return { database, orders, outbox, publisher, signal, handlers };
}

/** Captura o erro de uma promise que deve falhar (deixa o teste fazer várias verificações nele). */
export async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Era esperado um erro, mas a operação deu certo.');
}
