/**
 * Deal matching — whole-word, stemmed token matching between an item name and
 * a flyer deal's product name. Shared by the Flipp adapter and dealMatcher so
 * both agree on what counts as the same product: "milk" never matches
 * "buttermilk", and multi-word names need at least two hits, so "green grapes"
 * cannot match "red grapes" on "grapes" alone. Variant rules (GREEN vs RED,
 * lactose-free…) are enforced later by the basket planner.
 */

// ─── Tokens ─────────────────────────────────────────────────────────────────

/** Words that add no matching value in grocery context */
export const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'without', 'fresh', 'frozen', 'organic', 'natural', 'premium',
  'value', 'selected', 'choice', 'best', 'plus', 'all', 'each', 'per',
  'pack', 'bag', 'box', 'bottle', 'can', 'jar', 'tub', 'tray', 'bunch',
  'kg', 'g', 'ml', 'l', 'oz', 'lb', 'litre', 'liter', 'gram', 'grams',
  'piece', 'pieces', 'count', 'size', 'large', 'medium', 'small',
  'grade', 'type', 'style', 'brand', 'save', 'caisse', 'chaque',
]);

/** Crude plural folding so "grapes" ≡ "grape" and "patties" ≡ "patty". */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 4 && token.endsWith('oes')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Meaningful, stemmed tokens of a product name. Hyphens split ("lactose-free"). */
export function extractKeywords(name: string): string[] {
  if (!name || typeof name !== 'string') return [];
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
    .map(stem);
}

/**
 * Score how well query tokens match product tokens (0..1). Whole tokens
 * only — "milk" must not match "buttermilk". Multi-word queries need at
 * least two hits so "green grapes" does not match "red grapes".
 */
export function matchScore(queryTokens: string[], productTokens: string[]): number {
  if (queryTokens.length === 0 || productTokens.length === 0) return 0;
  const product = new Set(productTokens);
  const hits = queryTokens.filter((t) => product.has(t)).length;
  if (hits < 2 && queryTokens.length > 1) return 0;
  return hits / queryTokens.length;
}
