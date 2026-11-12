import { z } from 'zod';
import { ConflictError } from '../../../domain/errors';
import { findOrderOrThrow } from '../../findOrder';
import type { OrderRepository } from '../../ports/OrderRepository';
import { customerEmailSchema, customerNameSchema, notesSchema } from '../../schemas';
import { validate } from '../../validation';
import { toOrderView, type OrderView } from '../../views';

// PUT substitui os dados do cliente por inteiro: `notes` ausente apaga a observação.
export const updateOrderSchema = z.object({
  customerName: customerNameSchema,
  customerEmail: customerEmailSchema,
  notes: notesSchema,
});

export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;

export class UpdateOrderHandler {
  constructor(
    private readonly orders: OrderRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(id: string, input: unknown): Promise<OrderView> {
    const data = validate(updateOrderSchema, input);
    const order = await findOrderOrThrow(this.orders, id);

    const expectedStatus = order.status;
    order.updateCustomer(data, this.now());

    // Se o status mudou entre a leitura e a gravação, o pedido já não está mais PENDENTE.
    const saved = await this.orders.save(order, expectedStatus, []);
    if (!saved) {
      throw new ConflictError(
        'ORDER_NOT_EDITABLE',
        'O pedido mudou de status enquanto era editado e não pode mais ser alterado.',
      );
    }
    return toOrderView(order);
  }
}
