/**
 * Render markdown text to chalk-formatted terminal output.
 * Uses marked's lexer to parse tokens, then applies chalk styles.
 * Handles: headings, bold, italic, code spans, fenced code blocks,
 * links, lists, paragraphs, blockquotes.
 */
import chalk from "chalk";
import { marked } from "marked";

export function renderMarkdown(text: string): string {
  const tokens = marked.lexer(text);
  return renderTokens(tokens).trim();
}

function renderTokens(tokens: marked.Token[]): string {
  let out = "";
  for (const token of tokens) {
    out += renderToken(token);
  }
  return out;
}

function renderToken(token: marked.Token): string {
  switch (token.type) {
    case "heading":
      return chalk.bold(renderInline(token.tokens ?? [])) + "\n\n";

    case "paragraph":
      return renderInline(token.tokens ?? []) + "\n\n";

    case "code": {
      const lang = token.lang ? chalk.dim(` ${token.lang}`) : "";
      const border = chalk.dim("│ ");
      const lines = token.text.split("\n").map((l) => border + chalk.cyan(l)).join("\n");
      return chalk.dim("┌──") + lang + "\n" + lines + "\n" + chalk.dim("└──") + "\n\n";
    }

    case "blockquote": {
      const bqText = renderTokens(token.tokens ?? []).trim();
      return bqText.split("\n").map((l) => chalk.dim("  ▎ ") + chalk.italic(l)).join("\n") + "\n\n";
    }

    case "list": {
      let result = "";
      for (let i = 0; i < token.items.length; i++) {
        const item = token.items[i];
        const bullet = token.ordered ? chalk.dim(`${i + 1}.`) : chalk.dim("•");
        const content = renderTokens(item.tokens ?? []).trim();
        result += `  ${bullet} ${content}\n`;
      }
      return result + "\n";
    }

    case "hr":
      return chalk.dim("─".repeat(40)) + "\n\n";

    case "space":
      return "\n";

    default:
      // For any unhandled block-level token, try rendering inline
      if ("tokens" in token && token.tokens) {
        return renderInline(token.tokens as marked.Token[]) + "\n\n";
      }
      if ("text" in token) {
        return (token as any).text + "\n\n";
      }
      return "";
  }
}

function renderInline(tokens: marked.Token[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        out += token.text;
        break;
      case "strong":
        out += chalk.bold(renderInline(token.tokens ?? []));
        break;
      case "em":
        out += chalk.italic(renderInline(token.tokens ?? []));
        break;
      case "codespan":
        out += chalk.cyan(token.text);
        break;
      case "link":
        out += chalk.underline.blue(token.text || token.href);
        break;
      case "br":
        out += "\n";
        break;
      case "del":
        out += chalk.strikethrough(renderInline(token.tokens ?? []));
        break;
      default:
        if ("text" in token) out += (token as any).text;
        break;
    }
  }
  return out;
}
