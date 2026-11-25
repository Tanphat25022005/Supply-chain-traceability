/** Hand-written OpenAPI 3.0 spec covering the public API surface. */
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'TraceChain API',
    version: '1.5.0',
    description: 'Supply-chain traceability API with a hash-chain ledger, RBAC, and anomaly detection.',
  },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Actor: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          role: {
            type: 'string',
            enum: ['FARMER', 'COLLECTOR', 'PROCESSOR', 'WAREHOUSE', 'INSPECTOR', 'EXPORTER', 'DISTRIBUTOR', 'RETAILER', 'IMPORTER', 'ADMIN'],
          },
          organization: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          isActive: { type: 'boolean' },
        },
      },
      Batch: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          productName: { type: 'string' },
          productType: { type: 'string', description: 'Catalog name (on create: a catalog name, code or alias — or send productTypeId).' },
          productTypeId: { type: 'string', format: 'uuid' },
          origin: { type: 'string' },
          quantity: { type: 'number' },
          unit: { type: 'string', description: 'kg, tấn, or a packaging unit of the product type (e.g. bao = 60 kg of green coffee).' },
          quantityBase: { type: 'number', description: 'quantity × unitFactor, in baseUnit (kg or cái).' },
          workflowId: { type: 'string', format: 'uuid', description: 'The workflow template version the lot follows.' },
          createdAt: { type: 'string', format: 'date-time' },
          createdBy: { type: 'string', format: 'uuid' },
          currentStage: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['ACTIVE', 'IN_TRANSIT', 'ON_HOLD', 'REJECTED', 'RECALLED', 'DESTROYED', 'CONSUMED'] },
          consumedQuantity: { type: 'number' },
          lostQuantity: { type: 'number', description: 'Transit shortfall and disposals.' },
          isRecalled: { type: 'boolean', description: 'Derived: status = RECALLED.' },
          recallReason: { type: 'string', nullable: true },
          metadata: { type: 'object' },
          assignedToActorId: { type: 'string', format: 'uuid', nullable: true },
          headHash: {
            type: 'string',
            pattern: '^[0-9a-f]{64}$',
            description: 'Hash of the last event, i.e. the recorded head of the batch chain (genesis = 64 zeros).',
          },
          eventCount: { type: 'integer', description: 'Number of events in the chain; a verifier compares it to the events returned.' },
        },
      },
      TraceEvent: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          batchId: { type: 'string', format: 'uuid' },
          stage: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['OBSERVE', 'MERGE', 'SPLIT', 'TRANSFORM', 'REWORK', 'DOWNGRADE', 'TRANSFER_OUT', 'TRANSFER_ACCEPT', 'TRANSFER_REJECT', 'TRANSFER_CANCEL', 'HOLD', 'RELEASE', 'RECALL', 'DISPOSE'],
          },
          actorId: { type: 'string', format: 'uuid' },
          timestamp: { type: 'string', format: 'date-time', description: 'When it was recorded (server clock).' },
          occurredAt: { type: 'string', format: 'date-time', description: 'When it happened (declared; committed by hash v4).' },
          location: { type: 'string' },
          notes: { type: 'string', nullable: true },
          data: { type: 'object' },
          hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          prevHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          sequenceNumber: { type: 'integer' },
          hashVersion: {
            type: 'integer',
            enum: [1, 2, 3, 4],
            description:
              '4 = v3 + occurredAt in the envelope (docs/SPEC_PHASE1_5.md). 3 = per-field salted commitments (selective disclosure, docs/SPEC_PHASE1.md). 2 = SHA-256 over the RFC 8785 canonical JSON of the whole event and a salt. 1 = legacy HMAC, server-verifiable only.',
          },
          salt: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Per-event random salt (v2 only).' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          issues: {
            type: 'array',
            description: '422 only: one entry per field that broke the stage\'s field schema.',
            items: { type: 'object', properties: { field: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } } },
          },
        },
      },
    },
  },
  paths: {
    '/catalog': {
      get: {
        summary: 'Platform catalog: stages, workflow templates, product types, units, field schemas (public)',
        responses: { '200': { description: 'Catalog' } },
      },
    },
    '/catalog/tenant': {
      get: { summary: "The catalog with the tenant's own product types and units", security: [{ bearerAuth: [] }], responses: { '200': { description: 'Catalog' } } },
    },
    '/catalog/reference': {
      get: {
        summary: 'Mass-balance reference data with sources (platform values and tenant overrides)',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Conversion factors, process ratios, yield caps, product settings' } },
      },
    },
    '/catalog/unmapped': {
      get: { summary: 'Old lots not yet linked to the catalog (ADMIN)', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Groups by old name and unit' } } },
    },
    '/batches/{id}/transfers': {
      post: {
        summary: 'Hand a lot over — the receiver must accept (or reject) it',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '201': { description: 'Transfer pending; lot IN_TRANSIT' }, '409': { description: 'Lot not ACTIVE/REJECTED, or a transfer already pending' } },
      },
    },
    '/transfers/incoming': {
      get: { summary: 'Hand-overs waiting for the caller', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Pending transfers' } } },
    },
    '/transfers/{id}/respond': {
      post: {
        summary: 'Accept (with the weighed quantity) or reject (with a reason) a hand-over',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Answered; a shortfall beyond tolerance raises QUANTITY_DISCREPANCY' } },
      },
    },
    '/transfers/{id}/cancel': {
      post: { summary: 'The sender withdraws an unanswered hand-over', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Cancelled' } } },
    },
    '/batches/{id}/hold': {
      post: { summary: 'Put a lot on hold pending investigation (ADMIN/INSPECTOR)', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ON_HOLD' } } },
    },
    '/batches/{id}/release': {
      post: { summary: 'Release a hold with a reason (ADMIN/INSPECTOR)', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Previous status restored' } } },
    },
    '/batches/{id}/dispose': {
      post: {
        summary: 'Destroy what remains of a lot, with a record number, method and witness',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'DESTROYED' } },
      },
    },
    '/trace/{batchId}/receipt-links': {
      post: {
        summary: 'After EXPORT: a time-limited link for the foreign buyer to confirm receipt (EXPORTER)',
        security: [{ bearerAuth: [] }],
        responses: { '201': { description: 'Token and expiry' } },
      },
    },
    '/trace/public/{batchId}/receipt': {
      get: { summary: 'What the buyer sees for a receipt link (?token=)', responses: { '200': { description: 'Lot summary and export data' } } },
      post: { summary: 'The buyer confirms what arrived (token in the body)', responses: { '201': { description: 'Receipt recorded as the last step' } } },
    },
    '/auth/login': {
      post: {
        summary: 'Log in with email/password',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: { email: { type: 'string' }, password: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Access + refresh token issued' },
          '401': { description: 'Invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/auth/register': {
      post: {
        summary: 'Sign up — found a new workspace (becomes its ADMIN) or redeem an invitation (role from the invite)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    type: 'object',
                    required: ['mode', 'name', 'email', 'password', 'organization', 'tenantSlug', 'tenantName'],
                    properties: {
                      mode: { type: 'string', enum: ['workspace'] },
                      name: { type: 'string' },
                      email: { type: 'string' },
                      password: { type: 'string', minLength: 8 },
                      organization: { type: 'string' },
                      tenantSlug: { type: 'string', pattern: '^[a-z0-9-]+$' },
                      tenantName: { type: 'string' },
                    },
                  },
                  {
                    type: 'object',
                    required: ['mode', 'name', 'email', 'password', 'organization', 'inviteCode'],
                    properties: {
                      mode: { type: 'string', enum: ['invite'] },
                      name: { type: 'string' },
                      email: { type: 'string' },
                      password: { type: 'string', minLength: 8 },
                      organization: { type: 'string' },
                      inviteCode: { type: 'string', example: 'K7QF-M2XP-9A3R' },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Actor created' },
          '403': { description: 'Invitation was issued for a different email' },
          '404': { description: 'Invitation invalid or expired' },
          '409': { description: 'Email already registered, workspace slug taken, or invitation already used' },
        },
      },
    },
    '/auth/invitations/{code}': {
      get: {
        summary: 'Preview an invitation (workspace name + granted role) — no auth required',
        parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Invitation preview' }, '404': { description: 'Invalid or expired' } },
      },
    },
    '/auth/refresh': {
      post: {
        summary: 'Exchange a refresh token for a new access token',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { refreshToken: { type: 'string' } } } } } },
        responses: { '200': { description: 'New tokens issued' }, '401': { description: 'Invalid/expired refresh token' } },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'Revoke a refresh token',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { refreshToken: { type: 'string' } } } } } },
        responses: { '204': { description: 'Revoked' } },
      },
    },
    '/batches': {
      get: {
        summary: 'List batches (paginated, searchable)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          {
            name: 'stage',
            in: 'query',
            schema: { type: 'string', description: 'A stage code, or NONE for lots with no event yet' },
          },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['ACTIVE', 'IN_TRANSIT', 'ON_HOLD', 'REJECTED', 'RECALLED', 'DESTROYED', 'CONSUMED'] },
          },
        ],
        responses: { '200': { description: 'Paginated batch list' } },
      },
      post: {
        summary: 'Create a batch',
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Batch' } } } },
        responses: { '201': { description: 'Batch created' } },
      },
    },
    '/batches/{id}': {
      get: {
        summary: 'Get a batch by id',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Batch' }, '404': { description: 'Not found' } },
      },
    },
    '/batches/{id}/recall': {
      post: {
        summary: 'Recall a batch (ADMIN or INSPECTOR) — lots made from it go ON_HOLD, or are recalled too with cascade: true',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } } } } } },
        responses: { '200': { description: 'Batch recalled' }, '403': { description: 'Not ADMIN or INSPECTOR' } },
      },
    },
    '/batches/{id}/qr': {
      get: {
        summary: 'Get an SVG QR code linking to the public provenance page',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'image/svg+xml' } },
      },
    },
    '/events': {
      post: {
        summary: 'Record a supply-chain event for a batch',
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TraceEvent' } } } },
        responses: { '201': { description: 'Event recorded' }, '403': { description: 'Role not permitted for this stage' } },
      },
    },
    '/trace/{batchId}': {
      get: {
        summary: 'Full trace (forward/backward) for a batch — requires auth',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'batchId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'direction', in: 'query', schema: { type: 'string', enum: ['forward', 'backward'] } },
        ],
        responses: { '200': { description: 'Trace result with events + anomalies + isValid' } },
      },
    },
    '/trace/public/{batchId}': {
      get: {
        summary: 'Public provenance summary — no auth required (QR-scan page)',
        parameters: [{ name: 'batchId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Public trace summary with the consumer-facing journey (organizations, places, dates, whitelisted facts)' } },
      },
    },
    '/stats/overview': {
      get: { summary: 'Aggregate counts', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Overview stats' } } },
    },
    '/stats/by-stage': {
      get: { summary: 'Event counts by stage', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Stats by stage' } } },
    },
    '/stats/attention': {
      get: {
        summary: 'Stalled batches (no activity for 3+ days) and the open-anomaly count',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Attention summary' } },
      },
    },
    '/admin/invitations': {
      get: { summary: 'Recent invitations (ADMIN only)', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Invitations' } } },
      post: {
        summary: 'Issue an invitation (ADMIN only) — the raw code is returned once',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['role'],
                properties: {
                  role: { type: 'string', enum: ['FARMER', 'PROCESSOR', 'INSPECTOR', 'DISTRIBUTOR', 'RETAILER', 'ADMIN'] },
                  email: { type: 'string' },
                  note: { type: 'string' },
                  expiresInDays: { type: 'integer', minimum: 1, maximum: 30, default: 7 },
                },
              },
            },
          },
        },
        responses: { '201': { description: '{ invitation, code }' } },
      },
    },
    '/admin/invitations/{id}': {
      delete: {
        summary: 'Revoke an unused invitation (ADMIN only)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Revoked' }, '409': { description: 'Already used or revoked' } },
      },
    },
    '/admin/audit-logs': {
      get: {
        summary: 'Paginated audit log (ADMIN only)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'Paginated audit log' }, '403': { description: 'Not ADMIN' } },
      },
    },
  },
};
