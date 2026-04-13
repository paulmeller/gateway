import { isTTY } from "./table.js";

export type OutputFormat = "table" | "json";

const VALID_FORMATS: OutputFormat[] = ["table", "json"];

export function resolveFormat(flagValue?: string, configValue?: string): OutputFormat {
  if (flagValue) {
    if (!VALID_FORMATS.includes(flagValue as OutputFormat)) {
      console.error(`Warning: unknown output format "${flagValue}", defaulting to table`);
      return "table";
    }
    return flagValue as OutputFormat;
  }
  if (!isTTY()) return "json";
  if (configValue && VALID_FORMATS.includes(configValue as OutputFormat)) {
    return configValue as OutputFormat;
  }
  return "table";
}

export function printJSON(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}
