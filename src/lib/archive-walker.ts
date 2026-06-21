import "server-only";
import AdmZip from "adm-zip";
import * as tar from "tar";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tools for unpacking a GitLab repo archive and reading files back out
 * without paying per-file GitLab API costs. The contract:
 *
 *   1. Caller hands us the archive bytes (zip / tar.gz / tar) from
 *      `getRepositoryArchive`, along with the format that worked.
 *   2. We extract to a unique tmpdir and identify the single top-level
 *      folder GitLab adds (e.g. `webileapps-foo-abc123/`).
 *   3. Caller reads files via the helpers below using PROJECT-RELATIVE
 *      paths (e.g. "src/foo.ts"). The tmpdir prefix is hidden.
 *   4. Caller MUST eventually call `cleanupExtractedRepo()` so we don't
 *      leak disk on every scan.
 *
 * We support `zip` (fastest, sync extraction via adm-zip), `tar.gz`,
 * and `tar` (uncompressed). The two tar variants share a code path —
 * node-tar auto-detects gzip vs raw tar streams, so they're identical
 * from the dispatcher's point of view.
 */

export type ArchiveFormat = "zip" | "tar.gz" | "tar";

export type ExtractedRepo = {
  /** Absolute path of the project root inside the tmpdir (after stripping the GitLab wrapper folder). */
  rootDir: string;
  /** Absolute path of the parent tmpdir we created (for cleanup). */
  tmpDir: string;
  /** Files at the project root (recursively), relative to `rootDir`, normalized to forward slashes. */
  files: string[];
  /** Total bytes on disk (best-effort sum). */
  totalBytes: number;
};

export type ExtractOpts = {
  /** Refuse to extract more than this many bytes total. Default 250 MB. */
  maxTotalBytes?: number;
  /** Refuse to read individual files larger than this. Default 5 MB. */
  maxFileBytes?: number;
};

/**
 * Decode a GitLab repo archive into a fresh tmpdir. Strips the single
 * top-level folder GitLab wraps every archive in. Dispatches by `format`:
 *   - `zip` → adm-zip (sync, fast).
 *   - `tar.gz` / `tar` → node-tar via a sidecar file. node-tar
 *     auto-detects whether the stream is gzipped, so the same path
 *     handles both.
 */
export async function extractRepoArchive(
  archiveBytes: Buffer,
  format: ArchiveFormat,
  opts?: ExtractOpts
): Promise<ExtractedRepo> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-analyzer-scan-"));
  try {
    if (format === "zip") {
      extractZipInto(archiveBytes, tmpDir, opts);
    } else {
      await extractTarInto(archiveBytes, tmpDir, format);
    }
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }

  // Detect the single top-level folder GitLab wraps everything in.
  const topLevels = fs
    .readdirSync(tmpDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const rootName = topLevels[0];
  if (!rootName) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error("Archive contains no top-level directory");
  }
  const rootDir = path.join(tmpDir, rootName);

  // Walk the extracted tree and build a flat file list + on-disk size.
  const maxTotal = opts?.maxTotalBytes ?? 250 * 1024 * 1024;
  const files: string[] = [];
  let totalBytes = 0;

  function walk(dir: string, rel: string): void {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const abs = path.join(dir, d.name);
      const next = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        walk(abs, next);
      } else if (d.isFile()) {
        try {
          const stat = fs.statSync(abs);
          totalBytes += stat.size;
          if (totalBytes > maxTotal) {
            throw new Error(
              `Extracted size ${totalBytes} exceeds maxTotalBytes ${maxTotal}`
            );
          }
          files.push(next);
        } catch (e) {
          // Re-throw the size-cap error; ignore unreadable individual entries.
          if ((e as Error).message?.startsWith("Extracted size")) throw e;
        }
      }
    }
  }
  try {
    walk(rootDir, "");
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }

  return { rootDir, tmpDir, files, totalBytes };
}

function extractZipInto(
  zipBytes: Buffer,
  tmpDir: string,
  opts?: ExtractOpts
): void {
  const maxTotal = opts?.maxTotalBytes ?? 250 * 1024 * 1024;
  const zip = new AdmZip(zipBytes);
  const entries = zip.getEntries();

  // Zip-bomb guard: refuse if uncompressed sum exceeds the cap.
  let totalUncompressed = 0;
  for (const e of entries) {
    if (!e.isDirectory) totalUncompressed += e.header.size;
  }
  if (totalUncompressed > maxTotal) {
    throw new Error(
      `Archive uncompressed size ${totalUncompressed} exceeds maxTotalBytes ${maxTotal}`
    );
  }
  zip.extractAllTo(tmpDir, /* overwrite */ true);
}

async function extractTarInto(
  tarballBytes: Buffer,
  tmpDir: string,
  format: "tar.gz" | "tar"
): Promise<void> {
  // node-tar prefers a file path (it does its own streaming + checksum
  // handling that way). We write the buffer to a sidecar file with a
  // matching extension as a hint, then extract, then delete the sidecar.
  // node-tar inspects the magic bytes and auto-decompresses gzip if
  // present, so the sidecar extension is informational.
  const ext = format === "tar.gz" ? "tar.gz" : "tar";
  const tarPath = path.join(tmpDir, `__archive.${ext}`);
  fs.writeFileSync(tarPath, tarballBytes);
  try {
    await tar.x({
      file: tarPath,
      cwd: tmpDir,
      // node-tar refuses absolute paths and `..` segments by default — good.
    });
  } finally {
    try {
      fs.unlinkSync(tarPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read a single file's contents back out of the extracted repo. The
 * `relPath` is relative to the project root (e.g. "src/foo.ts"), NOT
 * to the tmpdir. Files larger than `maxFileBytes` return null —
 * callers should treat that as "too big to inspect".
 */
export function readRepoFile(
  repo: ExtractedRepo,
  relPath: string,
  maxFileBytes: number = 1 * 1024 * 1024
): string | null {
  // Prevent path-escape attacks: resolve and check the result is still
  // inside rootDir.
  const target = path.resolve(repo.rootDir, relPath);
  if (!target.startsWith(repo.rootDir + path.sep)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > maxFileBytes) return null;

  try {
    return fs.readFileSync(target, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Best-effort: count newlines in a file without loading it into a
 * single string. Used by content rules to flag very-long files.
 */
export function countLines(repo: ExtractedRepo, relPath: string): number {
  const target = path.resolve(repo.rootDir, relPath);
  if (!target.startsWith(repo.rootDir + path.sep)) return 0;

  try {
    const buf = fs.readFileSync(target);
    let lines = 0;
    for (let i = 0; i < buf.length; i += 1) if (buf[i] === 10) lines += 1;
    // file ending without final newline still counts as 1 line
    if (buf.length > 0 && buf[buf.length - 1] !== 10) lines += 1;
    return lines;
  } catch {
    return 0;
  }
}

/** Always-callable cleanup. Safe to call twice. Never throws. */
export function cleanupExtractedRepo(repo: ExtractedRepo | null): void {
  if (!repo) return;
  let removedBytes = 0;
  try {
    // Stat best-effort so we can report freed space in logs.
    try {
      removedBytes = repo.totalBytes;
    } catch {
      /* ignore */
    }
    fs.rmSync(repo.tmpDir, { recursive: true, force: true });
    console.log(
      `[archive-walker] cleanup ok tmpDir=${repo.tmpDir} freed_bytes=${removedBytes}`
    );
  } catch (e) {
    console.warn(
      `[archive-walker] cleanup_failed tmpDir=${repo.tmpDir} error=${(e as Error).message?.slice(0, 120)}`
    );
  }
}

/**
 * Sweep any orphaned `mr-analyzer-scan-*` tmpdirs that were left behind
 * by previously crashed / SIGKILL'd processes. Safe to call concurrently
 * with active scans — we only delete dirs older than `olderThanMs`
 * (default 30 min) so an in-flight scan in another process is never
 * killed mid-flight.
 *
 * Returns the count of dirs removed and the bytes freed. Called
 * automatically at the start of every scan as a tax-of-success.
 */
export function sweepOrphanedScanDirs(
  olderThanMs: number = 30 * 60 * 1000
): { removed: number; bytesFreed: number } {
  const baseTmp = os.tmpdir();
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  let bytesFreed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(baseTmp);
  } catch {
    return { removed: 0, bytesFreed: 0 };
  }
  for (const name of entries) {
    if (!name.startsWith("mr-analyzer-scan-")) continue;
    const full = path.join(baseTmp, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (stat.mtimeMs > cutoff) continue;
    // Best-effort size accounting; failures are not fatal.
    try {
      const sz = dirSize(full);
      bytesFreed += sz;
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* ignore — locked or already gone */
    }
  }
  if (removed > 0) {
    console.log(
      `[archive-walker] swept_orphaned dirs=${removed} bytes_freed=${bytesFreed} older_than_ms=${olderThanMs}`
    );
  }
  return { removed, bytesFreed };
}

function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of entries) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      total += dirSize(full);
    } else if (d.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}
