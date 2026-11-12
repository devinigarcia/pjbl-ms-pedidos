import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // o teste com SQL real pode pegar o banco serverless "dormindo"
    testTimeout: 15_000,
    hookTimeout: 120_000,
  },
});
