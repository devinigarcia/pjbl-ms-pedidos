import { NotFoundError } from '../domain/errors';
import type { Order } from '../domain/order/Order';
import { isUuid } from '../domain/shared/uuid';
import type { OrderRepository } from './ports/OrderRepository';

export function orderNotFound(id: string): NotFoundError {
  return new NotFoundError('ORDER_NOT_FOUND', `Pedido ${id} não encontrado.`);
}

/**
 * Busca o pedido ou lança 404. Id que não tem formato de UUID nem chega no banco:
 * para quem chama é a mesma coisa que "não existe".
 */
export async function findOrderOrThrow(orders: OrderRepository, id: string): Promise<Order> {
  if (!isUuid(id)) {
    throw orderNotFound(id);
  }
  const order = await orders.findById(id.toLowerCase());
  if (!order) {
    throw orderNotFound(id);
  }
  return order;
}
