/**
 * Taxonomy guard for the OpenAPI surface split.
 *
 * The architect's PR9 review identified PR8's misclassification of
 * skills/memory_stores/models/work-queue as gateway-native (when they
 * are actually CMA-canonical) as a regression class worth a fixture-
 * driven test. This is that test.
 *
 * The fixture (`fixtures/cma-paths.json`) enumerates every path that
 * MUST live under `/anthropic/v1/*` plus every path that MUST live
 * under `/agentstep/v1/*`. The test:
 *
 *   - Asserts every CMA-canonical path appears in the
 *     `/anthropic/v1/openapi.json` surface, NOT in
 *     `/agentstep/v1/openapi.json`.
 *   - Asserts every AgentStep extension appears in the
 *     `/agentstep/v1/openapi.json` surface, NOT in
 *     `/anthropic/v1/openapi.json`.
 *
 * When CMA upstream adds new endpoints, add them to the fixture and
 * the test will fail until they're registered. When we add new
 * AgentStep extensions, add them to the fixture.
 */

import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/openapi/spec";
import fixture from "./fixtures/cma-paths.json";

function pathKeysFor(prefix: string): Set<string> {
  const doc = buildOpenApiDocument({
    serverUrl: "http://test.local",
    pathPrefix: prefix,
  }) as { paths: Record<string, unknown> };
  return new Set(Object.keys(doc.paths));
}

describe("OpenAPI surface taxonomy", () => {
  const anthropicSurface = pathKeysFor("/anthropic/v1");
  const agentstepSurface = pathKeysFor("/agentstep/v1");

  describe("every CMA-canonical path appears in /anthropic/v1/openapi.json", () => {
    for (const cmaPath of fixture.cma_canonical_paths) {
      it(`${cmaPath} is registered`, () => {
        expect(anthropicSurface.has(cmaPath)).toBe(true);
      });
    }
  });

  describe("no CMA-canonical path leaks into /agentstep/v1/openapi.json", () => {
    for (const cmaPath of fixture.cma_canonical_paths) {
      it(`${cmaPath} is absent`, () => {
        expect(agentstepSurface.has(cmaPath)).toBe(false);
      });
    }
  });

  describe("every AgentStep extension appears in /agentstep/v1/openapi.json", () => {
    for (const extPath of fixture.agentstep_extensions) {
      it(`${extPath} is registered`, () => {
        expect(agentstepSurface.has(extPath)).toBe(true);
      });
    }
  });

  describe("no AgentStep extension leaks into /anthropic/v1/openapi.json", () => {
    for (const extPath of fixture.agentstep_extensions) {
      it(`${extPath} is absent`, () => {
        expect(anthropicSurface.has(extPath)).toBe(false);
      });
    }
  });
});
