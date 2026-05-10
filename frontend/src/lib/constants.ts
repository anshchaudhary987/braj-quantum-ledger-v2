export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

export const API_ENDPOINTS = {
  auth: {
    login: '/auth/login',
    refresh: '/auth/refresh',
    logout: '/auth/logout',
    me: '/auth/me',
  },
  vouchers: {
    sales: '/vouchers/sales',
  },
  einvoice: {
    generate: '/einvoice/generate',
  },
  payroll: {
    employees: '/payroll/employees',
    process: '/payroll/process',
  },
  ocr: {
    extract: '/ocr/extract',
  },
  tally: {
    import: '/tally-import',
  },
} as const;

export const APP_ROUTES = {
  landing: '/',
  login: '/login',
  register: '/register',
  dashboard: '/dashboard',
  vouchers: '/vouchers',
  reports: '/reports',
  inventory: '/inventory',
  gst: '/gst',
  payroll: '/payroll',
  banking: '/banking',
  settings: '/settings',
} as const;
