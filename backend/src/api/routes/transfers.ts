import { Router } from 'express';
import { z } from 'zod';
import { AuthService } from '../../services/authService';
import { SupplyChainService } from '../../services/supplyChainService';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { validateBody } from '../middleware/validate';
import { respondTransferSchema } from '../../validation/schemas';

/** Hand-overs waiting for — or sent to — the signed-in actor, and answering them (docs/SPEC_PHASE1_5.md §0.4). */
export function transferRoutes(supplyChainService: SupplyChainService, authService: AuthService): Router {
  const router = Router();
  router.use(requireAuth(authService));

  router.get(
    '/incoming',
    asyncHandler(async (req, res) => {
      res.json(await supplyChainService.listIncomingTransfers(req.actor!));
    }),
  );

  router.get(
    '/outgoing',
    asyncHandler(async (req, res) => {
      res.json(await supplyChainService.listOutgoingTransfers(req.actor!));
    }),
  );

  router.post(
    '/:id/respond',
    validateBody(respondTransferSchema),
    asyncHandler(async (req, res) => {
      res.json(await supplyChainService.respondTransfer(req.actor!, req.params.id, req.body as z.infer<typeof respondTransferSchema>));
    }),
  );

  router.post(
    '/:id/cancel',
    asyncHandler(async (req, res) => {
      res.json(await supplyChainService.cancelTransfer(req.actor!, req.params.id));
    }),
  );

  return router;
}
