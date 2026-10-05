# Price comparison — rules

The engine is `src/pricing/basket-planner.ts` (`planBasket`). Store cards, route
cards, the trip sheet, route sections, list-row prices and the per-item "View
prices" banner all read the same `BasketPlan`, so they always agree. Display
wording comes from `src/pricing/plan-display.ts`.

## 1. What a line asks for (`list-intent.ts`)

Intent is derived from fields that already sync (name, quantity, unit, notes,
checked), so the storage schema does not change.

| Written | Meaning |
|---|---|
| `GREEN`, `red`, `whole`, `2%`, `skim`, `lactose-free`, `JAMAICAN`, `organic`, `seedless`, `unsalted`… | Hard requirement. Values in the same group (colour, milk fat, salt) contradict each other. |
| Any other word in ALL CAPS | A requirement the offer must evidence. It is never contradicted, only unconfirmed. |
| `sale only`, `only if on sale` | Only a verified, in-window sale price can be used. A flyer price counts as a sale unless the source says otherwise. |
| notes `must be X`, `only X`, `X only` (`lactose-free only`, `must be Tastee`) | Requirements, like variant words in the name. An offer evidences one through its attributes or a word in its product name. |
| `no subs` / `subs ok`, `any brand` | Whether an offer without evidence for a requirement may be used as a labelled **substitute**. The default is no. |
| `store hint: Costco`, `@Costco` | Context only. It is never a mandatory stop. |
| anything else in notes (`for kids`) | Stays a note. No allergy, brand or medical rule is inferred from it. |
| quantity `0` | Not buying. The line is never priced as 1. |
| empty unit | The amount is a **planning assumption** (`quantitySource: 'assumed'`). |
| non-numeric quantity | Unknown. The line is held. |
| checked | Not buying ("already checked off"). |

## 2. What an offer is (`types.ts` → `OfferEvidence`, `offer-evidence.ts`)

Each offer can carry: product name, variant attributes, package size, price basis
(per package / kg / lb / 100 g), currency, branch, channel, observation time,
validity dates, store timezone, stock, required membership, minimum packs, sale
flag and withdrawn flag. **Unknown fields stay unknown.** A legacy adapter result
with no evidence counts as `unverified`.

The source's provenance is always shown:

| Provenance | Source | Freshness limit |
|---|---|---|
| `verified` | documented retailer source | 7 days |
| `manual` | "Log Price". The latest entry wins, so an edit takes effect. | 14 days |
| `flyer` | Flipp flyer deal, with its printed end date | through `validTo` (7 days if no date) |
| `unverified` | adapter output without validity info | 24 hours |
| `demo` | built-in seed rows ("Sample price — not a real store price") | **excluded in release builds**; compared only in development builds (`includeDemo: __DEV__`), and never backs a savings claim |

Offers are judged against the **shopping window** you choose (Today / Tomorrow /
Next 7 days), not the day they were fetched. **Fail closed** means the offer is
excluded from the comparison and the reason is shown. The record itself is kept.

- These are excluded, with their reason: expired, not yet valid, stale,
  withdrawn, out of stock, wrong channel, wrong branch, wrong currency, a
  membership you have not enabled, the wrong product, a conflicting variant, no
  evidence for a requirement (when substitutes aren't allowed), sale-only with no
  verified sale, and incompatible units.
- A sale that ends inside the window is still usable, but carries a restriction,
  for example "price valid only through Wed Oct 7".
- Advancing the window past `validTo` drops the offer with no list edit. The list
  screen re-plans every minute and whenever the window changes.

Flyer deals are matched to items by whole words (`deal-matching.ts`, shared
with `dealMatcher`), so "milk" never matches "buttermilk", and a multi-word
name needs two hits. Cached deals whose end date has passed are skipped.

## 3. Quantities and packs (`units.ts`)

- Mass (g, kg, lb, oz), volume (mL, L) and count (ea, pcs, dozen) convert only
  **within** a dimension. Count is never turned into weight, and package
  contents are never guessed.
- Fixed packs use ceiling division: 500 g from 340 g packs is 2 packs (680 g).
- Weighed goods (per kg/lb/100 g) are bought fractionally.
- Unit price, required quantity, purchased quantity, pack count and line total
  are separate fields.

## 4. Routes

- The **comparable basket** is every line with at least one usable offer.
  **Held** lines are listed with their reasons. They are never priced at $0.
- For a limit of k stops (1–3), the planner checks every set of at most k
  stores. Within a set, each line goes to its cheapest pack-correct offer. Sets
  are ranked by **coverage first**, then merchandise total, then fewer stores,
  then store id. The result is deterministic and exact, with no greedy step.
  `__tests__/planner-oracle.test.ts` checks it against an independent exhaustive
  oracle on 900 random cases.
- Every card shows "N of M items". An incomplete store or route is labelled as
  incomplete and can never outrank a complete one.
- Savings are stated only between routes that **cover the same lines**. They are
  merchandise-only: tax, travel, delivery fees and memberships are unknown, not
  $0. When sample prices are involved, savings are marked "illustrative".
- The optional "cost of one extra stop" input only says whether the extra stop
  pays for itself. It never changes the savings figure.

## 5. Refresh and editing (`price-store.ts`)

- `perStorePrices` is merged **per item and store**. An offer a store no longer
  returns is removed. A store whose lookup *failed* keeps its previous prices.
- Every fetch or edit takes an increasing ticket, and a cell only accepts
  writes from a ticket at least as new as the one that last wrote it. A slow
  response cannot overwrite a newer edit, and a full refresh drops responses
  that were already in flight.
- "Log Price" writes through `loadSinglePrice` into `perStorePrices` (the store
  id matches the adapters', e.g. `no-frills`). Changes to the list, prices, the
  stop limit, the window and memberships all re-run the plan.

## Pinned fixture

`__tests__/fixtures/pinned-basket.ts` is test-only data and is never shipped.
With it, the planner must produce:

- 2 stops: **$77.20**. 3 stops: **$73.29**. Both cover the same 10 lines. Ketchup
  is held (sale-only, and its sale ended Oct 3). The extra stop saves **$3.91**
  before tax and travel.
- Fortinos alone is $7.88 for 2 of 10 lines, and is ranked last.
- FB + FreshCo totals $60.31 but covers 9 of 10 lines, so it loses to NF + FB.
- Red grapes at $2.18/kg never satisfy GREEN grapes.

The original assessment's fixture was not in the repository. This fixture was
built to reproduce the stated gate figures, and its arithmetic is documented in
the file header.

## Known limits

- Flyer-scan, cloud-flyer, store-prices, Instacart and scraping results still
  have no evidence, so they count as `unverified`. Flipp deals carry their end
  date but have no branch or package size.
- The demo seed rows still ship, but are hidden from comparisons in release
  builds.
- Merged with PR #3's `basket.ts` work. Its regression findings run against
  this planner in `__tests__/basket-correctness.test.ts`. One behaviour was
  deliberately not kept: a quantity that can't be reconciled with how the
  offer is sold is held, not assumed to be one package.
- Voice input still defaults a missing quantity to "1 each" (explicit). Only
  checklist import marks missing quantities as assumptions.
- Membership choices and the shopping window are kept in memory and reset on
  restart.
