import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createCodexClientOptions, loadDotEnv, parseDotEnv } from "../dist/index.js";

async function envDir(contents) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "code-agent-sdk-env-"));
  await writeFile(path.join(cwd, ".env"), contents, "utf8");
  return cwd;
}

describe(".env Codex config", () => {
  it("loads OPENAI_KEY and OPENAI_BASE_URL from .env", async () => {
    const cwd = await envDir([
      "OPENAI_KEY=env-key",
      "OPENAI_BASE_URL=https://example.test/v1",
      "",
    ].join("\n"));

    const options = createCodexClientOptions({ cwd, env: {} });

    assert.equal(options.apiKey, "env-key");
    assert.equal(options.baseUrl, "https://example.test/v1");
  });

  it("keeps existing environment values ahead of .env values", async () => {
    const cwd = await envDir([
      "OPENAI_API_KEY=env-key",
      "OPENAI_URL=https://env.example/v1",
      "",
    ].join("\n"));

    const options = createCodexClientOptions({
      cwd,
      env: {
        OPENAI_KEY: "process-key",
        OPENAI_BASE_URL: "https://process.example/v1",
      },
    });

    assert.equal(options.apiKey, "process-key");
    assert.equal(options.baseUrl, "https://process.example/v1");
  });

  it("supports quoted values and OPENAI_URL alias", async () => {
    const cwd = await envDir([
      "OPENAI_KEY=\"quoted-key\"",
      "OPENAI_URL='https://quoted.example/v1'",
      "",
    ].join("\n"));

    const options = createCodexClientOptions({ cwd, env: {} });

    assert.equal(options.apiKey, "quoted-key");
    assert.equal(options.baseUrl, "https://quoted.example/v1");
  });

  it("loads .env values without overriding existing keys", async () => {
    const cwd = await envDir("OPENAI_KEY=env-key\n");
    const env = { OPENAI_KEY: "existing-key" };

    loadDotEnv({ cwd, env });

    assert.equal(env.OPENAI_KEY, "existing-key");
  });

  it("parses comments and export prefixes", () => {
    assert.deepEqual(
      parseDotEnv([
        "export OPENAI_KEY=abc # comment",
        "# skipped",
        "OPENAI_BASE_URL=https://api.example/v1",
        "",
      ].join("\n")),
      {
        OPENAI_KEY: "abc",
        OPENAI_BASE_URL: "https://api.example/v1",
      }
    );
  });
});
