import { defineConfig, bindings, exports } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'roundhouse-platform', compatibilityDate: '2026-08-06', compatibilityFlags: ['nodejs_compat'],
    entrypoint: './index.js', assets: { runWorkerFirst: true, htmlHandling: 'none' },
    domains: ['roundhouse.tsc.hk', 'reportroom.roundhouse.tsc.hk'],
    env: {
      DB: bindings.d1({ name: 'roundhouse-platform', ...(process.env.ROUNDHOUSE_D1_ID ? { id: process.env.ROUNDHOUSE_D1_ID } : {}) }),
      CONTROLLERS: bindings.durableObject({ worker: 'roundhouse-platform', exportName: 'TenantController' }),
      REPORTS: bindings.durableObject({ worker: 'roundhouse-platform', exportName: 'ReportApplication' }),
      ASSETS: bindings.assets(),
      BROWSER: bindings.browser(),
      APPLICATION_TOKEN: bindings.text('internal-reportroom'),
      PUBLIC_ORIGIN: bindings.text('https://roundhouse.tsc.hk'),
      DEMO_ORIGIN: bindings.text('https://reportroom.roundhouse.tsc.hk'),
      SESSION_COOKIE_DOMAIN: bindings.text('roundhouse.tsc.hk'),
    },
    exports: { TenantController: exports.durableObject({ storage: 'sqlite' }), ReportApplication: exports.durableObject({ storage: 'sqlite' }) },
  },
});
