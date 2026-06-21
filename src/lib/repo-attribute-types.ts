import "server-only";
import type { SignalCategory, ScannerName } from "./types";

export type { SignalCategory, ScannerName };

/**
 * Shared types for the attribute pipeline.
 *
 * Every structural scanner (routes, test-map, layering, env, schema,
 * deadcode) emits a list of `RepoAttribute` rows. The repo-scanner
 * orchestrator collects them into a single `RepoAttributesBag` which
 * later becomes the rows in the `project_signal_attributes` table.
 *
 * Each attribute has:
 *   - a `category` (one of the 5 score axes),
 *   - a `scanner` (which module produced it),
 *   - an `attribute_key` (unique within scanner),
 *   - a numeric `value` (count, %, score, …),
 *   - a human `label` and optional `evidence` for display,
 *   - a `delta` describing how much it moved the score in its category.
 *
 * Scanners themselves don't see the running totals — they just declare
 * "+0.5 to security because there are 0 routes without auth", and the
 * scoring layer applies that delta on top of the existing dimension
 * formulas.
 */

export type RepoAttribute = {
  category: SignalCategory;
  scanner: ScannerName;
  attribute_key: string;
  attribute_value: number;
  attribute_label: string;
  delta_to_score: number;
  evidence?: unknown;
};

export type RepoAttributesBag = {
  attributes: RepoAttribute[];
  /** Aggregate delta per (scanner, category) — used by scoring. */
  by_category: Record<SignalCategory, number>;
};

export function emptyAttributesBag(): RepoAttributesBag {
  return {
    attributes: [],
    by_category: {
      code_quality: 0,
      security: 0,
      performance: 0,
      test_coverage: 0,
      readability: 0,
    },
  };
}

export function pushAttribute(
  bag: RepoAttributesBag,
  attr: RepoAttribute
): void {
  bag.attributes.push(attr);
  bag.by_category[attr.category] += attr.delta_to_score;
}

export function mergeAttributeBags(
  ...bags: RepoAttributesBag[]
): RepoAttributesBag {
  const out = emptyAttributesBag();
  for (const b of bags) {
    for (const a of b.attributes) pushAttribute(out, a);
  }
  return out;
}
