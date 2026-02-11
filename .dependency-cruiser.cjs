/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── No circular dependencies ──────────────────────────────────────────
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No circular dependencies allowed between modules.',
      from: {},
      to: { circular: true },
    },

    // ── shared/ depends on nothing ────────────────────────────────────────
    {
      name: 'shared-no-deps',
      severity: 'error',
      comment: 'shared/ must not import from any other Meridian module.',
      from: { path: '^src/shared/' },
      to: {
        path: '^src/(axis|scout|sentinel|journal|bridge|gear)/',
      },
    },

    // ── axis/ depends on shared/ only ─────────────────────────────────────
    {
      name: 'axis-deps',
      severity: 'error',
      comment: 'axis/ may only depend on shared/.',
      from: { path: '^src/axis/' },
      to: {
        path: '^src/(scout|sentinel|journal|bridge|gear)/',
      },
    },

    // ── scout/ depends on shared/ only ────────────────────────────────────
    {
      name: 'scout-deps',
      severity: 'error',
      comment: 'scout/ may only depend on shared/.',
      from: { path: '^src/scout/' },
      to: {
        path: '^src/(axis|sentinel|journal|bridge|gear)/',
      },
    },

    // ── sentinel/ depends on shared/ only ─────────────────────────────────
    {
      name: 'sentinel-deps',
      severity: 'error',
      comment: 'sentinel/ may only depend on shared/.',
      from: { path: '^src/sentinel/' },
      to: {
        path: '^src/(axis|scout|journal|bridge|gear)/',
      },
    },

    // ── journal/ depends on shared/ only ──────────────────────────────────
    {
      name: 'journal-deps',
      severity: 'error',
      comment: 'journal/ may only depend on shared/.',
      from: { path: '^src/journal/' },
      to: {
        path: '^src/(axis|scout|sentinel|bridge|gear)/',
      },
    },

    // ── gear/ depends on shared/ only ─────────────────────────────────────
    {
      name: 'gear-deps',
      severity: 'error',
      comment: 'gear/ may only depend on shared/.',
      from: { path: '^src/gear/' },
      to: {
        path: '^src/(axis|scout|sentinel|journal|bridge)/',
      },
    },

    // ── bridge/ depends on shared/ only ───────────────────────────────────
    {
      name: 'bridge-deps',
      severity: 'error',
      comment: 'bridge/ may only depend on shared/.',
      from: { path: '^src/bridge/' },
      to: {
        path: '^src/(axis|scout|sentinel|journal|gear)/',
      },
    },

    // NOTE: Cross-module internal file imports (must go through index.ts)
    // are enforced by ESLint no-restricted-imports rules in eslint.config.js,
    // which provides better error messages and catches at the import level.
  ],

  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
