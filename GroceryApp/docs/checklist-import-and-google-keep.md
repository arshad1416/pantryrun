# Checklist import and Google Keep

_Checked 4 Oct 2026 against Google's official developer documentation._

## What ships

**Add Item → "Import from Google Keep"** opens `ImportListSheet` (added in PR #6). How to use it:

1. In Keep, copy the note: ⋮ → Send → Copy to clipboard.
2. Paste it into the sheet. A Takeout note's JSON is accepted too.
3. Review the preview, then add the items.

What the parser (`src/import/keep.ts`) does with what you paste:
- **Store headings** (`Costco:`, `— No Frills —`, a bare known store such as `A1 Cash & Carry`) are never imported as items. Items listed under one get the note `From: <Store> list`.
- **Ticked items, repeats and items already on the list** are skipped and listed in the preview.
- **Notes** written in parentheses or after a dash (`ketchup - sale only`) become the item's notes. That keeps the planner's sale-only and variant rules working.
- **Quantities and units** that are written are read. A line with no quantity becomes 1 package of whatever the store sells. That matches the app's convention for an item with no unit.

Undo in the toast removes the imported items.

`__tests__/keep-import.test.ts` covers the parser. `__tests__/keep-import-planning.test.ts` checks that an imported list prices the same as the hand-built Waterdown fixture.

## Direct Google Keep import: not feasible for this app today

| Route | Status |
|---|---|
| Google Keep API (`keep.googleapis.com`) | Google says it is "used in an enterprise environment to manage Google Keep content and resolve issues identified by cloud security software" ([API reference](https://developers.google.com/workspace/keep/api/reference/rest)). Authorization uses domain-wide delegation, which a Workspace administrator has to approve ([guides](https://developers.google.com/workspace/keep/api/guides)). Notes do carry checklist items with `text` and `checked` fields ([Note resource](https://developers.google.com/workspace/keep/api/reference/rest/v1/notes)). The docs give no route for a personal `@gmail.com` account, so a consumer family app can't use it. |
| Unofficial / reverse-engineered Keep clients | Not considered. They are unsupported and would mean handling Google credentials. |
| Google Takeout export | Pasting a note's JSON is supported. A bulk Takeout import is not built. |
| Keep → Android/iOS share sheet → app | Possible future work, using the same parser. Not built or tested. |

Deliberately not done: Google authentication, OAuth client setup, writing to Keep, and syncing with it.
