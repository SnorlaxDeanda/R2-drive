# R2 Drive

A simple Cloudflare Worker file explorer for Cloudflare R2 storage. Deploy it to a
Worker route or custom domain to browse a bucket, upload files, create folders,
download objects, and delete objects from a web UI.

## Features

- Folder-style navigation using R2 prefixes
- File table with name, last modified time, size, and content type
- Drag-and-drop or file-picker uploads
- New folder creation using hidden `.keep` marker objects
- Open and download links for objects
- Optional delete support
- Optional named users with Cloudflare Worker secrets
- Optional book covers, titles, authors, and descriptions from an R2 JSON file
- Admin-only download/open statistics by user and book

## Requirements

- Node.js
- A Cloudflare account with Workers and R2 enabled
- An existing R2 bucket
- A domain or route configured for the Worker

## Setup

Install dependencies:

```sh
npm install
```

Update `wrangler.toml`:

```toml
name = "r2-drive"
main = "src/worker.ts"
compatibility_date = "2026-05-16"

[[routes]]
pattern = "files.example.com"
custom_domain = true

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "your-r2-bucket-name"

[vars]
EXPLORER_TITLE = "Book Vault"
ALLOW_UPLOADS = "true"
ALLOW_DELETES = "true"
```

The Worker code expects the R2 binding to be named `BUCKET`.

If you deploy as a Cloudflare **Worker Custom Domain**, use just the hostname:

```toml
[[routes]]
pattern = "files.example.com"
custom_domain = true
```

Do not use this for a custom domain:

```toml
{ pattern = "files.example.com/*", custom_domain = true }
```

That line is invalid by itself, and `custom_domain = true` should not include
`/*`.

If you instead want a normal zone route, use this format:

```toml
[[routes]]
pattern = "files.example.com/*"
zone_name = "example.com"
```

### Optional users

Without auth settings, anyone who can reach the domain can use the explorer. To
require sign-in and make it easy to add users later, set an `AUTH_USERS` Worker
secret:

```sh
npx wrangler secret put AUTH_USERS
```

When Wrangler asks for the value, paste JSON like this:

```json
{"alice":"alice-secret-token","bob":"bob-secret-token"}
```

Users will be redirected to `/login` and must enter their username and token.

By default, users in the simple format can browse and upload, but they cannot
delete. To let one user delete files, use the expanded format and set
`canDelete` to `true` for that user:

```json
{
  "john": {
    "token": "john-secret-token",
    "canDelete": true
  },
  "jane": "jane-secret-token",
  "sam": "sam-secret-token"
}
```

In that example, `john` can delete files. `jane` and `sam` cannot delete files.
`ALLOW_DELETES` must also stay set to `"true"` in `wrangler.toml`; setting it to
`"false"` disables deletes for everyone.

To add another user in the future, run the same command again with the updated
JSON:

```json
{"john":{"token":"john-secret-token","canDelete":true},"jane":"jane-secret-token","sam":"sam-secret-token","charlie":"charlie-secret-token"}
```

For a single shared token, the app still supports the older `AUTH_TOKEN` secret:

```sh
npx wrangler secret put AUTH_TOKEN
```

### Disable writes

Set these variables in `wrangler.toml` if you want read-only or upload-only
behavior:

```toml
[vars]
ALLOW_UPLOADS = "false"
ALLOW_DELETES = "false"
```

## Book covers and descriptions

To show book covers and descriptions, upload a JSON file named
`_book-metadata.json` to the root of the R2 bucket. The explorer hides this file
from the normal file list and uses it to decorate matching book files.

Use the exact R2 object key for each book. If a book is inside a folder, include
the folder path in the key:

```json
{
  "books": {
    "Dune.epub": {
      "title": "Dune",
      "author": "Frank Herbert",
      "description": "A desert planet, a noble family, and a fight over the most valuable resource in the universe.",
      "coverUrl": "https://example.com/covers/dune.jpg"
    },
    "Fantasy/The Hobbit.pdf": {
      "title": "The Hobbit",
      "author": "J. R. R. Tolkien",
      "description": "Bilbo Baggins joins a company of dwarves on a quest to reclaim a mountain home.",
      "coverKey": "covers/the-hobbit.jpg"
    }
  }
}
```

Cover options:

- `coverUrl` points to an image hosted anywhere on the web.
- `coverKey` points to an image stored in the same R2 bucket. The explorer serves
  it through the existing authenticated `/api/object` route.

Supported optional fields for each book:

- `title`
- `author`
- `description`
- `coverUrl`
- `coverKey`

After changing `_book-metadata.json`, refresh the explorer page.

## Download statistics

The explorer records lightweight analytics events when a signed-in user clicks
`Open` or `Download` for a book/file. Stats are stored in the same R2 bucket as
small JSON files under:

```txt
_analytics/downloads/
```

The `_analytics/` folder is hidden from normal browsing and search results.

Users who can delete files (`canDelete: true`) can also view statistics from the
`Stats` button in the explorer. The stats panel shows:

- total tracked opens/downloads
- top books/files
- activity by user
- recent open/download events

Example user with stats access:

```json
{
  "Joe": {
    "token": "joe-password",
    "canDelete": true
  },
  "Reader": "reader-password"
}
```

In that example, `Joe` can delete files and view stats. `Reader` can use the
library but cannot view stats.

Cover images loaded through `coverKey` are not tracked as downloads. Browser
range requests are also ignored to avoid inflated counts for previews.

## Local development

Run the Worker locally:

```sh
npm run dev
```

Wrangler will use your Cloudflare account and R2 binding configuration. For local
multi-user testing, create `.dev.vars`:

```ini
AUTH_USERS={"alice":"alice-secret-token","bob":"bob-secret-token"}
```

Then open the local Wrangler URL and browse to `/files`.

## Deploy

After updating `wrangler.toml` with your bucket and domain:

```sh
npm run deploy
```

The root path redirects to `/files`, which renders the explorer.

## API routes

The UI uses these same-origin routes:

- `GET /api/list?prefix=<prefix>` lists folders and files.
- `GET /api/search?q=<query>` searches files and book metadata.
- `GET /api/stats` returns aggregated stats for admin/delete-capable users.
- `GET /api/object?key=<key>` opens an object.
- `GET /api/object?key=<key>&download=1` downloads an object.
- `POST /api/upload` uploads multipart form files using `prefix` and `files`.
- `POST /api/folder` creates a folder marker from JSON `{ "prefix", "name" }`.
- `DELETE /api/object?key=<key>` deletes an object.
