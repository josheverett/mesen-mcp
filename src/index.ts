import { McpServer, type JSONObject, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { configFromEnvironment, createSessions } from "./sessions.ts";

const id = z.uuid();
const checkpoint = z.string().min(1).max(64);
const session = { session_id: id };
const playback = {
  mode: z.enum(["stepped", "continuous"]).default("stepped"),
  speed: z.number().min(0.25).max(4).default(1),
};
const button = z.string().trim().toLowerCase().regex(/^[a-z0-9]+$/);
type Content = { type: "text"; text: string } | { type: "image"; mimeType: "image/png"; data: string };

function buildServer() {
  const server = new McpServer({ name: "mesen-mcp", version: "0.1.0" });
  const games = createSessions(configFromEnvironment());

  function tool<T>(
    name: string,
    description: string,
    inputSchema: StandardSchemaWithJSON<unknown, T>,
    handle: (input: T) => Promise<JSONObject>,
  ) {
    server.registerTool(name, { description, inputSchema }, async (input) => {
      try {
        const { png, ...structuredContent } = await handle(input);
        const content: Content[] = [{ type: "text", text: JSON.stringify(structuredContent) }];
        if (typeof png === "string") content.push({ type: "image", mimeType: "image/png", data: png });
        return { content, structuredContent };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    });
  }

  tool("list_games", "List the configured ROMs and their game IDs.", z.strictObject({}),
    async () => ({ games: await games.listGames() }));
  tool("list_playthroughs", "List saved playthrough IDs, including games that are closed.", z.strictObject({}),
    async () => ({ playthroughs: await games.listPlaythroughs() }));
  tool("list_sessions", "List managed Mesen sessions and whether their processes are still running.", z.strictObject({}),
    async () => ({ sessions: await games.listSessions() }));
  tool("open_game", "Open a visible Mesen window. Give a game_id for a fresh playthrough or a playthrough_id to reuse its saves. Returns a session_id.", z.strictObject({
    game_id: z.string().min(1).optional(),
    playthrough_id: id.optional(),
    ...playback,
  }).refine((value) => !!value.game_id !== !!value.playthrough_id, "Provide exactly one of game_id or playthrough_id."),
  ({ game_id, playthrough_id, mode, speed }) => games.openGame({ game_id, playthrough_id }, { mode, speed }));
  tool("status", "Get the session's ROM, live frame, native FPS, playback settings, and connected controllers.", z.strictObject(session),
    ({ session_id }) => games.status(session_id));
  tool("look", "Return a PNG of the current game screen and its frame without advancing a stepped session.", z.strictObject(session),
    ({ session_id }) => games.look(session_id));
  tool("act", "Hold buttons for the given emulated frames, release them, and return a PNG. An empty button list waits. In continuous play, two agents sharing a session can hold inputs on different controllers at the same time.", z.strictObject({
    ...session,
    controller: z.int().min(1).max(2).default(1),
    buttons: z.array(button).max(12),
    frames: z.int().min(1).max(600),
  }), ({ session_id, controller, buttons, frames }) => games.act(session_id, controller, [...new Set(buttons)], frames));
  tool("set_playback", "Choose frame stepping or continuous play. Speed is a multiplier of native FPS during continuous play.", z.strictObject({ ...session, ...playback }),
    ({ session_id, mode, speed }) => games.playback(session_id, { mode, speed }));
  tool("list_memory_regions", "List readable memory region names and byte sizes for the current console.", z.strictObject(session),
    async ({ session_id }) => ({ regions: await games.memoryRegions(session_id) }));
  tool("read_memory", "Read up to 4096 bytes without memory-mapped I/O side effects. Returns hexadecimal bytes.", z.strictObject({
    ...session,
    region: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
    address: z.int().min(0).max(0x7fffffff),
    length: z.int().min(1).max(4096),
  }), ({ session_id, region, address, length }) => games.readMemory(session_id, region, address, length));
  tool("save_state", "Save a named checkpoint for this playthrough. A name is case-insensitive. Existing names require replace: true.", z.strictObject({
    ...session, name: checkpoint, replace: z.boolean().default(false),
  }), ({ session_id, name, replace }) => games.saveState(session_id, name, replace));
  tool("list_save_states", "List named checkpoints for a live session or a stored playthrough. Provide exactly one ID.", z.strictObject({
    session_id: id.optional(), playthrough_id: id.optional(),
  }).refine((value) => !!value.session_id !== !!value.playthrough_id, "Provide exactly one of session_id or playthrough_id."),
  (selection) => games.listSaveStates(selection));
  tool("load_state", "Restore a named checkpoint in the running playthrough and return the new screen.", z.strictObject({
    ...session, name: checkpoint,
  }), ({ session_id, name }) => games.loadState(session_id, name));
  tool("reset_game", "Reset the emulated console in the current session and return its screen.", z.strictObject(session),
    ({ session_id }) => games.resetGame(session_id));
  tool("close_game", "Quit the selected managed Mesen window and retain its playthrough. Also clears a session record after its process has exited.", z.strictObject(session),
    ({ session_id }) => games.closeGame(session_id));
  return server;
}

serveStdio(buildServer);
