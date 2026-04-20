import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    // Tests exercise enterprise features (tenancy, upstream pool,
    // per-key analytics, Redis rate-limit, etc.). Setting the license
    // key in the test env enables all of them. The actual key value
    // doesn't matter — any non-empty string = enterprise in v0.5.
    env: {
      AGENTSTEP_LICENSE_KEY: "test-enterprise-license",
    },
  },
});
