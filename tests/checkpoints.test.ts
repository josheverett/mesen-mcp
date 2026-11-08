import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkpointStore } from "../src/checkpoints.ts";

test("a normalized checkpoint name cannot replace progress unless requested and is local to its playthrough", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesen-checkpoints-"));
  try {
    const first = checkpointStore(join(root, "first"));
    const second = checkpointStore(join(root, "second"));
    await first.save("Before Boss", Buffer.from("first"));
    await assert.rejects(first.save(" before boss ", Buffer.from("accidental")), /name_taken/);
    await second.save("before boss", Buffer.from("second"));
    assert.equal((await first.load("before boss")).toString(), "first");
    assert.equal((await second.load("Before Boss")).toString(), "second");
    await first.save("Before Boss", Buffer.from("replacement"), true);
    assert.deepEqual(await first.list(), ["before boss"]);
    assert.equal((await first.load("before boss")).toString(), "replacement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
