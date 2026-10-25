// companion repo (todo-app-backend) の docs/frontend-spec.md / docs/api-spec.md の仕様に沿った実装。
// フレームワークなし。APIキー・各LambdaのFunction URLは設定画面からlocalStorageに保存する。

const CONFIG_STORAGE_KEY = "todo-app:config";

let config = null;
let todos = [];

const todoListEl = document.getElementById("todoList");
const emptyMessageEl = document.getElementById("emptyMessage");
const errorBannerEl = document.getElementById("errorBanner");
const loadingIndicatorEl = document.getElementById("loadingIndicator");
const addButtonEl = document.getElementById("addButton");
const addDialogEl = document.getElementById("addDialog");
const addTodoInputEl = document.getElementById("addTodoInput");
const addErrorEl = document.getElementById("addError");
const addSubmitButtonEl = document.getElementById("addSubmitButton");
const addCancelButtonEl = document.getElementById("addCancelButton");
const settingsButtonEl = document.getElementById("settingsButton");
const settingsDialogEl = document.getElementById("settingsDialog");
const configInputEl = document.getElementById("configInput");
const settingsErrorEl = document.getElementById("settingsError");
const saveConfigButtonEl = document.getElementById("saveConfigButton");
const closeSettingsButtonEl = document.getElementById("closeSettingsButton");

// ---- 小さなDOM構築ヘルパー ------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

// ---- Markdownの簡易レンダリング（調査結果の表示用） ------------------------
// 入力は必ず先にHTMLエスケープしてから見出し/太字/リスト/区切り線のみ変換する。
// 生のHTMLタグを差し込む経路は無い。

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function inlineMarkdown(escapedText) {
  return escapedText
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function renderMarkdownToHtml(markdown) {
  const lines = escapeHtml(markdown).split("\n");
  let html = "";
  let inList = false;

  const closeListIfOpen = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      closeListIfOpen();
      const level = headingMatch[1].length;
      html += `<h${level}>${inlineMarkdown(headingMatch[2])}</h${level}>`;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""))}</li>`;
      continue;
    }

    if (/^\s*---\s*$/.test(line)) {
      closeListIfOpen();
      html += "<hr />";
      continue;
    }

    closeListIfOpen();
    if (line.trim() === "") {
      html += "<br />";
    } else {
      html += `<p>${inlineMarkdown(line)}</p>`;
    }
  }

  closeListIfOpen();
  return html;
}

function formatDateTime(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return date.toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });
}

// ---- 設定（APIキー・エンドポイント）の読み書き -----------------------------

function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveConfig(newConfig) {
  config = newConfig;
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(newConfig));
  } catch {
    // localStorageが使えない場合でも、このページの表示中はメモリ上の設定で動作する。
  }
}

// ---- APIクライアント -------------------------------------------------------

function buildUrl(base, path) {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return `${normalizedBase}${normalizedPath}`;
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      ...(options.headers || {}),
    },
  });

  if (response.status === 204) return null;

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = (data && data.error && data.error.message) || `リクエストに失敗しました (${response.status})`;
    throw new Error(message);
  }

  return data;
}

function apiListTodos() {
  return apiFetch(`${config.endpoints.listTodos}?limit=50`);
}

function apiCreateTodo(text) {
  return apiFetch(config.endpoints.createTodo, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

function apiUpdateTodo(id, patch) {
  return apiFetch(buildUrl(config.endpoints.updateTodo, `todos/${id}`), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

function apiUpdateStep(id, stepId, patch) {
  return apiFetch(buildUrl(config.endpoints.updateStep, `todos/${id}/steps/${stepId}`), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ---- 画面描画 ---------------------------------------------------------------

const openDetailIds = new Set();

function showError(message) {
  errorBannerEl.textContent = message;
  errorBannerEl.hidden = false;
}

function hideError() {
  errorBannerEl.hidden = true;
}

function setLoading(isLoading) {
  loadingIndicatorEl.hidden = !isLoading;
}

function renderList() {
  todoListEl.innerHTML = "";
  emptyMessageEl.hidden = todos.length > 0;
  for (const todo of todos) {
    todoListEl.appendChild(createTodoCardElement(todo));
  }
}

function createTodoCardElement(todo) {
  const isDone = todo.status === "DONE";
  const isOpen = openDetailIds.has(todo.id);
  const card = el("li", { class: `todo-card${isDone ? " is-done" : ""}` });

  const badge = el("span", {
    class: `type-badge ${todo.type}`,
    text: todo.type === "BREAKDOWN" ? "やること" : "調べもの",
  });

  const titleSpan = el("span", { class: "todo-title", text: todo.title, tabindex: "0" });

  const header = el("div", { class: "todo-card-header" }, [badge, titleSpan]);

  if (todo.type === "BREAKDOWN") {
    const steps = (todo.result && todo.result.steps) || [];
    const doneCount = steps.filter((step) => step.done).length;
    header.appendChild(el("span", { class: "todo-progress", text: `${doneCount}/${steps.length}` }));
  }

  const statusCheckbox = el("input", { type: "checkbox", class: "checkbox-input", "aria-label": "完了" });
  statusCheckbox.checked = isDone;
  statusCheckbox.addEventListener("change", () => handleStatusToggle(todo, statusCheckbox.checked));
  const statusLabel = el("label", { class: "status-toggle" }, [statusCheckbox, el("span", { class: "checkbox-visual" })]);
  header.appendChild(statusLabel);

  card.appendChild(header);
  card.appendChild(el("div", { class: "todo-meta", text: `作成: ${formatDateTime(todo.createdAt)}` }));

  const detailWrapper = el("div", { class: `todo-detail-wrapper${isOpen ? " is-open" : ""}` });
  const detail = el("div", { class: "todo-detail" });
  detail.appendChild(todo.type === "BREAKDOWN" ? buildStepList(todo) : buildResearchDetail(todo));

  const closeButton = el("button", { type: "button", class: "detail-close-button icon-button", "aria-label": "閉じる", text: "⌃" });
  closeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openDetailIds.delete(todo.id);
    detailWrapper.classList.remove("is-open");
  });
  detail.appendChild(closeButton);
  detailWrapper.appendChild(detail);
  card.appendChild(detailWrapper);

  titleSpan.addEventListener("click", () => {
    if (openDetailIds.has(todo.id)) {
      startEditTitle(todo, titleSpan);
    } else {
      openDetailIds.add(todo.id);
      detailWrapper.classList.add("is-open");
    }
  });

  return card;
}

function startEditTitle(todo, span) {
  const input = el("input", { type: "text", class: "todo-title-input" });
  input.value = todo.title;
  span.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newTitle = input.value.trim();
    if (!newTitle || newTitle === todo.title) {
      renderList();
      return;
    }
    try {
      await apiUpdateTodo(todo.id, { title: newTitle });
      todo.title = newTitle;
    } catch (err) {
      showError(err.message);
    }
    renderList();
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
    if (event.key === "Escape") {
      input.value = todo.title;
      input.blur();
    }
  });
}

function buildStepList(todo) {
  const list = el("ul", { class: "step-list" });
  const steps = (todo.result && todo.result.steps) || [];
  for (const step of steps) {
    list.appendChild(buildStepItem(todo, step));
  }
  return list;
}

function buildStepItem(todo, step) {
  const checkbox = el("input", { type: "checkbox", class: "checkbox-input", "aria-label": "完了" });
  checkbox.checked = !!step.done;
  checkbox.addEventListener("change", () => handleStepDoneToggle(todo, step, checkbox.checked));
  const checkboxLabel = el("label", { class: "step-checkbox" }, [checkbox, el("span", { class: "checkbox-visual" })]);

  const titleSpan = el("span", {
    class: `step-title${step.done ? " is-done" : ""}`,
    text: step.title,
    tabindex: "0",
  });
  titleSpan.addEventListener("click", () => startEditStepField(todo, step, "title", titleSpan));

  const body = el("div", { class: "step-body" }, [titleSpan]);

  if (step.reason) {
    const reasonDiv = el("div", { class: "step-reason", text: `理由: ${step.reason}` });
    reasonDiv.addEventListener("click", () => startEditStepField(todo, step, "reason", reasonDiv));
    body.appendChild(reasonDiv);
  }

  return el("li", { class: "step-item" }, [checkboxLabel, body]);
}

function startEditStepField(todo, step, field, anchorElement) {
  const input = el("input", { type: "text", class: "todo-title-input" });
  input.value = field === "reason" ? step.reason || "" : step.title;
  anchorElement.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const value = input.value.trim();
    const patch = {};
    if (field === "title") {
      if (!value) {
        renderList();
        return;
      }
      patch.title = value;
    } else {
      patch.reason = value || null;
    }
    try {
      await apiUpdateStep(todo.id, step.id, patch);
      Object.assign(step, patch);
    } catch (err) {
      showError(err.message);
    }
    renderList();
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
  });
}

function buildResearchDetail(todo) {
  const container = el("div");

  const content = el("div", { class: "research-content" });
  content.innerHTML = renderMarkdownToHtml((todo.result && todo.result.summaryMarkdown) || "");
  container.appendChild(content);

  const sources = todo.result && todo.result.sources;
  if (sources && sources.length) {
    const list = el("ul", { class: "step-list" });
    for (const source of sources) {
      const link = el("a", {
        href: source.url,
        target: "_blank",
        rel: "noopener noreferrer",
        text: source.title || source.url,
      });
      list.appendChild(el("li", {}, [link]));
    }
    container.appendChild(list);
  }

  const editButton = el("button", { type: "button", class: "edit-button", text: "編集" });
  editButton.addEventListener("click", () => startEditResearch(todo, container, content, editButton));
  container.appendChild(editButton);

  return container;
}

function startEditResearch(todo, container, contentElement, editButton) {
  const textarea = el("textarea", { rows: "10" });
  textarea.value = (todo.result && todo.result.summaryMarkdown) || "";
  contentElement.replaceWith(textarea);
  editButton.hidden = true;

  const saveButton = el("button", { type: "button", text: "保存" });
  const cancelButton = el("button", { type: "button", text: "キャンセル" });
  const actions = el("div", { class: "dialog-actions" }, [saveButton, cancelButton]);
  container.appendChild(actions);

  saveButton.addEventListener("click", async () => {
    try {
      await apiUpdateTodo(todo.id, { summaryMarkdown: textarea.value });
      todo.result.summaryMarkdown = textarea.value;
    } catch (err) {
      showError(err.message);
    }
    renderList();
  });

  cancelButton.addEventListener("click", () => renderList());
}

async function handleStatusToggle(todo, checked) {
  const newStatus = checked ? "DONE" : "TODO";
  try {
    await apiUpdateTodo(todo.id, { status: newStatus });
    todo.status = newStatus;
  } catch (err) {
    showError(err.message);
  }
  renderList();
}

async function handleStepDoneToggle(todo, step, done) {
  try {
    await apiUpdateStep(todo.id, step.id, { done });
    step.done = done;
  } catch (err) {
    showError(err.message);
  }
  renderList();
}

// ---- 一覧の取得・新規登録 ---------------------------------------------------

async function refreshTodoList() {
  if (!config) {
    openSettingsDialog();
    return;
  }
  hideError();
  setLoading(true);
  try {
    const data = await apiListTodos();
    todos = data.items || [];
    renderList();
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

function openAddDialog() {
  if (!config) {
    openSettingsDialog();
    return;
  }
  addTodoInputEl.value = "";
  addErrorEl.hidden = true;
  addDialogEl.hidden = false;
  addTodoInputEl.focus();
}

function closeAddDialog() {
  addDialogEl.hidden = true;
}

async function handleSubmit() {
  const text = addTodoInputEl.value.trim();
  if (!text) return;
  addErrorEl.hidden = true;
  addSubmitButtonEl.disabled = true;
  try {
    const created = await apiCreateTodo(text);
    todos.unshift(created);
    renderList();
    closeAddDialog();
  } catch (err) {
    addErrorEl.textContent = err.message;
    addErrorEl.hidden = false;
  } finally {
    addSubmitButtonEl.disabled = false;
  }
}

// ---- 設定画面 ---------------------------------------------------------------

function openSettingsDialog() {
  configInputEl.value = config ? JSON.stringify(config) : "";
  settingsErrorEl.hidden = true;
  settingsDialogEl.hidden = false;
}

function closeSettingsDialog() {
  settingsDialogEl.hidden = true;
}

function handleSaveConfig() {
  let parsed;
  try {
    parsed = JSON.parse(configInputEl.value);
  } catch {
    settingsErrorEl.textContent = "JSONの形式が正しくありません。";
    settingsErrorEl.hidden = false;
    return;
  }
  if (!parsed || !parsed.apiKey || !parsed.endpoints) {
    settingsErrorEl.textContent = "apiKeyとendpointsの両方が必要です。";
    settingsErrorEl.hidden = false;
    return;
  }
  saveConfig(parsed);
  closeSettingsDialog();
  refreshTodoList();
}

// ---- 初期化 -----------------------------------------------------------------

addButtonEl.addEventListener("click", openAddDialog);
addSubmitButtonEl.addEventListener("click", handleSubmit);
addCancelButtonEl.addEventListener("click", closeAddDialog);
settingsButtonEl.addEventListener("click", openSettingsDialog);
saveConfigButtonEl.addEventListener("click", handleSaveConfig);
closeSettingsButtonEl.addEventListener("click", () => {
  if (!config) {
    settingsErrorEl.textContent = "先に設定を保存してください。";
    settingsErrorEl.hidden = false;
    return;
  }
  closeSettingsDialog();
});

config = loadConfig();
refreshTodoList();
