import { itemSubtotal, type Order } from '../domain/order/Order';
import type { OrderEventType } from '../domain/order/OrderEvents';
import type { OrderStatus } from '../domain/order/OrderStatus';
import type { OrderIntegrationEvent } from './events/OrderIntegrationEvent';
import type { OutboxMessage } from './ports/OutboxRepository';

// Formatos de saída (o JSON que a API devolve), iguais aos do documento de contratos.

export interface OrderItemView {
  productId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
}

export interface OrderView {
  id: string;
  customerName: string;
  customerEmail: string;
  status: OrderStatus;
  items: OrderItemView[];
  total: number;
  itemCount: number;
  notes: string | null;
  allowedTransitions: OrderStatus[];
  createdAt: string;
  updatedAt: string;
}

export function toOrderView(order: Order): OrderView {
  return {
    id: order.id,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    status: order.status,
    items: order.items.map((item) => ({ ...item, subtotal: itemSubtotal(item) })),
    total: order.total,
    itemCount: order.itemCount,
    notes: order.notes,
    allowedTransitions: order.allowedTransitions,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

export type OutboxStatus = 'PUBLICADO' | 'FALHOU' | 'PENDENTE';

export interface OutboxItemView {
  id: string;
  type: OrderEventType;
  aggregateId: string;
  occurredAt: string;
  processedAt: string | null;
  attempts: number;
  lastError: string | null;
  status: OutboxStatus;
  payload: OrderIntegrationEvent;
}

export function outboxStatusOf(message: Pick<OutboxMessage, 'processedAt' | 'lastError'>): OutboxStatus {
  if (message.processedAt) return 'PUBLICADO';
  if (message.lastError) return 'FALHOU';
  return 'PENDENTE';
}

export function toOutboxItemView(message: OutboxMessage): OutboxItemView {
  return {
    id: message.id,
    type: message.type,
    aggregateId: message.aggregateId,
    occurredAt: message.occurredAt.toISOString(),
    processedAt: message.processedAt ? message.processedAt.toISOString() : null,
    attempts: message.attempts,
    lastError: message.lastError,
    status: outboxStatusOf(message),
    payload: message.payload,
  };
}
