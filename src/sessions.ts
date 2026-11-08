import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, copyFile, cp, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bridgeCall, bridgePort, observation, type Playback } from "./bridge.ts";
import { checkpointStore, hasCode } from "./checkpoints.ts";

type Game = { game_id: string; name: string };
type Playthrough = Game & { playthrough_id: string; sha256: string };
type Session = { session_id: string; playthrough_id: string; game_id: string; pid: number };
type Selection = { game_id?: string; playthrough_id?: string };
type Config = { roms: string; data: string; mesen: string; firmware: string };

const bridgeScript = fileURLToPath(new URL("../lua/bridge.lua", import.meta.url));
const extensions = new Set([".nes", ".sfc", ".smc", ".gb", ".gbc", ".gba", ".pce", ".sms", ".gg", ".sg", ".col", ".ws", ".wsc"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function configFromEnvironment(env = process.env): Config {
  const data = resolve(env.MESEN_MCP_DATA_DIR ?? join(homedir(), ".mesen-mcp"));
  return {
    roms: resolve(env.MESEN_ROM_DIR ?? join(homedir(), "Roms")),
    data,
    mesen: resolve(env.MESEN_BIN ?? "/Applications/Mesen.app/Contents/MacOS/Mesen"),
    firmware: resolve(env.MESEN_FIRMWARE_DIR ?? join(data, "Firmware")),
  };
}

function requireId(id: string): string {
  if (!uuid.test(id)) throw new Error("Invalid Mesen session or playthrough ID.");
  return id;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function entries(path: string) {
  return readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  });
}

async function romHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest("hex");
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasCode(error, "ESRCH")) return false;
    throw error;
  }
}

export function createSessions(config: Config) {
  const sessionRoot = join(config.data, "sessions");
  const playthroughRoot = join(config.data, "playthroughs");
  const sessionFile = (id: string) => join(sessionRoot, `${requireId(id)}.json`);
  const endpointFile = (id: string) => join(sessionRoot, `${requireId(id)}.port`);
  const playthroughDir = (id: string) => join(playthroughRoot, requireId(id));
  const activeFile = (id: string) => join(playthroughDir(id), "active");
  const saves = (id: string) => checkpointStore(join(playthroughDir(id), "checkpoints"));

  async function listGames(): Promise<Game[]> {
    const games: Game[] = [];
    async function visit(directory: string) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
          games.push({ game_id: relative(config.roms, path), name: basename(path, extname(path)) });
        }
      }
    }
    await visit(config.roms);
    return games.sort((a, b) => a.game_id.localeCompare(b.game_id));
  }

  async function getPlaythrough(id: string): Promise<Playthrough> {
    try {
      return await readJson<Playthrough>(join(playthroughDir(id), "playthrough.json"));
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new Error("Unknown playthrough. Use list_playthroughs.");
      throw error;
    }
  }

  async function getSession(id: string): Promise<Session> {
    try {
      return await readJson<Session>(sessionFile(id));
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new Error("Unknown session. Use list_sessions.");
      throw error;
    }
  }

  async function call(id: string, command: string, ...args: (string | number)[]) {
    let port: number;
    try {
      port = await bridgePort(endpointFile(id));
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new Error("The Mesen bridge is unavailable. Check list_sessions before reopening the playthrough.");
      throw error;
    }
    return bridgeCall(port, id, command, ...args);
  }

  async function status(id: string) {
    const record = await getSession(id);
    const [actualId, encodedRom, frame, fps, mode, speed, first, second] = await call(id, "STATUS");
    if (actualId !== id) throw new Error("The Mesen bridge belongs to a different session.");
    const rom = Buffer.from(encodedRom, "base64").toString("utf8");
    if (rom !== await realpath(join(config.roms, record.game_id))) throw new Error("Mesen is running a different ROM from the one assigned to this session.");
    return {
      session_id: id, playthrough_id: record.playthrough_id, game_id: record.game_id,
      frame: Number(frame), fps: Number(fps), mode, speed: Number(speed),
      controllers: [first, second].flatMap((buttons, index) => buttons ? [{ controller: index + 1, buttons: buttons.split(",") }] : []),
    };
  }

  async function provision(directory: string): Promise<string> {
    if (process.platform !== "darwin") throw new Error("Visible Mesen sessions in this version require macOS.");
    const binary = await realpath(config.mesen);
    const sourceApp = dirname(dirname(dirname(binary)));
    if (extname(sourceApp) !== ".app") throw new Error("MESEN_BIN must point to a Mesen executable inside its macOS .app bundle.");
    const profileApp = join(directory, "Mesen.app");
    const profileBinary = join(profileApp, relative(sourceApp, binary));
    const settings = join(dirname(profileBinary), "settings.json");
    try {
      await access(settings);
      await access(profileBinary, constants.X_OK);
      return profileBinary;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    await cp(sourceApp, profileApp, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => !path.endsWith(".dSYM"),
    });
    await writeFile(settings, JSON.stringify({
      Preferences: {
        SingleInstance: false,
        PauseWhenInBackground: false,
        ConfirmExitResetPower: false,
        AutomaticallyCheckForUpdates: false,
        GameSelectionScreenMode: "PowerOn",
        EnableAutoSaveState: false,
      },
      Debug: {
        ScriptWindow: {
          AllowIoOsAccess: true, AllowNetworkAccess: true, AutoStartScriptOnLoad: true,
          AutoRestartScriptAfterPowerCycle: false, ScriptTimeout: 86400,
        },
      },
      // Lua paces continuous play from the ROM's own frame rate.
      Emulation: { EmulationSpeed: 0 },
      Snes: { Port1: { Type: "SnesController" }, Port2: { Type: "SnesController" } },
      Nes: { Port1: { Type: "NesController" }, Port2: { Type: "NesController" } },
    }));
    return profileBinary;
  }

  async function forget(record: Session) {
    await rm(endpointFile(record.session_id), { force: true });
    await rm(sessionFile(record.session_id), { force: true });
    const active = activeFile(record.playthrough_id);
    const claimed = await readFile(active, "utf8").catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return "";
      throw error;
    });
    if (claimed === record.session_id) await rm(active, { force: true });
  }

  async function openGame(selection: Selection, playback: Playback) {
    const previous = selection.playthrough_id ? await getPlaythrough(selection.playthrough_id) : undefined;
    const game = (await listGames()).find(({ game_id }) => game_id === (previous?.game_id ?? selection.game_id));
    if (!game) throw new Error("Unknown ROM. Use list_games to find its game_id.");
    const gbaBios = extname(game.game_id).toLowerCase() === ".gba" ? join(config.firmware, "gba_bios.bin") : undefined;
    if (gbaBios) {
      const file = await stat(gbaBios).catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (!file?.isFile() || file.size !== 16_384) {
        throw new Error(`A GBA game requires a 16,384-byte gba_bios.bin in MESEN_FIRMWARE_DIR (${config.firmware}).`);
      }
    }
    const rom = await realpath(join(config.roms, game.game_id));
    const sha256 = await romHash(rom);
    if (previous && previous.sha256 !== sha256) throw new Error("This ROM changed since the playthrough was created.");
    const playthrough: Playthrough = previous ?? { ...game, playthrough_id: randomUUID(), sha256 };
    const directory = playthroughDir(playthrough.playthrough_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    if (!previous) await writeFile(join(directory, "playthrough.json"), JSON.stringify(playthrough), { flag: "wx" });
    const record: Session = {
      session_id: randomUUID(), playthrough_id: playthrough.playthrough_id, game_id: game.game_id, pid: 0,
    };
    try {
      await writeFile(activeFile(record.playthrough_id), record.session_id, { flag: "wx" });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const id = await readFile(activeFile(record.playthrough_id), "utf8");
      throw new Error(`This playthrough already has session ${id}. Use that session or close it before reopening.`);
    }
    let child: ChildProcess | undefined;
    try {
      const binary = await provision(directory);
      if (gbaBios) {
        const firmware = join(dirname(binary), "Firmware");
        await mkdir(firmware, { recursive: true });
        await copyFile(gbaBios, join(firmware, basename(gbaBios)));
      }
      const logPath = join(sessionRoot, `${record.session_id}.log`);
      const log = await open(logPath, "a");
      try {
        child = spawn(binary, ["--doNotSaveSettings", bridgeScript, rom], {
          cwd: directory,
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          env: {
            ...process.env,
            // Use a silent SDL device. MesenCE's --noAudio switch disables video.
            SDL_AUDIODRIVER: "dummy",
            MESEN_MCP_SESSION: record.session_id,
            MESEN_MCP_ENDPOINT: endpointFile(record.session_id),
            MESEN_MCP_MODE: playback.mode,
            MESEN_MCP_SPEED: String(playback.speed),
          },
        });
        await new Promise<void>((resolve, reject) => {
          child!.once("spawn", resolve);
          child!.once("error", reject);
        });
        child.unref();
        record.pid = child.pid!;
      } finally {
        await log.close();
      }
      await writeFile(sessionFile(record.session_id), JSON.stringify(record), { flag: "wx" });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && alive(record.pid)) {
        try {
          await access(endpointFile(record.session_id));
          return await status(record.session_id);
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
        }
        await delay(100);
      }
      throw new Error(`The isolated Mesen window did not start its bridge. See ${logPath}.`);
    } catch (error) {
      child?.kill("SIGINT");
      await forget(record);
      throw error;
    }
  }

  async function closeGame(id: string) {
    const record = await getSession(id);
    const recentGame = join(
      playthroughDir(record.playthrough_id), "Mesen.app", "Contents", "MacOS", "RecentGames",
      `${basename(record.game_id, extname(record.game_id))}.rgd`,
    );
    if (alive(record.pid)) {
      await status(id);
      await rm(recentGame, { force: true });
      await call(id, "QUIT");
      // The native core creates this file after flushing battery saves.
      // Quit through a signal after the flush to avoid the macOS Lua window teardown crash.
      const stopDeadline = Date.now() + 8_000;
      while (true) {
        if (await stat(recentGame).catch((error: unknown) => {
          if (hasCode(error, "ENOENT")) return undefined;
          throw error;
        })) break;
        if (!alive(record.pid) || Date.now() >= stopDeadline) {
          throw new Error("Mesen did not confirm that its in-game saves were flushed.");
        }
        await delay(50);
      }
      process.kill(record.pid, "SIGINT");
      const deadline = Date.now() + 8_000;
      while (alive(record.pid) && Date.now() < deadline) await delay(100);
      if (alive(record.pid)) throw new Error("Mesen did not close. Close the managed window, then call close_game to clear the session.");
    }
    await rm(recentGame, { force: true });
    await forget(record);
    return { session_id: id, playthrough_id: record.playthrough_id, closed: true };
  }

  return {
    listGames,
    async listPlaythroughs() {
      return Promise.all((await entries(playthroughRoot)).filter((entry) => entry.isDirectory() && uuid.test(entry.name)).map((entry) => getPlaythrough(entry.name)));
    },
    async listSessions() {
      const files = (await entries(sessionRoot)).filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
      return Promise.all(files.map(async ({ name }) => {
        const { pid, ...record } = await getSession(name.slice(0, -5));
        return { ...record, running: alive(pid) };
      }));
    },
    openGame, closeGame, status,
    async look(id: string) { return observation(await call(id, "LOOK")); },
    async act(id: string, controller: number, buttons: string[], frames: number) {
      const fields = await call(id, "ACT", controller - 1, frames, buttons.join(","));
      return {
        ...observation(fields), controller, buttons, held_frames: Number(fields[2]),
        release_frames: Number(fields[3]), input_polls: Number(fields[4]),
        matched_input_polls: Number(fields[5]), started_frame: Number(fields[6]),
      };
    },
    async playback(id: string, playback: Playback) {
      await call(id, "PLAYBACK", playback.mode, playback.speed);
      return status(id);
    },
    async memoryRegions(id: string) {
      const [list] = await call(id, "REGIONS");
      return list.split(",").filter(Boolean).map((entry) => {
        const [region, size] = entry.split(":");
        return { region, size: Number(size) };
      });
    },
    async readMemory(id: string, region: string, address: number, length: number) {
      const [frame, hex] = await call(id, "READ", region, address, length);
      return { frame: Number(frame), region, address, length, hex };
    },
    async saveState(id: string, name: string, replace: boolean) {
      const record = await getSession(id);
      const [frame, encoded] = await call(id, "SAVE");
      if (!encoded) throw new Error("Mesen returned an empty checkpoint.");
      return { frame: Number(frame), name: await saves(record.playthrough_id).save(name, Buffer.from(encoded, "base64"), replace) };
    },
    async listSaveStates(selection: { session_id?: string; playthrough_id?: string }) {
      const id = selection.session_id ? (await getSession(selection.session_id)).playthrough_id : selection.playthrough_id!;
      await getPlaythrough(id);
      return { playthrough_id: id, checkpoints: await saves(id).list() };
    },
    async loadState(id: string, name: string) {
      const record = await getSession(id);
      const state = await saves(record.playthrough_id).load(name);
      return observation(await call(id, "LOAD", state.toString("base64")));
    },
    async resetGame(id: string) { return observation(await call(id, "RESET")); },
  };
}
