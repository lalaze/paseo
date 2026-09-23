import type { Command } from "./schema.js";

function validateLine(line: string) {
  if (line.includes("\n") || line.includes("\r") || line.includes("\0"))
    throw new Error("Enter one command per item; add multiple checks separately.");
}
function result(words: string[]) {
  if (!words[0]?.trim()) throw new Error("Enter a check command, such as npm test.");
  return { command: words[0], args: words.slice(1) };
}
export function parseCommandLine(line: string): { command: string; args: string[] } {
  validateLine(line);
  const words: string[] = [];
  let word = "",
    quote = "",
    started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === "'") {
      if (char === "'") quote = "";
      else word += char;
      continue;
    }
    if (char === "\\") {
      const next = line[i + 1];
      if (next === undefined)
        throw new Error("A character is required after the trailing backslash.");
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) {
        word += char;
        continue;
      }
      word += next;
      i++;
      started = true;
      continue;
    }
    if (char === "$" || char === "`")
      throw new Error(
        "Enter literal argument values; variables and command substitutions are not expanded here.",
      );
    if (quote === '"') {
      if (char === '"') quote = "";
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/[;&|<>]/.test(char))
      throw new Error("Add each check command separately; do not use &&, pipes, or redirection.");
    if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("A quote in the command is not closed.");
  if (started) words.push(word);
  return result(words);
}

export function commandLine(command: Pick<Command, "command" | "args">): string {
  return [command.command, ...command.args]
    .map((value) =>
      /^[a-zA-Z0-9_./:@%=+,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`,
    )
    .join(" ");
}
