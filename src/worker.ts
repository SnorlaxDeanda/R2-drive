interface Env {
  BUCKET: R2Bucket;
  EXPLORER_TITLE?: string;
  AUTH_TOKEN?: string;
  ALLOW_UPLOADS?: string;
  ALLOW_DELETES?: string;
}

interface FileEntry {
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

const COOKIE_NAME = "r2_drive_token";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/logout") {
        return redirectWithCookie("/login", clearAuthCookie(url));
      }

      if (env.AUTH_TOKEN && url.pathname === "/login") {
        return handleLogin(request, env, url);
      }

      if (env.AUTH_TOKEN && !isAuthorized(request, env)) {
        return unauthorizedResponse(request, url);
      }

      if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/" && request.method === "GET") {
        return Response.redirect(`${url.origin}/files`, 302);
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
        return html(renderExplorer(env), 200);
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
    .map((object) => ({
      key: object.key,
      name: object.key.slice(prefix.length),
      size: object.size,
      uploaded: object.uploaded.toISOString(),
      contentType: object.httpMetadata?.contentType,
      etag: object.httpEtag,
    }));

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
    status = 206;
    headers.set("content-length", String(range.length));
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
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
  const files = form.getAll("files").filter(isFileWithName);

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
  if (!isEnabled(env.ALLOW_DELETES, true)) {
    return json({ error: "Deletes are disabled" }, 403);
  }

  const url = new URL(request.url);
  const key = normalizeKey(url.searchParams.get("key"));
  await env.BUCKET.delete(key);
  return json({ deleted: key });
}

async function handleLogin(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "GET") {
    return html(renderLogin(url), 200);
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const next = safeNextPath(String(form.get("next") ?? "/files"));

  if (token !== env.AUTH_TOKEN) {
    return html(renderLogin(url, "The token you entered is not valid."), 401);
  }

  return redirectWithCookie(next, authCookie(token, url));
}

function renderExplorer(env: Env): string {
  const title = env.EXPLORER_TITLE || "R2 Drive";
  const config = safeJson({
    allowDeletes: isEnabled(env.ALLOW_DELETES, true),
    allowUploads: isEnabled(env.ALLOW_UPLOADS, true),
    title,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7fb;
      --card: #ffffff;
      --text: #182033;
      --muted: #647084;
      --line: #dde3ee;
      --accent: #f38020;
      --accent-dark: #c95f0c;
      --danger: #c62828;
      --shadow: 0 18px 45px rgba(34, 42, 61, 0.09);
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at top left, rgba(243, 128, 32, 0.16), transparent 34rem), var(--bg);
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
      width: 48px;
    }
    h1 {
      font-size: clamp(24px, 4vw, 34px);
      line-height: 1.1;
      margin: 0;
    }
    .subtitle {
      color: var(--muted);
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
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      color: var(--text);
      cursor: pointer;
      display: inline-flex;
      font-weight: 650;
      gap: 8px;
      padding: 10px 14px;
      text-decoration: none;
      transition: 0.16s ease;
      white-space: nowrap;
    }
    .button:hover {
      border-color: #c8d2e1;
      transform: translateY(-1px);
    }
    .button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
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
      color: var(--accent-dark);
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
      background: #fff9f3;
      border-bottom: 1px dashed #f1b67b;
      color: #7d4b1e;
      display: flex;
      gap: 10px;
      justify-content: center;
      padding: 14px;
      transition: 0.16s ease;
    }
    .dropzone.dragging {
      background: #ffe6ce;
      color: #4b2d12;
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
    .icon {
      align-items: center;
      border-radius: 10px;
      display: inline-flex;
      height: 32px;
      justify-content: center;
      width: 32px;
    }
    .icon.folder {
      background: #fff0de;
    }
    .icon.file {
      background: #eef4ff;
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
      color: var(--accent-dark);
      cursor: pointer;
      font-weight: 700;
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
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="logo" aria-hidden="true">R2</div>
        <div>
          <h1>${escapeHtml(title)}</h1>
          <div class="subtitle">Browse and manage files stored in Cloudflare R2.</div>
        </div>
      </div>
      <div class="actions">
        <button class="button" id="refreshButton" type="button">Refresh</button>
        <button class="button" id="newFolderButton" type="button">New folder</button>
        <button class="button primary" id="uploadButton" type="button">Upload files</button>
        <a class="button" href="/logout">Sign out</a>
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
      row.appendChild(mutedCell("--"));
      row.appendChild(mutedCell("--"));
      row.appendChild(mutedCell("Folder"));
      row.appendChild(document.createElement("td"));
      return row;
    }

    function fileRow(file) {
      const row = document.createElement("tr");
      row.className = "file";
      row.appendChild(nameCell("file", file.name));
      row.appendChild(textCell(formatDate(file.uploaded)));
      row.appendChild(textCell(formatSize(file.size)));
      row.appendChild(textCell(file.contentType || "Object"));

      const actions = document.createElement("td");
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

    function nameCell(kind, name) {
      const cell = document.createElement("td");
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

    function textCell(value) {
      const cell = document.createElement("td");
      cell.textContent = value;
      return cell;
    }

    function mutedCell(value) {
      const cell = textCell(value);
      cell.className = "muted";
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

function renderLogin(url: URL, error = ""): string {
  const next = safeNextPath(url.searchParams.get("next") ?? "/files");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in - R2 Drive</title>
  <style>
    body {
      align-items: center;
      background: #f6f7fb;
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
      box-shadow: 0 18px 45px rgba(34, 42, 61, 0.09);
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
      background: #f38020;
      border: 0;
      border-radius: 12px;
      color: white;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      margin-top: 16px;
      padding: 11px 14px;
      width: 100%;
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
    <p>Enter the token configured for this R2 explorer.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <input name="next" type="hidden" value="${escapeHtml(next)}">
    <label for="token">Access token</label>
    <input autocomplete="current-password" autofocus id="token" name="token" required type="password">
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
      "content-type": "text/html; charset=utf-8",
    },
    status,
  });
}

function normalizePrefix(value: FormDataEntryValue | string | null): string {
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

function shouldShowObject(key: string, prefix: string): boolean {
  if (key === prefix || !key.startsWith(prefix)) return false;
  const name = key.slice(prefix.length);
  return name !== ".keep" && name.length > 0 && !name.includes("/");
}

function folderName(prefix: string, folderPrefix: string): string {
  return folderPrefix.slice(prefix.length).replace(/\/$/, "");
}

function basename(key: string): string {
  return key.split("/").filter(Boolean).pop() || "download";
}

function isFileWithName(value: FormDataEntryValue): value is File {
  return typeof value !== "string" && value.name.length > 0;
}

function isEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function isAuthorized(request: Request, env: Env): boolean {
  const token = env.AUTH_TOKEN;
  if (!token) return true;

  const authorization = request.headers.get("authorization");
  if (authorization === `Bearer ${token}`) return true;

  const cookies = parseCookies(request.headers.get("cookie") ?? "");
  return cookies[COOKIE_NAME] === token;
}

function unauthorizedResponse(request: Request, url: URL): Response {
  if (url.pathname.startsWith("/api/")) {
    return json({ error: "Authentication required" }, 401);
  }

  const next = encodeURIComponent(url.pathname + url.search);
  if (request.method === "GET") {
    return Response.redirect(`${url.origin}/login?next=${next}`, 302);
  }

  return json({ error: "Authentication required" }, 401);
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name) continue;
    cookies[name] = decodeURIComponent(valueParts.join("="));
  }
  return cookies;
}

function authCookie(token: string, url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`;
}

function clearAuthCookie(url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function redirectWithCookie(location: string, cookie: string): Response {
  return new Response(null, {
    headers: {
      location,
      "set-cookie": cookie,
    },
    status: 302,
  });
}

function safeNextPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/files";
  return value;
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
