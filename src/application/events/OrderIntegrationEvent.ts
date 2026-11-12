import { randomUUID } from 'node:crypto';
import type { OrderDomainEvent, OrderEventData, OrderEventType } from '../../domain/order/OrderEvents';
import type { OutboxMessage } from '../ports/OutboxRepository';

export const EVENT_SOURCE = 'ms-pedidos';
export const EVENT_VERSION = 1;

/**
 * Envelope do evento que vai para a fila `order-events` (contrato com a Azure Function).
 * O mesmo formato está documentado em docs/asyncapi.yaml.
 */
export interface OrderIntegrationEvent {
  eventId: string;
  type: OrderEventType;
  version: number;
  source: string;
  occurredAt: string;
  correlationId: string;
  data: OrderEventData;
}

/**
 * Transforma os eventos que o pedido gerou em mensagens do outbox.
 * O id da mensagem é o próprio `eventId`: é ele que os consumidores usam para idempotência.
 */
export function toOutboxMessages(events: OrderDomainEvent[], correlationId: string): OutboxMessage[] {
  return events.map((event) => {
    const eventId = randomUUID();
    return {
      id: eventId,
      type: event.type,
      aggregateId: event.data.orderId,
      payload: {
        eventId,
        type: event.type,
        version: EVENT_VERSION,
        source: EVENT_SOURCE,
        occurredAt: event.occurredAt.toISOString(),
        correlationId,
        data: event.data,
      },
      occurredAt: event.occurredAt,
      processedAt: null,
      attempts: 0,
      lastError: null,
    };
  });
}
