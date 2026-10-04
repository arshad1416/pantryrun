# Checklist import and Google Keep

_Checked 4 Oct 2026 against Google's official developer documentation._

## What ships

**Add Item → "Paste a checklist"** opens `ChecklistImportSheet`, which works like this:

1. You paste text. That can be Google Keep's *Copy* output (`☐` / `☑` lines), a Markdown task list (`[ ]` / `[x]`), bullets, or plain lines.
2. A preview shows every line. Each line is marked as a heading or an item, with its quantity, checked state, attached notes and section. Lines that need a decision are flagged:
   - ambiguous headings
   - duplicates within the paste
   - items already on the list
   - conflicting variants
   - assumed or invalid quantities
3. Nothing changes until you tap **Add N items**:
   - **Cancel** leaves the list untouched.
   - The add is all-or-nothing: if any add fails, the items already added are removed.
   - After a successful import you can **Undo** it.

The parsing and review rules are in `src/services/checklistImport.ts` and are covered by `__tests__/checklist-import.test.ts`:
- Headings such as `Costco:` or `A1 Cash & Carry` are never added as products. Items under them get a `Section: …` note.
- Duplicates are skipped by default and never summed.
- Variants are never merged.

## Direct Google Keep import: not feasible for this app today

| Route | Status |
|---|---|
| Google Keep API (`keep.googleapis.com`) | Built for enterprise use. Google describes it as "used in an enterprise environment to manage Google Keep content and resolve issues identified by cloud security software" ([API reference](https://developers.google.com/workspace/keep/api/reference/rest)). Authorization uses domain-wide delegation, which a Workspace administrator has to approve ([guides](https://developers.google.com/workspace/keep/api/guides)). The note resource does carry checklist items with `text` and `checked` fields ([Note resource](https://developers.google.com/workspace/keep/api/reference/rest/v1/notes)). The documentation offers no route for a personal `@gmail.com` account, so a consumer family app can't use it. |
| Unofficial / reverse-engineered Keep clients | Not considered. They are unsupported and would mean handling Google credentials. |
| Google Takeout export | Not verified. The Takeout help page I checked doesn't list Keep, so this is not claimed as a supported route. |
| Keep → Android/iOS share sheet → app | Possible future work. The app would receive the same text the paste flow already parses. It hasn't been built or tested. |

Not done, by design: no Google authentication or OAuth client setup. Writing to Keep and syncing with it are out of scope.
