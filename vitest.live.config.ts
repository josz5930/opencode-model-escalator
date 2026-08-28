import { defineConfig } from 'vitest/config';

/**
 * Opt-in live-integration config. Kept SEPARATE from the default `vitest run`
 * so the always-on unit suite never needs a network, an OpenRouter key, or a
 * booted OpenCode server. Vitest's default include only matches `.test.ts` /
 * `.spec.ts` files, so it never picks up a `.live.ts` file; `npm test` ignores
 * these. They run only via `npm run test:live` (which additionally requires
 * `OPENCODE_LIVE=1` and an OpenRouter key at runtime).
 */
export default defineConfig({
  test: {
    include: ['test/live/**/*.live.ts'],
    // Booting an in-process OpenCode + real model round-trips is slow.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // One live server at a time; no cross-file parallelism.
    fileParallelism: false,
  },
});
