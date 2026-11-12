import type { Order } from '../../domain/order/Order';
import type { OrderStatus } from '../../domain/order/OrderStatus';
import type { OutboxMessage } from './OutboxRepository';

export interface OrderListFilter {
  status?: OrderStatus;
  /** Trecho do nome ou do e-mail do cliente. */
  search?: string;
  page: number;
  pageSize: number;
}

export interface OrderRepository {
  /** Grava o pedido, os itens e as mensagens do outbox numa única transação. */
  create(order: Order, outbox: OutboxMessage[]): Promise<void>;

  findById(id: string): Promise<Order | null>;

  /** Mais recentes primeiro. `total` é a contagem com o filtro, sem a paginação. */
  list(filter: OrderListFilter): Promise<{ items: Order[]; total: number }>;

  /**
   * Atualiza o pedido (dados do cliente e status) e grava as mensagens do outbox na mesma transação,
   * mas só se o status no banco ainda for `expectedStatus` (concorrência otimista).
   * Devolve `false` quando outra requisição mudou o pedido antes; nesse caso nada é gravado.
   */
  save(order: Order, expectedStatus: OrderStatus, outbox: OutboxMessage[]): Promise<boolean>;

  /** Exclui o pedido (e os itens) se ele ainda estiver em `expectedStatus`. Devolve se excluiu. */
  delete(id: string, expectedStatus: OrderStatus): Promise<boolean>;
}
