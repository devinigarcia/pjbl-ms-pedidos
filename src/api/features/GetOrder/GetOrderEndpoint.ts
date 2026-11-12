import type { Router } from 'express';
import type { GetOrderHandler } from '../../../application/features/GetOrder/GetOrder';

export function mapGetOrder(router: Router, handler: GetOrderHandler): void {
  router.get('/orders/:id', async (req, res) => {
    res.json(await handler.execute(req.params.id));
  });
}
