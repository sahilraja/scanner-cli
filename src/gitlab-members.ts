import { execSync } from "node:child_process";
import type { ScanConfig } from "./types";

type GitLabMember = {
  id: number;
  username: string;
  name: string;
  email?: string;
};

/** Fetch project member emails from GitLab API, falling back to git committers. */
export async function resolveRecipients(
  projectDir: string,
  config: ScanConfig
): Promise<string[]> {
  const extra = config.notify?.email?.extraRecipients ?? [];

  let gitlabEmails: string[] = [];
  try {
    gitlabEmails = await fetchGitLabMemberEmails(config);
  } catch (e) {
    process.stderr.write(`[scan] GitLab member lookup failed: ${(e as Error).message}\n`);
  }

  let gitEmails: string[] = [];
  if (gitlabEmails.length === 0) {
    gitEmails = getGitCommitterEmails(projectDir);
  }

  const all = [...new Set([...gitlabEmails, ...gitEmails, ...extra])].filter(isValidEmail);

  if (all.length === 0) {
    process.stderr.write("[scan] No email recipients resolved — skipping email notification\n");
  }

  return all;
}

async function fetchGitLabMemberEmails(config: ScanConfig): Promise<string[]> {
  const gl = config.gitlab;
  if (!gl?.baseUrl || !gl.projectId) return [];

  const token = gl.token || process.env["GITLAB_TOKEN"] || process.env["CI_JOB_TOKEN"];
  if (!token) return [];

  const url = `${gl.baseUrl.replace(/\/$/, "")}/api/v4/projects/${gl.projectId}/members/all?per_page=100`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "PRIVATE-TOKEN": token, "Accept": "application/json" },
    });
  } catch (e) {
    throw new Error(`GitLab API request failed: ${(e as Error).message}`);
  }

  if (!res.ok) {
    throw new Error(`GitLab API ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const members = (await res.json()) as GitLabMember[];
  const emails: string[] = [];

  for (const m of members) {
    if (m.email && isValidEmail(m.email)) {
      emails.push(m.email);
    } else {
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

function getGitCommitterEmails(projectDir: string): string[] {
  try {
    const out = execSync("git log --format=%ae --max-count=200", {
      cwd: projectDir,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();

    return [...new Set(
      out.split("\n")
        .map((e) => e.trim())
        .filter(isValidEmail)
        .filter((e) => !NOREPLY_PATTERN.test(e))
    )];
  } catch {
    return [];
  }
}

function guessEmailDomain(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).hostname;
    // Strip common prefixes: git.foo.com → foo.com, gitlab.foo.com → foo.com
    const parts = host.split(".");
    if (parts.length >= 3 && (parts[0] === "git" || parts[0] === "gitlab")) {
      return parts.slice(1).join(".");
    }
    return host;
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(e: string): boolean {
  return EMAIL_RE.test(e);
}

const NOREPLY_PATTERN = /no.?reply|noreply|@users\.noreply|@github\.com/i;
