const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  user: null,
  threads: [],
  activeThread: null,
  files: [],
  sending: false,
};

const errorMessages = {
  AUTH_REQUIRED: "Sua sessão expirou. Entre novamente.",
  INVALID_CREDENTIALS: "Usuário ou senha inválidos.",
  RATE_LIMITED: "Muitas tentativas em pouco tempo. Aguarde e tente novamente.",
  INVALID_BOOTSTRAP_TOKEN: "Token inicial inválido.",
  SETUP_ALREADY_COMPLETED: "O ambiente já foi ativado.",
  SETUP_TOKEN_NOT_CONFIGURED: "O token de ativação inicial não está configurado.",
  PASSWORD_LENGTH: "A senha deve ter pelo menos 12 caracteres.",
  INVALID_USERNAME: "Use um usuário com pelo menos 3 caracteres, sem espaços.",
  USERNAME_EXISTS: "Esse usuário já existe.",
  AI_NOT_CONFIGURED: "A IA ainda não foi configurada pelo administrador.",
  AI_DATA_POLICY_NOT_ACKNOWLEDGED: "O administrador ainda não confirmou a política de dados do provedor de IA.",
  DATA_POLICY_ACK_REQUIRED: "Confirme a política de dados antes de ativar a IA.",
  AI_PROVIDER_ERROR: "O provedor de IA recusou ou não concluiu a solicitação.",
  AI_EMPTY_RESPONSE: "O provedor de IA respondeu sem conteúdo utilizável.",
  THREAD_NOT_FOUND: "A demanda não foi encontrada.",
  INVALID_MESSAGE: "Escreva uma mensagem válida.",
  INVALID_MODE: "Modo jurídico inválido.",
  INVALID_FILES: "Quantidade de anexos inválida.",
  INVALID_FILE: "Um dos anexos possui formato não permitido.",
  FILE_TOO_LARGE: "Um dos anexos ultrapassa o limite permitido.",
  FILES_TOO_LARGE: "O conjunto de anexos ultrapassa o limite permitido.",
  INVALID_API_KEY_FORMAT: "Chave inválida. Use uma OpenAI API key iniciada por sk- ou sk-proj-; a assinatura do ChatGPT não substitui a API.",
  INVALID_MODEL: "Modelo inválido.",
  CURRENT_PASSWORD_INVALID: "A senha atual está incorreta.",
  CANNOT_DISABLE_SELF: "Você não pode desativar sua própria conta.",
};

function showToast(message, type = "") {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = `toast ${type}`.trim();
  setTimeout(() => {
    toast.className = "toast hidden";
  }, 4200);
}

function apiError(error) {
  const code = error?.payload?.error || error?.message || "UNKNOWN";
  return errorMessages[code] || `Não foi possível concluir a operação (${code}).`;
}

async function request(path, options = {}) {
  const init = {
    credentials: "same-origin",
    headers: { ...(options.headers || {}) },
    ...options,
  };
  if (options.body && typeof options.body !== "string") {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP_${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function setAuthView(setupRequired = false) {
  $("auth-view").classList.remove("hidden");
  $("app-view").classList.add("hidden");
  $("setup-form").classList.toggle("hidden", !setupRequired);
  $("login-form").classList.toggle("hidden", setupRequired);
}

function setAppView() {
  $("auth-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  $("user-label").textContent = `${state.user.displayName} · ${state.user.role === "admin" ? "Admin" : "Advogada"}`;
  $("admin-button").classList.toggle("hidden", state.user.role !== "admin");
}

function setAiStatus() {
  const el = $("ai-status");
  if (!state.status?.aiConfigured) {
    el.textContent = "IA não configurada";
    el.className = "status-pill warn";
  } else {
    el.textContent = `IA ativa · ${state.status.model}`;
    el.className = "status-pill ok";
  }
}

function safeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function renderThreads() {
  const list = $("thread-list");
  list.textContent = "";
  for (const thread of state.threads) {
    const row = document.createElement("div");
    row.className = "thread-item";
    if (state.activeThread?.id === thread.id) row.classList.add("active");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "thread-open";
    open.textContent = thread.title || "Nova demanda";
    open.title = thread.title || "Nova demanda";
    open.addEventListener("click", () => openThread(thread));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "thread-delete";
    del.textContent = "×";
    del.title = "Excluir demanda";
    del.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!confirm("Excluir esta demanda e seu histórico?")) return;
      try {
        await request(`/api/threads/${thread.id}`, { method: "DELETE" });
        if (state.activeThread?.id === thread.id) {
          state.activeThread = null;
          $("thread-title").textContent = "Nova demanda";
          $("messages").textContent = "";
          $("messages").classList.add("hidden");
          $("empty-state").classList.remove("hidden");
        }
        await refreshThreads();
      } catch (error) {
        showToast(apiError(error), "error");
      }
    });

    row.append(open, del);
    list.append(row);
  }
}

async function refreshThreads() {
  const payload = await request("/api/threads");
  state.threads = payload.threads || [];
  renderThreads();
}

function messageNode(message) {
  const block = document.createElement("article");
  block.className = `message ${message.role}`;

  const text = document.createElement("div");
  text.textContent = message.text || "";
  block.append(text);

  const metadata = message.metadata || {};
  const meta = document.createElement("div");
  meta.className = "message-meta";
  if (metadata.mode) {
    const tag = document.createElement("span");
    tag.textContent = metadata.mode;
    meta.append(tag);
  }
  if (metadata.model && message.role === "assistant") {
    const tag = document.createElement("span");
    tag.textContent = metadata.model;
    meta.append(tag);
  }
  if (metadata.fileCount) {
    const tag = document.createElement("span");
    tag.textContent = `${metadata.fileCount} anexo(s)`;
    meta.append(tag);
  }
  if (meta.childNodes.length) block.append(meta);

  const citations = Array.isArray(metadata.citations) ? metadata.citations : [];
  if (citations.length) {
    const box = document.createElement("div");
    box.className = "citations";
    const label = document.createElement("strong");
    label.textContent = "Fontes consultadas";
    box.append(label);
    for (const citation of citations) {
      const href = safeHttpUrl(citation.url);
      if (!href) continue;
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = citation.title || href;
      box.append(link);
    }
    block.append(box);
  }
  return block;
}

function renderMessages(messages) {
  const area = $("messages");
  area.textContent = "";
  for (const message of messages) area.append(messageNode(message));
  area.classList.toggle("hidden", !messages.length && !state.activeThread);
  $("empty-state").classList.toggle("hidden", Boolean(state.activeThread));
  requestAnimationFrame(() => {
    area.scrollTop = area.scrollHeight;
  });
}

async function openThread(thread) {
  state.activeThread = thread;
  $("thread-title").textContent = thread.title || "Nova demanda";
  renderThreads();
  try {
    const payload = await request(`/api/threads/${thread.id}/messages`);
    renderMessages(payload.messages || []);
    $("message-input").focus();
  } catch (error) {
    showToast(apiError(error), "error");
  }
}

async function createThread(title = "Nova demanda") {
  const payload = await request("/api/threads", {
    method: "POST",
    body: { title },
  });
  state.activeThread = payload.thread;
  await refreshThreads();
  await openThread(payload.thread);
  return payload.thread;
}

function renderFiles() {
  const list = $("file-list");
  list.textContent = "";
  for (const file of state.files) {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    chip.textContent = `${file.name} · ${Math.ceil(file.size / 1024)} KB`;
    list.append(chip);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("FILE_READ_FAILED"));
    reader.onload = () => {
      const raw = String(reader.result || "");
      resolve(raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw);
    };
    reader.readAsDataURL(file);
  });
}

async function collectFiles() {
  const limits = state.status?.limits || {};
  if (state.files.length > (limits.maxFiles || 4)) throw new Error("INVALID_FILES");
  let total = 0;
  const result = [];
  for (const file of state.files) {
    if (file.size > (limits.maxFileBytes || 8 * 1024 * 1024)) throw new Error("FILE_TOO_LARGE");
    total += file.size;
    if (total > (limits.maxTotalFileBytes || 18 * 1024 * 1024)) throw new Error("FILES_TOO_LARGE");
    result.push({
      name: file.name,
      mime: file.type || "application/octet-stream",
      data: await fileToBase64(file),
    });
  }
  return result;
}

async function refreshStatus() {
  state.status = await request("/api/status");
  state.user = state.status.user || null;
  if (state.status.setupRequired) {
    setAuthView(true);
    return;
  }
  if (!state.status.authenticated || !state.user) {
    setAuthView(false);
    return;
  }
  setAppView();
  setAiStatus();
  await refreshThreads();
  if (state.activeThread) {
    const latest = state.threads.find((item) => item.id === state.activeThread.id);
    if (latest) state.activeThread = latest;
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await request("/api/login", {
      method: "POST",
      body: {
        username: $("login-username").value,
        password: $("login-password").value,
      },
    });
    $("login-password").value = "";
    await refreshStatus();
  } catch (error) {
    showToast(apiError(error), "error");
  }
});

$("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await request("/api/setup", {
      method: "POST",
      body: {
        token: $("setup-token").value,
        username: $("setup-username").value,
        displayName: $("setup-display-name").value,
        password: $("setup-password").value,
      },
    });
    $("setup-token").value = "";
    $("setup-password").value = "";
    await refreshStatus();
    showToast("Ambiente ativado.");
  } catch (error) {
    showToast(apiError(error), "error");
  }
});

$("logout-button").addEventListener("click", async () => {
  try {
    await request("/api/logout", { method: "POST", body: {} });
  } catch {}
  state.user = null;
  state.activeThread = null;
  state.threads = [];
  await refreshStatus();
});

$("new-thread").addEventListener("click", async () => {
  try {
    await createThread();
  } catch (error) {
    showToast(apiError(error), "error");
  }
});

$("file-input").addEventListener("change", () => {
  state.files = Array.from($("file-input").files || []);
  renderFiles();
});

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.sending) return;
  const message = $("message-input").value.trim();
  if (!message) return;
  if (!state.status?.aiConfigured) {
    showToast("O administrador precisa configurar a chave de IA antes do primeiro uso.", "error");
    return;
  }

  state.sending = true;
  $("send-button").disabled = true;
  $("send-button").textContent = "Analisando…";
  $("send-hint").textContent = "A resposta pode levar alguns instantes em análises extensas.";

  try {
    if (!state.activeThread) {
      const title = message.replace(/\s+/g, " ").slice(0, 78) || "Nova demanda";
      await createThread(title);
    }
    const files = await collectFiles();

    const pendingUser = {
      id: "pending-user",
      role: "user",
      text: message,
      metadata: {
        mode: $("mode-select").value,
        fileCount: files.length,
      },
    };
    const currentPayload = await request(`/api/threads/${state.activeThread.id}/messages`);
    renderMessages([...(currentPayload.messages || []), pendingUser]);

    const payload = await request(`/api/threads/${state.activeThread.id}/messages`, {
      method: "POST",
      body: {
        message,
        mode: $("mode-select").value,
        webSearch: $("web-search").checked,
        files,
      },
    });

    $("message-input").value = "";
    $("file-input").value = "";
    state.files = [];
    renderFiles();

    const refreshed = await request(`/api/threads/${state.activeThread.id}/messages`);
    renderMessages(refreshed.messages || []);
    await refreshThreads();
  } catch (error) {
    showToast(apiError(error), "error");
    if (error.status === 401) await refreshStatus();
  } finally {
    state.sending = false;
    $("send-button").disabled = false;
    $("send-button").textContent = "Enviar";
    $("send-hint").textContent = "";
  }
});

$("profile-button").addEventListener("click", () => $("profile-dialog").showModal());
$("admin-button").addEventListener("click", async () => {
  $("admin-dialog").showModal();
  await loadAdmin().catch((error) => showToast(apiError(error), "error"));
});

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialog = $(button.dataset.close);
    if (dialog?.open) dialog.close();
  });
});

$("password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await request("/api/me/password", {
      method: "POST",
      body: {
        currentPassword: $("current-password").value,
        newPassword: $("new-password").value,
      },
    });
    $("current-password").value = "";
    $("new-password").value = "";
    $("profile-dialog").close();
    showToast("Senha atualizada.");
  } catch (error) {
    showToast(apiError(error), "error");
  }
});

async function loadAdmin() {
  if (state.user?.role !== "admin") return;
  const [provider, users] = await Promise.all([
    request("/api/admin/provider"),
    request("/api/admin/users"),
  ]);
  $("provider-model").value = provider.model || "gpt-5.6-sol";
  $("provider-key").value = "";
  $("provider-policy-ack").checked = provider.dataPolicyAcknowledged === true;
  $("provider-state").textContent = provider.configured
    ? `Configurado · ${provider.source} · ${provider.model} · política confirmada`
    : provider.apiKeyConfigured
      ? "Chave cadastrada; falta confirmar a política de dados."
      : "Ainda não configurado.";
  renderUsers(users.users || []);
}

function renderUsers(users) {
  const list = $("user-list");
  list.textContent = "";
  for (const user of users) {
    const row = document.createElement("div");
    row.className = "user-row";

    const main = document.createElement("div");
    main.className = "user-main";
    const strong = document.createElement("strong");
    strong.textContent = user.displayName;
    const small = document.createElement("small");
    small.textContent = `${user.username} · ${user.role === "admin" ? "Admin" : "Advogada"} · ${user.active ? "Ativa" : "Desativada"}`;
    main.append(strong, small);

    const actions = document.createElement("div");
    actions.className = "user-actions";

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "ghost";
    reset.textContent = "Redefinir senha";
    reset.addEventListener("click", async () => {
      const password = prompt(`Nova senha temporária para ${user.displayName} (mín. 12 caracteres):`);
      if (!password) return;
      try {
        await request(`/api/admin/users/${user.id}/reset-password`, {
          method: "POST",
          body: { password },
        });
        showToast("Senha redefinida. As sessões antigas foram invalidadas.");
      } catch (error) {
        showToast(apiError(error), "error");
      }
    });

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ghost";
    toggle.textContent = user.active ? "Desativar" : "Ativar";
    toggle.disabled = user.id === state.user.id;
    toggle.addEventListener("click", async () => {
      try {
        await request(`/api/admin/users/${user.id}`, {
          method: "PATCH",
          body: { active: !user.active },
        });
        await loadAdmin();
      } catch (error) {
        showToast(apiError(error), "error");
      }
    });

    actions.append(reset, toggle);
    row.append(main, actions);
    list.append(row);
  }
}

$("provider-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await request("/api/admin/provider", {
      method: "POST",
      body: {
        apiKey: $("provider-key").value.trim(),
        model: $("provider-model").value.trim(),
        dataPolicyAcknowledged: $("provider-policy-ack").checked,
      },
    });
    $("provider-key").value = "";
    await refreshStatus();
    await loadAdmin();
    showToast("Configuração de IA salva.");
  } catch (error) {
    showToast(apiError(error), "error");
  }
});

$("create-user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await request("/api/admin/users", {
      method: "POST",
      body: {
        username: $("new-user-username").value,
        displayName: $("new-user-name").value,
        password: $("new-user-password").value,
        role: $("new-user-role").value,
      },
    });
    $("new-user-username").value = "";
    $("new-user-name").value = "";
    $("new-user-password").value = "";
    $("new-user-role").value = "lawyer";
    await loadAdmin();
    showToast("Usuária criada.");
  } catch (error) {
    showToast(apiError(error), "error");
  }
});

window.addEventListener("unhandledrejection", (event) => {
  console.error(event.reason);
});

refreshStatus().catch(() => setAuthView(false));
