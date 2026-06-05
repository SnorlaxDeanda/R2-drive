interface Env {
  BUCKET: R2Bucket;
  EXPLORER_TITLE?: string;
  AUTH_USERS?: string;
  AUTH_TOKEN?: string;
  ALLOW_UPLOADS?: string;
  ALLOW_DELETES?: string;
}

interface FileEntry {
  book?: BookInfo;
  key: string;
  name: string;
  size: number;
  uploaded: string;
  contentType?: string;
  etag?: string;
}

interface FolderEntry {
  name: string;
  prefix: string;
}

interface BookInfo {
  author?: string;
  coverKey?: string;
  coverUrl?: string;
  description?: string;
  title?: string;
}

interface AuthUser {
  canDelete: boolean;
  username: string;
  token: string;
}

const LEGACY_COOKIE_NAME = "r2_drive_token";
const SESSION_COOKIE_NAME = "r2_drive_session";
const FAVICON_URL = "https://www.freeiconspng.com/download/138";
const LOGO_URL = "https://www.pngmart.com/files/22/Snorlax-Pokemon-PNG.gif";
const BOOK_METADATA_KEY = "_book-metadata.json";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/logout") {
        return redirectWithCookie("/login", clearAuthCookie(url));
      }

      if (hasAuth(env) && url.pathname === "/login") {
        return handleLogin(request, env, url);
      }

      if (hasAuth(env) && !isAuthorized(request, env)) {
        return unauthorizedResponse(request, url);
      }

      if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/" && request.method === "GET") {
        return Response.redirect(`${url.origin}/files`, 302);
      }

      if (url.pathname === "/favicon.ico" && request.method === "GET") {
        return Response.redirect(FAVICON_URL, 302);
      }

      if (url.pathname === "/api/list" && request.method === "GET") {
        return listObjects(request, env);
      }

      if (url.pathname === "/api/object" && request.method === "GET") {
        return getObject(request, env);
      }

      if (url.pathname === "/api/upload" && request.method === "POST") {
        return uploadObjects(request, env);
      }

      if (url.pathname === "/api/folder" && request.method === "POST") {
        return createFolder(request, env);
      }

      if (url.pathname === "/api/object" && request.method === "DELETE") {
        return deleteObject(request, env);
      }

      if (request.method === "GET" && (url.pathname === "/files" || url.pathname.startsWith("/files/"))) {
        return html(renderExplorer(request, env), 200);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      return json({ error: message }, 500);
    }
  },
};

async function listObjects(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const prefix = normalizePrefix(url.searchParams.get("prefix"));
  const cursor = url.searchParams.get("cursor") || undefined;
  const bookMetadata = await getBookMetadata(env);
  const listed = await env.BUCKET.list({
    cursor,
    delimiter: "/",
    limit: 1000,
    prefix,
  });

  const folders: FolderEntry[] = (listed.delimitedPrefixes ?? [])
    .sort((left, right) => left.localeCompare(right))
    .map((folderPrefix) => ({
      name: folderName(prefix, folderPrefix),
      prefix: folderPrefix,
    }));

  const files: FileEntry[] = listed.objects
    .filter((object) => shouldShowObject(object.key, prefix))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((object) => {
      const name = object.key.slice(prefix.length);

      return {
        book: findBookInfo(bookMetadata, object.key, name),
        key: object.key,
        name,
        size: object.size,
        uploaded: object.uploaded.toISOString(),
        contentType: object.httpMetadata?.contentType,
        etag: object.httpEtag,
      };
    });

  return json({
    cursor: listed.truncated ? listed.cursor : null,
    files,
    folders,
    prefix,
    truncated: listed.truncated,
  });
}

async function getObject(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = normalizeKey(url.searchParams.get("key"));
  const object = await env.BUCKET.get(key, {
    range: request.headers,
  });

  if (!object) {
    return json({ error: "Object not found" }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=60");
  headers.set("etag", object.httpEtag);

  const range = object.range;
  let status = 200;

  if (range) {
    const { length, offset } = normalizeReturnedRange(range, object.size);
    status = 206;
    headers.set("content-length", String(length));
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
  } else {
    headers.set("content-length", String(object.size));
  }

  if (url.searchParams.get("download") === "1") {
    headers.set("content-disposition", `attachment; filename="${safeHeaderFilename(basename(key))}"`);
  }

  return new Response(object.body, { headers, status });
}

async function uploadObjects(request: Request, env: Env): Promise<Response> {
  if (!isEnabled(env.ALLOW_UPLOADS, true)) {
    return json({ error: "Uploads are disabled" }, 403);
  }

  const form = await request.formData();
  const prefix = normalizePrefix(form.get("prefix"));
  const files = (form.getAll("files") as unknown[]).filter(isFileWithName);

  if (files.length === 0) {
    return json({ error: "No files were uploaded" }, 400);
  }

  const uploaded: FileEntry[] = [];

  for (const file of files) {
    const key = `${prefix}${normalizeObjectName(file.name)}`;
    const object = await env.BUCKET.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type || "application/octet-stream",
      },
    });

    uploaded.push({
      key,
      name: key.slice(prefix.length),
      size: file.size,
      uploaded: object.uploaded.toISOString(),
      contentType: file.type || "application/octet-stream",
      etag: object.httpEtag,
    });
  }

  return json({ uploaded }, 201);
}

async function createFolder(request: Request, env: Env): Promise<Response> {
  if (!isEnabled(env.ALLOW_UPLOADS, true)) {
    return json({ error: "Folder creation is disabled" }, 403);
  }

  const body = await request.json<{ name?: string; prefix?: string }>();
  const prefix = normalizePrefix(body.prefix ?? "");
  const folder = normalizeFolderName(body.name ?? "");
  const folderPrefix = `${prefix}${folder}/`;
  const markerKey = `${folderPrefix}.keep`;
  const object = await env.BUCKET.put(markerKey, "", {
    customMetadata: {
      marker: "folder",
    },
    httpMetadata: {
      contentType: "application/x-directory",
    },
  });

  return json(
    {
      folder: {
        name: folder,
        prefix: folderPrefix,
      },
      marker: {
        key: markerKey,
        uploaded: object.uploaded.toISOString(),
      },
    },
    201,
  );
}

async function deleteObject(request: Request, env: Env): Promise<Response> {
  if (!canDeleteObjects(request, env)) {
    return json({ error: "Deletes are disabled" }, 403);
  }

  const url = new URL(request.url);
  const key = normalizeKey(url.searchParams.get("key"));
  await env.BUCKET.delete(key);
  return json({ deleted: key });
}

async function handleLogin(request: Request, env: Env, url: URL): Promise<Response> {
  const users = getAuthUsers(env);

  if (request.method === "GET") {
    return html(renderLogin(url, users), 200);
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const form = await request.formData();
  const username = String(form.get("username") ?? "");
  const token = String(form.get("token") ?? "").trim();
  const next = safeNextPath(String(form.get("next") ?? "/files"));
  const user = authenticateUser(users, username, token);

  if (!user) {
    return html(renderLogin(url, users, "The username or token you entered is not valid."), 401);
  }

  return redirectWithCookie(next, authCookie(user, url));
}

function renderExplorer(request: Request, env: Env): string {
  const title = env.EXPLORER_TITLE || "R2 Drive";
  const config = safeJson({
    allowDeletes: canDeleteObjects(request, env),
    allowUploads: isEnabled(env.ALLOW_UPLOADS, true),
    title,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/png" href="${FAVICON_URL}">
  <style>
    :root {
      color-scheme: light;
      --bg: #b01aa8;
      --card: #ffffff;
      --text: #182033;
      --muted: #647084;
      --line: #dde3ee;
      --accent: #ffffff;
      --accent-dark: #f4edf7;
      --accent-text: #2a0630;
      --danger: #c62828;
      --shadow: 0 18px 45px rgba(42, 6, 40, 0.24);
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button,
    input {
      font: inherit;
    }
    .shell {
      margin: 0 auto;
      max-width: 1180px;
      padding: 32px 20px 56px;
    }
    .topbar {
      align-items: center;
      display: flex;
      gap: 16px;
      justify-content: space-between;
      margin-bottom: 24px;
      color: white;
    }
    .brand {
      align-items: center;
      display: flex;
      gap: 14px;
    }
    .logo {
      align-items: center;
      background: var(--accent);
      border-radius: 16px;
      color: white;
      display: inline-flex;
      font-size: 24px;
      height: 48px;
      justify-content: center;
      overflow: hidden;
      width: 48px;
    }
    .logo img {
      display: block;
      height: 100%;
      object-fit: contain;
      width: 100%;
    }
    h1 {
      font-size: clamp(24px, 4vw, 34px);
      line-height: 1.1;
      margin: 0;
    }
    .subtitle {
      color: rgba(255, 255, 255, 0.82);
      margin-top: 4px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: flex-end;
    }
    .button {
      align-items: center;
      background: var(--accent);
      border: 1px solid var(--accent);
      border-radius: 12px;
      color: var(--accent-text);
      cursor: pointer;
      display: inline-flex;
      font-weight: 650;
      gap: 8px;
      min-height: 44px;
      padding: 10px 14px;
      text-decoration: none;
      transition: 0.16s ease;
      white-space: nowrap;
    }
    .button:hover {
      background: var(--accent-dark);
      border-color: var(--accent-dark);
      transform: translateY(-1px);
    }
    .button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-text);
    }
    .button.primary:hover {
      background: var(--accent-dark);
      border-color: var(--accent-dark);
    }
    .button.danger {
      color: var(--danger);
    }
    .card {
      background: rgba(255, 255, 255, 0.92);
      border: 1px solid rgba(221, 227, 238, 0.9);
      border-radius: 24px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .toolbar {
      align-items: center;
      border-bottom: 1px solid var(--line);
      display: flex;
      gap: 14px;
      justify-content: space-between;
      padding: 18px 20px;
    }
    .breadcrumbs {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      min-width: 0;
    }
    .crumb {
      background: transparent;
      border: 0;
      color: #2a0630;
      cursor: pointer;
      font-weight: 700;
      padding: 0;
    }
    .separator {
      color: var(--muted);
    }
    .status {
      color: var(--muted);
      min-height: 22px;
      text-align: right;
    }
    .dropzone {
      align-items: center;
      background: #ffffff;
      border-bottom: 1px dashed #e7dbea;
      color: #2a0630;
      display: flex;
      gap: 10px;
      justify-content: center;
      padding: 14px;
      transition: 0.16s ease;
    }
    .dropzone.dragging {
      background: #f4edf7;
      color: #2a0630;
    }
    .dropzone.hidden {
      display: none;
    }
    .table-wrap {
      overflow-x: auto;
    }
    table {
      border-collapse: collapse;
      min-width: 760px;
      width: 100%;
    }
    th,
    td {
      border-bottom: 1px solid var(--line);
      padding: 14px 18px;
      text-align: left;
      vertical-align: middle;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    tr:last-child td {
      border-bottom: 0;
    }
    tr.folder {
      cursor: pointer;
    }
    tr.folder:hover,
    tr.file:hover {
      background: #fbfcff;
    }
    .name-cell {
      align-items: center;
      display: flex;
      gap: 10px;
      min-width: 280px;
    }
    .book-cell {
      align-items: flex-start;
      display: flex;
      gap: 14px;
      min-width: 340px;
    }
    .book-cover {
      align-items: center;
      background: #f4edf7;
      border: 1px solid var(--line);
      border-radius: 10px;
      color: var(--muted);
      display: flex;
      flex: 0 0 58px;
      font-size: 11px;
      font-weight: 700;
      height: 82px;
      justify-content: center;
      overflow: hidden;
      text-align: center;
      text-transform: uppercase;
      width: 58px;
    }
    .book-cover img {
      display: block;
      height: 100%;
      object-fit: cover;
      width: 100%;
    }
    .book-details {
      min-width: 0;
    }
    .book-title {
      color: var(--text);
      font-weight: 800;
      overflow-wrap: anywhere;
    }
    .book-author,
    .book-filename {
      color: var(--muted);
      font-size: 13px;
      margin-top: 2px;
      overflow-wrap: anywhere;
    }
    .book-description {
      color: #38445a;
      font-size: 13px;
      line-height: 1.4;
      margin-top: 6px;
      max-width: 42rem;
      overflow-wrap: anywhere;
    }
    .icon {
      align-items: center;
      border-radius: 10px;
      display: inline-flex;
      height: 32px;
      justify-content: center;
      width: 32px;
    }
    .icon.folder {
      background: #fbe7fa;
    }
    .icon.file {
      background: #ffffff;
    }
    .muted {
      color: var(--muted);
    }
    .row-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .link-button {
      background: transparent;
      border: 0;
      color: #2a0630;
      cursor: pointer;
      font-weight: 700;
      min-height: 40px;
      padding: 4px;
      text-decoration: none;
    }
    .link-button.danger {
      color: var(--danger);
    }
    .empty {
      color: var(--muted);
      padding: 44px 20px;
      text-align: center;
    }
    .load-more {
      border-top: 1px solid var(--line);
      padding: 16px 20px;
      text-align: center;
    }
    .load-more.hidden,
    .hidden {
      display: none;
    }
    @media (max-width: 760px) {
      .topbar,
      .toolbar {
        align-items: flex-start;
        flex-direction: column;
      }
      .actions,
      .status {
        justify-content: flex-start;
        text-align: left;
      }
      .shell {
        padding: 22px 12px 36px;
      }
      .brand {
        align-items: flex-start;
      }
      .logo {
        border-radius: 14px;
        flex: 0 0 auto;
        font-size: 18px;
        height: 42px;
        width: 42px;
      }
      .subtitle {
        font-size: 14px;
      }
      .actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        width: 100%;
      }
      .button {
        justify-content: center;
        text-align: center;
        width: 100%;
      }
      .card {
        border-radius: 18px;
      }
      .toolbar {
        padding: 14px 16px;
      }
      .breadcrumbs {
        gap: 5px;
        line-height: 1.7;
      }
      .dropzone {
        padding: 14px 16px;
        text-align: center;
      }
      .table-wrap {
        overflow-x: visible;
        padding: 12px;
      }
      table,
      tbody,
      tr,
      td {
        display: block;
        min-width: 0;
        width: 100%;
      }
      table {
        border-collapse: separate;
      }
      thead {
        display: none;
      }
      tbody {
        display: grid;
        gap: 12px;
      }
      tr.folder,
      tr.file {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 12px;
      }
      tr.folder:hover,
      tr.file:hover {
        background: var(--card);
      }
      td {
        align-items: center;
        border-bottom: 0;
        color: var(--text);
        display: flex;
        gap: 16px;
        justify-content: space-between;
        padding: 7px 2px;
        text-align: right;
      }
      td::before {
        color: var(--muted);
        content: attr(data-label);
        flex: 0 0 auto;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-align: left;
        text-transform: uppercase;
      }
      td:first-child {
        border-bottom: 1px solid var(--line);
        margin-bottom: 6px;
        padding-bottom: 12px;
        text-align: left;
      }
      td:first-child::before,
      td.actions-cell::before {
        display: none;
      }
      .name-cell {
        min-width: 0;
        width: 100%;
      }
      .book-cell {
        min-width: 0;
        width: 100%;
      }
      .book-cover {
        flex-basis: 52px;
        height: 74px;
        width: 52px;
      }
      .name-cell span:last-child {
        overflow-wrap: anywhere;
      }
      .actions-cell {
        padding-top: 12px;
      }
      .actions-cell.no-actions {
        display: none;
      }
      .row-actions {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        width: 100%;
      }
      .link-button {
        align-items: center;
        background: #ffffff;
        border: 1px solid var(--line);
        border-radius: 12px;
        display: inline-flex;
        justify-content: center;
        padding: 9px 10px;
        text-align: center;
      }
      .link-button.danger {
        background: #fff5f5;
        border-color: #ffd1d1;
      }
      .empty {
        padding: 30px 16px;
      }
    }
    @media (max-width: 420px) {
      .shell {
        padding: 16px 8px 28px;
      }
      .actions,
      .row-actions {
        grid-template-columns: 1fr;
      }
      .brand {
        gap: 10px;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="logo" aria-hidden="true">
          <img src="${LOGO_URL}" alt="">
        </div>
        <div>
          <h1>${escapeHtml(title)}</h1>
          <div class="subtitle">Welcome to Joe's book Vault! Please reachout on discord
          for any requests. thatoneguy5633</div>
        </div>
      </div>
      <div class="actions">
        <button class="button" id="refreshButton" type="button">Refresh</button>
        <button class="button" id="newFolderButton" type="button">New folder</button>
        <button class="button primary" id="uploadButton" type="button">Upload files</button>
        ${hasAuth(env) ? '<a class="button" href="/logout">Sign out</a>' : ""}
      </div>
    </header>

    <section class="card" aria-live="polite">
      <div class="toolbar">
        <nav class="breadcrumbs" id="breadcrumbs" aria-label="Current folder"></nav>
        <div class="status" id="status"></div>
      </div>
      <div class="dropzone" id="dropzone">Drop files here to upload to the current folder.</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Last modified</th>
              <th>Size</th>
              <th>Type</th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody id="entries"></tbody>
        </table>
        <div class="empty hidden" id="emptyState">This folder is empty.</div>
      </div>
      <div class="load-more hidden" id="loadMoreWrap">
        <button class="button" id="loadMoreButton" type="button">Load more</button>
      </div>
    </section>
  </main>
  <input class="hidden" id="fileInput" multiple type="file">

  <script>
    const appConfig = ${config};
    const state = {
      cursor: null,
      loading: false,
      prefix: prefixFromLocation()
    };

    const entries = document.querySelector("#entries");
    const emptyState = document.querySelector("#emptyState");
    const statusEl = document.querySelector("#status");
    const breadcrumbs = document.querySelector("#breadcrumbs");
    const loadMoreWrap = document.querySelector("#loadMoreWrap");
    const loadMoreButton = document.querySelector("#loadMoreButton");
    const uploadButton = document.querySelector("#uploadButton");
    const newFolderButton = document.querySelector("#newFolderButton");
    const refreshButton = document.querySelector("#refreshButton");
    const fileInput = document.querySelector("#fileInput");
    const dropzone = document.querySelector("#dropzone");

    if (!appConfig.allowUploads) {
      uploadButton.classList.add("hidden");
      newFolderButton.classList.add("hidden");
      dropzone.classList.add("hidden");
    }

    if (!appConfig.allowDeletes) {
      document.body.dataset.deletes = "disabled";
    }

    window.addEventListener("popstate", () => {
      state.prefix = prefixFromLocation();
      loadList();
    });

    refreshButton.addEventListener("click", () => loadList());
    loadMoreButton.addEventListener("click", () => loadList({ append: true }));
    uploadButton.addEventListener("click", () => fileInput.click());
    newFolderButton.addEventListener("click", createFolder);
    fileInput.addEventListener("change", () => {
      uploadFiles(Array.from(fileInput.files || []));
      fileInput.value = "";
    });

    for (const eventName of ["dragenter", "dragover"]) {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.add("dragging");
      });
    }

    for (const eventName of ["dragleave", "drop"]) {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.remove("dragging");
      });
    }

    dropzone.addEventListener("drop", (event) => {
      uploadFiles(Array.from(event.dataTransfer?.files || []));
    });

    loadList();

    async function loadList(options = {}) {
      if (state.loading) return;
      state.loading = true;
      setStatus(options.append ? "Loading more..." : "Loading...");

      try {
        const params = new URLSearchParams({ prefix: state.prefix });
        if (options.append && state.cursor) params.set("cursor", state.cursor);
        const data = await api("/api/list?" + params.toString());

        state.cursor = data.cursor;
        renderBreadcrumbs();
        renderEntries(data, Boolean(options.append));
        loadMoreWrap.classList.toggle("hidden", !data.truncated);
        setStatus(data.truncated ? "More files are available." : "Up to date.");
      } catch (error) {
        setStatus(error.message || "Unable to load files.");
      } finally {
        state.loading = false;
      }
    }

    function renderEntries(data, append) {
      if (!append) entries.replaceChildren();

      for (const folder of data.folders) {
        entries.appendChild(folderRow(folder));
      }

      for (const file of data.files) {
        entries.appendChild(fileRow(file));
      }

      emptyState.classList.toggle("hidden", entries.children.length > 0);
    }

    function folderRow(folder) {
      const row = document.createElement("tr");
      row.className = "folder";
      row.tabIndex = 0;
      row.addEventListener("click", () => navigate(folder.prefix));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") navigate(folder.prefix);
      });

      row.appendChild(nameCell("folder", folder.name + "/"));
      row.appendChild(mutedCell("--", "Last modified"));
      row.appendChild(mutedCell("--", "Size"));
      row.appendChild(mutedCell("Folder", "Type"));
      row.appendChild(actionsCell());
      return row;
    }

    function fileRow(file) {
      const row = document.createElement("tr");
      row.className = "file";
      row.appendChild(file.book ? bookCell(file) : nameCell("file", file.name));
      row.appendChild(textCell(formatDate(file.uploaded), "Last modified"));
      row.appendChild(textCell(formatSize(file.size), "Size"));
      row.appendChild(textCell(file.contentType || "Object", "Type"));

      const actions = actionsCell();
      actions.classList.remove("no-actions");
      const actionWrap = document.createElement("div");
      actionWrap.className = "row-actions";

      const openLink = document.createElement("a");
      openLink.className = "link-button";
      openLink.href = objectUrl(file.key);
      openLink.target = "_blank";
      openLink.rel = "noopener";
      openLink.textContent = "Open";
      actionWrap.appendChild(openLink);

      const downloadLink = document.createElement("a");
      downloadLink.className = "link-button";
      downloadLink.href = objectUrl(file.key, true);
      downloadLink.textContent = "Download";
      actionWrap.appendChild(downloadLink);

      if (appConfig.allowDeletes) {
        const deleteButton = document.createElement("button");
        deleteButton.className = "link-button danger";
        deleteButton.type = "button";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", () => deleteFile(file));
        actionWrap.appendChild(deleteButton);
      }

      actions.appendChild(actionWrap);
      row.appendChild(actions);
      return row;
    }

    function bookCell(file) {
      const book = file.book || {};
      const title = book.title || file.name;
      const coverSrc = bookCoverUrl(book);
      const cell = document.createElement("td");
      cell.dataset.label = "Book";

      const wrap = document.createElement("div");
      wrap.className = "book-cell";

      const cover = document.createElement("div");
      cover.className = "book-cover";

      if (coverSrc) {
        const image = document.createElement("img");
        image.src = coverSrc;
        image.alt = "";
        image.loading = "lazy";
        image.addEventListener("error", () => {
          image.remove();
          cover.textContent = "No cover";
        });
        cover.appendChild(image);
      } else {
        cover.textContent = "No cover";
      }

      const details = document.createElement("div");
      details.className = "book-details";

      const titleEl = document.createElement("div");
      titleEl.className = "book-title";
      titleEl.textContent = title;
      details.appendChild(titleEl);

      if (book.author) {
        const author = document.createElement("div");
        author.className = "book-author";
        author.textContent = "by " + book.author;
        details.appendChild(author);
      }

      if (title !== file.name) {
        const filename = document.createElement("div");
        filename.className = "book-filename";
        filename.textContent = file.name;
        details.appendChild(filename);
      }

      if (book.description) {
        const description = document.createElement("div");
        description.className = "book-description";
        description.textContent = book.description;
        details.appendChild(description);
      }

      wrap.append(cover, details);
      cell.appendChild(wrap);
      return cell;
    }

    function nameCell(kind, name) {
      const cell = document.createElement("td");
      cell.dataset.label = "Name";
      const wrap = document.createElement("div");
      wrap.className = "name-cell";
      const icon = document.createElement("span");
      icon.className = "icon " + kind;
      icon.textContent = kind === "folder" ? "DIR" : "FILE";
      const label = document.createElement("span");
      label.textContent = name;
      wrap.append(icon, label);
      cell.appendChild(wrap);
      return cell;
    }

    function textCell(value, label) {
      const cell = document.createElement("td");
      cell.dataset.label = label;
      cell.textContent = value;
      return cell;
    }

    function mutedCell(value, label) {
      const cell = textCell(value, label);
      cell.className = "muted";
      return cell;
    }

    function actionsCell() {
      const cell = document.createElement("td");
      cell.className = "actions-cell no-actions";
      cell.dataset.label = "Actions";
      return cell;
    }

    function renderBreadcrumbs() {
      breadcrumbs.replaceChildren();
      const root = crumbButton(appConfig.title, "");
      breadcrumbs.appendChild(root);
      const parts = state.prefix.split("/").filter(Boolean);
      let current = "";

      for (const part of parts) {
        current += part + "/";
        const separator = document.createElement("span");
        separator.className = "separator";
        separator.textContent = "/";
        breadcrumbs.appendChild(separator);
        breadcrumbs.appendChild(crumbButton(part, current));
      }
    }

    function crumbButton(label, prefix) {
      const button = document.createElement("button");
      button.className = "crumb";
      button.type = "button";
      button.textContent = label || "Bucket";
      button.addEventListener("click", () => navigate(prefix));
      return button;
    }

    async function uploadFiles(files) {
      if (!appConfig.allowUploads || files.length === 0) return;
      const form = new FormData();
      form.append("prefix", state.prefix);
      for (const file of files) form.append("files", file);

      setStatus("Uploading " + files.length + " file" + (files.length === 1 ? "" : "s") + "...");

      try {
        await api("/api/upload", {
          body: form,
          method: "POST"
        });
        await loadList();
      } catch (error) {
        setStatus(error.message || "Upload failed.");
      }
    }

    async function createFolder() {
      const name = prompt("Folder name");
      if (!name) return;

      try {
        await api("/api/folder", {
          body: JSON.stringify({ name, prefix: state.prefix }),
          headers: { "content-type": "application/json" },
          method: "POST"
        });
        await loadList();
      } catch (error) {
        setStatus(error.message || "Could not create folder.");
      }
    }

    async function deleteFile(file) {
      if (!confirm("Delete " + file.name + "?")) return;

      try {
        await api("/api/object?key=" + encodeURIComponent(file.key), {
          method: "DELETE"
        });
        await loadList();
      } catch (error) {
        setStatus(error.message || "Delete failed.");
      }
    }

    function navigate(prefix) {
      state.prefix = prefix;
      history.pushState({}, "", pathForPrefix(prefix));
      loadList();
    }

    async function api(path, options = {}) {
      const response = await fetch(path, options);
      if (response.status === 401) {
        location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
        throw new Error("Authentication required.");
      }

      const contentType = response.headers.get("content-type") || "";
      const body = contentType.includes("application/json") ? await response.json() : null;

      if (!response.ok) {
        throw new Error(body?.error || "Request failed.");
      }

      return body;
    }

    function prefixFromLocation() {
      const path = location.pathname.replace(/^\\/files\\/?/, "");
      if (!path) return "";
      return path
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part))
        .join("/") + "/";
    }

    function pathForPrefix(prefix) {
      const parts = prefix.split("/").filter(Boolean).map(encodeURIComponent);
      return parts.length === 0 ? "/files" : "/files/" + parts.join("/") + "/";
    }

    function objectUrl(key, download = false) {
      const params = new URLSearchParams({ key });
      if (download) params.set("download", "1");
      return "/api/object?" + params.toString();
    }

    function bookCoverUrl(book) {
      if (book.coverUrl) return book.coverUrl;
      if (book.coverKey) return objectUrl(book.coverKey);
      return "";
    }

    function formatSize(bytes) {
      if (bytes === 0) return "0 Bytes";
      const units = ["Bytes", "KB", "MB", "GB", "TB"];
      const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      return (bytes / Math.pow(1024, index)).toLocaleString(undefined, {
        maximumFractionDigits: index === 0 ? 0 : 1
      }) + " " + units[index];
    }

    function formatDate(value) {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date(value));
    }

    function setStatus(message) {
      statusEl.textContent = message;
    }
  </script>
</body>
</html>`;
}

function renderLogin(url: URL, users: AuthUser[], error = ""): string {
  const next = safeNextPath(url.searchParams.get("next") ?? "/files");
  const showUsername = users.length > 1 || Boolean(users[0]?.username && users[0].username !== "default");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in - R2 Drive</title>
  <link rel="icon" type="image/png" href="${FAVICON_URL}">
  <style>
    body {
      align-items: center;
      background: #b01aa8;
      color: #182033;
      display: flex;
      font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      justify-content: center;
      margin: 0;
      min-height: 100vh;
      padding: 20px;
    }
    form {
      background: white;
      border: 1px solid #dde3ee;
      border-radius: 22px;
      box-shadow: 0 18px 45px rgba(42, 6, 40, 0.24);
      max-width: 420px;
      padding: 28px;
      width: 100%;
    }
    h1 {
      margin: 0 0 8px;
    }
    p {
      color: #647084;
      margin: 0 0 22px;
    }
    label {
      display: block;
      font-weight: 700;
      margin-bottom: 8px;
    }
    input {
      border: 1px solid #cfd8e5;
      border-radius: 12px;
      box-sizing: border-box;
      font: inherit;
      padding: 11px 12px;
      width: 100%;
    }
    button {
      background: #ffffff;
      border: 1px solid #dde3ee;
      border-radius: 12px;
      color: #2a0630;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      margin-top: 16px;
      padding: 11px 14px;
      width: 100%;
    }
    button:hover {
      background: #f4edf7;
    }
    .error {
      background: #fff0f0;
      border: 1px solid #ffc8c8;
      border-radius: 12px;
      color: #a11919;
      margin-bottom: 16px;
      padding: 10px 12px;
    }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Sign in</h1>
    <p>${showUsername ? "Enter your username and access token." : "Enter the token configured for this R2 explorer."}</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <input name="next" type="hidden" value="${escapeHtml(next)}">
    ${
      showUsername
        ? `<label for="username">Username</label>
    <input autocomplete="username" autofocus id="username" name="username" required type="text">`
        : ""
    }
    <label for="token">Access token</label>
    <input autocomplete="current-password" ${showUsername ? "" : "autofocus"} id="token" name="token" required type="password">
    <button type="submit">Open explorer</button>
  </form>
</body>
</html>`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });
}

function html(markup: string, status = 200): Response {
  return new Response(markup, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
    status,
  });
}

function normalizePrefix(value: string | null): string {
  if (typeof value !== "string") return "";
  const withoutLeadingSlash = value.replace(/^\/+/, "");
  const compact = withoutLeadingSlash.replace(/\/{2,}/g, "/");
  return compact && !compact.endsWith("/") ? `${compact}/` : compact;
}

function normalizeKey(value: string | null): string {
  const key = value?.replace(/^\/+/, "") ?? "";
  if (!key || key.includes("\0")) {
    throw new Error("A valid object key is required");
  }
  return key;
}

function normalizeObjectName(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) {
    throw new Error("A valid file name is required");
  }
  return normalized;
}

function normalizeFolderName(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0")) {
    throw new Error("Use a single valid folder name without slashes");
  }
  return normalized;
}

async function getBookMetadata(env: Env): Promise<Map<string, BookInfo>> {
  const object = await env.BUCKET.get(BOOK_METADATA_KEY);
  if (!object) return new Map();

  try {
    const parsed = JSON.parse(await object.text()) as unknown;
    return parseBookMetadata(parsed);
  } catch {
    return new Map();
  }
}

function parseBookMetadata(value: unknown): Map<string, BookInfo> {
  const map = new Map<string, BookInfo>();
  const source = unwrapBookMetadata(value);

  if (!source || Array.isArray(source) || typeof source !== "object") {
    return map;
  }

  for (const [key, metadata] of Object.entries(source)) {
    const info = parseBookInfo(metadata);
    if (key.trim() && info) {
      map.set(key, info);
    }
  }

  return map;
}

function unwrapBookMetadata(value: unknown): unknown {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return value;
  }

  const maybeWrapped = value as { books?: unknown };
  return maybeWrapped.books ?? value;
}

function parseBookInfo(value: unknown): BookInfo | null {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const info: BookInfo = {};

  if (typeof raw.author === "string") info.author = raw.author;
  if (typeof raw.coverKey === "string") info.coverKey = raw.coverKey;
  if (typeof raw.coverUrl === "string") info.coverUrl = raw.coverUrl;
  if (typeof raw.description === "string") info.description = raw.description;
  if (typeof raw.title === "string") info.title = raw.title;

  return Object.keys(info).length > 0 ? info : null;
}

function findBookInfo(metadata: Map<string, BookInfo>, key: string, name: string): BookInfo | undefined {
  return metadata.get(key) ?? metadata.get(name);
}

function shouldShowObject(key: string, prefix: string): boolean {
  if (key === prefix || !key.startsWith(prefix)) return false;
  const name = key.slice(prefix.length);
  return name !== ".keep" && name !== BOOK_METADATA_KEY && name.length > 0 && !name.includes("/");
}

function folderName(prefix: string, folderPrefix: string): string {
  return folderPrefix.slice(prefix.length).replace(/\/$/, "");
}

function basename(key: string): string {
  return key.split("/").filter(Boolean).pop() || "download";
}

function isFileWithName(value: unknown): value is File {
  return value instanceof File && value.name.length > 0;
}

function isEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function hasAuth(env: Env): boolean {
  return getAuthUsers(env).length > 0;
}

function getAuthUsers(env: Env): AuthUser[] {
  const users: AuthUser[] = [];

  if (env.AUTH_USERS?.trim()) {
    users.push(...parseAuthUsers(env.AUTH_USERS));
  }

  if (env.AUTH_TOKEN?.trim()) {
    users.push({
      canDelete: isEnabled(env.ALLOW_DELETES, true),
      username: "default",
      token: env.AUTH_TOKEN.trim(),
    });
  }

  return users.filter((user) => user.username.length > 0 && user.token.length > 0);
}

function parseAuthUsers(value: string): AuthUser[] {
  const trimmed = value.trim();

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("AUTH_USERS must be a JSON object like {\"alice\":\"secret\"}");
    }

    return Object.entries(parsed)
      .map(([username, userConfig]) => parseAuthUser(username, userConfig))
      .filter((user): user is AuthUser => user !== null);
  } catch (error) {
    if (trimmed.includes(":")) {
      return trimmed.split(",").map((pair) => {
        const separator = pair.indexOf(":");
        return {
          canDelete: false,
          username: pair.slice(0, separator).trim(),
          token: pair.slice(separator + 1).trim(),
        };
      });
    }

    throw error;
  }
}

function parseAuthUser(username: string, value: unknown): AuthUser | null {
  if (typeof value === "string") {
    return {
      canDelete: false,
      username: username.trim(),
      token: value.trim(),
    };
  }

  if (!value || Array.isArray(value) || typeof value !== "object") {
    return null;
  }

  const config = value as { canDelete?: unknown; token?: unknown };
  if (typeof config.token !== "string") {
    return null;
  }

  return {
    canDelete: config.canDelete === true,
    username: username.trim(),
    token: config.token.trim(),
  };
}

function authenticateUser(users: AuthUser[], username: string, token: string): AuthUser | null {
  const cleanUsername = username.trim();
  const cleanToken = token.trim();
  if (!cleanToken) return null;

  return (
    users.find((user) => {
      const usernameMatches = cleanUsername ? user.username === cleanUsername : users.length === 1;
      return usernameMatches && user.token === cleanToken;
    }) ?? null
  );
}

function isAuthorized(request: Request, env: Env): boolean {
  return getCurrentUser(request, env) !== null;
}

function canDeleteObjects(request: Request, env: Env): boolean {
  if (!isEnabled(env.ALLOW_DELETES, true)) return false;

  const users = getAuthUsers(env);
  if (users.length === 0) return true;

  const user = getCurrentUser(request, env);
  return Boolean(user?.canDelete);
}

function getCurrentUser(request: Request, env: Env): AuthUser | null {
  const users = getAuthUsers(env);
  if (users.length === 0) {
    return {
      canDelete: isEnabled(env.ALLOW_DELETES, true),
      username: "anonymous",
      token: "",
    };
  }

  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    const user = users.find((candidate) => candidate.token === token);
    if (user) return user;
  }

  const cookies = parseCookies(request.headers.get("cookie") ?? "");
  const cookieUser = parseAuthCookie(cookies[SESSION_COOKIE_NAME] ?? cookies[LEGACY_COOKIE_NAME]);
  return cookieUser ? authenticateUser(users, cookieUser.username, cookieUser.token) : null;
}

function unauthorizedResponse(request: Request, url: URL): Response {
  if (url.pathname.startsWith("/api/")) {
    return json({ error: "Authentication required" }, 401);
  }

  const next = encodeURIComponent(url.pathname + url.search);
  if (request.method === "GET") {
    return redirectNoStore(`${url.origin}/login?next=${next}`);
  }

  return json({ error: "Authentication required" }, 401);
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name) continue;
    cookies[name] = safeDecodeURIComponent(valueParts.join("="));
  }
  return cookies;
}

function authCookie(user: AuthUser, url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const value = encodeURIComponent(JSON.stringify({ token: user.token, username: user.username }));
  return `${SESSION_COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`;
}

function clearAuthCookie(url: URL): string[] {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return [
    `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
    `${LEGACY_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
  ];
}

function redirectWithCookie(location: string, cookie: string | string[]): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    location,
  });

  for (const value of Array.isArray(cookie) ? cookie : [cookie]) {
    headers.append("set-cookie", value);
  }

  return new Response(null, { headers, status: 303 });
}

function redirectNoStore(location: string): Response {
  return new Response(null, {
    headers: {
      "cache-control": "no-store",
      location,
    },
    status: 302,
  });
}

function parseAuthCookie(value: string | undefined): AuthUser | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<AuthUser>;
    if (typeof parsed.username === "string" && typeof parsed.token === "string") {
      return {
        canDelete: false,
        username: parsed.username,
        token: parsed.token,
      };
    }
  } catch {
    return {
      canDelete: false,
      username: "",
      token: value,
    };
  }

  return null;
}

function safeNextPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/files";
  return value;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function safeHeaderFilename(value: string): string {
  return value.replace(/[\\"]/g, "_");
}

function normalizeReturnedRange(range: NonNullable<R2ObjectBody["range"]>, size: number): { length: number; offset: number } {
  if ("suffix" in range) {
    const length = Math.min(range.suffix, size);
    return {
      length,
      offset: Math.max(size - length, 0),
    };
  }

  const offset = "offset" in range && typeof range.offset === "number" ? range.offset : 0;
  const length = "length" in range && typeof range.length === "number" ? range.length : Math.max(size - offset, 0);
  return { length, offset };
}
