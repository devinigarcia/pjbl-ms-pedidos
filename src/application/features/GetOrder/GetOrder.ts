import { findOrderOrThrow } from '../../findOrder';
import type { OrderRepository } from '../../ports/OrderRepository';
import { toOrderView, type OrderView } from '../../views';

export class GetOrderHandler {
  constructor(private readonly orders: OrderRepository) {}

  async execute(id: string): Promise<OrderView> {
    const order = await findOrderOrThrow(this.orders, id);
    return toOrderView(order);
  }
}
