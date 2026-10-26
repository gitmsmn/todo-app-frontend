// companion repo (todo-app-backend) の docs/frontend-spec.md / docs/api-spec.md の仕様に沿った実装。
// フレームワークなし。APIキー・各LambdaのFunction URLは設定画面からlocalStorageに保存する。

const CONFIG_STORAGE_KEY = "todo-app:config";
const INPUT_PREFS_STORAGE_KEY = "todo-app:inputPrefs";

const LIST_PAGE_LIMIT = 50;
// FilterExpressionで件数が減るため、この件数に届くまで（または末尾まで）続けて取得する（docs/api-spec.md GET /todos）
const LIST_MIN_BATCH = 20;
const LIST_MAX_REQUESTS_PER_BATCH = 5;

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const TOAST_DURATION_MS = 5000;
const MIN_STEP_COUNT = 1;
const MAX_STEP_COUNT = 10;

let config = null;
let todos = [];
let nextCursor = null;
let isLoadingList = false;
let listGeneration = 0;
let enteredDoneViewByLongPress = false;

const todoListEl = document.getElementById("todoList");
const listSentinelEl = document.getElementById("listSentinel");
const emptyMessageEl = document.getElementById("emptyMessage");
const errorBannerEl = document.getElementById("errorBanner");
const loadingIndicatorEl = document.getElementById("loadingIndicator");
const appTitleEl = document.getElementById("appTitle");
const viewLabelEl = document.getElementById("viewLabel");
const toastEl = document.getElementById("toast");
const addButtonEl = document.getElementById("addButton");
const addDialogEl = document.getElementById("addDialog");
const addTodoInputEl = document.getElementById("addTodoInput");
const typeSegmentEl = document.getElementById("typeSegment");
const aiToggleEl = document.getElementById("aiToggle");
const aiOptionsEl = document.getElementById("aiOptions");
const modelRowEl = document.getElementById("modelRow");
const modelSelectEl = document.getElementById("modelSelect");
const breakdownOptionsEl = document.getElementById("breakdownOptions");
const stepCountInputEl = document.getElementById("stepCountInput");
const researchOptionsEl = document.getElementById("researchOptions");
const researchModeSegmentEl = document.getElementById("researchModeSegment");
const researchModeHintEl = document.getElementById("researchModeHint");
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

// ---- 設定（APIキー・エンドポイント・モデルの選択肢）の読み書き -------------

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

// 古い設定（Phase 1のfrontend_config）にはmodelsが無い。その場合はモデル選択を出さず、サーバーの既定モデルに任せる。
function availableModels() {
  return config && Array.isArray(config.models) ? config.models : [];
}

// 入力エリアの前回の選択状態（種別・AIオン/オフ・モデル・調べ方）。段階数は毎回空欄に戻すので保存しない。
function loadInputPrefs() {
  const defaults = { type: "BREAKDOWN", useAi: true, model: null, researchMode: "SUMMARY" };
  try {
    const raw = localStorage.getItem(INPUT_PREFS_STORAGE_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults;
  }
}

function saveInputPrefs(prefs) {
  try {
    localStorage.setItem(INPUT_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 保存できなくても登録自体には影響しない。
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

function apiListTodos(status, cursor) {
  const params = new URLSearchParams({ limit: String(LIST_PAGE_LIMIT), status });
  if (cursor) params.set("cursor", cursor);
  return apiFetch(`${config.endpoints.listTodos}?${params}`);
}

function apiCreateTodo(body) {
  return apiFetch(config.endpoints.createTodo, {
    method: "POST",
    body: JSON.stringify(body),
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

// ---- 表示中の一覧（通常 = TODO / 完了済み = DONE） --------------------------

function currentViewStatus() {
  return location.hash === "#done" ? "DONE" : "TODO";
}

function toggleView() {
  if (currentViewStatus() === "DONE") {
    if (enteredDoneViewByLongPress) {
      history.back();
    } else {
      // #doneを直接開いた場合はhistory.back()でサイト外に出てしまうため、URLだけ書き換える
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      handleViewChange();
    }
  } else {
    enteredDoneViewByLongPress = true;
    location.hash = "done";
  }
}

function handleViewChange() {
  if (currentViewStatus() === "TODO") enteredDoneViewByLongPress = false;
  applyViewChrome();
  refreshTodoList();
}

function applyViewChrome() {
  const isDoneView = currentViewStatus() === "DONE";
  viewLabelEl.hidden = !isDoneView;
  addButtonEl.hidden = isDoneView;
  emptyMessageEl.textContent = isDoneView ? "完了済みのTODOはありません。" : "まだTODOがありません。";
}

// ---- 長押し ----------------------------------------------------------------
// 長押しが成立するまでは通常のタップ・スクロールとして扱い、指が動いたらキャンセルする。
// 成立後に続くclickは1回だけ握りつぶす（タイトルのタップ編集などが誤って発火しないように）。

let suppressNextClick = false;

document.addEventListener("click", (event) => {
  if (!suppressNextClick) return;
  suppressNextClick = false;
  event.preventDefault();
  event.stopPropagation();
}, true);

function attachLongPress(element, onLongPress, shouldStart = () => true) {
  let timer = null;
  let start = null;

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  element.addEventListener("pointerdown", (event) => {
    suppressNextClick = false;
    if (event.button !== 0 || !shouldStart(event)) return;
    start = { x: event.clientX, y: event.clientY };
    cancel();
    timer = setTimeout(() => {
      timer = null;
      suppressNextClick = true;
      onLongPress(event);
    }, LONG_PRESS_MS);
  });
  element.addEventListener("pointermove", (event) => {
    if (!timer) return;
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance > LONG_PRESS_MOVE_TOLERANCE_PX) cancel();
  });
  element.addEventListener("pointerup", cancel);
  element.addEventListener("pointercancel", cancel);
  element.addEventListener("contextmenu", (event) => event.preventDefault());
}

// ---- 画面描画 ---------------------------------------------------------------

const openDetailIds = new Set();
let toastTimer = null;

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

function showToast(message, { actionLabel, onAction } = {}) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = "";
  toastEl.appendChild(el("span", { text: message }));
  if (actionLabel) {
    const actionButton = el("button", { type: "button", class: "toast-action", text: actionLabel });
    actionButton.addEventListener("click", () => {
      hideToast();
      onAction();
    });
    toastEl.appendChild(actionButton);
  }
  toastEl.hidden = false;
  toastTimer = setTimeout(hideToast, TOAST_DURATION_MS);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.hidden = true;
}

function renderList() {
  todoListEl.innerHTML = "";
  emptyMessageEl.hidden = todos.length > 0 || isLoadingList;
  for (const todo of todos) {
    todoListEl.appendChild(createTodoCardElement(todo));
  }
}

function createTodoCardElement(todo) {
  const isDone = todo.status === "DONE";
  const isOpen = openDetailIds.has(todo.id);
  const card = el("li", { class: "todo-card" });

  const badge = el("span", {
    class: `type-badge ${todo.type}`,
    text: todo.type === "BREAKDOWN" ? "やること" : "調べもの",
  });

  const titleSpan = el("span", { class: "todo-title", text: todo.title, tabindex: "0" });

  const header = el("div", { class: "todo-card-header" }, [badge, titleSpan]);

  if (todo.type === "BREAKDOWN") {
    const steps = stepsOf(todo);
    if (steps.length) {
      const doneCount = steps.filter((step) => step.done).length;
      header.appendChild(el("span", { class: "todo-progress", text: `${doneCount}/${steps.length}` }));
    }
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

// ---- BREAKDOWN: ステップ ----------------------------------------------------

function stepsOf(todo) {
  return (todo.result && todo.result.steps) || [];
}

function stepPayload(step) {
  return { id: step.id, title: step.title, reason: step.reason ?? null, done: !!step.done };
}

// 追加・削除・並べ替えはすべてsteps配列全体の置き換えで行う（docs/api-spec.md PATCH /todos/{id}）
async function replaceSteps(todo, steps) {
  const updated = await apiUpdateTodo(todo.id, { steps });
  todo.result = updated.result;
  todo.updatedAt = updated.updatedAt;
}

function buildStepList(todo) {
  const container = el("div");
  const list = el("ul", { class: "step-list" });
  for (const step of stepsOf(todo)) {
    list.appendChild(buildStepItem(todo, step));
  }
  enableStepReorder(list, todo);
  container.appendChild(list);
  container.appendChild(buildAddStepControl(todo));
  return container;
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

  return el("li", { class: "step-item", "data-step-id": step.id }, [checkboxLabel, body]);
}

function startEditStepField(todo, step, field, anchorElement) {
  const input = el("input", { type: "text", class: "todo-title-input" });
  input.value = field === "reason" ? step.reason || "" : step.title;
  let finished = false;

  if (field === "title") {
    // ×はpointerdownで処理する（clickだと先にinputのblurで確定・再描画されてボタンが消えるため）
    const deleteButton = el("button", { type: "button", class: "step-delete-button", "aria-label": "ステップを削除", text: "×" });
    deleteButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      finished = true;
      deleteStep(todo, step);
    });
    anchorElement.replaceWith(el("div", { class: "step-edit-row" }, [input, deleteButton]));
  } else {
    anchorElement.replaceWith(input);
  }
  input.focus();
  input.select();

  const commit = async () => {
    if (finished) return;
    finished = true;
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

function buildAddStepControl(todo) {
  const addButton = el("button", { type: "button", class: "add-step-button", text: "＋ ステップを追加" });
  addButton.addEventListener("click", () => {
    const input = el("input", { type: "text", class: "todo-title-input", placeholder: "ステップ名" });
    addButton.replaceWith(input);
    input.focus();

    let finished = false;
    const commit = async () => {
      if (finished) return;
      finished = true;
      const title = input.value.trim();
      if (!title) {
        renderList();
        return;
      }
      try {
        await replaceSteps(todo, [...stepsOf(todo).map(stepPayload), { title, reason: null, done: false }]);
      } catch (err) {
        showError(err.message);
      }
      renderList();
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") {
        input.value = "";
        input.blur();
      }
    });
  });
  return addButton;
}

async function deleteStep(todo, step) {
  const snapshot = stepsOf(todo).map(stepPayload);
  try {
    await replaceSteps(todo, snapshot.filter((item) => item.id !== step.id));
    showToast("ステップを削除しました", { actionLabel: "元に戻す", onAction: () => restoreSteps(todo, snapshot) });
  } catch (err) {
    showError(err.message);
  }
  renderList();
}

async function restoreSteps(todo, snapshot) {
  // 削除済みのステップはサーバー上にIDが残っていないので、新規扱い（idなし）で送り直す
  const currentIds = new Set(stepsOf(todo).map((step) => step.id));
  const steps = snapshot.map((step) => (currentIds.has(step.id) ? step : { ...step, id: undefined }));
  try {
    await replaceSteps(todo, steps);
  } catch (err) {
    showError(err.message);
  }
  renderList();
}

// ---- BREAKDOWN: 長押しドラッグでの並べ替え ----------------------------------
// 長押しが成立したらドラッグ状態にし、指の位置に合わせてDOM上の並びを入れ替える。
// 指を離した時点で順序が変わっていればsteps全体を送る。失敗したら再描画して元の順序に戻す。

let stepDrag = null;

function stepOrderOf(listEl) {
  return [...listEl.querySelectorAll(".step-item")].map((item) => item.dataset.stepId);
}

function enableStepReorder(listEl, todo) {
  const shouldStart = (event) => !event.target.closest("input, textarea, button, label");
  for (const itemEl of listEl.querySelectorAll(".step-item")) {
    attachLongPress(itemEl, () => startStepDrag(listEl, itemEl, todo), shouldStart);
  }
}

function startStepDrag(listEl, itemEl, todo) {
  stepDrag = { listEl, itemEl, todo, originalOrder: stepOrderOf(listEl) };
  itemEl.classList.add("is-dragging");
  if (navigator.vibrate) navigator.vibrate(15);
}

function handleStepDragMove(event) {
  if (!stepDrag) return;
  const { listEl, itemEl } = stepDrag;
  const siblings = [...listEl.querySelectorAll(".step-item")].filter((item) => item !== itemEl);
  const insertBefore = siblings.find((item) => {
    const rect = item.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2;
  });
  if (insertBefore) {
    if (itemEl.nextElementSibling !== insertBefore) listEl.insertBefore(itemEl, insertBefore);
  } else if (listEl.lastElementChild !== itemEl) {
    listEl.appendChild(itemEl);
  }
}

async function finishStepDrag(cancelled) {
  if (!stepDrag) return;
  const { listEl, itemEl, todo, originalOrder } = stepDrag;
  stepDrag = null;
  itemEl.classList.remove("is-dragging");

  const newOrder = stepOrderOf(listEl);
  if (cancelled || newOrder.join() === originalOrder.join()) {
    renderList();
    return;
  }

  const stepsById = new Map(stepsOf(todo).map((step) => [step.id, step]));
  try {
    await replaceSteps(todo, newOrder.map((id) => stepPayload(stepsById.get(id))));
  } catch (err) {
    showError(err.message);
  }
  renderList();
}

document.addEventListener("pointermove", handleStepDragMove);
document.addEventListener("pointerup", () => finishStepDrag(false));
document.addEventListener("pointercancel", () => finishStepDrag(true));
// ドラッグ中だけスクロールを止める（passive: falseでないとpreventDefaultが効かない）
document.addEventListener("touchmove", (event) => {
  if (stepDrag) event.preventDefault();
}, { passive: false });

// ---- RESEARCH ---------------------------------------------------------------

function buildResearchDetail(todo) {
  const container = el("div");
  const result = todo.result || {};

  if (result.researchPrompt) {
    container.appendChild(buildResearchPromptBlock(result.researchPrompt, !result.summaryMarkdown));
  }

  if (!result.summaryMarkdown) {
    // 空の間は編集欄を最初から出しておく（プロンプト生成モードで外部の回答を貼り付ける用途）
    const placeholder = result.researchPrompt ? "Claudeの回答をここに貼り付け" : "調べた結果をメモ（Markdown可）";
    container.appendChild(buildSummaryEditor(todo, placeholder));
    return container;
  }

  const content = el("div", { class: "research-content" });
  content.innerHTML = renderMarkdownToHtml(result.summaryMarkdown);
  container.appendChild(content);

  const sources = result.sources;
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

function buildResearchPromptBlock(prompt, open) {
  const copyButton = el("button", { type: "button", class: "edit-button", text: "コピー" });
  copyButton.addEventListener("click", (event) => {
    event.preventDefault(); // summary内のボタンなので、押しても開閉はさせない
    copyText(prompt);
  });

  const details = el("details", { class: "research-prompt" }, [
    el("summary", {}, [el("span", { text: "調査用プロンプト" }), copyButton]),
    el("pre", { class: "research-prompt-text", text: prompt }),
  ]);
  details.open = open;
  return details;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("コピーしました");
  } catch {
    showError("コピーできませんでした。プロンプトを長押しして選択・コピーしてください。");
  }
}

function buildSummaryEditor(todo, placeholder) {
  const textarea = el("textarea", { rows: "6", placeholder });
  const saveButton = el("button", { type: "button", text: "保存" });
  saveButton.addEventListener("click", async () => {
    if (!textarea.value.trim()) return;
    try {
      await apiUpdateTodo(todo.id, { summaryMarkdown: textarea.value });
      todo.result.summaryMarkdown = textarea.value;
    } catch (err) {
      showError(err.message);
    }
    renderList();
  });
  return el("div", {}, [textarea, el("div", { class: "dialog-actions" }, [saveButton])]);
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

// ---- 完了状態 ---------------------------------------------------------------

async function handleStatusToggle(todo, checked) {
  const newStatus = checked ? "DONE" : "TODO";
  try {
    await apiUpdateTodo(todo.id, { status: newStatus });
  } catch (err) {
    showError(err.message);
    renderList();
    return;
  }
  todo.status = newStatus;

  // 表示中の一覧に属さなくなったカードは消し、誤タップに備えて元に戻せるようにする
  if (newStatus !== currentViewStatus()) {
    const index = todos.indexOf(todo);
    todos.splice(index, 1);
    showToast(newStatus === "DONE" ? "完了にしました" : "未完了に戻しました", {
      actionLabel: "元に戻す",
      onAction: () => undoStatusChange(todo, index),
    });
  }
  renderList();
}

async function undoStatusChange(todo, index) {
  const previousStatus = todo.status === "DONE" ? "TODO" : "DONE";
  try {
    await apiUpdateTodo(todo.id, { status: previousStatus });
    todo.status = previousStatus;
    if (previousStatus === currentViewStatus() && !todos.includes(todo)) {
      todos.splice(Math.min(index, todos.length), 0, todo);
    }
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

// ---- 一覧の取得 -------------------------------------------------------------

async function refreshTodoList() {
  if (!config) {
    openSettingsDialog();
    return;
  }
  hideError();
  listGeneration += 1;
  todos = [];
  nextCursor = null;
  isLoadingList = false;
  await loadTodoBatch();
}

async function loadTodoBatch() {
  const generation = listGeneration;
  const status = currentViewStatus();
  let cursor = nextCursor;
  let loadedCount = 0;

  isLoadingList = true;
  setLoading(true);
  renderList();
  try {
    for (let i = 0; i < LIST_MAX_REQUESTS_PER_BATCH; i += 1) {
      const data = await apiListTodos(status, cursor);
      if (generation !== listGeneration) return; // 取得中に表示を切り替えた
      const knownIds = new Set(todos.map((todo) => todo.id));
      const items = (data.items || []).filter((item) => !knownIds.has(item.id));
      todos.push(...items);
      loadedCount += items.length;
      cursor = data.nextCursor || null;
      if (!cursor || loadedCount >= LIST_MIN_BATCH) break;
    }
    nextCursor = cursor;
  } catch (err) {
    if (generation === listGeneration) showError(err.message);
  } finally {
    if (generation === listGeneration) {
      isLoadingList = false;
      setLoading(false);
      renderList();
    }
  }

  // 画面が縦に余っていて末尾が見えたままなら続けて読む（IntersectionObserverは変化時しか発火しないため）
  if (generation === listGeneration && nextCursor && isSentinelVisible()) loadTodoBatch();
}

function isSentinelVisible() {
  return listSentinelEl.getBoundingClientRect().top < window.innerHeight;
}

const sentinelObserver = new IntersectionObserver((entries) => {
  if (entries.some((entry) => entry.isIntersecting) && nextCursor && !isLoadingList) loadTodoBatch();
});
sentinelObserver.observe(listSentinelEl);

// ---- 新規登録 ---------------------------------------------------------------

function getSegmentValue(segmentEl) {
  const pressed = segmentEl.querySelector('[aria-pressed="true"]');
  return pressed ? pressed.dataset.value : null;
}

function setSegmentValue(segmentEl, value) {
  for (const button of segmentEl.querySelectorAll("button[data-value]")) {
    button.setAttribute("aria-pressed", String(button.dataset.value === value));
  }
}

function setupSegment(segmentEl) {
  segmentEl.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    setSegmentValue(segmentEl, button.dataset.value);
    updateAddOptionsVisibility();
  });
}

function updateAddOptionsVisibility() {
  const type = getSegmentValue(typeSegmentEl);
  aiOptionsEl.hidden = !aiToggleEl.checked;
  breakdownOptionsEl.hidden = type !== "BREAKDOWN";
  researchOptionsEl.hidden = type !== "RESEARCH";
  researchModeHintEl.textContent = getSegmentValue(researchModeSegmentEl) === "PROMPT"
    ? "Claude等に貼り付けて調べてもらうためのプロンプトを作ります"
    : "Web検索はしません（AIの知識のみで要約）";
}

function populateModelSelect(selectedKey) {
  const models = availableModels();
  modelRowEl.hidden = models.length === 0;
  modelSelectEl.innerHTML = "";
  for (const model of models) {
    modelSelectEl.appendChild(el("option", { value: model.key, text: model.label }));
  }
  const keys = models.map((model) => model.key);
  modelSelectEl.value = keys.includes(selectedKey) ? selectedKey : (config.defaultModel || keys[0] || "");
}

function openAddDialog() {
  if (!config) {
    openSettingsDialog();
    return;
  }
  const prefs = loadInputPrefs();
  addTodoInputEl.value = "";
  stepCountInputEl.value = "";
  setSegmentValue(typeSegmentEl, prefs.type);
  setSegmentValue(researchModeSegmentEl, prefs.researchMode);
  aiToggleEl.checked = !!prefs.useAi;
  populateModelSelect(prefs.model);
  updateAddOptionsVisibility();
  addErrorEl.hidden = true;
  addDialogEl.hidden = false;
  addTodoInputEl.focus();
}

function closeAddDialog() {
  addDialogEl.hidden = true;
}

function showAddError(message) {
  addErrorEl.textContent = message;
  addErrorEl.hidden = false;
}

// docs/api-spec.md POST /todos のリクエストを組み立てる。入力に問題があればnullを返す。
function buildCreateRequest(text) {
  const type = getSegmentValue(typeSegmentEl);
  const body = { text, type };
  if (!aiToggleEl.checked) return body;

  const ai = {};
  if (!modelRowEl.hidden && modelSelectEl.value) ai.model = modelSelectEl.value;

  if (type === "BREAKDOWN") {
    const rawStepCount = stepCountInputEl.value.trim();
    if (rawStepCount) {
      const stepCount = Number(rawStepCount);
      if (!Number.isInteger(stepCount) || stepCount < MIN_STEP_COUNT || stepCount > MAX_STEP_COUNT) {
        showAddError(`段階数は${MIN_STEP_COUNT}〜${MAX_STEP_COUNT}の整数で入力してください。`);
        return null;
      }
      ai.stepCount = stepCount;
    }
  } else {
    ai.researchMode = getSegmentValue(researchModeSegmentEl);
  }

  body.ai = ai;
  return body;
}

async function handleSubmit() {
  const text = addTodoInputEl.value.trim();
  if (!text) return;
  addErrorEl.hidden = true;

  const body = buildCreateRequest(text);
  if (!body) return;

  saveInputPrefs({
    type: body.type,
    useAi: aiToggleEl.checked,
    model: modelSelectEl.value || null,
    researchMode: getSegmentValue(researchModeSegmentEl),
  });

  const originalLabel = addSubmitButtonEl.textContent;
  addSubmitButtonEl.disabled = true;
  if (body.ai) addSubmitButtonEl.textContent = "生成中...";
  try {
    const created = await apiCreateTodo(body);
    todos.unshift(created);
    openDetailIds.add(created.id); // 生成結果（またはステップ追加欄）をすぐ見られるように開いておく
    renderList();
    closeAddDialog();
  } catch (err) {
    showAddError(err.message);
  } finally {
    addSubmitButtonEl.disabled = false;
    addSubmitButtonEl.textContent = originalLabel;
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
setupSegment(typeSegmentEl);
setupSegment(researchModeSegmentEl);
aiToggleEl.addEventListener("change", updateAddOptionsVisibility);
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
attachLongPress(appTitleEl, toggleView);
window.addEventListener("hashchange", handleViewChange);

config = loadConfig();
applyViewChrome();
refreshTodoList();
