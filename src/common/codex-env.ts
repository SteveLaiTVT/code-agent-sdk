import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CodexOptions } from "@openai/codex-sdk";

export interface CodexEnvOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function loadDotEnv(options: CodexEnvOptions = {}): Record<string, string> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const envPath = path.join(cwd, ".env");

  if (!existsSync(envPath)) {
    return {};
  }

  const parsed = parseDotEnv(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
  return parsed;
}

export function createCodexClientOptions(options: CodexEnvOptions = {}): CodexOptions {
  const env = options.env ?? process.env;
  const processApiKey = firstNonEmpty(env.OPENAI_API_KEY, env.OPENAI_KEY);
  const processBaseUrl = firstNonEmpty(
    env.OPENAI_API_BSSE_URL,
    env.OPENAI_API_BASE_URL,
    env.OPENAI_BASE_URL,
    env.OPENAI_URL,
  );

  loadDotEnv({ cwd: options.cwd, env });

  const apiKey = processApiKey ?? firstNonEmpty(env.OPENAI_API_KEY, env.OPENAI_KEY);
  const baseUrl =
    processBaseUrl ??
    firstNonEmpty(
      env.OPENAI_API_BSSE_URL,
      env.OPENAI_API_BASE_URL,
      env.OPENAI_BASE_URL,
      env.OPENAI_URL,
    );
  const codexOptions: CodexOptions = {};

  if (apiKey) {
    codexOptions.apiKey = apiKey;
  }
  if (baseUrl) {
    codexOptions.baseUrl = baseUrl;
  }

  return codexOptions;
}

export function parseDotEnv(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const assignment = line.startsWith("export ")
      ? line.slice("export ".length).trimStart()
      : line;
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = assignment.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    parsed[key] = parseDotEnvValue(assignment.slice(separatorIndex + 1));
  }

  return parsed;
}

function parseDotEnvValue(rawValue: string): string {
  const value = rawValue.trim();
  if (!value) {
    return "";
  }

  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
    const unquoted = value.slice(1, -1);
    return quote === "\"" ? unescapeDoubleQuotedValue(unquoted) : unquoted;
  }

  return value.replace(/\s+#.*$/, "").trim();
}

function unescapeDoubleQuotedValue(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values
    .find((value): value is string => typeof value === "string" && value.trim() !== "")
    ?.trim();
}
