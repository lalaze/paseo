import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { execCommand, type UsageSourceRegistration } from "@getpaseo/plugin/server";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";
import { AntigravityError } from "./internal/wire.js";

const inputSchema = z.object({ account: z.string() }).strict();
const quotaSchema = z.object({
  status: z.literal("SUCCESS"),
  num_turns: z.literal(0),
  command: z.object({
    name: z.literal("usage"),
    data: z.object({
      groups: z.array(
        z.object({
          name: z.string(),
          buckets: z.array(
            z.object({
              id: z.string().min(1),
              window: z.enum(["weekly", "5h"]),
              remaining_fraction: z.number().min(0).max(1),
              reset_time: z.iso.datetime(),
            }),
          ),
        }),
      ),
    }),
  }),
});

interface Launch {
  command: string;
  env: NodeJS.ProcessEnv;
}

interface QuotaCommand {
  launch: Launch;
  args: string[];
  timeoutMs: number;
}

async function resolveBinary(env: NodeJS.ProcessEnv): Promise<string | null> {
  const home = env.HOME || homedir();
  const binary = process.platform === "win32" ? "agy.exe" : "agy";
  const directories = (env.PATH || "").split(path.delimiter).filter(Boolean);
  const candidates = [
    env.PASEO_ANTIGRAVITY_BIN || env.ANTIGRAVITY_CLI_PATH,
    ...directories.map((directory) => path.join(directory, binary)),
    path.join(home, ".local", "bin", binary),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    path.join(home, ".gemini", "bin", binary),
  ];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
      )
        continue;
      throw error;
    }
  }
  return null;
}

async function run(input: QuotaCommand): Promise<string> {
  try {
    const { stdout } = await execCommand(input.launch.command, input.args, {
      env: input.launch.env,
      cwd: input.launch.env.HOME || homedir(),
      timeout: input.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    // CLI stderr can contain credentials; only expose our own diagnostic.
    const timedOut = error instanceof Error && "killed" in error && error.killed === true;
    const message = timedOut
      ? "Antigravity quota query timed out. Retry Refresh."
      : "Antigravity quota query failed. Run agy /usage in a terminal to check your login.";
    throw new AntigravityError(message, "USAGE_COMMAND_FAILED");
  }
}

function supportsUsage(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  // Earlier CLIs treat /usage as a model prompt rather than a read-only command.
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11)));
}

async function readUsage(launch: Launch): Promise<UsageReport> {
  // Keep both subprocesses inside the daemon's 20-second Usage deadline.
  const version = await run({ launch, args: ["--version"], timeoutMs: 3_000 });
  if (!supportsUsage(version))
    return unavailable({
      kind: "no_quota",
      detail: "Update agy to 1.1.11 or later to read quota.",
    });
  const stdout = await run({
    launch,
    args: ["-p", "/usage", "--output-format", "json", "--print-timeout", "12s"],
    timeoutMs: 15_000,
  });
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new AntigravityError("Antigravity returned invalid quota data.", "INVALID_USAGE");
  }
  const parsed = quotaSchema.safeParse(json);
  if (!parsed.success)
    throw new AntigravityError(
      "Antigravity did not return a read-only quota result.",
      "INVALID_USAGE",
    );
  const windows = parsed.data.command.data.groups.flatMap((group) =>
    group.buckets.map((bucket) => {
      const usedPct = Math.round((1 - bucket.remaining_fraction) * 10_000) / 100;
      const weekly = bucket.window === "weekly";
      const period = weekly ? "Weekly limit" : "5-hour limit";
      return windowFromUsedPct({
        id: bucket.id,
        label: `${group.name} · ${period}`,
        shortLabel: weekly ? "wk" : "5h",
        utilizationPct: usedPct,
        resetsAt: new Date(bucket.reset_time).toISOString(),
        tone: toneFromUsedPct(usedPct),
      });
    }),
  );
  if (windows.length === 0)
    return unavailable({ kind: "no_quota", detail: "Antigravity reported no quota windows." });
  return { status: "available", windows };
}

export class Usage {
  private readonly launches = new Map<string, Launch>();

  registration(): UsageSourceRegistration {
    return {
      id: "antigravity",
      label: "Google Antigravity",
      icon: "icon.svg",
      input: inputSchema,
      discover: async (scope) => {
        if (scope.kind === "session" && scope.provider !== "antigravity") return [];
        const env = scope.kind === "session" ? { ...process.env, ...scope.env } : process.env;
        const command = await resolveBinary(env);
        if (!command) return [];
        const account = hashAccountKey(JSON.stringify([command, env.HOME || homedir()]));
        this.launches.set(account, { command, env });
        return [{ key: account, harness: "Antigravity", input: { account } }];
      },
      fetch: async (input) => {
        const { account } = inputSchema.parse(input);
        const launch = this.launches.get(account);
        if (!launch)
          throw new AntigravityError(
            "Antigravity login was not discovered.",
            "UNKNOWN_USAGE_ACCOUNT",
          );
        try {
          return await readUsage(launch);
        } catch (error) {
          if (!(error instanceof AntigravityError)) throw error;
          return { status: "error", error: error.message };
        }
      },
    };
  }
}
