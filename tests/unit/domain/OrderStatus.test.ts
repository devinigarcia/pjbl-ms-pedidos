import { describe, expect, it } from 'vitest';
import { ConflictError } from '../../../src/domain/errors';
import { Order } from '../../../src/domain/order/Order';
import {
  allowedTransitions,
  canTransition,
  isFinalStatus,
  isOrderStatus,
  ORDER_STATUSES,
  type OrderStatus,
} from '../../../src/domain/order/OrderStatus';
import { newOrderInput } from '../../support/testKit';

const NOW = new Date('2025-06-10T12:00:00.000Z');
const LATER = new Date('2025-06-10T13:00:00.000Z');

// A máquina de estados inteira, como está no enunciado do projeto.
const VALID: Array<[OrderStatus, OrderStatus]> = [
  ['PENDENTE', 'PAGO'],
  ['PENDENTE', 'CANCELADO'],
  ['PAGO', 'ENVIADO'],
  ['PAGO', 'CANCELADO'],
  ['ENVIADO', 'ENTREGUE'],
];

const INVALID: Array<[OrderStatus, OrderStatus]> = ORDER_STATUSES.flatMap((from) =>
  ORDER_STATUSES.filter((to) => !VALID.some(([f, t]) => f === from && t === to)).map(
    (to): [OrderStatus, OrderStatus] => [from, to],
  ),
);

/** Cria um pedido já no status desejado, sem passar pelas transições. */
function orderIn(status: OrderStatus): Order {
  return Order.restore({ ...Order.create(newOrderInput(), NOW).toProps(), status });
}

describe('Máquina de estados do pedido', () => {
  it.each(VALID)('permite %s → %s', (from, to) => {
    const order = orderIn(from);

    order.changeStatus(to, LATER);

    expect(order.status).toBe(to);
    expect(order.updatedAt).toEqual(LATER);
    expect(canTransition(from, to)).toBe(true);
  });

  it.each(INVALID)('recusa %s → %s com INVALID_STATUS_TRANSITION', (from, to) => {
    const order = orderIn(from);

    let caught: unknown;
    try {
      order.changeStatus(to, LATER);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).code).toBe('INVALID_STATUS_TRANSITION');
    expect(order.status).toBe(from);
    expect(order.pullEvents()).toEqual([]);
  });

  it('são 5 transições válidas e 20 inválidas (5 x 5 combinações)', () => {
    expect(VALID).toHaveLength(5);
    expect(INVALID).toHaveLength(20);
  });

  it('informa as transições permitidas e quais status são finais', () => {
    expect(allowedTransitions('PENDENTE')).toEqual(['PAGO', 'CANCELADO']);
    expect(allowedTransitions('PAGO')).toEqual(['ENVIADO', 'CANCELADO']);
    expect(allowedTransitions('ENVIADO')).toEqual(['ENTREGUE']);
    expect(allowedTransitions('ENTREGUE')).toEqual([]);
    expect(allowedTransitions('CANCELADO')).toEqual([]);

    expect(ORDER_STATUSES.filter(isFinalStatus)).toEqual(['ENTREGUE', 'CANCELADO']);
    expect(isOrderStatus('PAGO')).toBe(true);
    expect(isOrderStatus('pago')).toBe(false);
  });
});

describe('Eventos gerados pelas transições', () => {
  it('cancelar gera order.cancelled com status CANCELADO e os itens a devolver', () => {
    const order = Order.create(newOrderInput(), NOW);
    order.pullEvents(); // descarta o order.created

    order.changeStatus('CANCELADO', LATER);

    const events = order.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('order.cancelled');
    expect(events[0]!.occurredAt).toEqual(LATER);
    expect(events[0]!.data.status).toBe('CANCELADO');
    expect(events[0]!.data.orderId).toBe(order.id);
    expect(events[0]!.data.items.map((item) => item.quantity)).toEqual([2, 1]);
  });

  it('cancelar um pedido PAGO também gera order.cancelled', () => {
    const order = orderIn('PAGO');
    order.changeStatus('CANCELADO', LATER);
    expect(order.pullEvents().map((event) => event.type)).toEqual(['order.cancelled']);
  });

  it('pagar, enviar e entregar não geram evento', () => {
    const order = Order.create(newOrderInput(), NOW);
    order.pullEvents();

    order.changeStatus('PAGO', LATER);
    order.changeStatus('ENVIADO', LATER);
    order.changeStatus('ENTREGUE', LATER);

    expect(order.pullEvents()).toEqual([]);
    expect(order.allowedTransitions).toEqual([]);
  });
});
