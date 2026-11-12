import { findOrderOrThrow, orderNotFound } from '../../findOrder';
import type { OrderRepository } from '../../ports/OrderRepository';

export class DeleteOrderHandler {
  constructor(private readonly orders: OrderRepository) {}

  async execute(id: string): Promise<void> {
    const order = await findOrderOrThrow(this.orders, id);
    order.assertCanBeDeleted();

    // Os eventos já publicados continuam no outbox como histórico; só o pedido e os itens somem.
    const deleted = await this.orders.delete(order.id, order.status);
    if (!deleted) {
      // alguém excluiu o mesmo pedido um instante antes
      throw orderNotFound(id);
    }
  }
}
