# Google Keep import — feasibility (checked 2026-10-04)

## Decision

PantryRun ships a **paste-and-review import** (`src/import/checklist-import.ts`,
`src/components/ImportChecklistSheet.tsx`). There is no direct Google Keep
connection, and writing back to Keep is out of scope.

## What the official API allows

Sources: the Google Keep API overview
(<https://developers.google.com/workspace/keep/api/guides>) and the REST reference
(<https://developers.google.com/workspace/keep/api/reference/rest/v1/notes>,
`.../notes/list`), read 2026-10-04.

- The API is described as a way "to create apps allowing **enterprise
  administrators** to manage Google Keep notes". It is documented for **Google
  Workspace** only.
- Authorization is by **domain-wide delegation**, either through a service
  account or through an OAuth client a Workspace administrator approves.
- `GET https://keep.googleapis.com/v1/notes` accepts the scope
  `https://www.googleapis.com/auth/keep.readonly`. A read-only route exists.
- A checklist note's `body.list.listItems[]` has `checked` and one level of
  `childListItems[]`, so checkbox state would come through.

## What that means for this app

| Account type | Supported read-only route? | What would be required |
|---|---|---|
| Consumer Google account (@gmail.com) | **No.** The API is not offered to consumer accounts. | Nothing works. Use paste-and-review. |
| Google Workspace account | Possible | A Workspace admin grants domain-wide delegation for `keep.readonly` to a PantryRun OAuth client or service account. You also need a Google Cloud project, OAuth consent configuration and app verification for a restricted scope. A server would have to hold delegated credentials, which conflicts with PantryRun's end-to-end-encrypted, relay-can't-read design. |

The account linked to this project is a consumer @gmail.com account, so there is
**no supported read-only Keep route for it**. We have not built any of the
following, and should not:

- unofficial or reverse-engineered Keep endpoints (e.g. gkeepapi-style clients),
- extracting a master token or cookies from a signed-in Google session,
- screen-scraping keep.google.com.

These break Google's terms, put the user's whole Google account at risk, and
could stop working without notice.

## The workflow that ships

1. In Keep, open the note, select all and copy. (Keep's "Copy to Google Docs" also works:
   copy the text out of the resulting Doc.)
2. In PantryRun, tap the clipboard icon on the list and paste the text.
3. Review the preview:
   - Checkbox state is kept. Checked lines default to **Skip**.
   - Headings such as `Costco` or `A1 Cash & Carry:` become store **hints** on the
     lines below them. They are never items and never required stops.
   - Quantities are only taken when they are written down. A missing quantity is
     flagged, and if it is accepted it is labelled as a planning assumption.
   - Notes (`(sale only)`, `- for kids`) stay attached to their line.
   - A line that repeats one in the paste, or is already on the list, is skipped
     and the reason is shown. Lines for the same product in different variants
     (`grapes` / `GREEN grapes` / `red grapes`) are flagged and kept separate.
   - **Import** stays disabled until every flagged line marked Add has been
     reviewed.

If a Workspace user ever needs a direct connection, it would need its own
authorization: a Cloud project, admin delegation, scope verification and a
credential-holding service. None of those exist today.
