import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { StrategySession, StrategyVersionArtifact } from "./types.js";

const SAFE_ID = /^[a-zA-Z0-9_-]{1,96}$/;

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must contain only letters, digits, '_' or '-'.`);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export class FileStrategySessionStore {
  readonly rootDirectory: string;

  constructor(rootDirectory = "data/strategy-sessions") {
    this.rootDirectory = resolve(rootDirectory);
  }

  private sessionPath(sessionId: string): string {
    assertSafeId(sessionId, "sessionId");
    return resolve(this.rootDirectory, sessionId, "session.json");
  }

  private versionPath(sessionId: string, versionId: string): string {
    assertSafeId(sessionId, "sessionId");
    assertSafeId(versionId, "versionId");
    return resolve(this.rootDirectory, sessionId, "versions", `${versionId}.json`);
  }

  async loadSession(sessionId: string): Promise<StrategySession> {
    return JSON.parse(await readFile(this.sessionPath(sessionId), "utf8")) as StrategySession;
  }

  async loadVersion(sessionId: string, versionId: string): Promise<StrategyVersionArtifact> {
    return JSON.parse(await readFile(this.versionPath(sessionId, versionId), "utf8")) as StrategyVersionArtifact;
  }

  async loadLatestVersion(sessionId: string): Promise<StrategyVersionArtifact> {
    const session = await this.loadSession(sessionId);
    const versionId = session.versionIds.at(-1);
    if (!versionId) throw new Error(`Strategy session '${sessionId}' has no versions.`);
    return this.loadVersion(sessionId, versionId);
  }

  async saveNewSession(session: StrategySession, version: StrategyVersionArtifact): Promise<void> {
    const sessionPath = this.sessionPath(session.sessionId);
    const versionPath = this.versionPath(session.sessionId, version.versionId);
    await mkdir(dirname(versionPath), { recursive: true });
    await writeFile(versionPath, `${JSON.stringify(version, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }

  async appendVersion(version: StrategyVersionArtifact): Promise<StrategySession> {
    const session = await this.loadSession(version.sessionId);
    if (version.ordinal !== session.versionIds.length + 1) {
      throw new Error(`Version ordinal ${version.ordinal} does not follow session ordinal ${session.versionIds.length}.`);
    }
    const versionPath = this.versionPath(version.sessionId, version.versionId);
    await mkdir(dirname(versionPath), { recursive: true });
    await writeFile(versionPath, `${JSON.stringify(version, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    const updated: StrategySession = {
      ...session,
      updatedAt: version.createdAt,
      versionIds: [...session.versionIds, version.versionId],
    };
    await writeJsonAtomic(this.sessionPath(version.sessionId), updated);
    return updated;
  }
}
