import "server-only";
import type { ExtractedRepo } from "./archive-walker";
import {
  emptyAttributesBag,
  pushAttribute,
  type RepoAttributesBag,
} from "./repo-attribute-types";

/**
 * Test-to-source mapping.
 *
 * Project-wide test ratios are useful but blunt — a repo with two
 * heavily tested modules and one untested one looks the same as a
 * repo with uniform mediocre coverage. This scanner produces a
 * **per-directory** breakdown so the analytics page can highlight
 * the worst offenders.
 *
 * For each non-test source file we compute the "module bucket": the
 * top-level meaningful directory (e.g. `frontend/src/api`,
 * `backend/src/services`). For each bucket we count source files,
 * test files, and a rough "covered" count: a source file is
 * *covered* if a sibling `*.test.*` / `*.spec.*` file exists, or a
 * `__tests__/<name>.test.*` lives in the same directory.
 *
 * The scanner is intentionally tolerant of layout — it works for
 * monorepos (`apps/web/...`), Nest-style (`controllers/users.controller.ts`),
 * and flat repos.
 */

const SCANNER = "test-map" as const;

const SOURCE_EXT = ["ts", "tsx", "js", "jsx", "mjs", "cjs"] as const;
const JSX_EXT = new Set(["tsx", "jsx"]);
const TEST_RX = /\.(test|spec)\.[a-z]+$/i;
const TESTS_DIR_RX = /(^|\/)__tests__(\/|$)/;

/**
 * Folder + path heuristics for "this bucket is a React / frontend
 * module". We exclude those buckets from the test-desert finding
 * because frontend test discipline rarely uses sibling unit tests —
 * Cypress / Playwright / Storybook live in dedicated folders we
 * can't reliably map back to source files, so calling them "test
 * deserts" produces false positives.
 */
const FRONTEND_PATH_RX =
  /(^|\/)(frontend|client|web|webapp|admin|dashboard|portal|ui|spa|mobile)(\/|$)/i;
const REACT_FOLDER_RX =
  /(^|\/)(pages|components|hooks|views|screens|containers|layouts|app)(\/|$)/i;

export type DirCoverageRow = {
  dir: string;
  source_files: number;
  test_files: number;
  covered_files: number;
  coverage_pct: number;
};

export type RepoTestMapSignals = {
  total_source_files: number;
  total_test_files: number;
  total_covered_files: number;
  /** % of source files with a test sibling. 0..100. */
  coverage_pct: number;
  by_dir: DirCoverageRow[];
  /** Buckets that have ≥10 source files but 0 tests — "test deserts". */
  test_deserts: string[];
  /** Buckets that have above-average coverage (≥70%). */
  well_tested: string[];
  /** Avg files-per-test (lower = better, but only meaningful when >0 tests). */
  files_per_test: number;
  duration_ms: number;
};

function fileExt(p: string): string {
  const i = p.lastIndexOf(".");
  return i === -1 ? "" : p.slice(i + 1).toLowerCase();
}

function isSourceFile(p: string): boolean {
  if (!SOURCE_EXT.includes(fileExt(p) as (typeof SOURCE_EXT)[number])) return false;
  if (TEST_RX.test(p)) return false;
  if (TESTS_DIR_RX.test(p)) return false;
  if (p.includes("/node_modules/") || p.includes("/dist/") || p.includes("/build/"))
    return false;
  if (p.endsWith(".d.ts")) return false;
  return true;
}

function isTestFile(p: string): boolean {
  if (!SOURCE_EXT.includes(fileExt(p) as (typeof SOURCE_EXT)[number])) return false;
  if (TEST_RX.test(p)) return true;
  if (TESTS_DIR_RX.test(p)) return true;
  return false;
}

/**
 * Bucket a path into its "module" — typically the second or third
 * meaningful segment. We avoid bucketing too aggressively (the whole
 * `src/` blob would be useless) and too granularly (one bucket per
 * file is meaningless).
 */
function bucketPath(p: string): string {
  const segs = p.split("/").slice(0, -1); // drop filename
  if (segs.length === 0) return "(root)";
  // Trim leading common prefixes that don't carry information.
  const TRIM = ["src", "lib", "app"];
  let start = 0;
  while (start < segs.length && TRIM.includes(segs[start])) start += 1;
  // Take up to 3 meaningful segments. For monorepos like
  // `frontend/src/components/Button/Button.tsx` we want
  // `frontend/components/Button` so adjacent files share a bucket.
  const meaningful = segs.slice(start);
  // If the first segment is a monorepo split (frontend/, apps/web/),
  // keep up to 4 segments.
  const isMono =
    /^(frontend|backend|client|server|web|api|admin|mobile|apps|packages)$/i.test(
      segs[0] ?? ""
    );
  const limit = isMono ? 3 : 2;
  const top = meaningful.slice(0, limit);
  // Re-prepend the monorepo slot so apps/web vs apps/admin stay distinct.
  if (isMono && start > 0) top.unshift(...segs.slice(0, start));
  return top.join("/") || "(root)";
}

function siblingTestExists(allFiles: Set<string>, sourcePath: string): boolean {
  const segs = sourcePath.split("/");
  const fname = segs[segs.length - 1];
  const dir = segs.slice(0, -1).join("/");
  const dot = fname.lastIndexOf(".");
  const stem = dot === -1 ? fname : fname.slice(0, dot);
  const ext = dot === -1 ? "" : fname.slice(dot + 1);
  const candidates = [
    `${dir}/${stem}.test.${ext}`,
    `${dir}/${stem}.spec.${ext}`,
    `${dir}/__tests__/${stem}.test.${ext}`,
    `${dir}/__tests__/${stem}.spec.${ext}`,
    `${dir}/__tests__/${stem}.test.ts`,
    `${dir}/__tests__/${stem}.spec.ts`,
    `${dir}/${stem}.test.ts`,
    `${dir}/${stem}.spec.ts`,
  ];
  for (const c of candidates) if (allFiles.has(c)) return true;
  return false;
}

/**
 * A bucket is "React-like" if any of these hold:
 *   1. ≥40% of its source files have a JSX extension (`.tsx` / `.jsx`).
 *   2. Its path lives under an obvious frontend slot
 *      (`frontend/`, `client/`, `apps/web/`, …).
 *   3. Its leaf folder is a typical React module folder
 *      (`pages/`, `components/`, `hooks/`, `views/`, `screens/`).
 *
 * Used to suppress test-desert false positives — frontend test
 * suites live in `cypress/` / `playwright/` etc. that we don't
 * trace, so flagging these as deserts is misleading.
 */
function isReactLikeBucket(dir: string, source: number, jsx: number): boolean {
  if (source > 0 && jsx / source >= 0.4) return true;
  if (FRONTEND_PATH_RX.test(dir)) return true;
  if (REACT_FOLDER_RX.test(dir)) return true;
  return false;
}

export function scanRepoTestMap(repo: ExtractedRepo): RepoTestMapSignals {
  const startedAt = Date.now();
  const fileSet = new Set(repo.files);

  type Bucket = {
    dir: string;
    source: number;
    test: number;
    covered: number;
    jsx: number;
  };
  const buckets = new Map<string, Bucket>();
  let totalSource = 0;
  let totalTest = 0;
  let totalCovered = 0;

  for (const p of repo.files) {
    if (isSourceFile(p)) {
      totalSource += 1;
      const dir = bucketPath(p);
      const b =
        buckets.get(dir) ??
        { dir, source: 0, test: 0, covered: 0, jsx: 0 };
      b.source += 1;
      if (JSX_EXT.has(fileExt(p))) b.jsx += 1;
      if (siblingTestExists(fileSet, p)) {
        b.covered += 1;
        totalCovered += 1;
      }
      buckets.set(dir, b);
    } else if (isTestFile(p)) {
      totalTest += 1;
      const dir = bucketPath(p);
      const b =
        buckets.get(dir) ??
        { dir, source: 0, test: 0, covered: 0, jsx: 0 };
      b.test += 1;
      buckets.set(dir, b);
    }
  }

  const rows: DirCoverageRow[] = Array.from(buckets.values())
    .map((b) => ({
      dir: b.dir,
      source_files: b.source,
      test_files: b.test,
      covered_files: b.covered,
      coverage_pct: b.source > 0 ? Math.round((b.covered / b.source) * 100) : 0,
    }))
    .sort((a, b) => b.source_files - a.source_files);

  // Exclude React-like buckets from the desert finding so frontend
  // modules covered by Cypress / Playwright don't get scolded.
  const test_deserts = Array.from(buckets.values())
    .filter(
      (b) =>
        b.source >= 10 &&
        b.test === 0 &&
        !isReactLikeBucket(b.dir, b.source, b.jsx)
    )
    .map((b) => b.dir);
  const well_tested = rows
    .filter((r) => r.source_files >= 5 && r.coverage_pct >= 70)
    .map((r) => r.dir);
  const files_per_test = totalTest > 0 ? totalSource / totalTest : 0;

  return {
    total_source_files: totalSource,
    total_test_files: totalTest,
    total_covered_files: totalCovered,
    coverage_pct:
      totalSource > 0 ? Math.round((totalCovered / totalSource) * 100) : 0,
    by_dir: rows,
    test_deserts,
    well_tested,
    files_per_test: Math.round(files_per_test * 10) / 10,
    duration_ms: Date.now() - startedAt,
  };
}

export function testMapAttributes(s: RepoTestMapSignals): RepoAttributesBag {
  const bag = emptyAttributesBag();
  if (s.total_source_files === 0) return bag;

  // Headline coverage. We attach an evidence payload that summarises
  // the totals and lists the top buckets by source size so reviewers
  // can immediately see WHERE the gap (or the strength) lives.
  const coverageEvidence = {
    total_source_files: s.total_source_files,
    total_test_files: s.total_test_files,
    total_covered_files: s.total_covered_files,
    coverage_pct: s.coverage_pct,
    files_per_test: s.files_per_test,
    top_directories: s.by_dir.slice(0, 8).map((d) => ({
      dir: d.dir,
      source_files: d.source_files,
      test_files: d.test_files,
      coverage_pct: d.coverage_pct,
    })),
  };

  if (s.coverage_pct >= 60) {
    pushAttribute(bag, {
      category: "test_coverage",
      scanner: SCANNER,
      attribute_key: "global_coverage",
      attribute_value: s.coverage_pct,
      attribute_label: `${s.coverage_pct}% of source files have a test sibling`,
      delta_to_score: +1.5,
      evidence: coverageEvidence,
    });
  } else if (s.coverage_pct >= 30) {
    pushAttribute(bag, {
      category: "test_coverage",
      scanner: SCANNER,
      attribute_key: "global_coverage",
      attribute_value: s.coverage_pct,
      attribute_label: `${s.coverage_pct}% of source files have a test sibling`,
      delta_to_score: +0.6,
      evidence: coverageEvidence,
    });
  } else if (s.coverage_pct >= 10) {
    pushAttribute(bag, {
      category: "test_coverage",
      scanner: SCANNER,
      attribute_key: "global_coverage",
      attribute_value: s.coverage_pct,
      attribute_label: `Only ${s.coverage_pct}% of source files have a test sibling`,
      delta_to_score: 0,
      evidence: coverageEvidence,
    });
  } else if (s.total_test_files === 0) {
    pushAttribute(bag, {
      category: "test_coverage",
      scanner: SCANNER,
      attribute_key: "no_tests",
      attribute_value: 0,
      attribute_label: `No test files detected (${s.total_source_files} source files)`,
      delta_to_score: -1.0,
      evidence: {
        total_source_files: s.total_source_files,
        largest_untested_dirs: s.by_dir
          .filter((d) => d.test_files === 0)
          .slice(0, 10)
          .map((d) => `${d.dir} (${d.source_files} source files)`),
      },
    });
  } else {
    pushAttribute(bag, {
      category: "test_coverage",
      scanner: SCANNER,
      attribute_key: "global_coverage",
      attribute_value: s.coverage_pct,
      attribute_label: `${s.coverage_pct}% files-with-test (low)`,
      delta_to_score: -0.4,
      evidence: coverageEvidence,
    });
  }

  // Code quality: well-tested modules signal good engineering practice.
  if (s.well_tested.length > 0) {
    pushAttribute(bag, {
      category: "code_quality",
      scanner: SCANNER,
      attribute_key: "well_tested_modules",
      attribute_value: s.well_tested.length,
      attribute_label: `${s.well_tested.length} module(s) with ≥70% test coverage`,
      delta_to_score: Math.min(0.6, s.well_tested.length * 0.2),
      evidence: s.well_tested,
    });
  }

  // Code quality / readability: large untested modules ("test deserts").
  if (s.test_deserts.length > 0) {
    pushAttribute(bag, {
      category: "code_quality",
      scanner: SCANNER,
      attribute_key: "test_deserts",
      attribute_value: s.test_deserts.length,
      attribute_label: `${s.test_deserts.length} module(s) with ≥10 source files and zero tests`,
      delta_to_score: -Math.min(0.8, s.test_deserts.length * 0.3),
      evidence: s.test_deserts,
    });
  }

  // Bare information row used by the analytics page. Evidence is a
  // structured snapshot so the row isn't a black box on hover.
  pushAttribute(bag, {
    category: "test_coverage",
    scanner: SCANNER,
    attribute_key: "files_per_test",
    attribute_value: s.files_per_test,
    attribute_label:
      s.total_test_files > 0
        ? `${s.files_per_test} source files per test file`
        : "no test files",
    delta_to_score: 0,
    evidence: {
      total_source_files: s.total_source_files,
      total_test_files: s.total_test_files,
      total_covered_files: s.total_covered_files,
      files_per_test: s.files_per_test,
    },
  });

  return bag;
}
