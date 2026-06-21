"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveRecipients = resolveRecipients;
const node_child_process_1 = require("node:child_process");
/** Fetch project member emails from GitLab API, falling back to git committers. */
async function resolveRecipients(projectDir, config) {
    const extra = config.notify?.email?.extraRecipients ?? [];
    let gitlabEmails = [];
    try {
        gitlabEmails = await fetchGitLabMemberEmails(config);
    }
    catch (e) {
        process.stderr.write(`[scan] GitLab member lookup failed: ${e.message}\n`);
    }
    let gitEmails = [];
    if (gitlabEmails.length === 0) {
        gitEmails = getGitCommitterEmails(projectDir);
    }
    const all = [...new Set([...gitlabEmails, ...gitEmails, ...extra])].filter(isValidEmail);
    if (all.length === 0) {
        process.stderr.write("[scan] No email recipients resolved — skipping email notification\n");
    }
    return all;
}
async function fetchGitLabMemberEmails(config) {
    const gl = config.gitlab;
    if (!gl?.baseUrl || !gl.projectId)
        return [];
    const token = gl.token || process.env["GITLAB_TOKEN"] || process.env["CI_JOB_TOKEN"];
    if (!token)
        return [];
    const url = `${gl.baseUrl.replace(/\/$/, "")}/api/v4/projects/${gl.projectId}/members/all?per_page=100`;
    let res;
    try {
        res = await fetch(url, {
            headers: { "PRIVATE-TOKEN": token, "Accept": "application/json" },
        });
    }
    catch (e) {
        throw new Error(`GitLab API request failed: ${e.message}`);
    }
    if (!res.ok) {
        throw new Error(`GitLab API ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const members = (await res.json());
    const emails = [];
    for (const m of members) {
        if (m.email && isValidEmail(m.email)) {
            emails.push(m.email);
        }
        else {
            // GitLab API only returns email if the token is a personal token with read_user scope.
            // Fall back to guessing from username if a domain is configured.
            // (Most self-hosted GitLab instances have predictable email patterns.)
            const domain = guessEmailDomain(config.gitlab?.baseUrl ?? "");
            if (domain && m.username) {
                emails.push(`${m.username}@${domain}`);
            }
        }
    }
    return emails;
}
function getGitCommitterEmails(projectDir) {
    try {
        const out = (0, node_child_process_1.execSync)("git log --format=%ae --max-count=200", {
            cwd: projectDir,
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
        }).toString();
        return [...new Set(out.split("\n")
                .map((e) => e.trim())
                .filter(isValidEmail)
                .filter((e) => !NOREPLY_PATTERN.test(e)))];
    }
    catch {
        return [];
    }
}
function guessEmailDomain(baseUrl) {
    try {
        const host = new URL(baseUrl).hostname;
        // Strip common prefixes: git.foo.com → foo.com, gitlab.foo.com → foo.com
        const parts = host.split(".");
        if (parts.length >= 3 && (parts[0] === "git" || parts[0] === "gitlab")) {
            return parts.slice(1).join(".");
        }
        return host;
    }
    catch {
        return null;
    }
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(e) {
    return EMAIL_RE.test(e);
}
const NOREPLY_PATTERN = /no.?reply|noreply|@users\.noreply|@github\.com/i;
