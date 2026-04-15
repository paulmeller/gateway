import { Command } from "commander";
import { loadConfig, configSet, configGet, configUnset, configPath, effectiveApiKey, effectiveBaseUrl, effectiveOutput, maskKey } from "../config/file.js";

export function registerConfigCommands(parent: Command): void {
  const config = parent.command("config").description("Manage CLI configuration");

  config.command("set <key> <value>")
    .description("Set a config value (api-key, base-url, output)")
    .action((key, value) => {
      configSet(key, value);
      console.log(`Set ${key}`);
    });

  config.command("get <key>")
    .description("Get a config value")
    .action((key) => {
      const val = configGet(key);
      if (key === "api-key") {
        console.log(val ? maskKey(val) : "(not set)");
      } else {
        console.log(val || "(not set)");
      }
    });

  config.command("unset <key>")
    .description("Remove a config value")
    .action((key) => {
      configUnset(key);
      console.log(`Unset ${key}`);
    });

  config.command("list")
    .description("List all config values")
    .action(() => {
      const cfg = loadConfig();
      console.log(`api-key:    ${maskKey(effectiveApiKey(cfg))}`);
      console.log(`base-url:   ${effectiveBaseUrl(cfg)}`);
      console.log(`output:     ${effectiveOutput(cfg)}`);
      console.log(`telemetry:  ${cfg.telemetry === true ? "enabled" : cfg.telemetry === false ? "disabled" : "(not set)"}`);
    });

  config.command("path")
    .description("Print config file path")
    .action(() => {
      console.log(configPath());
    });
}
