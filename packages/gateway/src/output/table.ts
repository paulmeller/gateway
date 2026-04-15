import Table from "cli-table3";
import chalk from "chalk";

export interface Column<T = any> {
  header: string;
  field: (item: T) => string;
  width?: number;
}

export function isTTY(): boolean {
  return process.stdout.isTTY === true;
}

export function printTable<T>(items: T[], columns: Column<T>[]): void {
  if (items.length === 0) {
    console.log("No results found.");
    return;
  }

  const table = new Table({
    head: columns.map((c) => chalk.bold(c.header)),
    style: { head: [], border: [] },
    chars: {
      top: "", "top-mid": "", "top-left": "", "top-right": "",
      bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "",
      left: "", "left-mid": "", right: "", "right-mid": "",
      mid: "", "mid-mid": "", middle: "  ",
    },
  });

  for (const item of items) {
    table.push(columns.map((c) => {
      const val = c.field(item);
      if (c.width && val.length > c.width) return val.slice(0, c.width - 3) + "...";
      return val;
    }));
  }

  console.log(table.toString());
}

export function printSingle<T>(item: T, columns: Column<T>[]): void {
  const maxLabel = Math.max(...columns.map((c) => c.header.length));
  for (const col of columns) {
    const label = col.header.padEnd(maxLabel) + ":";
    console.log(`${chalk.bold(label)}  ${col.field(item)}`);
  }
}

export function formatOutput<T>(
  format: "table" | "json",
  data: T | T[],
  columns: Column<T>[],
): void {
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else if (Array.isArray(data)) {
    printTable(data, columns);
  } else {
    printSingle(data, columns);
  }
}
