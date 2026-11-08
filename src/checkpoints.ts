import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function normalize(name: string): string {
  const normalized = name.trim().toLowerCase().normalize("NFC");
  if (!normalized || Buffer.byteLength(normalized) > 64 || /\p{Cc}/u.test(normalized)) {
    throw new Error("Checkpoint names must contain 1–64 UTF-8 bytes without control characters.");
  }
  return normalized;
}

export function checkpointStore(directory: string) {
  const filename = (name: string) => join(directory, `${encodeURIComponent(name)}.mss`);
  return {
    async save(name: string, data: Buffer, replace = false): Promise<string> {
      const key = normalize(name);
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, data, { flag: "wx" });
        if (replace) await rename(temporary, filename(key));
        else await link(temporary, filename(key));
      } catch (error) {
        if (hasCode(error, "EEXIST")) throw new Error(`name_taken: ${key}. Choose another name or pass replace: true.`);
        throw error;
      } finally {
        await rm(temporary, { force: true });
      }
      return key;
    },
    async load(name: string): Promise<Buffer> {
      const key = normalize(name);
      try {
        return await readFile(filename(key));
      } catch (error) {
        if (hasCode(error, "ENOENT")) throw new Error(`Unknown checkpoint: ${key}`);
        throw error;
      }
    },
    async list(): Promise<string[]> {
      const entries = await readdir(directory).catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) return [];
        throw error;
      });
      return entries.filter((entry) => entry.endsWith(".mss")).map((entry) => decodeURIComponent(entry.slice(0, -4))).sort();
    },
  };
}
