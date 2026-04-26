import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseUnifiedDiffChangedFiles } from "../dist/index.js";

describe("patch parsing", () => {
  it("extracts changed files from a unified git diff", () => {
    const diff = [
      "diff --git a/src/game.js b/src/game.js",
      "index 1111111..2222222 100644",
      "--- a/src/game.js",
      "+++ b/src/game.js",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/test/game.test.js b/test/game.test.js",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/test/game.test.js",
    ].join("\n");

    assert.deepEqual(parseUnifiedDiffChangedFiles(diff), [
      "src/game.js",
      "test/game.test.js",
    ]);
  });
});
