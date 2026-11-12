import type { Router } from 'express';
import type { DeleteOrderHandler } from '../../../application/features/DeleteOrder/DeleteOrder';

export function mapDeleteOrder(router: Router, handler: DeleteOrderHandler): void {
  router.delete('/orders/:id', async (req, res) => {
    await handler.execute(req.params.id);
    res.status(204).end();
  });
}
