# Architecture: Grocery Store Site Scraper — Regular Shelf Prices

**Status:** Design Document  
**Last Updated:** 2026-06-15  
**Depends On:** `ARCHITECTURE-PRICE-LOOKUP.md`, `flippscrape.py`, the operator's Turso DB
(hostname supplied via `PANTRYRUN_TURSO_URL`, never committed)

> **Status (Oct 2026): served through the relay.** The scraper still writes
> `flipp_deals` and `store_prices` to Turso from the operator's machine. The
> app never reads Turso: the relay reads it server-side with a **read-only**
> token (`TURSO_URL`, `TURSO_READ_TOKEN` in the relay's `.env`) and serves
> `GET /api/prices/deals?fsa=` and `GET /api/prices/shelf?fsa=` to enrolled
> devices (`relay-server/prices/`). The app downloads its region and matches
> on the device (`src/pricing/live-prices.ts`). Without the env vars the
> endpoints return 503 and the app shows no live prices.
>
> Setup: `turso db tokens create <db> --read-only`, put both values in the
> relay's `.env`, `docker compose up -d`, then set the relay URL and FSA in
> the app. Columns the app may see are allowlisted in `prices-server.js`.

---

## 1. Problem Statement

Flipp only provides **flyer deals** (promotional/discounted items with expiry dates). Regular shelf prices — the everyday price of Milk, Pork Chops, Cheddar Cheese — are not available through Flipp. To enable meaningful price comparison and trip optimization, PantryRun needs access to **current regular prices** from major Canadian grocery chains.

### What We Have vs What We Need

| Data | Source | Status |
|------|--------|--------|
| Flyer deals (sale items) | Flipp API via `flippscrape.py` | ✅ Working |
| Regular shelf prices | Grocery store websites | ❌ **This document** |
| Barcode-scanned prices | User submissions | ✅ Schema exists |
| Crowd-sourced prices | In-memory from app | ✅ Working |

---

## 2. Target Stores — Priority Order

### Tier 1: Loblaws Group (shared API infrastructure)

Loblaws, No Frills, Real Canadian Superstore, and T&T all run on the same e-commerce platform (`loblaw.ca` / `nofrills.ca`). They share a common product search API, making them the **highest-value, lowest-effort** target.

| Store | URL | Banner ID | Notes |
|-------|-----|-----------|-------|
| **No Frills** | `nofrills.ca` | `NOFRILLS` | Discount banner, highest user overlap |
| **Loblaws** | `loblaws.ca` | `LOBLAWS` | Full-service, higher prices |
| **Superstore** | `realcanadiansuperstore.ca` | `SUPERSTORE` | Wholesale-style |

**Scraping method:** Internal JSON API (`/api/product-service/v1/search`)  
**Complexity:** Low — single API endpoint, no browser required  
**Coverage:** Full product catalog with prices, unit prices, images, sale flags

### Tier 2: Metro Group (shared infrastructure)

Metro, Food Basics, and Jean Coutu share a platform.

| Store | URL | Banner ID | Notes |
|-------|-----|-----------|-------|
| **Metro** | `metro.ca` | `METRO` | Full-service |
| **Food Basics** | `foodbasics.ca` | `FOOD_BASICS` | Discount banner, same parent |

**Scraping method:** Internal product search API + HTML fallback  
**Complexity:** Medium — API requires session cookies, geo-headers  
**Coverage:** Good product catalog, unit prices available

### Tier 3: Walmart Canada

| Store | URL | Banner ID | Notes |
|-------|-----|-----------|-------|
| **Walmart** | `walmart.ca/grocery` | `WALMART` | Largest retailer, separate platform |

**Scraping method:** Internal product search API (`/orchestra/graphql`)  
**Complexity:** Medium-High — GraphQL, location-based results, anti-bot measures  
**Coverage:** Very large catalog, competitive prices

### Tier 4: FreshCo (Sobeys Group)

| Store | URL | Banner ID | Notes |
|-------|-----|-----------|-------|
| **FreshCo** | `freshco.ca` | `FRESHCO` | Discount banner, Sobeys subsidiary |

**Scraping method:** HTML scraping with requests + BeautifulSoup  
**Complexity:** Medium — less API-driven, more traditional web  
**Coverage:** Moderate, price matching focus

### Priority Rationale

1. **Loblaws Group** first — covers 3 major banners with one API, highest Ontario market share
2. **Metro/Food Basics** second — 2 banners, good discount coverage
3. **Walmart** third — largest overall but separate platform, more anti-scraping
4. **FreshCo** fourth — smaller footprint, Sobeys platform is less scraper-friendly

---

## 3. Scraping Approach Per Store

### 3.1 Loblaws Group API (No Frills, Loblaws, Superstore)

The Loblaws e-commerce platform exposes a product search API used by their website and mobile app.

```python
# Endpoint pattern
POST https://api.pcexpress.ca/pcx-bff/api/v2/search

# Headers
{
    "x-apikey": "<public-api-key>",       # Extracted from website JS bundle
    "x-loblaw-tenant-id": "NOFRILLS_ON",  # Banner + province
    "content-type": "application/json",
}

# Body
{
    "query": "cheddar cheese",
    "pagination": {"from": 0, "size": 20},
    "filters": {"availability": "IN_STOCK"},
    "storeId": "<store-id>",              # Resolved from postal code
}
```

**Response includes:**
- Product name, brand, description
- Current price (regular and sale)
- Unit price (e.g., "$0.44/100g")
- Product image URL
- Package size / selling type
- Sale flags (`wasPrice`, `multiBuyDeal`, `pcOptimumOffer`)
- Availability status

**Key considerations:**
- The `x-apikey` is a public key embedded in the website — rotate detection possible
- Store ID is location-specific — resolve via postal code lookup endpoint first
- Rate limit: ~60 req/min observed, stay under 30 for safety
- Results are paginated (20 per page max)

### 3.2 Metro Group API (Metro, Food Basics)

```python
# Endpoint pattern
GET https://api.metro.ca/api/product/search/v2

# Headers
{
    "Accept": "application/json",
    "Accept-Language": "en-CA",
    "x-location": "<postal-code>",
}

# Query params
{
    "q": "cheddar cheese",
    "storeId": "<store-id>",
    "limit": 20,
    "offset": 0,
}
```

**Response includes:**
- Product name, brand, category
- Regular price and promotional price
- Unit price
- Image URL
- In-stock flag

**Key considerations:**
- Requires valid session with geo-location headers
- Store resolution needed (similar to Loblaws)
- Rate limit: ~40 req/min estimated

### 3.3 Walmart Canada API

```python
# Walmart uses a GraphQL endpoint
POST https://www.walmart.ca/orchestra/graphql

# Body (simplified)
{
    "operationName": "search",
    "variables": {
        "query": "cheddar cheese",
        "categoryId": "10019",  # Grocery category
        "page": 1,
        "pageSize": 20,
        "storeId": "<store-id>",
    }
}
```

**Key considerations:**
- GraphQL schema changes more frequently than REST APIs
- Heavy anti-bot: Cloudflare, fingerprinting, rate limiting
- May require Playwright fallback for initial session/cookie establishment
- Location-based pricing — postal code store resolution essential
- Rate limit: conservative at 20 req/min

### 3.4 FreshCo (HTML Scraping)

FreshCo has a less API-driven site. Scraping involves:

1. **Search page:** `https://www.freshco.ca/search?q=cheddar+cheese`
2. **Parse HTML:** Product cards with price, name, image
3. **Fallback:** If JavaScript-rendered, use Playwright headless browser

```python
# requests + BeautifulSoup approach
from bs4 import BeautifulSoup
resp = SESSION.get("https://www.freshco.ca/search", params={"q": query})
soup = BeautifulSoup(resp.text, "html.parser")
# Extract product cards via CSS selectors
```

**Key considerations:**
- Most fragile approach — HTML structure changes break selectors
- May need Playwright for JS-rendered content
- Lower priority due to higher maintenance cost

---

## 4. Database Schema — New `store_prices` Table

### 4.1 Decision: New Table vs Reuse `flipp_deals`

**Recommendation: New `store_prices` table.** Reasons:

| Factor | `flipp_deals` reuse | New `store_prices` |
|--------|--------------------|--------------------|
| Schema fit | Missing fields (unit_price, sale_flag, scraped_at) | Purpose-built |
| TTL model | `valid_to` for flyer expiry | `scraped_at` freshness model |
| Data mixing | Flyer deals ≠ shelf prices — different semantics | Clean separation |
| Adapter impact | FlippDealsAdapter needs no changes | New `StorePricesAdapter` |
| Query pattern | FSA postal code prefix | Store ID + item name |

### 4.2 Schema

```sql
CREATE TABLE IF NOT EXISTS store_prices (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id      TEXT NOT NULL,           -- 'nofrills', 'loblaws', 'metro', 'walmart', etc.
    store_name    TEXT NOT NULL,           -- 'No Frills', 'Loblaws', 'Metro', 'Walmart'
    name          TEXT NOT NULL,           -- Product name as scraped
    name_clean    TEXT NOT NULL,           -- Normalized name for matching (lowercase, trimmed)
    price         TEXT NOT NULL,           -- Display price string (e.g. "4.99")
    price_real    REAL,                    -- Numeric price for sorting/comparison
    unit_price    TEXT,                    -- Unit price string (e.g. "$0.44/100g")
    unit_price_real REAL,                  -- Numeric unit price
    unit          TEXT,                    -- 'each', '100g', '100ml', 'kg', etc.
    image_url     TEXT,                    -- Product image
    brand         TEXT,                    -- Brand name
    category      TEXT,                    -- Product category (dairy, meat, produce, etc.)
    is_on_sale    INTEGER DEFAULT 0,       -- 1 if currently on sale
    sale_price    REAL,                    -- Sale price if on sale
    was_price     REAL,                    -- Regular price if on sale
    postal_code   TEXT NOT NULL,           -- Postal code used for store resolution
    scraped_at    TEXT NOT NULL DEFAULT (datetime('now')),
    source        TEXT NOT NULL DEFAULT 'scraper',  -- 'scraper', 'api', 'crowd'
    UNIQUE(store_id, name_clean, postal_code)        -- Upsert key
);

CREATE INDEX IF NOT EXISTS idx_store_prices_store ON store_prices(store_id);
CREATE INDEX IF NOT EXISTS idx_store_prices_name ON store_prices(name_clean);
CREATE INDEX IF NOT EXISTS idx_store_prices_scraped ON store_prices(scraped_at);
CREATE INDEX IF NOT EXISTS idx_store_prices_postal ON store_prices(postal_code);
```

### 4.3 Data Retention

```sql
-- Delete prices older than 7 days (shelf prices change infrequently)
DELETE FROM store_prices WHERE scraped_at < datetime('now', '-7 days');

-- Delete prices older than 3 days for volatile categories (produce, meat)
DELETE FROM store_prices
WHERE scraped_at < datetime('now', '-3 days')
  AND category IN ('produce', 'meat', 'seafood', 'bakery');
```

---

## 5. Python Scraper Architecture

### 5.1 File Structure

```
~/.hermes/scripts/
├── flippscrape.py              # Existing — Flipp flyer deals
├── store_prices_scrape.py      # NEW — Main entry point
├── scrapers/
│   ├── __init__.py
│   ├── base.py                 # Base scraper class
│   ├── loblaws_group.py        # No Frills, Loblaws, Superstore
│   ├── metro_group.py          # Metro, Food Basics
│   ├── walmart_ca.py           # Walmart Canada
│   └── freshco_ca.py           # FreshCo
├── normalize_store_prices.py   # NEW — Price normalization
└── turso_helper.py             # Existing — Turso HTTP helpers
```

### 5.2 Base Scraper Class

```python
# scrapers/base.py
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional
import time
import requests

@dataclass
class ProductPrice:
    store_id: str           # 'nofrills', 'metro', 'walmart'
    store_name: str         # 'No Frills', 'Metro', 'Walmart'
    name: str               # Original product name
    name_clean: str         # Normalized for matching
    price: str              # Display price
    price_real: float       # Numeric price
    unit_price: Optional[str]
    unit_price_real: Optional[float]
    unit: Optional[str]
    image_url: Optional[str]
    brand: Optional[str]
    category: Optional[str]
    is_on_sale: bool
    sale_price: Optional[float]
    was_price: Optional[float]
    postal_code: str

class BaseScraper(ABC):
    """Base class for grocery store scrapers."""

    store_id: str
    store_name: str
    requests_per_minute: int = 30

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/125.0.0.0 Safari/537.36",
            "Accept": "application/json",
            "Accept-Language": "en-CA,en;q=0.9",
        })
        self._last_request_time = 0

    def _rate_limit(self):
        """Enforce rate limiting between requests."""
        min_interval = 60.0 / self.requests_per_minute
        elapsed = time.time() - self._last_request_time
        if elapsed < min_interval:
            time.sleep(min_interval - elapsed)
        self._last_request_time = time.time()

    @abstractmethod
    def search(self, query: str, postal_code: str) -> list[ProductPrice]:
        """Search for products matching query at a store near postal_code."""
        ...

    @abstractmethod
    def resolve_store(self, postal_code: str) -> str:
        """Resolve postal code to a store ID for this banner."""
        ...

    def search_many(self, queries: list[str], postal_code: str) -> list[ProductPrice]:
        """Search for multiple items with rate limiting."""
        results = []
        for query in queries:
            try:
                self._rate_limit()
                items = self.search(query, postal_code)
                results.extend(items)
            except Exception as e:
                # Log but continue — partial results are still useful
                print(f"  ⚠ {self.store_name} search failed for '{query}': {e}")
        return results
```

### 5.3 Loblaws Group Scraper (Priority 1)

```python
# scrapers/loblaws_group.py
"""Scraper for Loblaws Group banners: No Frills, Loblaws, Superstore.

Uses the PC Express API (api.pcexpress.ca) which powers the e-commerce
websites for all Loblaws Group banners. A single scraper handles multiple
banners via the tenant ID header.
"""

from .base import BaseScraper, ProductPrice

BANNERS = {
    "nofrills": {
        "store_name": "No Frills",
        "tenant_id": "NOFRILLS_ON",
    },
    "loblaws": {
        "store_name": "Loblaws",
        "tenant_id": "LOBLAWS_ON",
    },
    "superstore": {
        "store_name": "Real Canadian Superstore",
        "tenant_id": "SUPERSTORE_ON",
    },
}

SEARCH_URL = "https://api.pcexpress.ca/pcx-bff/api/v2/search"
STORE_LOCATOR_URL = "https://api.pcexpress.ca/pcx-bff/api/v2/store-locator"

class LoblawsGroupScraper(BaseScraper):
    requests_per_minute = 30

    def __init__(self, banner: str = "nofrills"):
        super().__init__()
        self.banner = BANNERS[banner]
        self.store_id = banner
        self.store_name = self.banner["store_name"]
        self.session.headers.update({
            "x-apikey": "<extracted-from-js-bundle>",
            "x-loblaw-tenant-id": self.banner["tenant_id"],
        })

    def resolve_store(self, postal_code: str) -> str:
        """Resolve postal code to nearest store ID."""
        resp = self.session.get(STORE_LOCATOR_URL, params={
            "postalCode": postal_code,
            "banner": self.banner["tenant_id"],
        })
        resp.raise_for_status()
        stores = resp.json()
        return stores[0]["id"] if stores else ""

    def search(self, query: str, postal_code: str) -> list[ProductPrice]:
        """Search for products matching query."""
        self._rate_limit()
        resp = self.session.post(SEARCH_URL, json={
            "query": query,
            "pagination": {"from": 0, "size": 20},
            "storeId": self.resolve_store(postal_code),
        })
        resp.raise_for_status()
        data = resp.json()

        results = []
        for item in data.get("products", []):
            price_val = item.get("price", {}).get("value", 0)
            was_price = item.get("price", {}).get("wasValue")
            unit_price_str = item.get("unitPrice", "")

            results.append(ProductPrice(
                store_id=self.store_id,
                store_name=self.store_name,
                name=item.get("name", ""),
                name_clean=_clean_name(item.get("name", "")),
                price=f"{price_val:.2f}",
                price_real=float(price_val),
                unit_price=unit_price_str or None,
                unit_price_real=_parse_unit_price(unit_price_str),
                unit=item.get("sellingSize") or "each",
                image_url=item.get("imageUrl"),
                brand=item.get("brand"),
                category=item.get("category", {}).get("name"),
                is_on_sale=bool(was_price and was_price > price_val),
                sale_price=float(price_val) if was_price else None,
                was_price=float(was_price) if was_price else None,
                postal_code=postal_code,
            ))
        return results
```

### 5.4 Main Entry Point

```python
#!/usr/bin/env python3
"""
store_prices_scrape.py — Grocery shelf price scraper for PantryRun.

Scrapes current regular prices from Canadian grocery store websites
and writes results to the pantryrun Turso database.

Usage:
  python3 store_prices_scrape.py --postal-code L0R2H4 --items "milk,bread,eggs"
  python3 store_prices_scrape.py --postal-code L0R2H4 --items-file grocery_list.txt
  python3 store_prices_scrape.py --postal-code L0R2H4 --stores nofrills,metro --turso
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

# Turso write support (reuses flippscrape patterns)
# The database hostname is an operator secret-adjacent value, not a constant:
# this repository is public, so it is read from the environment rather than
# published here alongside the token path below.
PANTRYRUN_TURSO_URL = os.environ.get("PANTRYRUN_TURSO_URL", "")

def _get_turso_token() -> str:
    token_path = os.path.expanduser("~/.hermes/pantryrun_turso_token.txt")
    if os.path.exists(token_path):
        with open(token_path) as f:
            return f.read().strip()
    return os.environ.get("PANTRYRUN_TURSO_TOKEN", "")

def write_to_turso(prices: list[dict], url: str, token: str) -> dict:
    """Batch insert prices into store_prices table."""
    stats = {"attempted": 0, "inserted": 0, "errors": 0}
    batch = []
    for p in prices:
        stats["attempted"] += 1
        # Escape single quotes
        name = p["name"].replace("'", "''")
        name_clean = p["name_clean"].replace("'", "''")
        store_name = p["store_name"].replace("'", "''")
        brand = (p.get("brand") or "").replace("'", "''")
        img = (p.get("image_url") or "").replace("'", "''")
        unit_price = (p.get("unit_price") or "").replace("'", "''")
        category = (p.get("category") or "").replace("'", "''")

        sql = f"""INSERT OR REPLACE INTO store_prices
            (store_id, store_name, name, name_clean, price, price_real,
             unit_price, unit_price_real, unit, image_url, brand, category,
             is_on_sale, sale_price, was_price, postal_code, source)
            VALUES ('{p["store_id"]}', '{store_name}', '{name}', '{name_clean}',
                    '{p["price"]}', {p["price_real"]},
                    '{unit_price}', {p.get("unit_price_real") or "NULL"},
                    '{p.get("unit", "each")}', '{img}', '{brand}', '{category}',
                    {1 if p.get("is_on_sale") else 0},
                    {p.get("sale_price") or "NULL"},
                    {p.get("was_price") or "NULL"},
                    '{p["postal_code"]}', 'scraper')"""
        batch.append(sql)

    # Execute in chunks of 50
    for i in range(0, len(batch), 50):
        chunk = batch[i:i + 50]
        # ... (same batch execution pattern as flippscrape.py)
        stats["inserted"] += len(chunk)  # simplified

    return stats

# ── Store scraper registry ──
SCRAPERS = {
    "nofrills": lambda: __import__("scrapers.loblaws_group", fromlist=["LoblawsGroupScraper"])
                       .LoblawsGroupScraper("nofrills"),
    "loblaws":  lambda: __import__("scrapers.loblaws_group", fromlist=["LoblawsGroupScraper"])
                       .LoblawsGroupScraper("loblaws"),
    "metro":    lambda: __import__("scrapers.metro_group", fromlist=["MetroGroupScraper"])
                       .MetroGroupScraper("metro"),
    "foodbasics": lambda: __import__("scrapers.metro_group", fromlist=["MetroGroupScraper"])
                         .MetroGroupScraper("foodbasics"),
    "walmart":  lambda: __import__("scrapers.walmart_ca", fromlist=["WalmartCaScraper"])
                       .WalmartCaScraper(),
    "freshco":  lambda: __import__("scrapers.freshco_ca", fromlist=["FreshCoScraper"])
                       .FreshCoScraper(),
}

def main():
    parser = argparse.ArgumentParser(description="Grocery shelf price scraper")
    parser.add_argument("--postal-code", required=True, help="Canadian postal code")
    parser.add_argument("--items", help="Comma-separated item list")
    parser.add_argument("--items-file", help="File with one item per line")
    parser.add_argument("--stores", default="nofrills,metro,walmart",
                        help="Comma-separated store IDs (default: nofrills,metro,walmart)")
    parser.add_argument("--turso", action="store_true", help="Write to Turso DB")
    parser.add_argument("--output", help="Write JSON output to file")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    # Parse items
    items = []
    if args.items_file:
        with open(args.items_file) as f:
            items = [line.strip() for line in f if line.strip()]
    elif args.items:
        items = [i.strip() for i in args.items.split(",")]
    else:
        parser.error("One of --items or --items-file is required")

    stores = [s.strip() for s in args.stores.split(",")]

    # Scrape each store
    all_prices = []
    for store_id in stores:
        if store_id not in SCRAPERS:
            print(f"Unknown store: {store_id}")
            continue
        scraper = SCRAPERS[store_id]()
        if not args.quiet:
            print(f"Scraping {scraper.store_name} for {len(items)} items...")
        prices = scraper.search_many(items, args.postal_code)
        all_prices.extend(prices)
        if not args.quiet:
            print(f"  → {len(prices)} prices found")

    # Write to Turso
    if args.turso:
        token = _get_turso_token()
        if token:
            stats = write_to_turso(all_prices, PANTRYRUN_TURSO_URL, token)
            if not args.quiet:
                print(f"Turso: {stats['inserted']} inserted, {stats['errors']} errors")

    # Output JSON
    if args.output:
        with open(args.output, "w") as f:
            json.dump([p.__dict__ for p in all_prices], f, indent=2)

    # Summary
    if not args.quiet:
        print(f"\nTotal: {len(all_prices)} prices across {len(stores)} stores")
```

---

## 6. Integration with Existing System

### 6.1 New StorePricesAdapter (TypeScript)

A new `PriceAdapter` that queries `store_prices` from Turso, parallel to `FlippDealsAdapter`:

```typescript
// src/pricing/store-prices-adapter.ts (NEW)
import type { PriceAdapter } from './adapter';
import type { PriceResult, ConfidenceLevel } from './types';

export class StorePricesAdapter implements PriceAdapter {
  id = 'store-prices';
  name = 'Store Shelf Prices';
  tier = 'scraping' as const;  // Same tier as existing scraping adapter

  isAvailable(): boolean {
    // Available if Turso is configured and store_prices table has data
    return true; // check via settings
  }

  async getPrice(itemName: string, storeId: string): Promise<PriceResult | null> {
    // Query store_prices WHERE store_id = ? AND name_clean MATCH ?
    // Use same keyword matching as FlippDealsAdapter
    // Return PriceResult with confidence based on scraped_at age
    ...
  }

  async getPrices(items: string[], storeId: string): Promise<Map<string, PriceResult>> {
    // Batch query for efficiency
    ...
  }
}
```

### 6.2 Registry Integration

Register in `src/pricing/registry.ts` after FlippDealsAdapter:

```typescript
import { storePricesAdapter } from './store-prices-adapter';

// In constructor:
this.registerAdapter(storePricesAdapter);
```

**Tier ordering result:**
```
official → flyer → crowd → scraping
                         ↑
                    store-prices + existing scraping adapter
```

Store prices will be tried after flyer deals (so sale prices from Flipp take priority) but before the empty scraping placeholder.

### 6.3 Confidence Mapping

| scraped_at age | Confidence | Display |
|----------------|-----------|---------|
| < 24 hours | `real_time` | Normal price |
| 1-3 days | `recent` | Normal price |
| 3-7 days | `estimated` | "~" prefix |
| > 7 days | `stale` | Skip (don't show) |

### 6.4 Name Matching

Reuse the same keyword extraction and matching logic from `FlippDealsAdapter` (and `dealMatcher.ts`):

```python
# Python side — normalize_store_prices.py
STOP_WORDS = {'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', ...}

def clean_name(name: str) -> str:
    """Normalize product name for fuzzy matching."""
    import re
    name = name.lower().strip()
    name = re.sub(r'[^a-z0-9\s-]', ' ', name)
    tokens = [t for t in name.split() if len(t) >= 2 and t not in STOP_WORDS]
    return ' '.join(tokens)
```

This mirrors the TypeScript `extractKeywords()` in `flipp-deals-adapter.ts` so the same matching logic works on both sides.

---

## 7. Where to Run — Pi Cron Schedule

### 7.1 Scheduling

```cron
# Weekly full scrape — Sunday 3:00 AM ET
0 3 * * 0  cd ~/.hermes/scripts && python3 store_prices_scrape.py \
  --postal-code L0R2H4 --items-file ~/.hermes/data/grocery_items.txt \
  --stores nofrills,metro,walmart,foodbasics --turso --quiet \
  >> ~/.hermes/logs/store_prices.log 2>&1

# Daily quick scrape — top 50 items, Mon-Sat 4:00 AM ET
0 4 * * 1-6  cd ~/.hermes/scripts && python3 store_prices_scrape.py \
  --postal-code L0R2H4 --items-file ~/.hermes/data/top50_items.txt \
  --stores nofrills,metro --turso --quiet \
  >> ~/.hermes/logs/store_prices.log 2>&1
```

### 7.2 On-Demand via Relay Server

The relay server can trigger a price scrape when the user views their grocery list:

```
App → Relay Server → SSH to Pi → store_prices_scrape.py --items "milk,bread,eggs"
```

This is useful for items not in the weekly/daily rotation.

### 7.3 Item List Management

Maintain two item files on Pi:

- `~/.hermes/data/grocery_items.txt` — All items ever added to grocery lists (comprehensive, weekly)
- `~/.hermes/data/top50_items.txt` — Most frequently added items (quick daily refresh)

Updated automatically by the relay server when users add new items.

### 7.4 Estimated Timing

| Scenario | Items | Stores | Time | Frequency |
|----------|-------|--------|------|-----------|
| Weekly full | 200 | 4 | ~25 min | Sunday 3 AM |
| Daily quick | 50 | 2 | ~5 min | Mon-Sat 4 AM |
| On-demand | 5-10 | 1-2 | ~1 min | User-triggered |

---

## 8. Data Normalization Strategy

### 8.1 Price Parsing

```python
def parse_price(price_str: str) -> float | None:
    """Parse various Canadian price formats."""
    import re
    if not price_str:
        return None
    # Remove $, commas, whitespace
    cleaned = re.sub(r'[$,\s]', '', price_str)
    try:
        return round(float(cleaned), 2)
    except ValueError:
        return None

def parse_unit_price(unit_str: str) -> tuple[float | None, str | None]:
    """Parse unit price like '$0.44/100g' → (0.44, '100g')."""
    import re
    match = re.match(r'\$?([\d.]+)\s*/\s*(\w+)', unit_str)
    if match:
        return float(match.group(1)), match.group(2)
    return None, None
```

### 8.2 Name Normalization

```python
def normalize_product_name(name: str) -> str:
    """Normalize for deduplication and matching.

    Same logic as TypeScript extractKeywords() in flipp-deals-adapter.ts.
    """
    import re
    STOP_WORDS = {
        'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
        'with', 'without', 'fresh', 'frozen', 'organic', 'natural', 'premium',
        'value', 'selected', 'choice', 'best', 'plus', 'all', 'each', 'per',
        'pack', 'bag', 'box', 'bottle', 'can', 'jar', 'tub', 'tray', 'bunch',
    }
    name = name.lower().strip()
    name = re.sub(r'[^a-z0-9\s-]', ' ', name)
    tokens = [t for t in name.split() if len(t) >= 2 and t not in STOP_WORDS]
    return ' '.join(tokens)
```

### 8.3 Unit Normalization

All prices normalized to standard units for comparison (matching `src/pricing/normalizer.ts`):

| Raw Unit | Normalized | Display |
|----------|-----------|---------|
| kg | per 100g | `/100g` |
| g | per 100g | `/100g` |
| L | per 100mL | `/100mL` |
| mL | per 100mL | `/100mL` |
| each / ea | per unit | `/ea` |
| lb | per 100g | `/100g` (÷2.205) |

### 8.4 Category Classification

Scraped products are assigned a category for differential TTL:

```python
CATEGORIES = {
    'produce': ['apple', 'banana', 'tomato', 'lettuce', 'onion', 'potato', ...],
    'dairy': ['milk', 'cheese', 'yogurt', 'butter', 'cream', ...],
    'meat': ['chicken', 'beef', 'pork', 'sausage', 'steak', ...],
    'seafood': ['salmon', 'shrimp', 'tuna', 'cod', ...],
    'bakery': ['bread', 'bagel', 'muffin', 'croissant', ...],
    'frozen': ['pizza', 'ice cream', 'frozen vegetables', ...],
    'pantry': ['pasta', 'rice', 'cereal', 'oil', 'flour', ...],
    'beverages': ['juice', 'water', 'pop', 'coffee', 'tea', ...],
    'snacks': ['chips', 'cookies', 'crackers', 'nuts', ...],
}
```

---

## 9. Privacy Considerations

### 9.1 What Leaves the Pi

| Data | Destination | Sensitivity |
|------|------------|-------------|
| Item names (e.g. "milk", "bread") | Grocery store search APIs | Low — generic grocery terms |
| Postal code | Store locator APIs | Medium — identifies neighbourhood |
| Store preferences | Scrape request URLs | Low |

### 9.2 What Does NOT Leave the Pi

- Grocery list IDs, structure, categories
- Family member names or assignments
- Checked/unchecked state
- User's full postal code (only first 3 chars sent to store locator)
- Any app usage data

### 9.3 Data Minimization

- Only scrape items that appear in the user's grocery lists (no bulk catalog crawling)
- Use the minimal postal code prefix needed for store resolution (FSA only)
- Don't store user identifiers alongside scraped prices
- Prices are stored with `postal_code` for location context but no user ID

### 9.4 No PII in Scraped Data

The `store_prices` table contains only:
- Product information (name, price, brand)
- Store information (store_id, store_name)
- Scraping metadata (scraped_at, source, postal_code)

No user IDs, device IDs, list IDs, or personal information.

---

## 10. Legal Considerations

### 10.1 Terms of Service Review Required

**⚠️ Before implementing, review each store's Terms of Service and robots.txt.**

| Store | robots.txt | ToS Review | Risk Level |
|-------|-----------|------------|------------|
| Loblaws Group | Check `nofrills.ca/robots.txt` | Required | Medium — public website |
| Metro Group | Check `metro.ca/robots.txt` | Required | Medium — public website |
| Walmart Canada | Check `walmart.ca/robots.txt` | Required | High — aggressive anti-bot |
| FreshCo | Check `freshco.ca/robots.txt` | Required | Low-Medium |

### 10.2 Mitigation Strategies

1. **Respect robots.txt** — Check and honor `Disallow` directives
2. **Rate limiting** — Max 30 requests/minute per store (well below human browsing speed)
3. **No login bypass** — Only access publicly available product/pricing pages
4. **Caching** — Don't re-scrape items scraped within the last 24 hours
5. **User-Agent** — Identify as a standard browser, not a bot
6. **No circumvention** — Don't bypass CAPTCHAs, geo-blocks, or access controls
7. **Personal use only** — This is for personal grocery price comparison, not commercial resale

### 10.3 Legal Position

This scraper is for **personal, non-commercial use** to compare prices for the user's own grocery shopping. It accesses publicly available pricing information that any consumer can see by visiting the store's website. No accounts are created, no login credentials are used, and no data is resold.

### 10.4 Recommendation

Implement the scraper with self-hosted deployment only (Pi). The `scraping.ts` placeholder already carries the correct legal warning. The new Python scraper should carry the same disclaimer.

---

## 11. Error Handling & Resilience

### 11.1 Per-Store Failure Isolation

If one store's API is down or blocked, the others continue working:

```
nofrills  → ✅ 45 prices
metro     → ❌ API timeout (skip, log warning)
walmart   → ✅ 38 prices
foodbasics → ✅ 41 prices
```

### 11.2 Retry Strategy

```python
def search_with_retry(self, query: str, postal_code: str, max_retries: int = 2):
    for attempt in range(max_retries + 1):
        try:
            return self.search(query, postal_code)
        except requests.RequestException as e:
            if attempt == max_retries:
                raise
            time.sleep(2 ** attempt)  # Exponential backoff: 1s, 2s
```

### 11.3 Staleness Graceful Degradation

If a scrape fails entirely, the existing `store_prices` data remains valid for up to 7 days. The adapter checks `scraped_at` and returns results with appropriate confidence levels:

- 1-3 days old: `recent` confidence — still useful
- 3-7 days old: `estimated` confidence — show with "~" prefix
- > 7 days: don't show at all (stale)

---

## 12. Monitoring & Observability

### 12.1 Scrape Summary (stdout for cron/Telegram)

```
Store Prices for L0R2H4
  No Frills:    45 items scraped, 3 sale prices detected
  Metro:        42 items scraped, 5 sale prices detected
  Walmart:      38 items scraped, 2 sale prices detected
  Total:        125 prices, 0 errors
  Duration:     4m 32s
  Written to:   Turso store_prices table
```

### 12.2 Logging

All scrape runs log to `~/.hermes/logs/store_prices.log` with:
- Timestamp, postal code, items requested
- Per-store results (items found, errors)
- Duration
- Turso write stats

### 12.3 Health Checks

```sql
-- Check freshness of store prices
SELECT store_id, COUNT(*) as items,
       MAX(scraped_at) as last_scraped,
       MIN(scraped_at) as oldest
FROM store_prices
GROUP BY store_id;

-- Check price distribution
SELECT store_id, COUNT(*) as total,
       AVG(price_real) as avg_price,
       SUM(CASE WHEN is_on_sale THEN 1 ELSE 0 END) as on_sale
FROM store_prices
WHERE scraped_at > datetime('now', '-3 days')
GROUP BY store_id;
```

---

## 13. Implementation Phases

### Phase 1: Loblaws Group API Scraper (3-4 days)

| Task | Details |
|------|---------|
| Reverse-engineer PC Express API | Extract API key, headers, request format |
| Implement `LoblawsGroupScraper` | No Frills first, then Loblaws, Superstore |
| Create `store_prices` Turso table | Run schema migration |
| Write `store_prices_scrape.py` | Main entry point, CLI, Turso write |
| Test with real postal code + items | Verify data quality |
| Deploy to Pi | Cron schedule |

**Deliverable:** Working scraper for 3 Loblaws banners, prices in Turso.

### Phase 2: Metro + Walmart (2-3 days)

| Task | Details |
|------|---------|
| Implement `MetroGroupScraper` | Metro + Food Basics |
| Implement `WalmartCaScraper` | Walmart Canada |
| Handle anti-bot gracefully | Fallback to Playwright if needed |
| Update Pi cron | Add new stores to rotation |

**Deliverable:** 5 stores covered, daily/weekly cron running.

### Phase 3: TypeScript Adapter (1 day)

| Task | Details |
|------|---------|
| Create `store-prices-adapter.ts` | Query store_prices from Turso |
| Register in `registry.ts` | Add to adapter chain |
| Confidence mapping | Age-based confidence from scraped_at |
| Test end-to-end | Item added → price displayed |

**Deliverable:** App displays scraped shelf prices alongside Flipp deals.

### Phase 4: FreshCo + Polish (1-2 days)

| Task | Details |
|------|---------|
| Implement `FreshCoScraper` | HTML/Playwright scraping |
| On-demand relay integration | App triggers scrape via relay |
| Item list auto-update | New grocery items → scrape list |
| Monitoring dashboard | Pi health check script |

**Deliverable:** Full 6-store coverage, on-demand scraping, monitoring.

---

## 14. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Stores covered | 6 | Count of working scrapers |
| Price match rate | >50% of common items | Items with at least 1 store price |
| Scrape success rate | >90% per store | Successful requests / total |
| Price freshness | <72 hours average | AVG(now - scraped_at) |
| Scrape duration | <30 min full run | Timer on main() |
| Error rate | <5% per store | Errors / total requests |
| DB write success | >99% | Inserts / attempts |

---

## 15. File Inventory

### New Files

| File | Location | Purpose |
|------|----------|---------|
| `store_prices_scrape.py` | `~/.hermes/scripts/` | Main entry point |
| `scrapers/__init__.py` | `~/.hermes/scripts/scrapers/` | Package init |
| `scrapers/base.py` | `~/.hermes/scripts/scrapers/` | Base scraper class |
| `scrapers/loblaws_group.py` | `~/.hermes/scripts/scrapers/` | No Frills, Loblaws, Superstore |
| `scrapers/metro_group.py` | `~/.hermes/scripts/scrapers/` | Metro, Food Basics |
| `scrapers/walmart_ca.py` | `~/.hermes/scripts/scrapers/` | Walmart Canada |
| `scrapers/freshco_ca.py` | `~/.hermes/scripts/scrapers/` | FreshCo |
| `normalize_store_prices.py` | `~/.hermes/scripts/` | Price/name normalization |
| `store-prices-adapter.ts` | `src/pricing/` | TypeScript adapter for Turso query |

### Modified Files

| File | Change |
|------|--------|
| `src/pricing/registry.ts` | Register `StorePricesAdapter` |
| `~/.hermes/scripts/flippscrape.py` | No changes (parallel system) |

### New DB Objects

| Object | Purpose |
|--------|---------|
| `store_prices` table | Shelf price storage |
| Indexes on store_prices | Query performance |

---

## 16. Open Questions

1. **API key rotation for Loblaws** — The PC Express API key is embedded in their website JS. How often does it rotate? Build a key-extraction script that runs before each scrape?

2. **Walmart anti-bot** — Walmart uses Cloudflare + fingerprinting. If HTTP scraping fails, is Playwright on Pi viable (headless Chromium memory usage)?

3. **Store resolution caching** — Postal code → store ID mapping rarely changes. Cache for 30 days?

4. **Deduplication across stores** — Same product (e.g., "Lactancia Milk 2L") at different prices. Should we normalize product identities or keep store-level pricing separate?

5. **Price history** — Should we keep historical prices in a separate table for trend analysis, or only the latest snapshot?

6. **Triggering from app** — Should the app send the grocery list to the relay server for on-demand scraping, or only use the Pi cron rotation?
