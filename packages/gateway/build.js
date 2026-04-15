import { build } from "esbuild";
import { builtinModules } from "node:module";

const nodeExternals = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/gateway.js",
  banner: { js: "#!/usr/bin/env node\nimport{createRequire as __cjsReq}from'node:module';const require=__cjsReq(import.meta.url);" },
  external: [
    ...nodeExternals,
    "libsql",
    "sharp",
    "cbor-x",
  ],
  packages: "bundle",
});
