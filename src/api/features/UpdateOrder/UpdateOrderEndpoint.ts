import type { Router } from 'express';
import type { UpdateOrderHandler } from '../../../application/features/UpdateOrder/UpdateOrder';

export function mapUpdateOrder(router: Router, handler: UpdateOrderHandler): void {
  router.put('/orders/:id', async (req, res) => {
    res.json(await handler.execute(req.params.id, req.body));
  });
}
