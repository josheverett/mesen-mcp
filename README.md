# Mesen MCP

A local stdio MCP server that opens visible MesenCE windows on macOS. One
running game has one session ID. Two agents can use the same session ID and
different controllers, or open independent sessions of the same ROM.

## Setup

Use Node 24+, pnpm, and the macOS build of [MesenCE](https://github.com/nesdev-org/MesenCE/releases).

```sh
git clone https://github.com/josheverett/mesen-mcp.git
cd mesen-mcp
pnpm install --frozen-lockfile
```

Configure your MCP client to launch this command (use absolute paths):

```json
{
  "command": "node",
  "args": ["/absolute/path/to/mesen-mcp/src/index.ts"],
  "env": {
    "MESEN_ROM_DIR": "/path/to/roms",
    "MESEN_MCP_DATA_DIR": "/path/to/mesen-mcp-data"
  }
}
```

`MESEN_ROM_DIR` defaults to `~/Roms`. The server lists supported, uncompressed
ROM files under that directory. `MESEN_MCP_DATA_DIR` defaults to
`~/.mesen-mcp`. Use the same data and ROM paths in both clients to share
sessions. Set `MESEN_BIN` to the executable inside your Mesen `.app` if it is
installed somewhere other than `/Applications/Mesen.app/Contents/MacOS/Mesen`.

For Game Boy Advance, put your 16,384-byte `gba_bios.bin` in
`$MESEN_MCP_DATA_DIR/Firmware` or set `MESEN_FIRMWARE_DIR` to the directory
that already contains it. The server checks for it before launching Mesen
and copies it into each managed GBA profile automatically.

On the first launch of a playthrough, the server creates a portable copy of
the app under the data directory. That copy has a private Mesen profile and
in-game save directory. Mesen loads the Lua bridge in the managed window with
script I/O and networking enabled for that profile. Node communicates with the
bridge over a loopback socket. Each playthrough has its own on-disk checkpoints
and can be resumed even after its window is closed. Managed windows send
audio to SDL's dummy driver so they never open a system audio output stream.
MesenCE's `--noAudio` switch can disable the native video renderer instead.

## Tools

| Tools | Use |
| --- | --- |
| `list_games`, `list_playthroughs`, `list_sessions` | Find ROMs, saved playthroughs, or existing windows. |
| `open_game`, `status`, `close_game` | Open a new visible session with a `game_id` or reopen a `playthrough_id`. Then use the returned `session_id` to inspect or quit that window. |
| `look`, `act`, `set_playback`, `reset_game` | Get a PNG, hold controller buttons for emulated frames, change the clock, or reset the current console. |
| `list_memory_regions`, `read_memory` | Discover the current console's memory regions and read bounded ranges as hexadecimal bytes. |
| `save_state`, `list_save_states`, `load_state` | Save, discover, and restore named checkpoints. To list checkpoints after closing a game, pass its playthrough ID. |

An omitted playback mode defaults to `stepped`. In that mode `look` leaves the
clock alone, and `act({ buttons: [], frames: 60, ... })` can advance through
an intro. Each nonempty hold has one neutral release frame. The first screenshot
may be blank while the ROM boots.

For continuous play, pass `mode: "continuous"` to `open_game` or
`set_playback`. Set `speed` between 0.25× and 4×. Lua paces frames from
Mesen's reported native rate. The game continues between tool calls. Share the
session ID and tell each agent its controller number. Calls to `act` on ports 1
and 2 can overlap. `status` lists connected controllers and supported buttons.
A second hold on a busy controller returns an error. Use the MCP playback
control while automating a window, since pausing through Mesen's own UI can
pause the bridge's frame callbacks as well.

Checkpoint names are trimmed and matched case-insensitively within a
playthrough. An existing name returns `name_taken` unless the caller sets
`replace: true`. Creating or restoring a checkpoint from a stepped session
runs through Mesen's main CPU callback and may advance a frame. Use
`list_playthroughs` to recover a playthrough ID after a restart.

Managed windows can outlive the MCP process. A restarted client can reuse a
live session ID. If Mesen itself exited, `close_game` clears that session record.
Then reopen the playthrough and explicitly load a checkpoint. If a controller
call timed out, inspect the game before repeating it.

Use `close_game` to quit a managed window. It stops the console, waits for
Mesen's temporary recent-game file to confirm the native save flush, then
ends the process and removes that file. On the tested macOS MesenCE build,
the system Quit action can crash while tearing down a command-line Lua
script window.

Native video or movie recording, decoded graphics inspection, numbered GUI
save slots, and network multiplayer are outside v1.

## Verification

```sh
pnpm typecheck
pnpm test
```

The two automated checks cover checkpoint naming and missing GBA firmware.
For a live smoke test, use a
temporary data directory and test ROMs, then open a continuous SNES session
from one MCP client and send overlapping holds from two clients using different
controller numbers. Compare `started_frame` and `frame` from both receipts and
confirm that `matched_input_polls` is nonzero on both ports.

The macOS smoke test used Secret of Mana and Pokémon FireRed in parallel. Both
SNES ports received 90 inputs on the same 90 frames. In a 650 ms sample,
continuous play advanced 39 frames at 1× and 78 at 2×. The test also exercised
stepping, PNG capture, read-only memory, checkpoint save and restore, reset,
reconnection after an MCP process restart, and native save files on close.
