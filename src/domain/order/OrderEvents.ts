import type { OrderStatus } from './OrderStatus';

export type OrderEventType = 'order.created' | 'order.cancelled';

export interface OrderEventItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
}

/** "Foto" do pedido no momento do evento. É o campo `data` da mensagem que vai para a fila. */
export interface OrderEventData {
  orderId: string;
  customerName: string;
  customerEmail: string;
  status: OrderStatus;
  total: number;
  items: OrderEventItem[];
}

/**
 * Evento de domínio: o pedido só registra O QUE aconteceu e QUANDO.
 * Identificador do evento, correlationId e o envelope da mensagem ficam por conta da aplicação.
 */
export interface OrderDomainEvent {
  type: OrderEventType;
  occurredAt: Date;
  data: OrderEventData;
}
