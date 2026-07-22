// Aligned with packages/ward-react/vitest.config.ts — we alias the SDK
// to its source so tests can call compilePolicy without a prior build.
export default {
  resolve: {
    alias: {
      "@ward/sdk": new URL("../../sdk/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
  },
};
