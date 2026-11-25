import type { CatalogView } from '../api/client'
import { Catalog } from '../domain/catalog'

/**
 * A small catalog shaped like the backend's (migrations 015–017): the coffee
 * export workflow, the legacy six-stage one, coffee product types with units,
 * and a few field schemas — enough to exercise the browser's rules.
 */
export const fixtureView: CatalogView = {
  stages: [
    { code: 'HARVEST', label: 'Thu hoạch', kind: 'RECORD', sortOrder: 10 },
    { code: 'COLLECTION', label: 'Thu gom', kind: 'RECORD', sortOrder: 20 },
    { code: 'PROCESSING', label: 'Chế biến', kind: 'RECORD', sortOrder: 40 },
    { code: 'WAREHOUSING', label: 'Nhập kho', kind: 'RECORD', sortOrder: 70 },
    { code: 'QUALITY_CHECK', label: 'Kiểm định chất lượng', kind: 'INSPECTION', sortOrder: 80 },
    { code: 'PACKAGING', label: 'Đóng gói', kind: 'RECORD', sortOrder: 90 },
    { code: 'CONTAINER_STUFFING', label: 'Đóng container', kind: 'RECORD', sortOrder: 100 },
    { code: 'EXPORT', label: 'Xuất khẩu', kind: 'EXPORT', sortOrder: 110 },
    { code: 'DISTRIBUTION', label: 'Phân phối', kind: 'RECORD', sortOrder: 130 },
    { code: 'RETAIL', label: 'Bán lẻ', kind: 'RECORD', sortOrder: 140 },
    { code: 'IMPORT_RECEIPT', label: 'Nhận hàng nhập khẩu', kind: 'RECEIPT', sortOrder: 150 },
  ],
  workflows: [
    {
      id: 'wf-generic',
      code: 'GENERIC_RETAIL',
      version: 1,
      name: 'Chuỗi chung',
      description: '',
      categoryCode: null,
      active: true,
      steps: [
        { position: 1, stage: 'HARVEST', required: false, roles: ['FARMER'] },
        { position: 2, stage: 'PROCESSING', required: false, roles: ['PROCESSOR'] },
        { position: 3, stage: 'QUALITY_CHECK', required: false, roles: ['INSPECTOR'] },
        { position: 4, stage: 'PACKAGING', required: false, roles: ['PROCESSOR'] },
        { position: 5, stage: 'DISTRIBUTION', required: false, roles: ['DISTRIBUTOR'] },
        { position: 6, stage: 'RETAIL', required: false, roles: ['RETAILER'] },
      ],
    },
    {
      id: 'wf-export',
      code: 'COFFEE_EXPORT',
      version: 1,
      name: 'Cà phê xuất khẩu',
      description: '',
      categoryCode: 'COFFEE',
      active: true,
      steps: [
        { position: 1, stage: 'HARVEST', required: true, roles: ['FARMER'] },
        { position: 2, stage: 'COLLECTION', required: false, roles: ['COLLECTOR'] },
        { position: 3, stage: 'PROCESSING', required: true, roles: ['PROCESSOR'] },
        { position: 4, stage: 'WAREHOUSING', required: false, roles: ['WAREHOUSE', 'PROCESSOR', 'EXPORTER'] },
        { position: 5, stage: 'QUALITY_CHECK', required: true, roles: ['INSPECTOR'] },
        { position: 6, stage: 'CONTAINER_STUFFING', required: true, roles: ['EXPORTER', 'WAREHOUSE'] },
        { position: 7, stage: 'EXPORT', required: true, roles: ['EXPORTER'] },
        { position: 8, stage: 'IMPORT_RECEIPT', required: false, roles: ['IMPORTER'] },
      ],
    },
  ],
  categories: [
    { code: 'COFFEE', name: 'Cà phê', sortOrder: 10 },
    { code: 'OTHER', name: 'Nông sản khác', sortOrder: 90 },
  ],
  productTypes: [
    { id: 'pt-cherry', tenantId: null, categoryCode: 'COFFEE', code: 'COFFEE_CHERRY', name: 'Cà phê quả tươi', baseUnit: 'kg', defaultWorkflowCode: 'COFFEE_EXPORT', aliases: [], active: true },
    { id: 'pt-green', tenantId: null, categoryCode: 'COFFEE', code: 'COFFEE_GREEN', name: 'Cà phê nhân xanh', baseUnit: 'kg', defaultWorkflowCode: 'COFFEE_EXPORT', aliases: [], active: true },
    { id: 'pt-other', tenantId: null, categoryCode: 'OTHER', code: 'OTHER_PRODUCE', name: 'Nông sản khác', baseUnit: 'kg', defaultWorkflowCode: 'GENERIC_RETAIL', aliases: [], active: true },
  ],
  units: [
    { id: 'u-kg', tenantId: null, productTypeId: null, baseUnit: 'kg', code: 'kg', label: 'kg', factor: 1 },
    { id: 'u-t', tenantId: null, productTypeId: null, baseUnit: 'kg', code: 'tấn', label: 'tấn', factor: 1000 },
    { id: 'u-bag', tenantId: null, productTypeId: 'pt-green', baseUnit: 'kg', code: 'bao', label: 'Bao 60 kg', factor: 60 },
  ],
  fieldSchemas: [
    {
      id: 1,
      categoryCode: null,
      stage: 'QUALITY_CHECK',
      version: 1,
      fields: [
        {
          key: 'result',
          label: 'Kết quả',
          type: 'select',
          required: true,
          public: true,
          options: [
            { value: 'PASS', label: 'Đạt' },
            { value: 'PASS_WITH_CONDITIONS', label: 'Đạt có điều kiện' },
            { value: 'FAIL', label: 'Không đạt' },
          ],
        },
        { key: 'conditions', label: 'Điều kiện phải đáp ứng', type: 'text', requiredWhen: { key: 'result', in: ['PASS_WITH_CONDITIONS'] } },
        { key: 'moisture', label: 'Độ ẩm', type: 'number', unit: '%', min: 0, max: 100 },
      ],
    },
    {
      id: 2,
      categoryCode: 'COFFEE',
      stage: 'HARVEST',
      version: 1,
      fields: [
        { key: 'variety', label: 'Giống cà phê', type: 'select', required: true, public: true, options: [{ value: 'ROBUSTA', label: 'Robusta (vối)' }] },
        { key: 'ripeRate', label: 'Tỉ lệ quả chín', type: 'number', unit: '%' },
      ],
    },
    { id: 3, categoryCode: null, stage: 'HARVEST', version: 1, fields: [{ key: 'variety', label: 'Giống', type: 'text', public: true }] },
  ],
}

export const fixtureCatalog = new Catalog(fixtureView)
