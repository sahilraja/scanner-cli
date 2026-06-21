import "server-only";
import { readRepoFile, type ExtractedRepo } from "./archive-walker";
import {
  emptyAttributesBag,
  pushAttribute,
  type RepoAttributesBag,
} from "./repo-attribute-types";

/**
 * Backend route / endpoint inventory.
 *
 * Detects three families of route definitions:
 *
 *   1. Express  — `router.METHOD(path, ...handlers)` /
 *                 `app.METHOD(path, ...handlers)` /
 *                 `router.use(prefix, sub)`.
 *   2. NestJS   — `@Controller('foo')` class with `@Get('bar')`,
 *                 `@Post(...)` etc. method decorators.
 *   3. Fastify  — `fastify.route({ method, url, handler })` or
 *                 `fastify.METHOD(url, handler)`.
 *
 * For each route we record the method, path, source location, the
 * tail of the handler chain (typically the controller call), and the
 * names of any preceding middleware. From the middleware names we
 * derive heuristic flags:
 *
 *   - `has_auth`        — middleware name contains "auth" or is one of
 *                         the well-known auth helpers.
 *   - `has_validate`    — middleware name contains "valid" or "schema".
 *   - `has_rate_limit`  — middleware name contains "rate" / "throttle"
 *                         or is one of the well-known limiters.
 *
 * Rolled-up signals feed Security ("routes without auth") and Test
 * Coverage ("routes covered by tests"); the per-route table is
 * surfaced in the UI.
 */

export type RouteRecord = {
  method: HttpMethod;
  path: string;
  file: string;
  line: number;
  handler: string | null;
  /** Names of middleware in the chain, in order. */
  middleware: string[];
  has_auth: boolean;
  has_validate: boolean;
  has_rate_limit: boolean;
  /** True if a matching `*.test.ts` / `*.spec.ts` file exists for this router file. */
  has_router_test: boolean;
  framework: "express" | "nestjs" | "fastify";
};

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "ALL"
  | "USE";

export type RepoRouteSignals = {
  total_routes: number;
  routes: RouteRecord[];
  by_method: Partial<Record<HttpMethod, number>>;
  by_framework: Partial<Record<RouteRecord["framework"], number>>;
  routes_without_auth: number;
  routes_without_validate: number;
  routes_without_rate_limit: number;
  routes_covered_by_tests: number;
  duplicate_paths: Array<{ method: HttpMethod; path: string; count: number }>;
  router_files: string[];
  /** True for routes pointing at obvious public marketing/landing endpoints. */
  public_routes: number;
  duration_ms: number;
  warnings: string[];
};

const SCANNER = "routes" as const;

const ROUTER_PATH_HINTS = [
  "/routes/",
  "/router/",
  "/routers/",
  "/controllers/",
  "/api/",
  "/handlers/",
];

const AUTH_HINTS =
  /(^|[._-])(auth|authenticate|requires?Auth|jwt|protected|portalAuth|verifyToken|adminOnly|isAuthed|ensureAuth|guard|passport)/i;
const VALIDATE_HINTS =
  /(^|[._-])(validate|validator|validation|schema|zod|joi|celebrate|yup|sanitiz)/i;
const RATE_HINTS =
  /(^|[._-])(rateLimit|rateLimiter|throttle|limiter|slowDown|rateLimiterMiddleware)/i;

function isParseableFile(p: string): boolean {
  if (
    p.endsWith(".ts") ||
    p.endsWith(".tsx") ||
    p.endsWith(".mts") ||
    p.endsWith(".cts") ||
    p.endsWith(".js") ||
    p.endsWith(".jsx") ||
    p.endsWith(".mjs")
  ) {
    return !p.includes("node_modules/") && !p.includes("/dist/") && !p.includes("/build/");
  }
  return false;
}

function looksLikeRouterFile(p: string): boolean {
  const lower = p.toLowerCase();
  if (lower.endsWith(".test.ts") || lower.endsWith(".spec.ts")) return false;
  if (lower.endsWith(".test.tsx") || lower.endsWith(".spec.tsx")) return false;
  if (lower.endsWith("/index.ts") || lower.endsWith("/main.ts")) return true;
  if (lower.includes(".routes.") || lower.includes(".controller.")) return true;
  return ROUTER_PATH_HINTS.some((h) => lower.includes(h));
}

function fileHasMatchingTest(repo: ExtractedRepo, filePath: string): boolean {
  const segs = filePath.split("/");
  const fname = segs[segs.length - 1];
  const dot = fname.lastIndexOf(".");
  const stem = dot === -1 ? fname : fname.slice(0, dot);
  const ext = dot === -1 ? "" : fname.slice(dot + 1);
  const candidates = [
    `${stem}.test.${ext}`,
    `${stem}.spec.${ext}`,
    `${stem}.test.ts`,
    `${stem}.spec.ts`,
  ];
  return repo.files.some((f) => {
    if (!candidates.some((c) => f.endsWith("/" + c) || f === c)) return false;
    return true;
  });
}

export function scanRepoRoutes(repo: ExtractedRepo): RepoRouteSignals {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const routes: RouteRecord[] = [];
  const routerFiles = new Set<string>();

  const candidates = repo.files.filter(
    (p) => isParseableFile(p) && looksLikeRouterFile(p)
  );

  for (const filePath of candidates) {
    const text = readRepoFile(repo, filePath, 256 * 1024);
    if (!text) continue;
    let added = 0;
    added += extractExpressRoutes(filePath, text, routes);
    added += extractNestRoutes(filePath, text, routes);
    added += extractFastifyRoutes(filePath, text, routes);
    if (added > 0) routerFiles.add(filePath);
  }

  // Per-route test coverage is heuristic: if the *router file* has a
  // `*.test.ts` sibling, all routes in it are considered "covered".
  // This is the most pragmatic signal we can compute without running
  // tests; finer per-route mapping would need import-graph analysis.
  const testCache = new Map<string, boolean>();
  for (const r of routes) {
    if (!testCache.has(r.file)) {
      testCache.set(r.file, fileHasMatchingTest(repo, r.file));
    }
    r.has_router_test = testCache.get(r.file) ?? false;
  }

  const by_method: Partial<Record<HttpMethod, number>> = {};
  const by_framework: Partial<Record<RouteRecord["framework"], number>> = {};
  let routesWithoutAuth = 0;
  let routesWithoutValidate = 0;
  let routesWithoutRateLimit = 0;
  let routesCoveredByTests = 0;
  let publicRoutes = 0;
  const dupKey = new Map<string, number>();

  for (const r of routes) {
    by_method[r.method] = (by_method[r.method] ?? 0) + 1;
    by_framework[r.framework] = (by_framework[r.framework] ?? 0) + 1;
    if (!r.has_auth) routesWithoutAuth += 1;
    if (!r.has_validate && (r.method === "POST" || r.method === "PUT" || r.method === "PATCH"))
      routesWithoutValidate += 1;
    if (!r.has_rate_limit) routesWithoutRateLimit += 1;
    if (r.has_router_test) routesCoveredByTests += 1;
    if (/\b(public|webhook|health|metrics|landing)\b/i.test(r.path)) publicRoutes += 1;
    const key = `${r.method} ${r.path}`;
    dupKey.set(key, (dupKey.get(key) ?? 0) + 1);
  }
  const duplicates: Array<{ method: HttpMethod; path: string; count: number }> = [];
  for (const [key, count] of dupKey) {
    if (count < 2) continue;
    const [methodPart, ...pathParts] = key.split(" ");
    duplicates.push({
      method: methodPart as HttpMethod,
      path: pathParts.join(" "),
      count,
    });
  }

  if (candidates.length > 0 && routes.length === 0) {
    warnings.push(
      `Scanned ${candidates.length} router-like files but extracted zero routes — framework may be unsupported.`
    );
  }

  return {
    total_routes: routes.length,
    routes,
    by_method,
    by_framework,
    routes_without_auth: routesWithoutAuth,
    routes_without_validate: routesWithoutValidate,
    routes_without_rate_limit: routesWithoutRateLimit,
    routes_covered_by_tests: routesCoveredByTests,
    duplicate_paths: duplicates,
    router_files: Array.from(routerFiles),
    public_routes: publicRoutes,
    duration_ms: Date.now() - startedAt,
    warnings,
  };
}

// ── Framework-specific extractors ─────────────────────────────────────

const EXPRESS_RX =
  /\b([a-zA-Z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|head|options|all|use)\s*\(\s*(['"`])([^'"`]+)\3\s*([\s\S]*?)\)\s*;?/g;

function extractExpressRoutes(
  file: string,
  text: string,
  out: RouteRecord[]
): number {
  let count = 0;
  EXPRESS_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPRESS_RX.exec(text)) !== null) {
    const objectName = m[1];
    const methodLower = m[2].toLowerCase();
    // Skip noise: console.get, response.use, etc.
    if (/^(console|logger|process|module|exports)$/.test(objectName)) continue;
    const method = methodLower.toUpperCase() as HttpMethod;
    // `app.use` and `router.use` express *mount points* — only capture
    // when the mount path is meaningful (starts with "/").
    const path = m[4];
    if (method === "USE" && !path.startsWith("/")) continue;
    const tail = m[5] ?? "";
    const middleware = parseHandlerChain(tail);
    const handler = middleware.length > 0 ? middleware[middleware.length - 1] : null;
    const middlewareOnly =
      middleware.length > 1 ? middleware.slice(0, -1) : middleware;
    out.push({
      method,
      path,
      file,
      line: lineForOffset(text, m.index ?? 0),
      handler,
      middleware: middlewareOnly,
      has_auth: middlewareOnly.some((n) => AUTH_HINTS.test(n)),
      has_validate: middlewareOnly.some((n) => VALIDATE_HINTS.test(n)),
      has_rate_limit: middlewareOnly.some((n) => RATE_HINTS.test(n)),
      has_router_test: false,
      framework: "express",
    });
    count += 1;
  }
  return count;
}

const NEST_CONTROLLER_RX =
  /@Controller\s*\(\s*(?:(['"`])([^'"`]*)\1)?\s*\)\s*[^{]*?(?:export\s+)?(?:default\s+)?class\s+([A-Z][\w$]*)/g;
const NEST_METHOD_DECORATOR_RX =
  /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/g;
const NEST_GUARD_RX = /@UseGuards\s*\(([^)]+)\)/g;
const NEST_PIPE_RX = /@UsePipes\s*\(([^)]+)\)/g;
const NEST_THROTTLE_RX = /@(Throttle|UseInterceptors)\s*\(([^)]+)\)/g;

function extractNestRoutes(
  file: string,
  text: string,
  out: RouteRecord[]
): number {
  let count = 0;
  NEST_CONTROLLER_RX.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = NEST_CONTROLLER_RX.exec(text)) !== null) {
    const ctrlPath = cm[2] ?? "";
    const ctrlClass = cm[3];
    // Find the class body braces and scan only inside them.
    const classStart = (cm.index ?? 0) + cm[0].length;
    const bodyStart = text.indexOf("{", classStart);
    if (bodyStart === -1) continue;
    const bodyEnd = matchingBraceEnd(text, bodyStart);
    if (bodyEnd === -1) continue;
    const body = text.slice(bodyStart, bodyEnd);

    NEST_METHOD_DECORATOR_RX.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = NEST_METHOD_DECORATOR_RX.exec(body)) !== null) {
      const method = mm[1].toUpperCase() as HttpMethod;
      const subPath = mm[3] ?? "";
      // Look at the surrounding decorator block (start of decorator
      // back to either previous method-end or class start) to detect
      // guards / pipes / throttle on this method.
      const window = body.slice(Math.max(0, (mm.index ?? 0) - 600), mm.index ?? 0);
      const guards = matchAllGroup(window, NEST_GUARD_RX, 1);
      const pipes = matchAllGroup(window, NEST_PIPE_RX, 1);
      const throttle = matchAllGroup(window, NEST_THROTTLE_RX, 2);
      const middleware: string[] = [];
      for (const g of guards) middleware.push(...splitNestNames(g));
      for (const p of pipes) middleware.push(...splitNestNames(p));
      for (const t of throttle) middleware.push(...splitNestNames(t));
      // Find the method handler name (the next identifier after the
      // closing parenthesis of the decorator).
      const tail = body.slice(mm.index ?? 0, (mm.index ?? 0) + 400);
      const hm = tail.match(
        /\)\s*(?:async\s+)?(?:public\s+|private\s+|protected\s+)?([a-zA-Z_$][\w$]*)\s*\(/
      );
      const handler = hm ? `${ctrlClass}.${hm[1]}` : ctrlClass;
      const fullPath = joinPath(ctrlPath, subPath);
      out.push({
        method,
        path: fullPath || "/",
        file,
        line: lineForOffset(text, bodyStart + (mm.index ?? 0)),
        handler,
        middleware,
        has_auth: middleware.some((n) => AUTH_HINTS.test(n)),
        has_validate: middleware.some((n) => VALIDATE_HINTS.test(n)),
        has_rate_limit: middleware.some((n) => RATE_HINTS.test(n)),
        has_router_test: false,
        framework: "nestjs",
      });
      count += 1;
    }
  }
  return count;
}

const FASTIFY_METHOD_RX =
  /\bfastify\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*(['"`])([^'"`]+)\2/g;
const FASTIFY_OBJECT_ROUTE_RX =
  /\bfastify\s*\.\s*route\s*\(\s*\{([\s\S]*?)\}\s*\)/g;

function extractFastifyRoutes(
  file: string,
  text: string,
  out: RouteRecord[]
): number {
  let count = 0;
  FASTIFY_METHOD_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FASTIFY_METHOD_RX.exec(text)) !== null) {
    const method = m[1].toUpperCase() as HttpMethod;
    out.push({
      method,
      path: m[3],
      file,
      line: lineForOffset(text, m.index ?? 0),
      handler: null,
      middleware: [],
      has_auth: false,
      has_validate: false,
      has_rate_limit: false,
      has_router_test: false,
      framework: "fastify",
    });
    count += 1;
  }
  FASTIFY_OBJECT_ROUTE_RX.lastIndex = 0;
  let om: RegExpExecArray | null;
  while ((om = FASTIFY_OBJECT_ROUTE_RX.exec(text)) !== null) {
    const body = om[1];
    const methodMatch = body.match(/method\s*:\s*['"`]([A-Z]+)['"`]/i);
    const urlMatch = body.match(/url\s*:\s*['"`]([^'"`]+)['"`]/);
    if (!methodMatch || !urlMatch) continue;
    out.push({
      method: methodMatch[1].toUpperCase() as HttpMethod,
      path: urlMatch[1],
      file,
      line: lineForOffset(text, om.index ?? 0),
      handler: null,
      middleware: [],
      has_auth: /preHandler\s*:\s*\[?[^\]]*auth/i.test(body),
      has_validate: /schema\s*:/i.test(body),
      has_rate_limit: /rateLimit/i.test(body),
      has_router_test: false,
      framework: "fastify",
    });
    count += 1;
  }
  return count;
}

// ── small helpers ─────────────────────────────────────────────────────

function lineForOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function matchingBraceEnd(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchAllGroup(text: string, rx: RegExp, group: number): string[] {
  rx.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    if (m[group]) out.push(m[group]);
  }
  return out;
}

function splitNestNames(arg: string): string[] {
  return arg
    .split(",")
    .map((s) => s.trim().replace(/[()]/g, "").replace(/^new\s+/, ""))
    .filter(Boolean);
}

function joinPath(a: string, b: string): string {
  const A = a ? "/" + a.replace(/^\/+/, "").replace(/\/+$/, "") : "";
  const B = b ? "/" + b.replace(/^\/+/, "").replace(/\/+$/, "") : "";
  const joined = (A + B).replace(/\/+/g, "/");
  return joined || (a || b ? "/" : "");
}

/**
 * Parse the tail of an `app.get('/', a, b, c.d)` expression into the
 * names used as middleware / final handler. We split on commas at
 * paren-depth zero and try to extract a readable identifier for each.
 */
function parseHandlerChain(tail: string): string[] {
  // Trim leading comma and surrounding whitespace.
  let s = tail.trim();
  if (s.startsWith(",")) s = s.slice(1);
  const args: string[] = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      if (buf.trim()) args.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) args.push(buf.trim());

  return args
    .map((a) => readableIdentifier(a))
    .filter((s): s is string => !!s);
}

function readableIdentifier(expr: string): string | null {
  const trimmed = expr.trim().replace(/[\s\n\r;]+$/g, "");
  if (!trimmed) return null;
  // arrow function — use first parenthesized identifier or "anonymous"
  if (/=>/.test(trimmed)) return "anonymous";
  // function call like `auth()` → "auth"
  const callMatch = trimmed.match(/^([\w$.]+)\s*\(/);
  if (callMatch) return callMatch[1];
  // identifier or member access
  const idMatch = trimmed.match(/^([\w$.]+)/);
  if (idMatch) return idMatch[1];
  return null;
}

// ── Attribute emission ────────────────────────────────────────────────

/**
 * Convert route-scan signals into score-affecting attribute rows.
 * Also scales the deltas to be reasonable in aggregate (no single
 * scanner should swing a dimension by more than ~2 points).
 */
export function routeAttributes(signals: RepoRouteSignals): RepoAttributesBag {
  const bag = emptyAttributesBag();
  const total = signals.total_routes;
  if (total === 0) return bag;

  // Security: route-level auth-middleware detection is intentionally
  // skipped from scoring. The static heuristic produces too many false
  // positives (auth applied at router setup, gateway / reverse-proxy
  // level, or via decorators we don't recognise). The underlying
  // `routes_without_auth` count is still computed and surfaced in the
  // structural-route signals payload for debugging — it just doesn't
  // emit an attribute (positive or negative) into the score breakdown.

  if (signals.routes_without_rate_limit / total >= 0.9 && total >= 10) {
    pushAttribute(bag, {
      category: "security",
      scanner: SCANNER,
      attribute_key: "no_rate_limit",
      attribute_value: signals.routes_without_rate_limit,
      attribute_label: "No rate-limit middleware on most routes",
      delta_to_score: -0.4,
      evidence: signals.routes
        .filter((r) => !r.has_rate_limit)
        .map((r) => `${r.method} ${r.path} (${r.file}:${r.line})`),
    });
  }

  // Code quality: validators on writes.
  const writeRoutes = signals.routes.filter((r) =>
    ["POST", "PUT", "PATCH"].includes(r.method)
  ).length;
  if (writeRoutes > 0) {
    const noValidate = signals.routes_without_validate;
    const ratio = noValidate / writeRoutes;
    if (ratio >= 0.5) {
      pushAttribute(bag, {
        category: "code_quality",
        scanner: SCANNER,
        attribute_key: "writes_without_validation",
        attribute_value: noValidate,
        attribute_label: `${noValidate}/${writeRoutes} write endpoints lack input validation`,
        delta_to_score: -0.6,
        evidence: signals.routes
          .filter(
            (r) =>
              ["POST", "PUT", "PATCH"].includes(r.method) && !r.has_validate
          )
          .map((r) => `${r.method} ${r.path} (${r.file}:${r.line})`),
      });
    } else if (ratio === 0) {
      pushAttribute(bag, {
        category: "code_quality",
        scanner: SCANNER,
        attribute_key: "all_writes_validated",
        attribute_value: 1,
        attribute_label: `All ${writeRoutes} write endpoints have validation middleware`,
        delta_to_score: +0.3,
        evidence: signals.routes
          .filter((r) => ["POST", "PUT", "PATCH"].includes(r.method))
          .map(
            (r) =>
              `${r.method} ${r.path} — ${r.middleware.join(" → ") || "(validated)"}`
          ),
      });
    }
  }

  // Code quality: duplicate paths.
  if (signals.duplicate_paths.length > 0) {
    pushAttribute(bag, {
      category: "code_quality",
      scanner: SCANNER,
      attribute_key: "duplicate_routes",
      attribute_value: signals.duplicate_paths.length,
      attribute_label: `${signals.duplicate_paths.length} duplicate route definition(s)`,
      delta_to_score: -0.4,
      evidence: signals.duplicate_paths.map(
        (d) => `${d.method} ${d.path} ×${d.count}`
      ),
    });
  }

  // Test coverage: router-file test mapping.
  if (signals.routes_covered_by_tests > 0) {
    const ratio = signals.routes_covered_by_tests / total;
    const testedRouterFiles = Array.from(
      new Set(
        signals.routes.filter((r) => r.has_router_test).map((r) => r.file)
      )
    ).slice(0, 10);
    if (ratio >= 0.7) {
      pushAttribute(bag, {
        category: "test_coverage",
        scanner: SCANNER,
        attribute_key: "routes_with_router_tests",
        attribute_value: ratio,
        attribute_label: `${signals.routes_covered_by_tests}/${total} routes live in tested router files`,
        delta_to_score: +0.6,
        evidence: testedRouterFiles,
      });
    } else if (ratio >= 0.3) {
      pushAttribute(bag, {
        category: "test_coverage",
        scanner: SCANNER,
        attribute_key: "routes_with_router_tests",
        attribute_value: ratio,
        attribute_label: `${signals.routes_covered_by_tests}/${total} routes in tested router files`,
        delta_to_score: +0.2,
        evidence: testedRouterFiles,
      });
    }
  }

  // Code quality: bare information attribute (always emitted) so the
  // analytics page can show "this project has N routes" even when no
  // delta was applied. The evidence carries the framework breakdown +
  // a sample of detected routes so it's not a black box.
  const sampleRoutes = signals.routes
    .slice(0, 12)
    .map((r) => `${r.method} ${r.path}  (${r.file}:${r.line})`);
  pushAttribute(bag, {
    category: "code_quality",
    scanner: SCANNER,
    attribute_key: "total_routes",
    attribute_value: total,
    attribute_label: `${total} HTTP route(s) detected (${Object.entries(signals.by_framework).map(([k, v]) => `${k}: ${v}`).join(", ")})`,
    delta_to_score: 0,
    evidence: {
      by_framework: signals.by_framework,
      by_method: signals.by_method,
      router_files: signals.router_files.slice(0, 10),
      sample: sampleRoutes,
    },
  });

  return bag;
}
