import { rejects } from "node:assert/strict";
import { test as runAgent } from "../dist/index.js";
import { describe, it } from "node:test";

describe("test()", () => {
  it("rejects when repo is not a git work tree", async () => {
    await rejects(
      runAgent("hello", "/nonexistent-path-" + Date.now(), "main"),
      /Not a git repository/
    );
  });

  it("exports test as a function", () => {
    if (typeof runAgent !== "function") {
      throw new Error("expected test to be a function");
    }
  });
});
