import { Router } from 'express';
import { z } from 'zod';
import { AuthService } from '../../services/authService';
import { CatalogService, ReferenceTable } from '../../services/catalogService';
import { requireAuth, requireRole } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { validateBody } from '../middleware/validate';
import {
  conversionFactorSchema,
  createProductTypeSchema,
  createUnitSchema,
  mapUnmappedSchema,
  processRatioSchema,
  productSettingsSchema,
  updateProductTypeSchema,
  yieldCapSchema,
} from '../../validation/schemas';

const REFERENCE_TABLES: Record<string, ReferenceTable> = {
  'conversion-factors': 'conversion_factors',
  'process-ratios': 'process_ratios',
  'yield-caps': 'yield_caps',
  'product-settings': 'product_settings',
};

/** Product catalog, workflows, field schemas and mass-balance reference data (docs/SPEC_PHASE1_5.md). */
export function catalogRoutes(catalogService: CatalogService, authService: AuthService): Router {
  const router = Router();

  // Public — the platform catalog: stage labels, workflow templates, field
  // definitions. The consumer and verifier pages render with it.
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'public, max-age=300');
      res.json(await catalogService.publicCatalog());
    }),
  );

  router.use(requireAuth(authService));

  // The tenant's view: platform rows plus its own product types and units.
  router.get(
    '/tenant',
    asyncHandler(async (req, res) => {
      res.json(await catalogService.tenantCatalog(req.actor!));
    }),
  );

  router.get(
    '/reference',
    asyncHandler(async (req, res) => {
      res.json(await catalogService.referenceData(req.actor!));
    }),
  );

  router.use(requireRole('ADMIN'));

  router.post(
    '/product-types',
    validateBody(createProductTypeSchema),
    asyncHandler(async (req, res) => {
      res.status(201).json(await catalogService.createProductType(req.actor!, req.body as z.infer<typeof createProductTypeSchema>));
    }),
  );

  router.patch(
    '/product-types/:id',
    validateBody(updateProductTypeSchema),
    asyncHandler(async (req, res) => {
      res.json(await catalogService.updateProductType(req.actor!, req.params.id, req.body as z.infer<typeof updateProductTypeSchema>));
    }),
  );

  router.post(
    '/units',
    validateBody(createUnitSchema),
    asyncHandler(async (req, res) => {
      res.status(201).json(await catalogService.createUnit(req.actor!, req.body as z.infer<typeof createUnitSchema>));
    }),
  );

  // Lots from before the catalog, waiting for an admin to say what they are.
  router.get(
    '/unmapped',
    asyncHandler(async (req, res) => {
      res.json(await catalogService.unmapped(req.actor!));
    }),
  );

  router.post(
    '/unmapped/map',
    validateBody(mapUnmappedSchema),
    asyncHandler(async (req, res) => {
      res.json(await catalogService.mapUnmapped(req.actor!, req.body as z.infer<typeof mapUnmappedSchema>));
    }),
  );

  router.put(
    '/reference/conversion-factors',
    validateBody(conversionFactorSchema),
    asyncHandler(async (req, res) => {
      res.json(await catalogService.setConversionFactor(req.actor!, req.body as z.infer<typeof conversionFactorSchema>));
    }),
  );

  router.put(
    '/reference/process-ratios',
    validateBody(processRatioSchema),
    asyncHandler(async (req, res) => {
      res.json(await catalogService.setProcessRatio(req.actor!, req.body as z.infer<typeof processRatioSchema>));
    }),
  );

  router.put(
    '/reference/yield-caps',
    validateBody(yieldCapSchema),
    asyncHandler(async (req, res) => {
      res.json(await catalogService.setYieldCap(req.actor!, req.body as z.infer<typeof yieldCapSchema>));
    }),
  );

  router.put(
    '/reference/product-settings',
    validateBody(productSettingsSchema),
    asyncHandler(async (req, res) => {
      res.json(await catalogService.setProductSettings(req.actor!, req.body as z.infer<typeof productSettingsSchema>));
    }),
  );

  router.delete(
    '/reference/:table/:id',
    asyncHandler(async (req, res) => {
      const table = REFERENCE_TABLES[req.params.table];
      if (!table) {
        res.status(404).json({ error: 'Unknown reference table' });
        return;
      }
      res.json(await catalogService.deleteOverride(req.actor!, table, req.params.id));
    }),
  );

  return router;
}
