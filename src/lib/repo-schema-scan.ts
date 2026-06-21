import "server-only";
import { readRepoFile, type ExtractedRepo } from "./archive-walker";
import {
  emptyAttributesBag,
  pushAttribute,
  type RepoAttributesBag,
} from "./repo-attribute-types";

/**
 * DB schema + index audit.
 *
 * Walks the codebase looking for table / model definitions across the
 * popular database stacks and audits each one for index coverage. The
 * headline number is **tables_missing_indexes** — every table that has
 * zero non-PK indexes is listed by name so the user can act on the
 * report.
 *
 * Supported sources:
 *   1. Mongoose (`new Schema({...})`, `.index({...})`, `index: true`).
 *   2. Prisma (`model X { ... }`, `@@index([...])`, `@@unique([...])`).
 *   3. TypeORM (`@Entity` + `@Column` + `@Index`).
 *   4. Sequelize (`sequelize.define('name', {...}, { indexes })`,
 *      `Model.init({...}, {...})`).
 *   5. Knex / Kysely migrations
 *      (`knex.schema.createTable('users', t => { t.string(...).index() })`).
 *   6. Drizzle ORM (`pgTable / mysqlTable / sqliteTable`).
 *   7. Raw SQL (`*.sql`, `migrations/`, `supabase/migrations/`):
 *      `CREATE TABLE`, `CREATE [UNIQUE] INDEX`, `ALTER TABLE ... ADD
 *      [UNIQUE] INDEX/CONSTRAINT`. Handles double-quoted, backtick,
 *      and bracketed identifiers — covers Postgres / MySQL / MSSQL /
 *      SQLite / Supabase.
 *
 * For each model/table we also flag fields that look like foreign
 * keys (`*_id` / `userId` / `@relation`) or common lookups
 * (`email`, `slug`) but have no index.
 */

const SCANNER = "schema" as const;

const FK_NAME_RX =
  /(^|_)(?:user|tenant|org|organization|owner|account|project|customer|company|product|item|category|parent|target|reviewer|assignee|creator|author)(_id|Id)$/i;

const COMMON_INDEX_FIELDS = [
  "email",
  "username",
  "slug",
  "handle",
  "subdomain",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "deletedAt",
  "deleted_at",
];

export type SchemaSource =
  | "mongoose"
  | "prisma"
  | "typeorm"
  | "sequelize"
  | "knex"
  | "drizzle"
  | "sql";

export type SchemaModel = {
  name: string;
  source: SchemaSource;
  file: string;
  /** Database family when known (postgres / mysql / mssql / sqlite / mongo). */
  dialect: string | null;
  fields: SchemaField[];
  indexes: SchemaIndex[];
  /** True iff this model/table has at least one non-primary-key index. */
  has_non_pk_index: boolean;
};

export type SchemaField = {
  name: string;
  type: string;
  is_unique: boolean;
  is_indexed: boolean;
  is_foreign_key: boolean;
  is_primary: boolean;
};

export type SchemaIndex = {
  fields: string[];
  is_unique: boolean;
};

export type SchemaSignals = {
  models_found: number;
  models: SchemaModel[];
  by_source: Partial<Record<SchemaSource, number>>;
  total_indexes: number;
  total_fields: number;
  /** Fields that look like FKs / common-lookup fields but aren't indexed. */
  unindexed_lookup_fields: Array<{ model: string; field: string; reason: string }>;
  /** Names of tables/models with zero non-PK indexes (ALL of them, no cap). */
  tables_missing_indexes: string[];
  /** % of tables that have at least one non-PK index. */
  index_coverage_pct: number;
  /** Files we found schema definitions in. */
  schema_files: string[];
  duration_ms: number;
};

// ── helpers ───────────────────────────────────────────────────────────

function isParseable(p: string): boolean {
  if (
    !/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|prisma|sql)$/i.test(p) &&
    !p.endsWith(".prisma")
  )
    return false;
  if (p.includes("/node_modules/") || p.includes("/dist/") || p.includes("/build/"))
    return false;
  return true;
}

function looksUnique(name: string): boolean {
  return COMMON_INDEX_FIELDS.includes(name) || /(slug|email|handle|username)$/i.test(name);
}

function looksForeignKey(name: string): boolean {
  return FK_NAME_RX.test(name);
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

function matchingParenEnd(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Strip surrounding identifier quoting from a SQL identifier:
 *   `users` → users
 *   "users" → users
 *   [users] → users  (MSSQL)
 *   public.users → users
 */
function unquoteIdent(s: string): string {
  let v = s.trim();
  v = v.replace(/^[`"\[]/, "").replace(/[`"\]]$/, "");
  const dot = v.lastIndexOf(".");
  if (dot !== -1) v = v.slice(dot + 1).replace(/^[`"\[]/, "").replace(/[`"\]]$/, "");
  return v;
}

function recomputeFlags(m: SchemaModel): void {
  m.has_non_pk_index =
    m.indexes.length > 0 ||
    m.fields.some((f) => f.is_indexed && !f.is_primary);
}

// ── Prisma ────────────────────────────────────────────────────────────

const PRISMA_FIELD_RX =
  /^\s*(\w+)\s+([\w\[\]?@.()"']+(?:\s+@[^/\n]+)*)/gm;
const PRISMA_INDEX_RX = /^\s*@@(index|unique)\(\s*\[([^\]]+)\]/gm;

function parsePrismaSchema(file: string, text: string): SchemaModel[] {
  const out: SchemaModel[] = [];
  let idx = 0;
  for (;;) {
    const m = /^model\s+([A-Z][\w]*)\s*{/m.exec(text.slice(idx));
    if (!m) break;
    const start = idx + (m.index ?? 0);
    const openBrace = text.indexOf("{", start);
    const closeBrace = matchingBraceEnd(text, openBrace);
    if (closeBrace === -1) break;
    const body = text.slice(openBrace + 1, closeBrace);
    const fields: SchemaField[] = [];
    const indexes: SchemaIndex[] = [];

    PRISMA_FIELD_RX.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = PRISMA_FIELD_RX.exec(body)) !== null) {
      const name = fm[1];
      const rest = fm[2];
      if (name === "model" || name.startsWith("@@")) continue;
      const type = rest.split(/\s+/)[0] ?? "?";
      const isPrimary = /@id\b/.test(rest);
      const isUnique = /@unique\b/.test(rest);
      const hasRelation = /@relation\b/.test(rest);
      fields.push({
        name,
        type,
        is_unique: isUnique,
        is_indexed: isPrimary || isUnique,
        is_foreign_key: hasRelation || looksForeignKey(name),
        is_primary: isPrimary,
      });
    }
    PRISMA_INDEX_RX.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = PRISMA_INDEX_RX.exec(body)) !== null) {
      const isUnique = im[1] === "unique";
      const fieldsList = im[2]
        .split(",")
        .map((s) => s.trim().replace(/[\[\]]/g, ""))
        .filter(Boolean);
      indexes.push({ fields: fieldsList, is_unique: isUnique });
      for (const f of fieldsList) {
        const ref = fields.find((x) => x.name === f);
        if (ref) ref.is_indexed = true;
      }
    }

    const model: SchemaModel = {
      name: m[1],
      source: "prisma",
      file,
      dialect: null,
      fields,
      indexes,
      has_non_pk_index: false,
    };
    recomputeFlags(model);
    out.push(model);
    idx = closeBrace + 1;
  }
  return out;
}

// ── Mongoose ──────────────────────────────────────────────────────────

const MONGOOSE_NEW_SCHEMA_RX =
  /(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:mongoose\.)?Schema\s*\(\s*{/g;
const MONGOOSE_INDEX_CALL_RX =
  /(\w+)\s*\.\s*index\s*\(\s*\{([^}]*)\}\s*(?:,\s*\{([^}]*)\})?\s*\)/g;

function parseMongooseFields(body: string): SchemaField[] {
  const fields: SchemaField[] = [];
  let depth = 0;
  let pending = "";
  let inString: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (ch === inString && body[i - 1] !== "\\") inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === ":" && depth === 0) {
      const name = pending.trim();
      if (/^[a-zA-Z_$][\w$]*$/.test(name)) {
        const valueStart = i + 1;
        let valueEnd = valueStart;
        let d = 0;
        let str: string | null = null;
        for (let j = valueStart; j < body.length; j += 1) {
          const cj = body[j];
          if (str) {
            if (cj === str && body[j - 1] !== "\\") str = null;
            continue;
          }
          if (cj === "'" || cj === '"' || cj === "`") {
            str = cj;
            continue;
          }
          if (cj === "{" || cj === "[") d += 1;
          else if (cj === "}" || cj === "]") {
            d -= 1;
            if (d < 0) {
              valueEnd = j;
              break;
            }
          } else if (cj === "," && d === 0) {
            valueEnd = j;
            break;
          }
          valueEnd = j + 1;
        }
        const valueText = body.slice(valueStart, valueEnd);
        const isIndexed =
          /\bindex\s*:\s*true\b/.test(valueText) ||
          /\bunique\s*:\s*true\b/.test(valueText);
        const isUnique = /\bunique\s*:\s*true\b/.test(valueText);
        const refTypeMatch = valueText.match(/type\s*:\s*([\w.]+)/);
        const type = refTypeMatch ? refTypeMatch[1] : "?";
        fields.push({
          name,
          type,
          is_unique: isUnique,
          is_indexed: isIndexed,
          is_foreign_key:
            /\bref\s*:\s*['"`][^'"`]+['"`]/.test(valueText) ||
            looksForeignKey(name),
          is_primary: false,
        });
        i = valueEnd;
      }
      pending = "";
      continue;
    }
    if (ch === "," && depth === 0) {
      pending = "";
      continue;
    }
    pending += ch;
    if (pending.length > 200) pending = "";
  }
  return fields;
}

function parseMongooseFile(file: string, text: string): SchemaModel[] {
  const out: SchemaModel[] = [];
  MONGOOSE_NEW_SCHEMA_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MONGOOSE_NEW_SCHEMA_RX.exec(text)) !== null) {
    const varName = m[1];
    const openBrace = text.indexOf("{", (m.index ?? 0) + m[0].lastIndexOf("{"));
    const closeBrace = matchingBraceEnd(text, openBrace);
    if (closeBrace === -1) continue;
    const body = text.slice(openBrace + 1, closeBrace);
    const fields = parseMongooseFields(body);
    out.push({
      name: varName,
      source: "mongoose",
      file,
      dialect: "mongo",
      fields,
      indexes: [],
      has_non_pk_index: false,
    });
  }
  MONGOOSE_INDEX_CALL_RX.lastIndex = 0;
  let im: RegExpExecArray | null;
  while ((im = MONGOOSE_INDEX_CALL_RX.exec(text)) !== null) {
    const target = out.find((m2) => m2.name === im![1]);
    if (!target) continue;
    const fieldList = im[2]
      .split(",")
      .map((s) => s.split(":")[0].trim().replace(/['"`]/g, ""))
      .filter(Boolean);
    const opts = im[3] ?? "";
    const unique = /\bunique\s*:\s*true\b/.test(opts);
    target.indexes.push({ fields: fieldList, is_unique: unique });
    for (const f of fieldList) {
      const ref = target.fields.find((x) => x.name === f);
      if (ref) ref.is_indexed = true;
    }
  }
  for (const m of out) recomputeFlags(m);
  return out;
}

// ── TypeORM ───────────────────────────────────────────────────────────

const TYPEORM_ENTITY_RX =
  /@Entity\s*\(\s*[^)]*\)\s*[^{]*?(?:export\s+)?class\s+([A-Z]\w*)/g;
const TYPEORM_COLUMN_RX =
  /@(?:Column|PrimaryGeneratedColumn|PrimaryColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn)\s*\([^)]*\)\s*(\w+)\s*[!?]?\s*:/g;
const TYPEORM_INDEX_DECORATOR_RX =
  /@Index\s*\(\s*['"`]?([^'"`)]+)['"`]?\s*(?:,\s*\[([^\]]+)\])?\s*\)\s*(\w+)/g;

function parseTypeOrmFile(file: string, text: string): SchemaModel[] {
  const out: SchemaModel[] = [];
  TYPEORM_ENTITY_RX.lastIndex = 0;
  let em: RegExpExecArray | null;
  while ((em = TYPEORM_ENTITY_RX.exec(text)) !== null) {
    const className = em[1];
    const classBodyStart = text.indexOf("{", (em.index ?? 0) + em[0].length);
    if (classBodyStart === -1) continue;
    const classBodyEnd = matchingBraceEnd(text, classBodyStart);
    if (classBodyEnd === -1) continue;
    const body = text.slice(classBodyStart + 1, classBodyEnd);
    const fields: SchemaField[] = [];
    const indexes: SchemaIndex[] = [];

    TYPEORM_COLUMN_RX.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = TYPEORM_COLUMN_RX.exec(body)) !== null) {
      const name = cm[1];
      const declSlice = body.slice(
        Math.max(0, (cm.index ?? 0) - 200),
        cm.index ?? 0
      );
      const isPrimary = /@PrimaryGeneratedColumn|@PrimaryColumn/.test(declSlice);
      const isUnique = /@Column\([^)]*unique\s*:\s*true/.test(declSlice);
      const hasIndexAnnotation = /@Index\b/.test(declSlice);
      fields.push({
        name,
        type: "?",
        is_unique: isUnique,
        is_indexed: isPrimary || isUnique || hasIndexAnnotation,
        is_foreign_key:
          /@ManyToOne|@OneToMany|@OneToOne|@JoinColumn/.test(declSlice) ||
          looksForeignKey(name),
        is_primary: isPrimary,
      });
    }
    TYPEORM_INDEX_DECORATOR_RX.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = TYPEORM_INDEX_DECORATOR_RX.exec(body)) !== null) {
      const arr = dm[2];
      const target = dm[3];
      const list = arr
        ? arr.split(",").map((s) => s.trim().replace(/['"`]/g, ""))
        : [target];
      indexes.push({ fields: list, is_unique: false });
      for (const f of list) {
        const ref = fields.find((x) => x.name === f);
        if (ref) ref.is_indexed = true;
      }
    }

    const model: SchemaModel = {
      name: className,
      source: "typeorm",
      file,
      dialect: null,
      fields,
      indexes,
      has_non_pk_index: false,
    };
    recomputeFlags(model);
    out.push(model);
  }
  return out;
}

// ── Raw SQL (Postgres / MySQL / MSSQL / SQLite / Supabase) ────────────

const SQL_CREATE_TABLE_RX =
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[][^`"\]]+[`"\]]|[\w.]+)\s*\(/gi;
const SQL_CREATE_INDEX_RX =
  /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\[]?[\w.]+[`"\]]?\s+ON\s+([`"\[][^`"\]]+[`"\]]|[\w.]+)\s*\(([^)]+)\)/gi;
const SQL_ALTER_INDEX_RX =
  /\bALTER\s+TABLE\s+(?:ONLY\s+)?([`"\[][^`"\]]+[`"\]]|[\w.]+)\s+ADD\s+(?:CONSTRAINT\s+[`"\[]?[\w.]+[`"\]]?\s+)?(UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|INDEX|KEY)\s*[`"\[]?[\w.]*[`"\]]?\s*\(([^)]+)\)/gi;
const SQL_LINE_COMMENT_RX = /--[^\n]*/g;
const SQL_BLOCK_COMMENT_RX = /\/\*[\s\S]*?\*\//g;

function detectDialect(file: string, text: string): string | null {
  const lower = file.toLowerCase();
  if (lower.includes("/supabase/")) return "postgres";
  if (lower.includes("/postgres") || lower.includes("/pg/")) return "postgres";
  if (lower.includes("/mysql")) return "mysql";
  if (lower.includes("/mssql") || lower.includes("/sqlserver"))
    return "mssql";
  if (lower.includes("/sqlite")) return "sqlite";
  // Heuristics on the SQL itself.
  if (/\bSERIAL\b|\bUUID\s+DEFAULT|\bRETURNING\b|::\w+/i.test(text))
    return "postgres";
  if (/\bAUTO_INCREMENT\b|\bENGINE\s*=\s*InnoDB\b/i.test(text)) return "mysql";
  if (/\bIDENTITY\s*\(/i.test(text) || /NVARCHAR\b/i.test(text)) return "mssql";
  if (/\bAUTOINCREMENT\b/i.test(text)) return "sqlite";
  return null;
}

/**
 * Parse the body of a CREATE TABLE block (the text between the
 * opening and matching closing parenthesis) into a list of fields
 * and inline indexes.
 */
function parseSqlTableBody(
  body: string
): { fields: SchemaField[]; indexes: SchemaIndex[] } {
  const fields: SchemaField[] = [];
  const indexes: SchemaIndex[] = [];

  // Split on commas at paren-depth zero, ignoring strings.
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  let inStr: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inStr) {
      if (ch === inStr && body[i - 1] !== "\\") inStr = null;
      buf += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inStr = ch;
      buf += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      if (buf.trim()) parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());

  for (const raw of parts) {
    const partUpper = raw.toUpperCase();

    // Table-level constraints.
    if (
      /^PRIMARY\s+KEY\s*\(/.test(partUpper) ||
      /^CONSTRAINT\s+\S+\s+PRIMARY\s+KEY\s*\(/.test(partUpper)
    ) {
      const cols = extractParenList(raw);
      for (const c of cols) {
        const ref = fields.find((f) => f.name === c);
        if (ref) {
          ref.is_primary = true;
          ref.is_indexed = true;
        }
      }
      continue;
    }
    if (
      /^UNIQUE\s*(KEY|INDEX)?\s*\S*\s*\(/.test(partUpper) ||
      /^CONSTRAINT\s+\S+\s+UNIQUE\s*\(/.test(partUpper)
    ) {
      const cols = extractParenList(raw);
      indexes.push({ fields: cols, is_unique: true });
      for (const c of cols) {
        const ref = fields.find((f) => f.name === c);
        if (ref) {
          ref.is_indexed = true;
          ref.is_unique = true;
        }
      }
      continue;
    }
    if (/^(KEY|INDEX|FULLTEXT|SPATIAL)\s*\S*\s*\(/.test(partUpper)) {
      const cols = extractParenList(raw);
      indexes.push({ fields: cols, is_unique: false });
      for (const c of cols) {
        const ref = fields.find((f) => f.name === c);
        if (ref) ref.is_indexed = true;
      }
      continue;
    }
    if (/^FOREIGN\s+KEY\s*\(/.test(partUpper) || /^CONSTRAINT\s+\S+\s+FOREIGN\s+KEY/.test(partUpper)) {
      const cols = extractParenList(raw);
      for (const c of cols) {
        const ref = fields.find((f) => f.name === c);
        if (ref) ref.is_foreign_key = true;
      }
      continue;
    }
    if (/^CHECK\b/.test(partUpper) || /^CONSTRAINT\s+\S+\s+CHECK/.test(partUpper))
      continue;
    if (/^PERIOD\b|^EXCLUDE\b/.test(partUpper)) continue;

    // Column definition: <name> <type> [...inline modifiers].
    const colMatch = raw.match(/^([`"\[]?)([\w.]+)\1\s+([^\s,]+)/);
    if (!colMatch) continue;
    const name = unquoteIdent(colMatch[2]);
    const type = colMatch[3];
    const restUpper = raw.slice(colMatch[0].length).toUpperCase();
    const isPrimary = /\bPRIMARY\s+KEY\b/.test(restUpper);
    const isUnique = /\bUNIQUE\b/.test(restUpper);
    const isFkInline = /\bREFERENCES\b/.test(restUpper);
    fields.push({
      name,
      type,
      is_unique: isUnique,
      is_indexed: isPrimary || isUnique,
      is_foreign_key: isFkInline || looksForeignKey(name),
      is_primary: isPrimary,
    });
  }

  return { fields, indexes };
}

function extractParenList(text: string): string[] {
  const m = text.match(/\(([^)]+)\)/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => unquoteIdent(s.split(/\s+/)[0]))
    .filter(Boolean);
}

function parseSqlFile(file: string, rawText: string): SchemaModel[] {
  // Strip comments before pattern-matching so "-- CREATE INDEX foo" doesn't
  // leak into the index list.
  const text = rawText
    .replace(SQL_BLOCK_COMMENT_RX, " ")
    .replace(SQL_LINE_COMMENT_RX, " ");

  const dialect = detectDialect(file, text);
  const byName = new Map<string, SchemaModel>();

  // CREATE TABLE bodies.
  SQL_CREATE_TABLE_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SQL_CREATE_TABLE_RX.exec(text)) !== null) {
    const tableName = unquoteIdent(m[1]);
    if (!tableName) continue;
    const openParen = (m.index ?? 0) + m[0].length - 1;
    const closeParen = matchingParenEnd(text, openParen);
    if (closeParen === -1) continue;
    const body = text.slice(openParen + 1, closeParen);
    const { fields, indexes } = parseSqlTableBody(body);
    const existing = byName.get(tableName);
    if (existing) {
      // Same table referenced twice (unlikely but happens with
      // partitioned schemas) — merge.
      for (const f of fields)
        if (!existing.fields.find((x) => x.name === f.name))
          existing.fields.push(f);
      existing.indexes.push(...indexes);
    } else {
      const model: SchemaModel = {
        name: tableName,
        source: "sql",
        file,
        dialect,
        fields,
        indexes,
        has_non_pk_index: false,
      };
      byName.set(tableName, model);
    }
  }

  // CREATE [UNIQUE] INDEX ... ON ...
  SQL_CREATE_INDEX_RX.lastIndex = 0;
  while ((m = SQL_CREATE_INDEX_RX.exec(text)) !== null) {
    const tableName = unquoteIdent(m[2]);
    const cols = m[3]
      .split(",")
      .map((s) => unquoteIdent(s.split(/\s+/)[0]))
      .filter(Boolean);
    const isUnique = !!m[1];
    const target = byName.get(tableName);
    if (target) {
      target.indexes.push({ fields: cols, is_unique: isUnique });
      for (const c of cols) {
        const ref = target.fields.find((f) => f.name === c);
        if (ref) ref.is_indexed = true;
      }
    } else {
      // Index for a table we haven't seen the CREATE for (probably in
      // a separate migration file). Stash a placeholder so the index
      // is still counted globally.
      byName.set(tableName, {
        name: tableName,
        source: "sql",
        file,
        dialect,
        fields: [],
        indexes: [{ fields: cols, is_unique: isUnique }],
        has_non_pk_index: false,
      });
    }
  }

  // ALTER TABLE ... ADD INDEX / UNIQUE / PRIMARY KEY / FOREIGN KEY
  SQL_ALTER_INDEX_RX.lastIndex = 0;
  while ((m = SQL_ALTER_INDEX_RX.exec(text)) !== null) {
    const tableName = unquoteIdent(m[1]);
    const kind = m[2].toUpperCase().replace(/\s+/g, " ");
    const cols = m[3]
      .split(",")
      .map((s) => unquoteIdent(s.split(/\s+/)[0]))
      .filter(Boolean);
    const target = byName.get(tableName);
    if (!target) continue;
    if (/PRIMARY\s+KEY/.test(kind)) {
      for (const c of cols) {
        const ref = target.fields.find((f) => f.name === c);
        if (ref) {
          ref.is_primary = true;
          ref.is_indexed = true;
        }
      }
      continue;
    }
    if (/FOREIGN\s+KEY/.test(kind)) {
      for (const c of cols) {
        const ref = target.fields.find((f) => f.name === c);
        if (ref) ref.is_foreign_key = true;
      }
      continue;
    }
    target.indexes.push({ fields: cols, is_unique: kind === "UNIQUE" });
    for (const c of cols) {
      const ref = target.fields.find((f) => f.name === c);
      if (ref) {
        ref.is_indexed = true;
        if (kind === "UNIQUE") ref.is_unique = true;
      }
    }
  }

  const out = Array.from(byName.values());
  for (const m2 of out) recomputeFlags(m2);
  return out;
}

// ── Sequelize ─────────────────────────────────────────────────────────

const SEQ_DEFINE_RX =
  /\b(?:[\w.]+)\.define\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/g;
const SEQ_INIT_RX =
  /\bclass\s+(\w+)\s+extends\s+(?:[\w.]+\.)?Model[^{]*\{[\s\S]*?\}\s*([\s\S]*?\.\s*init\s*\(\s*\{)/g;

function parseSequelizeFile(file: string, text: string): SchemaModel[] {
  const out: SchemaModel[] = [];

  // sequelize.define('name', { ... }, { indexes: [...] })
  SEQ_DEFINE_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEQ_DEFINE_RX.exec(text)) !== null) {
    const tableName = m[1];
    const fieldsBraceStart = (m.index ?? 0) + m[0].length - 1;
    const fieldsBraceEnd = matchingBraceEnd(text, fieldsBraceStart);
    if (fieldsBraceEnd === -1) continue;
    const fieldsBody = text.slice(fieldsBraceStart + 1, fieldsBraceEnd);
    const fields = parseSequelizeFields(fieldsBody);
    // After the field block, the optional options object may carry an
    // `indexes: [...]` list. Look ahead until the matching closing
    // paren of the define(...) call.
    const callEnd = findCallEnd(text, m.index ?? 0);
    const optionsRegion = text.slice(fieldsBraceEnd + 1, callEnd);
    const indexes = parseSequelizeIndexes(optionsRegion, fields);

    const model: SchemaModel = {
      name: tableName,
      source: "sequelize",
      file,
      dialect: null,
      fields,
      indexes,
      has_non_pk_index: false,
    };
    recomputeFlags(model);
    out.push(model);
  }

  // class X extends Model { ... } X.init({ ... }, { ... })
  SEQ_INIT_RX.lastIndex = 0;
  while ((m = SEQ_INIT_RX.exec(text)) !== null) {
    const className = m[1];
    const lastBraceIdx = (m.index ?? 0) + m[0].length - 1;
    const fieldsBraceEnd = matchingBraceEnd(text, lastBraceIdx);
    if (fieldsBraceEnd === -1) continue;
    const fieldsBody = text.slice(lastBraceIdx + 1, fieldsBraceEnd);
    const fields = parseSequelizeFields(fieldsBody);
    const callEnd = findCallEnd(text, m.index ?? 0);
    const optionsRegion = text.slice(fieldsBraceEnd + 1, callEnd);
    const indexes = parseSequelizeIndexes(optionsRegion, fields);

    const model: SchemaModel = {
      name: className,
      source: "sequelize",
      file,
      dialect: null,
      fields,
      indexes,
      has_non_pk_index: false,
    };
    recomputeFlags(model);
    out.push(model);
  }

  return out;
}

function findCallEnd(text: string, callStart: number): number {
  // Find the matching `)` of the `(` after the call name.
  const openParen = text.indexOf("(", callStart);
  if (openParen === -1) return text.length;
  const close = matchingParenEnd(text, openParen);
  return close === -1 ? text.length : close;
}

function parseSequelizeFields(body: string): SchemaField[] {
  const fields: SchemaField[] = [];
  let depth = 0;
  let pending = "";
  let inString: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (ch === inString && body[i - 1] !== "\\") inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === ":" && depth === 0) {
      const name = pending.trim();
      if (/^[a-zA-Z_$][\w$]*$/.test(name)) {
        const valueStart = i + 1;
        let valueEnd = valueStart;
        let d = 0;
        let str: string | null = null;
        for (let j = valueStart; j < body.length; j += 1) {
          const cj = body[j];
          if (str) {
            if (cj === str && body[j - 1] !== "\\") str = null;
            continue;
          }
          if (cj === "'" || cj === '"' || cj === "`") {
            str = cj;
            continue;
          }
          if (cj === "{" || cj === "[" || cj === "(") d += 1;
          else if (cj === "}" || cj === "]" || cj === ")") {
            d -= 1;
            if (d < 0) {
              valueEnd = j;
              break;
            }
          } else if (cj === "," && d === 0) {
            valueEnd = j;
            break;
          }
          valueEnd = j + 1;
        }
        const valueText = body.slice(valueStart, valueEnd);
        const upper = valueText.toUpperCase();
        const isPrimary = /\bPRIMARYKEY\s*:\s*TRUE\b/.test(
          upper.replace(/\s+/g, "")
        );
        const isUnique =
          /\bUNIQUE\s*:\s*TRUE\b/.test(upper) ||
          /\bUNIQUE\s*:\s*['"]/.test(valueText);
        const isFk = /\bREFERENCES\s*:\s*\{/.test(valueText);
        const typeMatch = valueText.match(/type\s*:\s*([\w.]+)/);
        fields.push({
          name,
          type: typeMatch ? typeMatch[1] : "?",
          is_unique: isUnique,
          is_indexed: isPrimary || isUnique,
          is_foreign_key: isFk || looksForeignKey(name),
          is_primary: isPrimary,
        });
        i = valueEnd;
      }
      pending = "";
      continue;
    }
    if (ch === "," && depth === 0) {
      pending = "";
      continue;
    }
    pending += ch;
    if (pending.length > 200) pending = "";
  }
  return fields;
}

function parseSequelizeIndexes(
  optionsRegion: string,
  fields: SchemaField[]
): SchemaIndex[] {
  const indexes: SchemaIndex[] = [];
  // Look for indexes: [ { fields: [...], unique: true }, ... ]
  const indexBlock = optionsRegion.match(/indexes\s*:\s*\[([\s\S]*?)\]/);
  if (!indexBlock) return indexes;
  const body = indexBlock[1];
  // Split entries on top-level commas at depth 0.
  const entries: string[] = [];
  let depth = 0;
  let buf = "";
  let inStr: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inStr) {
      if (ch === inStr && body[i - 1] !== "\\") inStr = null;
      buf += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inStr = ch;
      buf += ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      if (buf.trim()) entries.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) entries.push(buf.trim());
  for (const e of entries) {
    const fieldsList = e.match(/fields\s*:\s*\[([^\]]+)\]/);
    if (!fieldsList) continue;
    const cols = fieldsList[1]
      .split(",")
      .map((s) => s.trim().replace(/['"`]/g, ""))
      .filter(Boolean);
    const isUnique = /\bunique\s*:\s*true\b/.test(e);
    indexes.push({ fields: cols, is_unique: isUnique });
    for (const c of cols) {
      const ref = fields.find((f) => f.name === c);
      if (ref) {
        ref.is_indexed = true;
        if (isUnique) ref.is_unique = true;
      }
    }
  }
  return indexes;
}

// ── Knex / Kysely migrations ──────────────────────────────────────────

const KNEX_CREATE_TABLE_RX =
  /\b(?:knex|this|db)\.schema\s*(?:\.\w+\([^)]*\))*\s*\.\s*createTable(?:IfNotExists)?\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:async\s*)?\(?\s*([\w$]+)\s*\)?\s*=>\s*\{/g;

function parseKnexFile(file: string, text: string): SchemaModel[] {
  const out: SchemaModel[] = [];
  KNEX_CREATE_TABLE_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KNEX_CREATE_TABLE_RX.exec(text)) !== null) {
    const tableName = m[1];
    const tableArg = m[2];
    const bodyStart = (m.index ?? 0) + m[0].length - 1;
    const bodyEnd = matchingBraceEnd(text, bodyStart);
    if (bodyEnd === -1) continue;
    const body = text.slice(bodyStart + 1, bodyEnd);

    const fields: SchemaField[] = [];
    const indexes: SchemaIndex[] = [];

    // table.<type>('col', ...).<modifier>().<modifier>()...
    // Common types: increments, bigIncrements, integer, bigInteger,
    // string, text, uuid, boolean, json, jsonb, decimal, timestamps.
    const tableArgEsc = tableArg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const colRx = new RegExp(
      `\\b${tableArgEsc}\\s*\\.\\s*(\\w+)\\s*\\(\\s*(?:['"\`]([^'"\`]+)['"\`])?([^;\\n]*?)(?=\\n|;|$)`,
      "g"
    );
    let cm: RegExpExecArray | null;
    while ((cm = colRx.exec(body)) !== null) {
      const type = cm[1];
      const name = cm[2];
      const tail = cm[3];
      const upper = `${type} ${tail}`.toUpperCase();
      const isPrimary =
        /\bPRIMARY\s*\(\s*\)/.test(upper) ||
        /\b(INCREMENTS|BIGINCREMENTS)\b/.test(upper);
      const isUnique = /\bUNIQUE\s*\(/.test(upper);
      const hasIndex = /\bINDEX\s*\(/.test(upper);
      const isFkChain = /\bREFERENCES\s*\(/.test(upper);
      // table.timestamps() / table.dropTimestamps() — emit nothing.
      if (!name && /^TIMESTAMPS|^DROPTIMESTAMPS|^COMMENT|^ENGINE/i.test(type))
        continue;
      // table.primary([...]) / table.unique([...]) / table.index([...])
      if (!name && /^(PRIMARY|UNIQUE|INDEX)$/i.test(type)) {
        const arr = tail.match(/\[([^\]]+)\]/);
        if (!arr) continue;
        const cols = arr[1]
          .split(",")
          .map((s) => s.trim().replace(/['"`]/g, ""))
          .filter(Boolean);
        if (/^PRIMARY$/i.test(type)) {
          for (const c of cols) {
            const ref = fields.find((f) => f.name === c);
            if (ref) {
              ref.is_primary = true;
              ref.is_indexed = true;
            }
          }
        } else {
          indexes.push({ fields: cols, is_unique: /^UNIQUE$/i.test(type) });
          for (const c of cols) {
            const ref = fields.find((f) => f.name === c);
            if (ref) ref.is_indexed = true;
          }
        }
        continue;
      }
      if (!name) continue;
      fields.push({
        name,
        type,
        is_unique: isUnique,
        is_indexed: isPrimary || isUnique || hasIndex,
        is_foreign_key: isFkChain || looksForeignKey(name),
        is_primary: isPrimary,
      });
      if (hasIndex) indexes.push({ fields: [name], is_unique: false });
      if (isUnique) indexes.push({ fields: [name], is_unique: true });
    }

    const model: SchemaModel = {
      name: tableName,
      source: "knex",
      file,
      dialect: null,
      fields,
      indexes,
      has_non_pk_index: false,
    };
    recomputeFlags(model);
    out.push(model);
  }
  return out;
}

// ── Drizzle ORM ───────────────────────────────────────────────────────

const DRIZZLE_TABLE_RX =
  /\b(?:export\s+const|const)\s+(\w+)\s*=\s*(pgTable|mysqlTable|sqliteTable|mssqlTable)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/g;

function parseDrizzleFile(file: string, text: string): SchemaModel[] {
  const out: SchemaModel[] = [];
  DRIZZLE_TABLE_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DRIZZLE_TABLE_RX.exec(text)) !== null) {
    const tableName = m[3];
    const factory = m[2];
    const dialect =
      factory === "pgTable"
        ? "postgres"
        : factory === "mysqlTable"
          ? "mysql"
          : factory === "sqliteTable"
            ? "sqlite"
            : factory === "mssqlTable"
              ? "mssql"
              : null;
    const colsBraceStart = (m.index ?? 0) + m[0].length - 1;
    const colsBraceEnd = matchingBraceEnd(text, colsBraceStart);
    if (colsBraceEnd === -1) continue;
    const colsBody = text.slice(colsBraceStart + 1, colsBraceEnd);
    const fields: SchemaField[] = [];
    // Each column: name: typeFn('col_name', ...).primaryKey().unique()...
    const colRx = /\b(\w+)\s*:\s*(\w+)\s*\(\s*['"`]?([^'"`,)]*)['"`]?\s*([^,\n]*)/g;
    let cm: RegExpExecArray | null;
    while ((cm = colRx.exec(colsBody)) !== null) {
      const propName = cm[1];
      const typeFn = cm[2];
      // Drizzle types include: serial, integer, bigint, text, varchar,
      // boolean, timestamp, uuid, etc. Skip generic JS keywords.
      if (/^(if|else|for|return|const|let|var)$/.test(typeFn)) continue;
      const tail = cm[4] ?? "";
      const upper = tail.toUpperCase();
      const isPrimary =
        /\.PRIMARYKEY\(/.test(upper.replace(/\s+/g, "")) ||
        /\bSERIAL\b/.test(typeFn.toUpperCase());
      const isUnique = /\.UNIQUE\(/.test(upper.replace(/\s+/g, ""));
      const isFk = /\.REFERENCES\(/.test(upper.replace(/\s+/g, ""));
      fields.push({
        name: propName,
        type: typeFn,
        is_unique: isUnique,
        is_indexed: isPrimary || isUnique,
        is_foreign_key: isFk || looksForeignKey(propName),
        is_primary: isPrimary,
      });
    }

    // Optional second-arg callback: (table) => ({ idx: index('foo').on(...) })
    const indexes: SchemaIndex[] = [];
    const callEnd = findCallEnd(text, m.index ?? 0);
    const optionsRegion = text.slice(colsBraceEnd + 1, callEnd);
    const idxRx =
      /\b(uniqueIndex|index)\s*\(\s*['"`]?([^'"`,)]*)['"`]?\s*\)\s*\.\s*on\s*\(([^)]+)\)/g;
    let im: RegExpExecArray | null;
    while ((im = idxRx.exec(optionsRegion)) !== null) {
      const isUnique = im[1] === "uniqueIndex";
      const cols = im[3]
        .split(",")
        .map((s) => s.trim().replace(/^.*\./, "").replace(/[`"'\)]/g, ""))
        .filter(Boolean);
      indexes.push({ fields: cols, is_unique: isUnique });
      for (const c of cols) {
        const ref = fields.find((f) => f.name === c);
        if (ref) {
          ref.is_indexed = true;
          if (isUnique) ref.is_unique = true;
        }
      }
    }

    const model: SchemaModel = {
      name: tableName,
      source: "drizzle",
      file,
      dialect,
      fields,
      indexes,
      has_non_pk_index: false,
    };
    recomputeFlags(model);
    out.push(model);
  }
  return out;
}

// ── Public entry point ────────────────────────────────────────────────

const MAX_TABLES_IN_LABEL = 30;

export function scanRepoSchema(repo: ExtractedRepo): SchemaSignals {
  const startedAt = Date.now();
  const allModels: SchemaModel[] = [];
  const schemaFiles = new Set<string>();

  for (const filePath of repo.files) {
    if (!isParseable(filePath)) continue;
    if (filePath.endsWith(".prisma")) {
      const text = readRepoFile(repo, filePath, 256 * 1024);
      if (!text) continue;
      const models = parsePrismaSchema(filePath, text);
      if (models.length) {
        schemaFiles.add(filePath);
        allModels.push(...models);
      }
      continue;
    }
    if (filePath.toLowerCase().endsWith(".sql")) {
      const text = readRepoFile(repo, filePath, 512 * 1024);
      if (!text) continue;
      const models = parseSqlFile(filePath, text);
      if (models.length) {
        schemaFiles.add(filePath);
        allModels.push(...models);
      }
      continue;
    }
    const text = readRepoFile(repo, filePath, 256 * 1024);
    if (!text) continue;
    const looksMongoose = /new\s+(mongoose\.)?Schema\s*\(/.test(text);
    const looksTypeOrm = /@Entity\s*\(/.test(text);
    const looksSequelize =
      /\.define\s*\(\s*['"`]/.test(text) ||
      /extends\s+(?:[\w.]+\.)?Model\b/.test(text);
    const looksKnex = /\.schema\s*\.\s*createTable(?:IfNotExists)?\s*\(/.test(text);
    const looksDrizzle = /\b(pgTable|mysqlTable|sqliteTable|mssqlTable)\s*\(/.test(text);
    if (
      !looksMongoose &&
      !looksTypeOrm &&
      !looksSequelize &&
      !looksKnex &&
      !looksDrizzle
    )
      continue;

    if (looksMongoose) {
      const models = parseMongooseFile(filePath, text);
      if (models.length) {
        schemaFiles.add(filePath);
        allModels.push(...models);
      }
    }
    if (looksTypeOrm) {
      const models = parseTypeOrmFile(filePath, text);
      if (models.length) {
        schemaFiles.add(filePath);
        allModels.push(...models);
      }
    }
    if (looksSequelize) {
      const models = parseSequelizeFile(filePath, text);
      if (models.length) {
        schemaFiles.add(filePath);
        allModels.push(...models);
      }
    }
    if (looksKnex) {
      const models = parseKnexFile(filePath, text);
      if (models.length) {
        schemaFiles.add(filePath);
        allModels.push(...models);
      }
    }
    if (looksDrizzle) {
      const models = parseDrizzleFile(filePath, text);
      if (models.length) {
        schemaFiles.add(filePath);
        allModels.push(...models);
      }
    }
  }

  // Merge same-named tables from different sources / files. SQL
  // migrations frequently arrive as one CREATE TABLE in file A and
  // then ALTER TABLE in file B; we already merged inside one file
  // but cross-file matches need handling here.
  const merged = mergeSameNameModels(allModels);

  const unindexed: SchemaSignals["unindexed_lookup_fields"] = [];
  const tablesMissingIndexes: string[] = [];
  let totalIdx = 0;
  let totalFields = 0;
  const bySource: Partial<Record<SchemaSource, number>> = {};
  for (const m of merged) {
    bySource[m.source] = (bySource[m.source] ?? 0) + 1;
    totalIdx += m.indexes.length;
    totalFields += m.fields.length;
    if (!m.has_non_pk_index) tablesMissingIndexes.push(m.name);
    for (const f of m.fields) {
      if (f.is_primary || f.is_indexed) continue;
      if (f.is_foreign_key) {
        unindexed.push({
          model: m.name,
          field: f.name,
          reason: "looks like a foreign key (suffix _id / Id / @relation / REFERENCES)",
        });
      } else if (looksUnique(f.name)) {
        unindexed.push({
          model: m.name,
          field: f.name,
          reason: "common lookup / sort field",
        });
      }
    }
  }

  const indexCoveragePct =
    merged.length > 0
      ? Math.round(((merged.length - tablesMissingIndexes.length) / merged.length) * 100)
      : 0;

  return {
    models_found: merged.length,
    models: merged,
    by_source: bySource,
    total_indexes: totalIdx,
    total_fields: totalFields,
    unindexed_lookup_fields: unindexed,
    tables_missing_indexes: tablesMissingIndexes,
    index_coverage_pct: indexCoveragePct,
    schema_files: Array.from(schemaFiles),
    duration_ms: Date.now() - startedAt,
  };
}

function mergeSameNameModels(input: SchemaModel[]): SchemaModel[] {
  const byName = new Map<string, SchemaModel>();
  for (const m of input) {
    const existing = byName.get(m.name);
    if (!existing) {
      byName.set(m.name, m);
      continue;
    }
    // Same table seen twice — merge fields and indexes. Prefer the
    // existing source label but report the multi-file location.
    for (const f of m.fields) {
      if (!existing.fields.find((x) => x.name === f.name)) {
        existing.fields.push(f);
      } else {
        const ref = existing.fields.find((x) => x.name === f.name)!;
        ref.is_primary ||= f.is_primary;
        ref.is_unique ||= f.is_unique;
        ref.is_indexed ||= f.is_indexed;
        ref.is_foreign_key ||= f.is_foreign_key;
      }
    }
    existing.indexes.push(...m.indexes);
    if (!existing.dialect && m.dialect) existing.dialect = m.dialect;
  }
  const out = Array.from(byName.values());
  for (const m of out) recomputeFlags(m);
  return out;
}

export function schemaAttributes(s: SchemaSignals): RepoAttributesBag {
  const bag = emptyAttributesBag();
  if (s.models_found === 0) return bag;

  // Headline attribute: tables missing indexes. ALWAYS emitted (even
  // when zero) so the analytics page can show "0 tables missing
  // indexes" as a green pill across projects.
  if (s.tables_missing_indexes.length > 0) {
    const sample = s.tables_missing_indexes
      .slice(0, MAX_TABLES_IN_LABEL)
      .join(", ");
    const more =
      s.tables_missing_indexes.length > MAX_TABLES_IN_LABEL
        ? ` … +${s.tables_missing_indexes.length - MAX_TABLES_IN_LABEL} more`
        : "";
    pushAttribute(bag, {
      category: "performance",
      scanner: SCANNER,
      attribute_key: "tables_missing_indexes",
      attribute_value: s.tables_missing_indexes.length,
      attribute_label:
        `${s.tables_missing_indexes.length}/${s.models_found} tables have no non-PK index — ` +
        `missing: ${sample}${more}`,
      delta_to_score: -Math.min(
        2.0,
        0.4 + s.tables_missing_indexes.length * 0.15
      ),
      evidence: s.tables_missing_indexes,
    });
  } else {
    pushAttribute(bag, {
      category: "performance",
      scanner: SCANNER,
      attribute_key: "all_tables_indexed",
      attribute_value: 1,
      attribute_label: `All ${s.models_found} tables have at least one non-PK index`,
      delta_to_score: +0.8,
      evidence: {
        models_found: s.models_found,
        total_indexes: s.total_indexes,
        index_coverage_pct: s.index_coverage_pct,
        sample_models: s.models
          .slice(0, 12)
          .map((m) => `${m.source}:${m.name}`),
      },
    });
  }

  if (s.unindexed_lookup_fields.length > 0) {
    pushAttribute(bag, {
      category: "performance",
      scanner: SCANNER,
      attribute_key: "unindexed_lookup_fields",
      attribute_value: s.unindexed_lookup_fields.length,
      attribute_label: `${s.unindexed_lookup_fields.length} field(s) look like FK / lookup but have no index`,
      delta_to_score: -Math.min(1.5, 0.2 + s.unindexed_lookup_fields.length * 0.1),
      evidence: s.unindexed_lookup_fields.map(
        (u) => `${u.model}.${u.field} — ${u.reason}`
      ),
    });
  } else {
    pushAttribute(bag, {
      category: "performance",
      scanner: SCANNER,
      attribute_key: "lookup_fields_indexed",
      attribute_value: 1,
      attribute_label: `Lookup / FK fields are indexed across ${s.models_found} model(s)`,
      delta_to_score: +0.3,
      evidence: {
        models_found: s.models_found,
        total_indexes: s.total_indexes,
        index_coverage_pct: s.index_coverage_pct,
      },
    });
  }

  // Bare info row.
  const sources = Object.entries(s.by_source)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  pushAttribute(bag, {
    category: "performance",
    scanner: SCANNER,
    attribute_key: "models_total",
    attribute_value: s.models_found,
    attribute_label:
      `${s.models_found} table(s)/model(s) [${sources}], ` +
      `${s.total_indexes} indexes across ${s.total_fields} fields, ` +
      `${s.index_coverage_pct}% index coverage`,
    delta_to_score: 0,
    evidence: {
      by_source: s.by_source,
      total_indexes: s.total_indexes,
      total_fields: s.total_fields,
      index_coverage_pct: s.index_coverage_pct,
      sample_models: s.models.slice(0, 15).map((m) => ({
        name: m.name,
        source: m.source,
        fields: m.fields.length,
        indexes: m.indexes.length,
      })),
    },
  });

  return bag;
}
