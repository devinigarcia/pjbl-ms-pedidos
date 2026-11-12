import type { Router } from 'express';
import type { DispatchOrderEventsHandler } from '../../../application/features/DispatchOrderEvents/DispatchOrderEvents';

export function mapDispatchOrderEvents(router: Router, handler: DispatchOrderEventsHandler): void {
  // Força uma rodada do relay agora, sem esperar o timer (útil em demonstração e depuração).
  router.post('/events/dispatch', async (_req, res) => {
    res.json(await handler.execute());
  });
}
