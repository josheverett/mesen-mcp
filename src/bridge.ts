import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";

export type Playback = { mode: "stepped" | "continuous"; speed: number };
export type Observation = { frame: number; png: string };

export async function bridgePort(endpointFile: string): Promise<number> {
  const port = Number((await readFile(endpointFile, "utf8")).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Mesen bridge port.");
  return port;
}

export function bridgeCall(port: number, sessionId: string, command: string, ...args: (string | number)[]): Promise<string[]> {
  const fields = [sessionId, command, ...args].map(String);
  if (fields.some((field) => /[\t\r\n]/.test(field))) throw new Error("Invalid bridge argument.");
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(command === "ACT" ? 60_000 : 5_000);
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.once("connect", () => socket.write(`${fields.join("\t")}\n`));
    socket.once("error", fail);
    socket.once("timeout", () => fail(new Error(`Mesen did not answer ${command}; inspect the session before repeating an input.`)));
    socket.once("end", () => fail(new Error(`Mesen closed the connection during ${command}.`)));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return fail(new Error("Mesen bridge response is too large."));
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) return;
      const [status, ...parts] = buffer.slice(0, lineEnd).split("\t");
      socket.destroy();
      if (status === "OK") resolve(parts);
      else reject(new Error(status === "ERR" ? Buffer.from(parts[0] ?? "", "base64").toString("utf8") : "Invalid Mesen bridge response."));
    });
  });
}

export function observation(fields: string[]): Observation {
  const [frame, png] = fields;
  if (!Number.isSafeInteger(Number(frame)) || !png?.startsWith("iVBORw0KGgo")) throw new Error("Mesen did not return a PNG screenshot.");
  return { frame: Number(frame), png };
}
