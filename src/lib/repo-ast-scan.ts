import "server-only";
import * as ts from "typescript";
import path from "node:path";
import fs from "node:fs";
import { type ExtractedRepo, readRepoFile } from "./archive-walker";

/**
 * AST-based scan of every TS / JS / JSX / TSX file in an extracted repo.
 *
 * What this module does (and explicitly does NOT do):
 *   ✓ Parses each file with the TypeScript compiler API (handles TS, TSX,
 *     JSX, plain JS, ESM/CJS — one parser, one config).
 *   ✓ Walks the AST to find every function-like construct: function
 *     declarations, function expressions, arrow functions, methods on
 *     classes / object literals, and constructors.
 *   ✓ Computes 7 per-function metrics: name, file, line span, parameter
 *     count, cyclomatic complexity, max nesting depth, exported flag,
 *     and whether a leading docblock comment exists.
 *   ✓ Cross-references every "complex" function (complexity ≥ 10) with
 *     the repo's test files (path-based) to flag untested complex code.
 *   ✓ Aggregates per-file signals: function count, exports, total LOC
 *     in functions, max single-function LOC.
 *   ✓ Aggregates per-repo signals: medians, p95s, top-N worst.
 *
 *   ✗ NO data-flow / taint analysis (still a static pass).
 *   ✗ NO type checking (we use parser-only mode for speed).
 *   ✗ NO cross-file resolution (each file is independent).
 *
 * Performance budget: ~3–10 seconds for a 1000-file project on first
 * scan. We bound work by `maxFiles` (default 2000) and `maxFileBytes`
 * (default 1 MB). Files that exceed either are reported but skipped.
 */

// ── Public types ────────────────────────────────────────────────────────────

export type AstFunction = {
  /** Short readable name. "(anonymous)" for unnamed expressions / arrows. */
  name: string;
  /** Path inside the repo, e.g. "src/lib/foo.ts". */
  file: string;
  /** 1-indexed line numbers — inclusive on both ends. */
  start_line: number;
  end_line: number;
  /** end_line - start_line + 1, ≥ 1. */
  loc: number;
  /** parameters.length for the construct. */
  params: number;
  /**
   * Cyclomatic complexity (McCabe) — 1 + count of branching constructs:
   * if, ?:, &&, ||, ??, case, catch, for, while, do, for-in, for-of.
   * Industry "warning" threshold is ≥10, "high" is ≥15, "very high" ≥20.
   */
  complexity: number;
  /**
   * Max nesting depth of control-flow blocks within the function body.
   * 0 = flat. Anything ≥4 is hard to read.
   */
  max_nesting: number;
  /**
   * Exported (public surface area) — true if the declaration has an
   * `export` modifier or is part of an `export { … }` re-export, OR
   * the function is assigned to `module.exports` / `exports.X`.
   */
  is_exported: boolean;
  /**
   * True if a JSDoc-style block comment (/** … *​/) immediately precedes
   * the function. Used for doc-coverage heuristics on public exports.
   */
  has_doc_comment: boolean;
  /**
   * True if no test file appears to cover this function. We use a
   * path-based heuristic: source `src/lib/foo.ts` is "covered" if any
   * test file mentions `foo` in its name (`foo.test.ts`, `foo.spec.ts`,
   * `__tests__/foo.test.ts`, etc.). Whole file is uncovered → all its
   * functions are uncovered. Coarse but actionable.
   */
  is_untested: boolean;
};

export type AstFileSummary = {
  file: string;
  function_count: number;
  /** Number of `export` statements / declared exported symbols at top level. */
  export_count: number;
  /** Sum of LOC inside function bodies (rough — useful as ratio of file LOC). */
  function_loc: number;
  max_function_loc: number;
  parse_ok: boolean;
  parse_error?: string;
};

export type RepoAstSignals = {
  /** All functions across every parsed file. Truncated to `keepTopN` worst by complexity for storage. */
  functions: AstFunction[];
  files: AstFileSummary[];

  // Aggregate metrics over ALL functions found (not just kept ones).
  total_functions: number;
  total_files_parsed: number;
  total_files_skipped: number;
  total_files_errored: number;

  // Distribution stats — computed once and surfaced in the UI.
  median_complexity: number;
  p95_complexity: number;
  max_complexity: number;
  median_function_loc: number;
  p95_function_loc: number;
  median_params: number;
  p95_params: number;
  max_nesting_p95: number;

  // Outlier counts (used by scoring + UI).
  god_functions: number; // complexity >= 15
  long_functions: number; // loc >= 100
  high_param_functions: number; // params >= 6
  deeply_nested_functions: number; // max_nesting >= 4

  // File-level outliers.
  god_files: number; // export_count >= 30 (barrel / mega-module smell)

  // Documentation coverage on public exports — % of exported functions
  // that have a leading doc comment.
  exported_function_count: number;
  documented_export_count: number;
  doc_coverage_pct: number; // 0..100

  // Untested complex code — exported functions with complexity ≥ 10
  // and no matching test file. Most actionable signal.
  untested_complex_functions: number;

  warnings: string[];
  bytes_parsed: number;
  duration_ms: number;
};

// ── Configuration ───────────────────────────────────────────────────────────

// Restricted to TypeScript only — `.js / .jsx / .mjs / .cjs` are skipped.
// Why: untyped JS files produce a noisier function inventory (more arrows,
// more anonymous callbacks, less reliable export detection) and the user's
// codebase is TS-first. Adding JS back is a one-line change.
const PARSEABLE_EXT = new Set(["ts", "tsx"]);

/**
 * Heuristic: is this file likely to contain React component bodies?
 * `.tsx` / `.jsx` are guaranteed JSX-capable; we also include files
 * that live under `pages/`, `components/`, or `views/` paths so a
 * component-shaped function written in plain `.ts` doesn't get
 * unfairly flagged either. The thresholds for "god function" and
 * "untested complex" are relaxed for these files because JSX
 * conditional-render branching naturally inflates cyclomatic count.
 */
const REACT_COMPONENT_PATH_RX =
  /(^|\/)(pages|components|views|screens|routes|hooks)(\/|$)/i;

function isReactComponentFile(filePath: string): boolean {
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) return true;
  return REACT_COMPONENT_PATH_RX.test(filePath);
}

const DEFAULT_OPTS = {
  /** Hard cap on files we'll parse to avoid runaway scans on monorepos. */
  maxFiles: 2000,
  /** Don't parse individual files larger than this (1 MB). */
  maxFileBytes: 1024 * 1024,
  /** Hard cap on total parsed bytes (50 MB) — defensive. */
  maxTotalBytes: 50 * 1024 * 1024,
  /** Keep at most this many functions in `functions[]` (sorted worst-first). */
  keepTopN: 200,
};

export type AstScanOpts = Partial<typeof DEFAULT_OPTS>;

// ── Public entry point ──────────────────────────────────────────────────────

export function scanRepoAst(
  repo: ExtractedRepo,
  opts?: AstScanOpts
): RepoAstSignals {
  const startedAt = Date.now();
  const merged = { ...DEFAULT_OPTS, ...opts };

  const warnings: string[] = [];
  const allFunctions: AstFunction[] = [];
  const fileSummaries: AstFileSummary[] = [];

  // Build a "covered modules" set from test file names. A source file
  // `foo.ts` is considered covered if any test path contains `foo` (sans
  // extension) as a token. This is intentionally generous — false-
  // negatives on coverage are worse than false-positives.
  const testStems = collectTestStems(repo);

  let totalBytes = 0;
  let filesParsed = 0;
  let filesSkipped = 0;
  let filesErrored = 0;

  const sourceFiles = repo.files.filter(isParseable);
  const sliced = sourceFiles.slice(0, merged.maxFiles);
  if (sourceFiles.length > merged.maxFiles) {
    warnings.push(
      `AST scan capped at ${merged.maxFiles} files; ${sourceFiles.length - merged.maxFiles} skipped.`
    );
    filesSkipped += sourceFiles.length - merged.maxFiles;
  }

  console.log(
    `[ast-scan] start files_total=${sourceFiles.length} ts_tsx_only=true cap=${merged.maxFiles}`
  );

  for (const filePath of sliced) {
    if (totalBytes > merged.maxTotalBytes) {
      filesSkipped += sliced.length - filesParsed - filesErrored;
      warnings.push(
        `AST scan capped at ${merged.maxTotalBytes} bytes; truncated.`
      );
      break;
    }

    const text = readRepoFile(repo, filePath, merged.maxFileBytes);
    if (text === null) {
      filesSkipped += 1;
      console.warn(`[ast-scan] skip file=${filePath} reason=too_large_or_unreadable`);
      fileSummaries.push({
        file: filePath,
        function_count: 0,
        export_count: 0,
        function_loc: 0,
        max_function_loc: 0,
        parse_ok: false,
        parse_error: "file too large or unreadable",
      });
      continue;
    }
    totalBytes += text.length;

    let summary: AstFileSummary;
    let fileFns: AstFunction[];
    const tFile = Date.now();
    try {
      const result = scanFile(filePath, text, testStems);
      fileFns = result.functions;
      summary = result.summary;
      filesParsed += 1;
      // Per-file trace. Compact: path, function count, max complexity in
      // this file, exports, doc-coverage hint, duration. Skipped if no
      // functions to keep the log noise down for tiny files.
      const maxCxInFile = fileFns.reduce(
        (m, f) => Math.max(m, f.complexity),
        0
      );
      const docExportsInFile = fileFns.filter(
        (f) => f.is_exported && f.has_doc_comment
      ).length;
      const expInFile = fileFns.filter((f) => f.is_exported).length;
      console.log(
        `[ast-scan] file=${filePath} fns=${fileFns.length} max_cx=${maxCxInFile} exp=${expInFile}${expInFile > 0 ? ` doc=${docExportsInFile}/${expInFile}` : ""} bytes=${text.length} took_ms=${Date.now() - tFile}`
      );
    } catch (e) {
      filesErrored += 1;
      console.warn(
        `[ast-scan] error file=${filePath} took_ms=${Date.now() - tFile} error=${(e as Error).message?.slice(0, 120) ?? "unknown"}`
      );
      summary = {
        file: filePath,
        function_count: 0,
        export_count: 0,
        function_loc: 0,
        max_function_loc: 0,
        parse_ok: false,
        parse_error: (e as Error).message?.slice(0, 200) ?? "unknown",
      };
      fileFns = [];
    }

    fileSummaries.push(summary);
    for (const fn of fileFns) allFunctions.push(fn);
  }

  // Aggregates over all functions found (not just kept).
  const complexities = allFunctions.map((f) => f.complexity).sort(asc);
  const locs = allFunctions.map((f) => f.loc).sort(asc);
  const params = allFunctions.map((f) => f.params).sort(asc);
  const nestings = allFunctions.map((f) => f.max_nesting).sort(asc);

  const exportedFns = allFunctions.filter((f) => f.is_exported);
  const documentedExports = exportedFns.filter((f) => f.has_doc_comment);
  // React component bodies (in `.tsx` / `.jsx`) naturally accumulate
  // cyclomatic complexity from JSX conditional rendering, so we use a
  // higher bar (cx ≥ 15) for those files. They're also typically
  // covered by E2E rather than unit tests, so flagging every page
  // component as "untested complex" produces dozens of noisy rows
  // that don't reflect actionable risk.
  const untestedComplex = exportedFns.filter((f) => {
    if (!f.is_untested) return false;
    const threshold = isReactComponentFile(f.file) ? 15 : 10;
    return f.complexity >= threshold;
  });

  const sortedFns = [...allFunctions].sort(
    (a, b) =>
      // Primary sort: complexity desc.
      b.complexity - a.complexity ||
      // Tiebreak: loc desc (longer is worse when equally complex).
      b.loc - a.loc
  );
  const kept = sortedFns.slice(0, merged.keepTopN);

  const signals: RepoAstSignals = {
    functions: kept,
    files: fileSummaries,
    total_functions: allFunctions.length,
    total_files_parsed: filesParsed,
    total_files_skipped: filesSkipped,
    total_files_errored: filesErrored,
    median_complexity: median(complexities),
    p95_complexity: p95(complexities),
    max_complexity: complexities[complexities.length - 1] ?? 0,
    median_function_loc: median(locs),
    p95_function_loc: p95(locs),
    median_params: median(params),
    p95_params: p95(params),
    max_nesting_p95: p95(nestings),
    // For "god functions" we use a higher threshold (cx ≥ 20) on
    // React component files so that the page-level component itself
    // doesn't always end up flagged. Non-component code keeps the
    // sharper cx ≥ 15 bar.
    god_functions: allFunctions.filter((f) =>
      isReactComponentFile(f.file) ? f.complexity >= 20 : f.complexity >= 15
    ).length,
    long_functions: allFunctions.filter((f) => f.loc >= 100).length,
    high_param_functions: allFunctions.filter((f) => f.params >= 6).length,
    deeply_nested_functions: allFunctions.filter((f) => f.max_nesting >= 4)
      .length,
    god_files: fileSummaries.filter((f) => f.export_count >= 30).length,
    exported_function_count: exportedFns.length,
    documented_export_count: documentedExports.length,
    doc_coverage_pct:
      exportedFns.length === 0
        ? 100
        : Math.round((documentedExports.length / exportedFns.length) * 100),
    untested_complex_functions: untestedComplex.length,
    warnings,
    bytes_parsed: totalBytes,
    duration_ms: Date.now() - startedAt,
  };

  return signals;
}

// ── Per-file scan ───────────────────────────────────────────────────────────

function scanFile(
  filePath: string,
  text: string,
  testStems: Set<string>
): { functions: AstFunction[]; summary: AstFileSummary } {
  // We only parse `.ts` and `.tsx`. `.tsx` needs ScriptKind.TSX so the
  // parser accepts JSX syntax; `.ts` uses ScriptKind.TS.
  const ext = (filePath.split(".").pop() ?? "").toLowerCase();
  const scriptKind =
    ext === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

  const sourceFile = ts.createSourceFile(
    path.basename(filePath),
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind
  );

  // Whole-file "is this file uncovered?" lookup. Module is covered if
  // any test path stem contains the source file's basename (sans ext).
  const stem = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  const fileIsCovered = stem
    ? testStems.has(stem.toLowerCase())
    : false;

  const functions: AstFunction[] = [];
  let exportCount = 0;

  // Visitor: every function-like node + every export.
  const visit = (node: ts.Node, parentNesting: number): void => {
    // Top-level export tracking (declarations + statements).
    if (
      node.parent &&
      ts.isSourceFile(node.parent) &&
      isExportingDeclaration(node)
    ) {
      exportCount += countExportsOnNode(node);
    }

    if (isFunctionLike(node)) {
      const fn = buildFunction(
        node,
        sourceFile,
        filePath,
        text,
        fileIsCovered
      );
      if (fn) functions.push(fn);
    }

    ts.forEachChild(node, (child) =>
      visit(child, parentNesting + (introducesNesting(child) ? 1 : 0))
    );
  };

  visit(sourceFile, 0);

  const fnLocSum = functions.reduce((acc, f) => acc + f.loc, 0);
  const fnLocMax = functions.reduce((acc, f) => Math.max(acc, f.loc), 0);

  const summary: AstFileSummary = {
    file: filePath,
    function_count: functions.length,
    export_count: exportCount,
    function_loc: fnLocSum,
    max_function_loc: fnLocMax,
    parse_ok: true,
  };

  return { functions, summary };
}

// ── AST helpers ─────────────────────────────────────────────────────────────

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function buildFunction(
  node: FunctionLike,
  sourceFile: ts.SourceFile,
  filePath: string,
  text: string,
  fileIsCovered: boolean
): AstFunction | null {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const startLine = start.line + 1;
  const endLine = end.line + 1;
  const loc = Math.max(1, endLine - startLine + 1);

  const name = functionName(node);
  const params = node.parameters.length;
  const complexity = computeComplexity(node);
  const maxNesting = computeMaxNesting(node);
  const isExported = isFunctionExported(node);
  const hasDocComment = hasLeadingDocComment(node, text);

  return {
    name,
    file: filePath,
    start_line: startLine,
    end_line: endLine,
    loc,
    params,
    complexity,
    max_nesting: maxNesting,
    is_exported: isExported,
    has_doc_comment: hasDocComment,
    is_untested: !fileIsCovered,
  };
}

function functionName(node: FunctionLike): string {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    if (node.name && ts.isIdentifier(node.name)) return node.name.text;
    if (node.name && ts.isStringLiteral(node.name)) return node.name.text;
    return "(method)";
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  // FunctionExpression / ArrowFunction: try to grab the name from the
  // enclosing variable / property declaration so "(anonymous)" is rare.
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.name && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent) && parent.name) {
    if (ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isStringLiteral(parent.name)) return parent.name.text;
  }
  if (parent && ts.isPropertyDeclaration(parent) && parent.name) {
    if (ts.isIdentifier(parent.name)) return parent.name.text;
  }
  if (
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    // module.exports = function() { ... } or exports.foo = function...
    const left = parent.left;
    if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.name)) {
      return left.name.text;
    }
  }
  return "(anonymous)";
}

/**
 * McCabe cyclomatic complexity. Starts at 1; each branch point adds 1.
 * Branch points: if, conditional (?:), &&, ||, ??, case, catch, for,
 * while, do-while, for-in, for-of.
 */
function computeComplexity(node: FunctionLike): number {
  let c = 1;
  const visit = (n: ts.Node): void => {
    if (ts.isIfStatement(n)) c += 1;
    else if (ts.isConditionalExpression(n)) c += 1;
    else if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (
        k === ts.SyntaxKind.AmpersandAmpersandToken ||
        k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.QuestionQuestionToken
      ) {
        c += 1;
      }
    } else if (ts.isCaseClause(n)) c += 1;
    else if (ts.isCatchClause(n)) c += 1;
    else if (
      ts.isForStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isDoStatement(n)
    ) {
      c += 1;
    }
    // Don't descend into nested functions — each function is scored
    // independently. (TS's forEachChild stops naturally if we return
    // from the visit on a function-like node.)
    if (n !== node && isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  if (node.body) visit(node.body);
  return c;
}

/**
 * Max nesting depth of control-flow constructs inside the function body.
 * Counts: if/else, switch, for*, while, do-while, try, and block-scoped
 * conditional expressions are NOT counted (they don't add visual depth).
 * Nested functions reset their own depth (we don't descend into them).
 */
function computeMaxNesting(node: FunctionLike): number {
  let maxDepth = 0;
  const visit = (n: ts.Node, depth: number): void => {
    let next = depth;
    if (introducesNesting(n)) {
      next = depth + 1;
      if (next > maxDepth) maxDepth = next;
    }
    if (n !== node && isFunctionLike(n)) return;
    ts.forEachChild(n, (c) => visit(c, next));
  };
  if (node.body) visit(node.body, 0);
  return maxDepth;
}

function introducesNesting(n: ts.Node): boolean {
  return (
    ts.isIfStatement(n) ||
    ts.isSwitchStatement(n) ||
    ts.isForStatement(n) ||
    ts.isForInStatement(n) ||
    ts.isForOfStatement(n) ||
    ts.isWhileStatement(n) ||
    ts.isDoStatement(n) ||
    ts.isTryStatement(n)
  );
}

function isExportingDeclaration(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isVariableStatement(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    ts.isExportAssignment(node)
  );
}

function countExportsOnNode(node: ts.Node): number {
  // `export { a, b, c }` re-exports.
  if (ts.isExportDeclaration(node)) {
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      return node.exportClause.elements.length;
    }
    // `export *` counts as 1 unit.
    return 1;
  }
  if (ts.isExportAssignment(node)) return 1; // `export default …` / `export = …`
  // `export const a, b, c = …` — count declarators.
  if (ts.isVariableStatement(node)) {
    if (!hasExportModifier(node)) return 0;
    return node.declarationList.declarations.length;
  }
  // `export function foo() {}`, `export class …`, etc.
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return hasExportModifier(node) ? 1 : 0;
  }
  return 0;
}

function hasExportModifier(node: ts.Node): boolean {
  // ts.canHaveModifiers / ts.getModifiers are TS 4.8+; we use them.
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node) ?? [];
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isFunctionExported(node: FunctionLike): boolean {
  // Direct: `export function foo() {}`
  if (ts.canHaveModifiers(node)) {
    const mods = ts.getModifiers(node) ?? [];
    if (mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  }
  // Indirect: walk up looking for a VariableStatement / class with
  // export modifier, OR a `module.exports = …` / `exports.X = …`
  // assignment.
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (ts.isVariableStatement(p) && hasExportModifier(p)) return true;
    if (ts.isClassDeclaration(p) && hasExportModifier(p)) return true;
    if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = p.left;
      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        (left.expression.text === "module" ||
          left.expression.text === "exports")
      ) {
        return true;
      }
    }
    if (ts.isExportAssignment(p)) return true;
    p = p.parent;
  }
  return false;
}

function hasLeadingDocComment(node: ts.Node, text: string): boolean {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart());
  if (!ranges) return false;
  return ranges.some(
    (r) =>
      r.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
      text.slice(r.pos, r.pos + 3) === "/**"
  );
}

// ── Test-coverage heuristic ─────────────────────────────────────────────────

const TEST_PATH_RX = [
  /(^|\/)tests?(\/|$)/i,
  /(^|\/)__tests__(\/|$)/,
  /(^|\/)spec(\/|$)/i,
  /\.(test|spec)\.[a-z]+$/i,
  /_test\.(js|jsx|ts|tsx|mjs|cjs)$/i,
  /\.test\.(js|jsx|ts|tsx|mjs|cjs)$/i,
];

/**
 * Build a set of "stems" that test files mention. A stem is the
 * basename of a test file with the `.test.` / `.spec.` segment and
 * the extension stripped, lowercased. So:
 *   tests/foo.test.ts    → "foo"
 *   src/__tests__/Bar.spec.tsx → "bar"
 *   foo_test.go          → ignored (not JS/TS, but harmless)
 *
 * A source file `src/lib/foo.ts` is considered "covered" when
 * `"foo"` is in this set. Coarse but matches conventional test
 * naming and keeps the heuristic lossy in the right direction
 * (more coverage credit, fewer false alarms).
 */
function collectTestStems(repo: ExtractedRepo): Set<string> {
  const stems = new Set<string>();
  for (const f of repo.files) {
    if (!TEST_PATH_RX.some((rx) => rx.test(f))) continue;
    const base = f.split("/").pop() ?? "";
    // Strip extension(s) and any .test / .spec qualifier.
    let stem = base.replace(/\.[^.]+$/, "");
    stem = stem
      .replace(/\.(test|spec)$/i, "")
      .replace(/_test$/i, "")
      .replace(/_spec$/i, "");
    if (stem) stems.add(stem.toLowerCase());
  }
  return stems;
}

// ── Misc helpers ────────────────────────────────────────────────────────────

function isParseable(filePath: string): boolean {
  // Skip generated / vendored code where AST data is misleading.
  if (/(^|\/)node_modules(\/|$)/.test(filePath)) return false;
  if (/(^|\/)dist(\/|$)/.test(filePath)) return false;
  if (/(^|\/)build(\/|$)/.test(filePath)) return false;
  if (/(^|\/)\.next(\/|$)/.test(filePath)) return false;
  if (/(^|\/)out(\/|$)/.test(filePath)) return false;
  if (/(^|\/)coverage(\/|$)/.test(filePath)) return false;
  if (/\.min\.(js|mjs|cjs)$/.test(filePath)) return false;
  if (/\.d\.ts$/.test(filePath)) return false; // declaration-only, no functions to score
  const ext = (filePath.split(".").pop() ?? "").toLowerCase();
  return PARSEABLE_EXT.has(ext);
}

function asc(a: number, b: number): number {
  return a - b;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length / 2)];
}

function p95(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * 0.95)];
}

// `fs` is imported only to keep this module self-contained for testing —
// not used by the public API path which goes through `readRepoFile`.
void fs;
