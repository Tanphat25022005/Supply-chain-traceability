import { Router } from 'express';
import { AnchorInfo } from '../../bootstrap';
import { AuthService } from '../../services/authService';
import { TraceDirection, TraceService } from '../../services/traceService';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { validateBody } from '../middleware/validate';
import { importReceiptSchema, receiptLinkSchema, verificationLinkSchema } from '../../validation/schemas';
import { z } from 'zod';
import { SupplyChainService } from '../../services/supplyChainService';

export function traceRoutes(
  traceService: TraceService,
  authService: AuthService,
  anchorInfo: AnchorInfo,
  supplyChainService: SupplyChainService,
): Router {
  const router = Router();

  // Public — which chain/contract events are anchored on.
  router.get('/anchor-info', (_req, res) => {
    res.json(anchorInfo);
  });

  // Public — no auth required, powers the QR-scan provenance page.
  router.get(
    '/public/:batchId',
    asyncHandler(async (req, res) => {
      res.json(await traceService.publicTrace(req.params.batchId));
    }),
  );

  // Public — material for the independent verifier (frontend /verify): hashes,
  // selectively disclosed fields and Merkle proofs. `?token=` (a verification
  // link) opens every field; without it only the SPEC §1.1 public fields.
  router.get(
    '/public/:batchId/full',
    asyncHandler(async (req, res) => {
      const token = typeof req.query.token === 'string' ? req.query.token : undefined;
      res.json(await traceService.verifyPublic(req.params.batchId, token));
    }),
  );

  // Public — the foreign buyer opens the receipt link the exporter sent...
  router.get(
    '/public/:batchId/receipt',
    asyncHandler(async (req, res) => {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      res.json(await supplyChainService.receiptInfo(req.params.batchId, token));
    }),
  );

  // ...and confirms what arrived. The token is the authorisation.
  router.post(
    '/public/:batchId/receipt',
    validateBody(importReceiptSchema),
    asyncHandler(async (req, res) => {
      const { token, ...dto } = req.body as z.infer<typeof importReceiptSchema>;
      res.status(201).json(await supplyChainService.recordImportReceipt(req.params.batchId, token, dto));
    }),
  );

  router.use(requireAuth(authService));

  router.post(
    '/:batchId/receipt-links',
    validateBody(receiptLinkSchema),
    asyncHandler(async (req, res) => {
      const { importerName, days } = req.body as z.infer<typeof receiptLinkSchema>;
      res.status(201).json(await supplyChainService.createReceiptLink(req.actor!, req.params.batchId, importerName, days));
    }),
  );

  router.post(
    '/:batchId/verification-links',
    validateBody(verificationLinkSchema),
    asyncHandler(async (req, res) => {
      const { days } = req.body as z.infer<typeof verificationLinkSchema>;
      res.status(201).json(await traceService.createVerificationLink(req.actor!, req.params.batchId, days));
    }),
  );

  router.get(
    '/:batchId',
    asyncHandler(async (req, res) => {
      const direction: TraceDirection = req.query.direction === 'backward' ? 'backward' : 'forward';
      res.json(await traceService.trace(req.params.batchId, direction, req.actor!));
    }),
  );

  return router;
}
