import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configFromEnvironment, createSessions } from "../src/sessions.ts";

test("opening a GBA ROM without configured firmware fails before spawning Mesen", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesen-mcp-firmware-"));
  try {
    await writeFile(join(root, "game.gba"), "test ROM");
    const config = configFromEnvironment({
      MESEN_ROM_DIR: root,
      MESEN_MCP_DATA_DIR: join(root, "state"),
      MESEN_FIRMWARE_DIR: join(root, "firmware"),
      MESEN_BIN: join(root, "unavailable.app", "Contents", "MacOS", "Mesen"),
    });
    await assert.rejects(
      createSessions(config).openGame({ game_id: "game.gba" }, { mode: "stepped", speed: 1 }),
      /gba_bios\.bin.*MESEN_FIRMWARE_DIR/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
