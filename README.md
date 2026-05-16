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
- Optional token gate with a Cloudflare Worker secret

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

routes = [
  { pattern = "files.example.com/*", custom_domain = true }
]

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "your-r2-bucket-name"

[vars]
EXPLORER_TITLE = "R2 Drive"
ALLOW_UPLOADS = "true"
ALLOW_DELETES = "true"
```

The Worker code expects the R2 binding to be named `BUCKET`.

### Optional access token

Without `AUTH_TOKEN`, anyone who can reach the domain can use the explorer. To
require sign-in, set a Worker secret:

```sh
npx wrangler secret put AUTH_TOKEN
```

Users will be redirected to `/login` and must enter that token.

### Disable writes

Set these variables in `wrangler.toml` if you want read-only or upload-only
behavior:

```toml
[vars]
ALLOW_UPLOADS = "false"
ALLOW_DELETES = "false"
```

## Local development

Run the Worker locally:

```sh
npm run dev
```

Wrangler will use your Cloudflare account and R2 binding configuration. For local
secret testing, create `.dev.vars`:

```ini
AUTH_TOKEN=replace-with-a-local-token
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
- `GET /api/object?key=<key>` opens an object.
- `GET /api/object?key=<key>&download=1` downloads an object.
- `POST /api/upload` uploads multipart form files using `prefix` and `files`.
- `POST /api/folder` creates a folder marker from JSON `{ "prefix", "name" }`.
- `DELETE /api/object?key=<key>` deletes an object.
