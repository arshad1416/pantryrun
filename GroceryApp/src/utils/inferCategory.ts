/**
 * Category inference shared by voice add and list import.
 */

/**
 * Basic category inference based on item name keywords.
 * Falls back to 'other' if no match is found.
 *
 * This is intentionally simple — a production system could use ML
 * or a configurable mapping. The user can always adjust the category
 * after the item is added.
 */
export function inferCategory(name: string): string {
  const lower = name.toLowerCase();

  if (
    /\b(milk|eggs|butter|cheese|yogurt|cream|yoghurt|dairy)\b/.test(lower)
  ) {
    return 'dairy';
  }
  if (
    /\b(chicken|beef|pork|bacon|sausage|salmon|fish|turkey|ham|steak|meat)\b/.test(
      lower,
    )
  ) {
    return 'meat';
  }
  if (
    /\b(apple|banana|lettuce|tomato|carrot|potato|onion|avocado|broccoli|spinach|produce|fruit|vegetable)\b/.test(
      lower,
    )
  ) {
    return 'produce';
  }
  if (
    /\b(bread|bagel|croissant|tortilla|bakery|roll|muffin|pastry)\b/.test(lower)
  ) {
    return 'bakery';
  }
  if (
    /\b(frozen|pizza|ice cream|veggies)\b/.test(lower) ||
    lower.startsWith('frozen ')
  ) {
    return 'frozen';
  }
  if (
    /\b(rice|pasta|oil|salt|pepper|flour|sugar|pantry|sauce|cereal|beans)\b/.test(
      lower,
    )
  ) {
    return 'pantry';
  }
  if (
    /\b(water|juice|coffee|tea|soda|drink|beverage|beer|wine)\b/.test(lower)
  ) {
    return 'beverages';
  }

  return 'other';
}
