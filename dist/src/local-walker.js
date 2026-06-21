"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.walkLocalDirectory = walkLocalDirectory;
exports.readLocalFile = readLocalFile;
exports.getLatestMtime = getLatestMtime;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const DEFAULT_EXCLUDE = new Set([
    "node_modules", "dist", "build", ".git", ".next", "coverage",
    ".turbo", "out", "__pycache__", ".pytest_cache", "vendor",
    ".gradle", ".mvn", "target", "Pods", ".yarn",
]);
function walkLocalDirectory(projectDir, config) {
    const rootDir = node_path_1.default.resolve(projectDir);
    const exclude = new Set([
        ...DEFAULT_EXCLUDE,
        ...(config.scan?.exclude ?? []),
    ]);
    const maxFileBytes = config.scan?.maxFileSizeBytes ?? 512 * 1024;
    const files = [];
    let totalBytes = 0;
    function walk(dir, prefix) {
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (exclude.has(entry.name))
                continue;
            if (entry.name.startsWith(".") && entry.name !== ".env.example" && entry.name !== ".editorconfig" && entry.name !== ".eslintrc.json" && entry.name !== ".eslintrc.js" && entry.name !== ".prettierrc" && entry.name !== ".prettierrc.json" && !entry.name.includes("gitlab-ci") && !entry.name.includes("github"))
                continue;
            const abs = node_path_1.default.join(dir, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(abs, rel);
            }
            else if (entry.isFile()) {
                try {
                    const stat = node_fs_1.default.statSync(abs);
                    if (stat.size <= maxFileBytes * 10) {
                        totalBytes += stat.size;
                        files.push(rel);
                    }
                }
                catch {
                    // skip unreadable files
                }
            }
        }
    }
    walk(rootDir, "");
    return { rootDir, tmpDir: rootDir, files, totalBytes };
}
function readLocalFile(repo, relPath, maxBytes = 512 * 1024) {
    const target = node_path_1.default.resolve(repo.rootDir, relPath);
    if (!target.startsWith(repo.rootDir))
        return null;
    let stat;
    try {
        stat = node_fs_1.default.statSync(target);
    }
    catch {
        return null;
    }
    if (!stat.isFile() || stat.size > maxBytes)
        return null;
    try {
        return node_fs_1.default.readFileSync(target, "utf-8");
    }
    catch {
        return null;
    }
}
/** Walk directory and return the latest mtime (ms). Used by watch mode. */
function getLatestMtime(dir, exclude = DEFAULT_EXCLUDE, depth = 0) {
    if (depth > 8)
        return 0;
    let latest = 0;
    let entries;
    try {
        entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    for (const e of entries) {
        if (exclude.has(e.name) || e.name.startsWith("."))
            continue;
        const abs = node_path_1.default.join(dir, e.name);
        try {
            const stat = node_fs_1.default.statSync(abs);
            if (stat.mtimeMs > latest)
                latest = stat.mtimeMs;
            if (e.isDirectory()) {
                const sub = getLatestMtime(abs, exclude, depth + 1);
                if (sub > latest)
                    latest = sub;
            }
        }
        catch {
            // skip
        }
    }
    return latest;
}
