import type { Backend } from "./interface.js";
import { LocalBackend } from "./local.js";
import { RemoteBackend } from "./remote.js";

export function resolveBackend(opts: { remote?: string; apiKey?: string }): Backend {
  if (opts.remote) {
    if (!opts.apiKey) {
      throw new Error("API key required for remote mode. Set GATEWAY_API_KEY or run \"gateway config set api-key <key>\"");
    }
    return new RemoteBackend(opts.remote, opts.apiKey);
  }
  return new LocalBackend();
}
