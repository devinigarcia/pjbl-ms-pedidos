import type { OrderListFilter, OrderRepository } from '../../application/ports/OrderRepository';
import type { OutboxMessage } from '../../application/ports/OutboxRepository';
import { Order } from '../../domain/order/Order';
import type { OrderStatus } from '../../domain/order/OrderStatus';
import { cloneOrderProps, cloneOutboxMessage, type InMemoryDatabase } from './InMemoryDatabase';

/**
 * Repositório em memória com o mesmo comportamento do SqlOrderRepository:
 * pedido + outbox gravados juntos e a mesma checagem de concorrência otimista.
 */
export class InMemoryOrderRepository implements OrderRepository {
  constructor(private readonly db: InMemoryDatabase) {}

  async create(order: Order, outbox: OutboxMessage[]): Promise<void> {
    const props = order.toProps();
    if (this.db.orders.has(props.id)) {
      throw new Error(`Já existe um pedido com o id ${props.id}.`);
    }
    this.assertNewOutboxIds(outbox);
    // Daqui para baixo não tem `await` e nada mais pode falhar: equivale à transação do SQL.
    this.db.orders.set(props.id, { props: cloneOrderProps(props), sequence: this.db.nextSequence() });
    this.appendOutbox(outbox);
  }

  async findById(id: string): Promise<Order | null> {
    const stored = this.db.orders.get(id.toLowerCase());
    return stored ? Order.restore(cloneOrderProps(stored.props)) : null;
  }

  async list(filter: OrderListFilter): Promise<{ items: Order[]; total: number }> {
    const search = filter.search?.trim().toLowerCase();

    const matching = [...this.db.orders.values()]
      .filter(({ props }) => !filter.status || props.status === filter.status)
      .filter(
        ({ props }) =>
          !search ||
          props.customerName.toLowerCase().includes(search) ||
          props.customerEmail.toLowerCase().includes(search),
      )
      .sort(
        (a, b) => b.props.createdAt.getTime() - a.props.createdAt.getTime() || b.sequence - a.sequence,
      );

    const offset = (filter.page - 1) * filter.pageSize;
    const page = matching.slice(offset, offset + filter.pageSize);
    return { items: page.map(({ props }) => Order.restore(cloneOrderProps(props))), total: matching.length };
  }

  async save(order: Order, expectedStatus: OrderStatus, outbox: OutboxMessage[]): Promise<boolean> {
    const props = order.toProps();
    const stored = this.db.orders.get(props.id);

    // Mesmo efeito do `UPDATE ... WHERE Id = @id AND Status = @expectedStatus` afetar 0 linhas.
    if (!stored || stored.props.status !== expectedStatus) {
      return false;
    }

    this.assertNewOutboxIds(outbox);
    stored.props = {
      ...stored.props,
      customerName: props.customerName,
      customerEmail: props.customerEmail,
      notes: props.notes,
      status: props.status,
      updatedAt: new Date(props.updatedAt),
    };
    this.appendOutbox(outbox);
    return true;
  }

  async delete(id: string, expectedStatus: OrderStatus): Promise<boolean> {
    const key = id.toLowerCase();
    const stored = this.db.orders.get(key);
    if (!stored || stored.props.status !== expectedStatus) {
      return false;
    }
    return this.db.orders.delete(key);
  }

  // Equivale à chave primária de OutboxMessages. A conferência vem ANTES de qualquer alteração,
  // para um erro aqui não deixar o pedido gravado pela metade (no SQL, é o papel do rollback).
  private assertNewOutboxIds(messages: OutboxMessage[]): void {
    for (const message of messages) {
      if (this.db.outbox.some((stored) => stored.message.id === message.id)) {
        throw new Error(`Já existe uma mensagem de outbox com o id ${message.id}.`);
      }
    }
  }

  private appendOutbox(messages: OutboxMessage[]): void {
    for (const message of messages) {
      this.db.outbox.push({ message: cloneOutboxMessage(message), sequence: this.db.nextSequence() });
    }
  }
}
