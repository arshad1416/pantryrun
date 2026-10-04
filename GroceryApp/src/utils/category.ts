/**
 * Category inference — a best-guess built-in category from an item name.
 *
 * Basic keyword matching; falls back to 'other'. Intentionally simple —
 * the person can always adjust the category after the item is added.
 * Shared by voice add and checklist import.
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
