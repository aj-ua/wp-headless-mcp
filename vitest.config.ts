import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests must never reach a real WordPress site or the network.
    unstubGlobals: true,
  },
});
