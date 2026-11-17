import { Bash, InMemoryFs } from "just-bash/browser";

type Entry = { path: string; kind: "directory" } | { path: string; kind: "file"; data: string };
interface Version { revision: number; entries: Entry[] }

/** Immutable virtual files only. These versions never represent external side effects. */
export class WorkspaceStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS workspace_versions(revision INTEGER PRIMARY KEY AUTOINCREMENT, monitor TEXT NOT NULL, parent INTEGER, entries TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_heads(monitor TEXT PRIMARY KEY, revision INTEGER NOT NULL);`);
  }

  head(monitor: string): Version {
    const row = this.storage.sql.exec<{ revision: number; entries: string }>("SELECT v.revision,v.entries FROM workspace_heads h JOIN workspace_versions v ON h.revision=v.revision WHERE h.monitor=?", monitor).toArray()[0];
    if (row) return { revision: row.revision, entries: JSON.parse(row.entries) };
    return { revision: 0, entries: [] };
  }

  history(monitor: string): object[] {
    return this.storage.sql.exec("SELECT revision,parent,reason,at FROM workspace_versions WHERE monitor=? ORDER BY revision DESC LIMIT 64", monitor).toArray();
  }

  private commit(monitor: string, expected: number, entries: Entry[], reason: string): number {
    return this.storage.transactionSync(() => {
      if (this.head(monitor).revision !== expected) throw new Error("workspace version conflict");
      const count = this.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM workspace_versions WHERE monitor=?", monitor).one().n;
      if (count >= 64) throw new Error("workspace version quota reached; retain/export before reconfiguring");
      const row = this.storage.sql.exec<{ revision: number }>("INSERT INTO workspace_versions(monitor,parent,entries,reason,at) VALUES(?,?,?,?,?) RETURNING revision", monitor, expected || null, JSON.stringify(entries), reason, Date.now()).one();
      this.storage.sql.exec("INSERT OR REPLACE INTO workspace_heads VALUES(?,?)", monitor, row.revision);
      return row.revision;
    });
  }

  restore(monitor: string, revision: number, expected: number): { revision: number; restored_from: number } {
    const row = this.storage.sql.exec<{ entries: string }>("SELECT entries FROM workspace_versions WHERE monitor=? AND revision=?", monitor, revision).toArray()[0];
    if (!row) throw new Error("workspace version not found");
    return { revision: this.commit(monitor, expected, JSON.parse(row.entries), `restore:${revision}`), restored_from: revision };
  }

  async shell(monitor: string, command: string, signal: AbortSignal): Promise<unknown> {
    const before = this.head(monitor);
    const fs = new InMemoryFs({}, { maxTotalBytes: 262144 });
    await fs.mkdir("/workspace", { recursive: true });
    for (const entry of before.entries) {
      if (entry.kind === "directory") await fs.mkdir(entry.path, { recursive: true });
      else {
        await fs.mkdir(entry.path.slice(0, entry.path.lastIndexOf("/")), { recursive: true });
        await fs.writeFile(entry.path, Uint8Array.from(atob(entry.data), c => c.charCodeAt(0)));
      }
    }
    const bash = new Bash({
      fs, cwd: "/workspace", env: {}, executionLimitProfile: "hardened",
      // No network, JS/Python, archives, external binaries or host filesystem adapters.
      commands: ["cat", "cp", "ls", "mkdir", "mv", "rm", "rmdir", "stat", "touch", "awk", "base64", "cut", "diff", "grep", "head", "jq", "nl", "printf", "rg", "sed", "sha256sum", "sort", "tail", "tr", "uniq", "wc", "basename", "dirname", "echo", "env", "find", "pwd", "seq", "true", "false", "tee"],
      executionLimits: {
        maxExecutionTimeMs: 2000, maxSourceBytes: 8192, maxCommandCount: 256,
        maxLoopIterations: 256, maxCallDepth: 16, maxOutputSize: 8192,
        maxFileSystemBytes: 262144, maxStringLength: 131072, maxArrayElements: 1024,
        maxLiveBytes: 1048576, maxInputBytes: 262144, maxWorkUnits: 100000,
        maxTraversalEntries: 512, maxTraversalWork: 2048,
      },
    });
    const result = await bash.exec(command, { replaceEnv: true, env: {}, signal });
    signal.throwIfAborted();
    if (result.exitCode !== 0) return { platform: "virtual-shell", exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr, revision: before.revision, committed: false };
    const entries: Entry[] = [];
    let size = 0;
    for (const path of fs.getAllPaths().sort()) {
      if (!path.startsWith("/workspace/")) continue;
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink) throw new Error("workspace snapshots do not permit symlinks");
      if (stat.isDirectory) entries.push({ path, kind: "directory" });
      else {
        const bytes = await fs.readFileBuffer(path);
        size += bytes.length;
        if (size > 131072) throw new Error("workspace byte quota reached");
        entries.push({ path, kind: "file", data: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join("")) });
      }
      if (entries.length > 128) throw new Error("workspace file quota reached");
    }
    const changed = JSON.stringify(entries) !== JSON.stringify(before.entries);
    const revision = changed ? this.commit(monitor, before.revision, entries, "virtual-shell") : before.revision;
    return { platform: "virtual-shell", exit_code: 0, stdout: result.stdout, stderr: result.stderr, revision, committed: changed };
  }
}
