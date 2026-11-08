-- One loopback connection carries one tab-delimited command. Binary results
-- use base64. Only this Mesen process can advance its clock or poll its pads.
local socket = require("socket.core")
local mime = require("mime.core")
local session = assert(os.getenv("MESEN_MCP_SESSION"))
local endpoint = assert(os.getenv("MESEN_MCP_ENDPOINT"))
local mode = assert(os.getenv("MESEN_MCP_MODE"))
local speed = assert(tonumber(os.getenv("MESEN_MCP_SPEED")))
local listener = assert(socket.tcp())
assert(listener:bind("127.0.0.1", 0))
assert(listener:listen(16))
listener:settimeout(0)

local clients, holds, pads = {}, {}, {}
local frame, fps, rom, nextFrameAt = 0
local stateOperation, resetPending, closing
local maxLine = 16 * 1024 * 1024

local function b64(bytes)
  return (mime.b64(bytes):gsub("%s", ""))
end

local function fields(line)
  local values = {}
  for value in (line .. "\t"):gmatch("([^\t]*)\t") do values[#values + 1] = value end
  return values
end

local function reply(peer, ...)
  peer.output = table.concat({ ... }, "\t") .. "\n"
  peer.sent = 0
end

local function failure(peer, reason)
  reply(peer, "ERR", b64(tostring(reason)))
end

local function drop(connection)
  clients[connection] = nil
  connection:close()
end

local function ready()
  fps = assert(emu.getState().fps, "Mesen did not report its native frame rate")
  rom = emu.getRomInfo().path
  nextFrameAt = socket.gettime()
  for port = 0, 1 do
    local names, keys = {}, {}
    for key, value in pairs(emu.getInput(port)) do
      if type(value) == "boolean" then
        keys[key] = true
        names[#names + 1] = key
      end
    end
    table.sort(names)
    if #names > 0 then pads[port] = { keys = keys, names = table.concat(names, ",") } end
  end
  local _, port = listener:getsockname()
  local file = assert(io.open(endpoint .. ".tmp", "w"))
  assert(file:write(tostring(port)))
  assert(file:close())
  assert(os.rename(endpoint .. ".tmp", endpoint))
end

local function padNames(port)
  return pads[port] and pads[port].names or ""
end

local function screenshot()
  return b64(emu.takeScreenshot())
end

local function playback(nextMode, nextSpeed)
  assert(nextMode == "stepped" or nextMode == "continuous", "Invalid playback mode")
  assert(nextSpeed and nextSpeed >= 0.25 and nextSpeed <= 4, "Invalid playback speed")
  mode, speed = nextMode, nextSpeed
  nextFrameAt = socket.gettime()
end

local function requireIdle()
  assert(not stateOperation and not resetPending and not next(holds), "Wait for the current input or state operation to finish")
end

local function stateCommand(peer, operation, encoded)
  requireIdle()
  local state = { peer = peer, operation = operation }
  local callback
  callback = emu.addMemoryCallback(function()
    emu.removeMemoryCallback(callback, emu.callbackType.exec, 0, 0x0FFFFFFF)
    state.ok, state.result = pcall(function()
      if operation == "SAVE" then return b64(emu.createSavestate()) end
      local bytes = assert(mime.unb64(encoded), "Invalid checkpoint bytes")
      assert(emu.loadSavestate(bytes), "Mesen rejected the checkpoint")
    end)
    state.done = true
  end, emu.callbackType.exec, 0, 0x0FFFFFFF)
  stateOperation = state
  peer.busy = true
end

local function handle(peer, line)
  local args = fields(line)
  assert(args[1] == session, "Wrong Mesen session")
  assert(not closing, "This session is closing")
  local command = args[2]
  if command == "STATUS" then
    reply(peer, "OK", session, b64(rom), frame, fps, mode, speed, padNames(0), padNames(1))
  elseif command == "LOOK" then
    reply(peer, "OK", frame, screenshot())
  elseif command == "ACT" then
    local port, count = tonumber(args[3]), tonumber(args[4])
    local pad = assert(pads[port], "That controller is not connected")
    assert(count and count >= 1 and count <= 600 and count % 1 == 0, "Invalid frame count")
    assert(not stateOperation and not resetPending, "A state operation is in progress")
    assert(not holds[port], "That controller already has input in progress")
    assert(mode == "continuous" or not next(holds), "Frame stepping has one input action at a time")
    local input, pressed = {}, false
    for key in pairs(pad.keys) do input[key] = false end
    for key in args[5]:gmatch("[^,]+") do
      assert(pad.keys[key], "Unsupported button for this controller: " .. key)
      input[key], pressed = true, true
    end
    holds[port] = { peer = peer, started = frame, remaining = count, frames = count, input = input, pressed = pressed, polled = 0, matched = 0 }
    peer.busy = true
  elseif command == "PLAYBACK" then
    requireIdle()
    playback(args[3], tonumber(args[4]))
    reply(peer, "OK", mode, speed)
  elseif command == "REGIONS" then
    local regions = {}
    for name, kind in pairs(emu.memType) do
      if kind < 0x100 then
        local size = emu.getMemorySize(kind)
        if size > 0 then regions[#regions + 1] = name .. ":" .. size end
      end
    end
    table.sort(regions)
    reply(peer, "OK", table.concat(regions, ","))
  elseif command == "READ" then
    local kind = emu.memType[args[3]]
    local address, length = tonumber(args[4]), tonumber(args[5])
    assert(kind and kind < 0x100, "Unknown memory region")
    assert(address and address >= 0 and address % 1 == 0 and length and length >= 1 and length <= 4096 and length % 1 == 0, "Invalid read range")
    assert(address + length <= emu.getMemorySize(kind), "Read range exceeds the memory region")
    local bytes = {}
    for offset = 0, length - 1 do
      -- The high bit flag requests reads without memory-mapped I/O side effects.
      bytes[offset + 1] = string.format("%02x", emu.read(address + offset, kind | 0x100))
    end
    reply(peer, "OK", frame, table.concat(bytes))
  elseif command == "SAVE" or command == "LOAD" then
    stateCommand(peer, command, args[3])
  elseif command == "RESET" then
    requireIdle()
    emu.reset()
    resetPending = peer
    peer.busy = true
  elseif command == "QUIT" then
    requireIdle()
    closing = peer
    reply(peer, "OK")
  else
    error("Unknown bridge command")
  end
end

local function pump(timeout)
  local readers, writers = { listener }, {}
  for connection, peer in pairs(clients) do
    if peer.output then
      writers[#writers + 1] = connection
    elseif not peer.busy then
      readers[#readers + 1] = connection
    end
  end
  local readable, writable = socket.select(readers, writers, timeout)
  for _, connection in ipairs(readable) do
    if connection == listener then
      local client = listener:accept()
      if client then
        client:settimeout(0)
        clients[client] = { connection = client, partial = "" }
      end
    else
      local peer = clients[connection]
      local line, err, partial = connection:receive("*l", peer.partial)
      if #(line or partial or "") > maxLine then
        failure(peer, "Mesen bridge request is too large")
      elseif line then
        local ok, reason = pcall(handle, peer, line)
        if not ok then failure(peer, reason) end
      elseif err == "timeout" then
        peer.partial = partial
      else
        drop(connection)
      end
    end
  end
  for _, connection in ipairs(writable) do
    local peer = clients[connection]
    local last, err, partial = connection:send(peer.output, peer.sent + 1)
    if last or err ~= "timeout" then
      drop(connection)
    else
      peer.sent = partial
    end
  end
end

emu.addEventCallback(function()
  for port, hold in pairs(holds) do
    -- MesenCE 2.2.1 pads the C stack to four arguments before reading
    -- the port and subport. The physical port is therefore in slot three.
    emu.setInput(hold.input, port, port, 0)
    if not hold.releasing then
      hold.polled = hold.polled + 1
      local actual = emu.getInput(port)
      local matched = true
      for key, value in pairs(hold.input) do
        if actual[key] ~= value then matched = false; break end
      end
      if matched then hold.matched = hold.matched + 1 end
    end
  end
end, emu.eventType.inputPolled)

emu.addEventCallback(function()
  frame = frame + 1
  if frame == 1 then
    local ok, reason = pcall(ready)
    if not ok then
      io.stderr:write(tostring(reason) .. "\n")
      io.stderr:flush()
      error(reason)
    end
  end
  for port, hold in pairs(holds) do
    hold.remaining = hold.remaining - 1
    if hold.remaining == 0 then
      if hold.pressed and not hold.releasing then
        for key in pairs(hold.input) do hold.input[key] = false end
        hold.releasing, hold.remaining = true, 1
      else
        reply(hold.peer, "OK", frame, screenshot(), hold.frames, hold.releasing and 1 or 0, hold.polled, hold.matched, hold.started)
        holds[port] = nil
      end
    end
  end
  if stateOperation and stateOperation.done then
    local state = stateOperation
    stateOperation = nil
    if not state.ok then
      failure(state.peer, state.result)
    elseif state.operation == "SAVE" then
      reply(state.peer, "OK", frame, state.result)
    else
      reply(state.peer, "OK", frame, screenshot())
    end
  end
  if resetPending then
    reply(resetPending, "OK", frame, screenshot())
    resetPending = nil
  end

  if not closing and mode == "continuous" then
    local now = socket.gettime()
    nextFrameAt = math.max(now, nextFrameAt + 1 / (fps * speed))
    while not closing and mode == "continuous" and now < nextFrameAt do
      pump(nextFrameAt - now)
      now = socket.gettime()
    end
  end
  -- A stepped session keeps serving commands while its game clock is idle.
  while not closing and mode == "stepped" and not next(holds) and not stateOperation and not resetPending do
    pump(0.1)
  end
  pump(0)
  if closing and not clients[closing.connection] then
    emu.stop(0)
  end
end, emu.eventType.endFrame)

emu.addEventCallback(function()
  listener:close()
  for connection in pairs(clients) do drop(connection) end
  os.remove(endpoint)
end, emu.eventType.scriptEnded)
