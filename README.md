# scanner-cli

CLI tool that scans a local project directory and generates a PDF health report — covering code quality, security, test coverage, architecture, and more — with optional email and Google Chat notifications.

## What it does

Point it at a project directory and it will:

- Walk the codebase and run a set of scanners (architecture, AST/code quality, layering, routes, schema, docs, test coverage, content rules)
- Compute an overall health score (0–100) and letter grade
- Generate a PDF report (`health-report-<project>-<date>.pdf` plus a `health-report.pdf` "latest" copy)
- Optionally cross-check coverage against FRD/spec markdown files
- Optionally email the report and/or post a summary to Google Chat
- Optionally fail the run (non-zero exit code) if the score drops below a threshold — handy as a CI gate

## Installation

This package is published to two registries. Use whichever your project/team already has configured — they contain identical code.

### Option A — GitLab (primary)

Add to your project's `.npmrc`:

```
@webileapps:registry=https://git.webileapps.com/api/v4/projects/857/packages/npm/
//git.webileapps.com/api/v4/projects/857/packages/npm/:_authToken=${GITLAB_DEPLOY_TOKEN}
```

Then install:

```
npm install -g @webileapps/scan
```

### Option B — GitHub Packages (secondary)

Add to your project's `.npmrc`:

```
@sahilraja:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` needs at least `read:packages` scope (create one at github.com/settings/tokens — GitHub Packages requires auth even for public packages).

Then install:

```
npm install -g @sahilraja/scan
```

### Without installing

```
npx @webileapps/scan
# or
npx @sahilraja/scan
```

## Usage

```
scan [directory] [options]
```

If `directory` is omitted, it scans the current working directory.

| Flag | Description |
| --- | --- |
| `--watch`, `-w` | Watch mode — scans immediately, then rescans on file changes (polls every 8s) |
| `--once` | Run a single scan and exit (default behavior when no flag is given) |
| `--ci` | CI mode — single scan, always sends notifications regardless of detected CI |
| `--no-notify` | Skip email / Google Chat notifications for this run |
| `--fail-below <n>` | Exit with code `2` if the health score is below `n` |
| `--report-dir <path>` | Write the PDF report to a custom directory |

Examples:

```
scan                          # scan current directory, write reports/ here
scan ../my-app                # scan a different project
scan --watch                  # rescan on every file save
scan --ci --fail-below 60     # CI gate: fail the pipeline below score 60
scan --no-notify              # generate the PDF only, skip notifications
```

### Output

By default the PDF report is written to `reports/` inside the scanned directory:

```
<project>/reports/health-report-<project>-<YYYY-MM-DD>.pdf
<project>/reports/health-report.pdf   (always the latest run)
```

Exit codes: `0` success, `1` fatal error (e.g. directory not found), `2` health score below `--fail-below` threshold.

## Configuration

Optional — create a `scan.config.json` in the root of the project being scanned. If omitted, sensible defaults are used.

```json
{
  "name": "My Project",
  "description": "Short description shown in the PDF header",

  "gitlab": {
    "baseUrl": "https://git.webileapps.com",
    "projectId": 123,
    "token": "${GITLAB_TOKEN}"
  },

  "frd": {
    "dir": "specs",
    "pattern": "**/*.md"
  },

  "notify": {
    "email": {
      "from": "scanner@webileapps.com",
      "extraRecipients": ["cto@webileapps.com"],
      "smtp": {
        "host": "${SMTP_HOST}",
        "port": 587,
        "user": "${SMTP_USER}",
        "pass": "${SMTP_PASS}"
      }
    },
    "googleChat": {
      "webhookUrl": "${GOOGLE_CHAT_WEBHOOK}"
    }
  },

  "scan": {
    "exclude": ["node_modules", "dist", "build", ".git", ".next", "coverage"],
    "reportDir": "reports",
    "maxFileSizeBytes": 524288,
    "failBelow": 50
  }
}
```

Notes:

- Any `${VAR_NAME}` value is resolved from environment variables at runtime — don't commit real secrets into `scan.config.json`.
- `gitlab` config (optional) is used to resolve notification recipients from GitLab project members.
- `frd.dir` (optional) points at a folder of markdown spec files; the scanner checks how much of each spec is reflected in the codebase and reports coverage.
- `notify.email` / `notify.googleChat` are both optional — omit either (or both) to disable that channel. See [`scan.config.example.json`](./scan.config.example.json) for the full template.

## Using it as a CI gate

In your project's CI pipeline (GitLab CI shown, but any CI works the same way):

```yaml
health-scan:
  stage: test
  script:
    - npm install -g @webileapps/scan
    - scan . --ci --fail-below 60
  artifacts:
    paths:
      - reports/
```

See [`ci-template.yml`](./ci-template.yml) for a copy-paste starting point.

## Development

```
git clone git@github.com:sahilraja/scanner-cli.git
cd scanner-cli
npm install
npm run build      # compiles TypeScript to dist/
npm run dev         # tsc --watch
npm start           # node dist/bin/scan.js
```

Run it against a project locally without publishing:

```
npm run build
node dist/bin/scan.js /path/to/some/project
```

## Publishing

- **GitLab (primary):** handled by `.gitlab-ci.yml` — pushes to the default branch / tags publish to `@webileapps/scan` on the GitLab npm registry.
- **GitHub Packages (secondary):** handled by `.github/workflows/publish.yml` — triggered by pushing a `v*.*.*` tag or publishing a GitHub Release. Publishes the same code as `@sahilraja/scan` to `npm.pkg.github.com`. The committed `package.json` always stays GitLab-scoped; the GitHub workflow rescopes the package name in CI only, so nothing in this repo needs to change to support both registries.

To cut a new GitHub Packages release:

```
git tag v1.0.x
git push github v1.0.x
```
