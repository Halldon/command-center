(() => {
  const STORAGE = {
    inbox: "cc.v3.inbox",
    drafts: "cc.v3.drafts",
    sendWindow: "cc.v3.sendWindow",
    tone: "cc.v3.tone",
    focusMode: "cc.v3.focusMode",
    plan: "cc.v3.plan",
    decomposition: "cc.v3.decomposition",
    commandHistory: "cc.v3.commandHistory",
    agentTeam: "cc.v3.agentTeam"
  };

  const DEFAULT_SEND_WINDOW = { start: "08:30", end: "18:00" };

  const state = {
    inbox: loadLocal(STORAGE.inbox, []),
    drafts: loadLocal(STORAGE.drafts, {}),
    sendWindow: loadLocal(STORAGE.sendWindow, DEFAULT_SEND_WINDOW),
    tone: loadLocal(STORAGE.tone, "direct"),
    focusMode: loadLocal(STORAGE.focusMode, false),
    planBlocks: loadLocal(STORAGE.plan, []),
    decomposition: loadLocal(STORAGE.decomposition, []),
    commandHistory: loadLocal(STORAGE.commandHistory, []),
    agentTeam: loadLocal(STORAGE.agentTeam, []),
    selectedInboxId: "",
    parsedCommand: null,
    operatorConfig: null,
    latestState: null,
    transcriptActions: []
  };

  let pollTimer = null;
  let followupTimer = null;

  function loadLocal(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function saveLocal(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function esc(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function slugify(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function relTime(value) {
    const ts = Date.parse(String(value || ""));
    if (!Number.isFinite(ts)) return "n/a";
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSec < 45) return "just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  }

  function showToast(message) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    window.clearTimeout(showToast._timer);
    showToast._timer = window.setTimeout(() => el.classList.remove("show"), 1900);
  }

  async function loadOperatorConfig() {
    if (state.operatorConfig) return state.operatorConfig;
    try {
      const response = await fetch(`./operator.config.json?ts=${Date.now()}`);
      if (response.ok) {
        state.operatorConfig = await response.json();
      }
    } catch (_) {
      // keep null
    }
    if (!state.operatorConfig) {
      state.operatorConfig = {
        realtime: {
          apiBaseUrl: "",
          statePath: "/api/state"
        }
      };
    }
    return state.operatorConfig;
  }

  function realtimeStateUrl(config) {
    const rt = config && config.realtime ? config.realtime : {};
    const base = String(rt.apiBaseUrl || "").replace(/\/+$/, "");
    const statePath = String(rt.statePath || "/api/state");
    const normalized = statePath.startsWith("/") ? statePath : `/${statePath}`;
    return `${base}${normalized}`;
  }

  function projectOptions() {
    const select = document.getElementById("todoProject");
    if (!select) return ["General"];
    const values = [...select.options].map((opt) => String(opt.value || "").trim()).filter(Boolean);
    return values.length ? values : ["General"];
  }

  function bestProjectForText(text) {
    const lower = String(text || "").toLowerCase();
    if (/(outreach|lead|email|agency)/.test(lower)) return "Outreach Pipeline";
    if (/(polymarket|paper|trading|risk)/.test(lower)) return "Polymarket Bot (paper-first)";
    if (/(ops|incident|control plane|command center)/.test(lower)) return "Command Center Ops";
    return "General";
  }

  function projectIdForName(name) {
    const lower = String(name || "").toLowerCase();
    const rows = state.latestState && state.latestState.realtime && state.latestState.realtime.projects
      ? state.latestState.realtime.projects
      : {};
    const byId = Object.entries(rows);
    for (const [projectId, row] of byId) {
      if (String(row && row.name || "").toLowerCase() === lower) return projectId;
    }
    const key = slugify(name);
    for (const [projectId, row] of byId) {
      const aliases = [projectId, slugify(row && row.name), slugify(row && row.type)];
      if (aliases.includes(key)) return projectId;
    }
    return key || "";
  }

  function coreTodos() {
    return loadLocal("cc.v2.todos", []);
  }

  function coreAppointments() {
    return loadLocal("cc.v2.appointments", []);
  }

  function addTodoToCore(text, project) {
    const form = document.getElementById("todoForm");
    const input = document.getElementById("todoInput");
    const select = document.getElementById("todoProject");
    if (!form || !input) return false;
    input.value = String(text || "").trim();
    if (select) {
      const options = [...select.options].map((opt) => opt.value);
      const nextProject = options.includes(project) ? project : "General";
      select.value = nextProject;
    }
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;
  }

  function seedInbox() {
    if (state.inbox.length) return;
    state.inbox = [
      {
        id: uid("inbox"),
        source: "email",
        subject: "Outreach sender warm-up review",
        body: "Need approval on sender warm-up pacing before scaling campaign volume.",
        project: "Outreach Pipeline",
        status: "open",
        urgency: "p1",
        requiresReply: true,
        receivedAt: nowIso()
      },
      {
        id: uid("inbox"),
        source: "telegram",
        subject: "Polymarket guard status",
        body: "Paper bot guard verification passed. Want to keep loop running overnight?",
        project: "Polymarket Bot (paper-first)",
        status: "open",
        urgency: "p2",
        requiresReply: true,
        receivedAt: nowIso()
      }
    ];
    saveLocal(STORAGE.inbox, state.inbox);
  }

  function ingestIncidentInboxRows() {
    const incidents = state.latestState && state.latestState.realtime && Array.isArray(state.latestState.realtime.incidents)
      ? state.latestState.realtime.incidents
      : [];
    for (const incident of incidents.slice(0, 12)) {
      const id = `incident-${incident.id || slugify(incident.ts || "")}`;
      if (state.inbox.some((row) => row.id === id)) continue;
      const projectName = incident.projectName || incident.projectId || "General";
      state.inbox.unshift({
        id,
        source: "agent",
        subject: `Incident: ${incident.message || "Unhandled issue"}`,
        body: `Root signal: ${incident.kind || "incident"} | Runbook: ${incident.runbook || "n/a"}`,
        project: projectName,
        status: "open",
        urgency: incident.severity === "critical" ? "p0" : "p1",
        requiresReply: false,
        receivedAt: incident.ts || nowIso(),
        tags: ["incident", incident.kind || "signal"].filter(Boolean)
      });
    }
    state.inbox = state.inbox.slice(0, 120);
    saveLocal(STORAGE.inbox, state.inbox);
  }

  function triageScore(item) {
    const urgencyScore = {
      p0: 95,
      p1: 78,
      p2: 58,
      p3: 36
    }[String(item.urgency || "p2").toLowerCase()] || 42;
    let score = urgencyScore;
    const text = `${item.subject || ""} ${item.body || ""}`.toLowerCase();
    if (/(blocked|down|critical|stale|urgent|risk|incident)/.test(text)) score += 14;
    if (item.status === "open") score += 8;
    if (item.requiresReply) score += 6;
    if (item.status === "resolved") score -= 24;
    return Math.max(0, Math.min(100, score));
  }

  function triageBucket(score) {
    if (score >= 85) return "p0";
    if (score >= 70) return "p1";
    if (score >= 52) return "p2";
    return "p3";
  }

  function triageClass(bucket) {
    return `triage-${bucket}`;
  }

  function sortedInboxRows() {
    return [...state.inbox]
      .map((row) => ({ ...row, triageScore: triageScore(row), triage: triageBucket(triageScore(row)) }))
      .sort((a, b) => b.triageScore - a.triageScore || Date.parse(b.receivedAt || 0) - Date.parse(a.receivedAt || 0));
  }

  function renderInbox() {
    const list = document.getElementById("unifiedInboxList");
    const summary = document.getElementById("inboxSummary");
    if (!list || !summary) return;

    const rows = sortedInboxRows();
    const openCount = rows.filter((row) => row.status === "open").length;
    const replyCount = rows.filter((row) => row.status === "open" && row.requiresReply).length;
    const criticalCount = rows.filter((row) => row.triage === "p0").length;
    summary.textContent = `${openCount} open | ${replyCount} awaiting reply | ${criticalCount} critical triage`;

    if (!rows.length) {
      list.innerHTML = '<li class="empty">No inbox items.</li>';
      return;
    }

    list.innerHTML = rows.map((row) => `
      <li class="inbox-item ${state.selectedInboxId === row.id ? "active" : ""}" data-inbox-id="${esc(row.id)}">
        <div class="item-head">
          <div>
            <p class="item-title">${esc(row.subject)}</p>
            <p class="item-sub">${esc(row.project || "General")} | ${esc(row.source)} | ${esc(relTime(row.receivedAt))}</p>
          </div>
          <span class="triage-chip ${triageClass(row.triage)}">${esc(row.triage.toUpperCase())}</span>
        </div>
      </li>
    `).join("");

    if (!state.selectedInboxId || !rows.some((row) => row.id === state.selectedInboxId)) {
      state.selectedInboxId = rows[0].id;
    }

    renderInboxDetail();
  }

  function selectedInboxRow() {
    return state.inbox.find((row) => row.id === state.selectedInboxId) || null;
  }

  function renderInboxDetail() {
    const detail = document.getElementById("inboxDetail");
    const draftBox = document.getElementById("inboxDraft");
    if (!detail || !draftBox) return;

    const row = selectedInboxRow();
    if (!row) {
      detail.textContent = "Select an inbox item to generate reply drafts.";
      draftBox.textContent = "No draft generated yet.";
      return;
    }

    detail.textContent = `${row.source.toUpperCase()} | ${row.project || "General"} | ${row.status.toUpperCase()} | ${relTime(row.receivedAt)}`;
    const draft = state.drafts[row.id] || "";
    draftBox.textContent = draft || row.body || "No detail available.";
  }

  function buildDraft(row, tone) {
    const toneLabel = tone === "formal" ? "formal and precise" : tone === "friendly" ? "friendly and warm" : "direct and concise";
    const project = row.project || "General";
    const nextStep = /(verify|health|check|review)/i.test(row.body || "")
      ? "I will run a verification pass and share the result with evidence links."
      : "I will execute the next safe step and report status within this cycle.";
    return [
      `Tone guardrail: ${toneLabel}.`,
      `Project: ${project}`,
      "",
      `Thanks for the update on \"${row.subject}\".`,
      nextStep,
      "",
      "If anything changes, send it here and I will triage it immediately.",
      "- James"
    ].join("\n");
  }

  function withinSendWindow() {
    const start = String(state.sendWindow.start || DEFAULT_SEND_WINDOW.start);
    const end = String(state.sendWindow.end || DEFAULT_SEND_WINDOW.end);
    const now = new Date();
    const [sh, sm] = start.split(":").map((part) => Number(part || 0));
    const [eh, em] = end.split(":").map((part) => Number(part || 0));
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = sh * 60 + sm;
    const endMinutes = eh * 60 + em;
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  function generateDraftForSelected() {
    const row = selectedInboxRow();
    if (!row) return;
    const draft = buildDraft(row, state.tone);
    state.drafts[row.id] = draft;
    saveLocal(STORAGE.drafts, state.drafts);
    renderInboxDetail();
    showToast("Draft generated");
  }

  function queueOrSendSelected() {
    const row = selectedInboxRow();
    if (!row) return;
    if (!state.drafts[row.id]) {
      generateDraftForSelected();
    }
    const allowedNow = withinSendWindow();
    const nextStatus = allowedNow ? "queued_send" : "queued_hold";
    const note = allowedNow ? "Queued for send" : "Outside send window, queued for next window";

    state.inbox = state.inbox.map((item) => {
      if (item.id !== row.id) return item;
      return {
        ...item,
        status: nextStatus,
        lastActionAt: nowIso(),
        followUpAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
      };
    });
    saveLocal(STORAGE.inbox, state.inbox);
    renderInbox();
    showToast(note);
  }

  function scheduleFollowupForSelected() {
    const row = selectedInboxRow();
    if (!row) return;
    state.inbox = state.inbox.map((item) => {
      if (item.id !== row.id) return item;
      return {
        ...item,
        followUpAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        status: item.status === "resolved" ? "resolved" : "followup_scheduled"
      };
    });
    saveLocal(STORAGE.inbox, state.inbox);
    renderInbox();
    showToast("Follow-up scheduled");
  }

  function markSelectedInboxResolved() {
    const row = selectedInboxRow();
    if (!row) return;
    state.inbox = state.inbox.map((item) => item.id === row.id ? { ...item, status: "resolved", resolvedAt: nowIso() } : item);
    saveLocal(STORAGE.inbox, state.inbox);
    renderInbox();
    showToast("Inbox item resolved");
  }

  function runFollowupSweep() {
    const now = Date.now();
    let changed = false;
    const rows = [...state.inbox];
    for (const item of rows) {
      const due = Date.parse(String(item.followUpAt || ""));
      if (!Number.isFinite(due)) continue;
      if (due > now) continue;
      if (item.status === "resolved") continue;
      if (item.status === "followup_due") continue;
      item.status = "followup_due";
      changed = true;
    }
    if (changed) {
      state.inbox = rows;
      saveLocal(STORAGE.inbox, state.inbox);
      renderInbox();
    }
  }

  function routeAgent(text) {
    const lower = String(text || "").toLowerCase();
    if (/(reply|email|draft|tone|copy|inbox)/.test(lower)) {
      return { primary: "Claude", secondary: "OpenClaw", why: "copy + communication workflow" };
    }
    if (/(automate|heartbeat|incident|monitor|telegram|follow-up|cron)/.test(lower)) {
      return { primary: "OpenClaw", secondary: "Codex", why: "always-on automation + operations" };
    }
    if (/(deploy|api|ui|refactor|script|branch|merge|promote|bug|fix)/.test(lower)) {
      return { primary: "Codex", secondary: "OpenClaw", why: "implementation + guarded execution" };
    }
    return { primary: "Codex", secondary: "Claude", why: "general planning + execution" };
  }

  function parseCommand(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    const project = bestProjectForText(lower);

    if (/^add todo\b|^todo\b|\bnew task\b/.test(lower)) {
      const content = raw.replace(/^add todo\s*/i, "").replace(/^todo\s*/i, "").trim() || raw;
      return { intent: "add_todo", text: content, project, raw };
    }

    if (/\bfocus\s+mode\s+on\b|\bfocus\s+on\b/.test(lower)) {
      return { intent: "focus", enabled: true, raw };
    }

    if (/\bfocus\s+mode\s+off\b|\bfocus\s+off\b/.test(lower)) {
      return { intent: "focus", enabled: false, raw };
    }

    if (/\bplan\b.*\b(day|today)\b|\bdaily plan\b/.test(lower)) {
      return { intent: "plan_day", raw };
    }

    if (/\bdecompose\b|\bbreak down\b/.test(lower)) {
      const task = raw.replace(/.*\bdecompose\b\s*/i, "").trim() || raw;
      return { intent: "decompose", task, raw };
    }

    if (/\bend of day\b|\beod\b|\bsummary\b/.test(lower)) {
      return { intent: "eod_summary", raw };
    }

    if (/\bauto\s*-?fix\b|\bauto\s*-?remediation\b/.test(lower)) {
      return { intent: "auto_fix", project, raw };
    }

    let actionKey = "";
    if (/\bhealth\b/.test(lower)) actionKey = "health_check";
    else if (/\bverify\b|\bvalidate\b/.test(lower)) actionKey = "verify";
    else if (/\bgo live\b|\blaunch\b|\brun paper\b/.test(lower)) actionKey = "go_live";
    else if (/\brollback\b|\bkill switch\b/.test(lower)) actionKey = "rollback";
    else if (/\bpromote\b|\bmerge up\b/.test(lower)) actionKey = "promote_review";

    if (actionKey) {
      return {
        intent: "project_action",
        actionKey,
        project,
        requiresConfirmation: actionKey === "go_live" || actionKey === "promote_review",
        raw
      };
    }

    return { intent: "add_todo", text: raw, project, raw };
  }

  function buildPlan(parsed) {
    if (!parsed) return [];
    const route = routeAgent(parsed.raw || parsed.intent);
    const steps = [
      { title: `Route task to ${route.primary} (secondary: ${route.secondary})`, kind: "routing", safe: true }
    ];

    if (parsed.intent === "project_action") {
      steps.push(
        { title: `Inspect ${parsed.project} current health + blockers`, kind: "review", safe: true },
        { title: `Run ${parsed.actionKey} dry-run preview`, kind: "dry_run", safe: true },
        { title: `Commit ${parsed.actionKey} on ${parsed.project}`, kind: "commit", safe: !parsed.requiresConfirmation }
      );
    } else if (parsed.intent === "auto_fix") {
      steps.push(
        { title: `Queue safe remediation checks for ${parsed.project}`, kind: "review", safe: true },
        { title: "Execute local-only fix path", kind: "commit", safe: true },
        { title: "Re-verify health + queue depth", kind: "verify", safe: true }
      );
    } else if (parsed.intent === "plan_day") {
      steps.push(
        { title: "Assemble priorities from tasks + inbox + calendar", kind: "planner", safe: true },
        { title: "Generate time-blocked plan", kind: "planner", safe: true }
      );
    } else if (parsed.intent === "decompose") {
      steps.push(
        { title: "Convert task into executable subtasks", kind: "planner", safe: true },
        { title: "Insert first task into today queue", kind: "commit", safe: true }
      );
    } else if (parsed.intent === "eod_summary") {
      steps.push({ title: "Compile completed work, risks, and next actions", kind: "planner", safe: true });
    } else if (parsed.intent === "focus") {
      steps.push({ title: `Switch focus mode ${parsed.enabled ? "ON" : "OFF"}`, kind: "ui", safe: true });
    } else if (parsed.intent === "add_todo") {
      steps.push({ title: `Add todo to ${parsed.project}`, kind: "commit", safe: true });
    }

    return steps;
  }

  function renderCommandSurface() {
    const routeEl = document.getElementById("commandRoute");
    const planList = document.getElementById("commandPlanList");
    if (!routeEl || !planList) return;

    if (!state.parsedCommand) {
      routeEl.textContent = "Agent route pending.";
      planList.innerHTML = '<li class="empty">Enter a command and click Plan.</li>';
      return;
    }

    const route = routeAgent(state.parsedCommand.raw || "");
    routeEl.textContent = `Primary: ${route.primary} | Secondary: ${route.secondary} | Why: ${route.why}`;
    const steps = buildPlan(state.parsedCommand);
    planList.innerHTML = steps.map((step, idx) => `
      <li class="plan-item">
        <div class="item-head">
          <p class="item-title">${idx + 1}. ${esc(step.title)}</p>
          <span class="triage-chip ${step.safe ? "triage-p2" : "triage-p1"}">${step.safe ? "SAFE" : "CHECK"}</span>
        </div>
      </li>
    `).join("");
  }

  async function executeActionCommand(projectName, actionKey, dryRun) {
    const token = String(localStorage.getItem("cc.v2.execToken") || "").trim();
    if (!token) {
      throw new Error("Exec token is missing. Use Set Exec Token in top bar.");
    }
    const projectId = projectIdForName(projectName);
    if (!projectId) throw new Error(`Unknown project for action: ${projectName}`);

    const requiresConfirm = actionKey === "go_live" || actionKey === "promote_review";
    const confirmed = requiresConfirm && !dryRun
      ? window.confirm(`Confirm ${actionKey} on ${projectName}?`)
      : false;

    if (requiresConfirm && !dryRun && !confirmed) {
      return { ok: false, skipped: true, reason: "Cancelled by operator" };
    }

    const response = await fetch("/api/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Command-Center-Token": token
      },
      body: JSON.stringify({
        projectId,
        actionKey,
        actor: "James",
        dryRun: Boolean(dryRun),
        confirmed: Boolean(confirmed)
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `execute failed (${response.status})`);
    }
    return payload;
  }

  async function runParsedCommand(dryRun) {
    const output = document.getElementById("commandRunOutput");
    if (!state.parsedCommand) {
      showToast("Plan a command first");
      return;
    }

    const parsed = state.parsedCommand;
    try {
      let resultText = "";
      if (parsed.intent === "add_todo") {
        addTodoToCore(parsed.text, parsed.project);
        resultText = `Added todo (${parsed.project}): ${parsed.text}`;
      } else if (parsed.intent === "focus") {
        state.focusMode = Boolean(parsed.enabled);
        saveLocal(STORAGE.focusMode, state.focusMode);
        applyFocusMode();
        resultText = `Focus mode set to ${state.focusMode ? "ON" : "OFF"}.`;
      } else if (parsed.intent === "plan_day") {
        state.planBlocks = generateDailyPlan();
        saveLocal(STORAGE.plan, state.planBlocks);
        renderPlanner();
        resultText = "Generated daily plan from current tasks, appointments, and inbox urgency.";
      } else if (parsed.intent === "decompose") {
        state.decomposition = decomposeTask(parsed.task);
        saveLocal(STORAGE.decomposition, state.decomposition);
        renderDecomposition();
        resultText = `Decomposed task: ${parsed.task}`;
      } else if (parsed.intent === "eod_summary") {
        resultText = generateEodSummary();
      } else if (parsed.intent === "project_action") {
        const payload = await executeActionCommand(parsed.project, parsed.actionKey, dryRun);
        resultText = JSON.stringify(payload, null, 2);
      } else if (parsed.intent === "auto_fix") {
        const actionPlan = ["health_check", "verify"];
        if (dryRun) {
          resultText = `Auto-fix dry-run for ${parsed.project}: ${actionPlan.join(" -> ")}`;
        } else {
          const chunks = [];
          for (const action of actionPlan) {
            const payload = await executeActionCommand(parsed.project, action, false);
            chunks.push(`${action}: ${payload.ok ? "ok" : "failed"}`);
          }
          resultText = chunks.join("\n");
        }
      }

      state.commandHistory.unshift({
        id: uid("cmd"),
        ts: nowIso(),
        text: parsed.raw,
        dryRun: Boolean(dryRun),
        result: resultText
      });
      state.commandHistory = state.commandHistory.slice(0, 40);
      saveLocal(STORAGE.commandHistory, state.commandHistory);

      if (output) output.textContent = resultText || "Command completed.";
      showToast(dryRun ? "Dry-run complete" : "Command executed");
    } catch (error) {
      if (output) output.textContent = String(error.message || error);
      showToast(String(error.message || error));
    }
  }

  function parseTranscriptActions(text) {
    const lines = String(text || "")
      .split(/\n|[.!?]/)
      .map((line) => line.trim())
      .filter(Boolean);

    const verbs = /(send|review|fix|build|verify|schedule|follow|launch|draft|update|ship|queue)/i;
    const actions = lines
      .filter((line) => verbs.test(line))
      .slice(0, 10)
      .map((line) => ({
        id: uid("act"),
        text: line,
        project: bestProjectForText(line)
      }));

    return actions;
  }

  function renderTranscriptActions() {
    const list = document.getElementById("transcriptActionList");
    if (!list) return;
    if (!state.transcriptActions.length) {
      list.innerHTML = '<li class="empty">No transcript actions extracted yet.</li>';
      return;
    }

    list.innerHTML = state.transcriptActions.map((item) => `
      <li class="transcript-item">
        <div class="item-head">
          <div>
            <p class="item-title">${esc(item.text)}</p>
            <p class="item-sub">Project: ${esc(item.project)}</p>
          </div>
          <button class="tiny-btn transcript-add" data-transcript-id="${esc(item.id)}">Add Task</button>
        </div>
      </li>
    `).join("");
  }

  function generateDailyPlan() {
    const todos = coreTodos().filter((todo) => !todo.done);
    const appointments = coreAppointments().sort((a, b) => Date.parse(a.when || 0) - Date.parse(b.when || 0));
    const inbox = sortedInboxRows().filter((row) => row.status === "open").slice(0, 5);

    const blocks = [];
    blocks.push({
      id: uid("plan"),
      title: "Morning executive check",
      detail: `Review ${Math.min(3, inbox.length)} top inbox risks and project health scores`,
      when: "08:45"
    });

    for (const appt of appointments.slice(0, 3)) {
      const d = new Date(appt.when);
      const when = Number.isFinite(d.getTime())
        ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
        : "TBD";
      blocks.push({
        id: uid("plan"),
        title: appt.title,
        detail: appt.context || "Calendar",
        when
      });
    }

    for (const todo of todos.slice(0, 4)) {
      blocks.push({
        id: uid("plan"),
        title: `Deep work: ${todo.text}`,
        detail: todo.project || "General",
        when: "Focus"
      });
    }

    blocks.push({
      id: uid("plan"),
      title: "End-of-day closeout",
      detail: "Summarize outcomes, unresolved risks, and first moves for tomorrow",
      when: "17:45"
    });

    return blocks;
  }

  function renderPlanner() {
    const list = document.getElementById("dailyPlannerList");
    if (!list) return;

    if (!state.planBlocks.length) {
      list.innerHTML = '<li class="empty">No day plan generated yet.</li>';
      return;
    }

    list.innerHTML = state.planBlocks.map((item) => `
      <li class="planner-item">
        <div class="item-head">
          <p class="item-title">${esc(item.when)} - ${esc(item.title)}</p>
          <span class="triage-chip triage-p2">PLAN</span>
        </div>
        <p class="item-sub">${esc(item.detail)}</p>
      </li>
    `).join("");
  }

  function decomposeTask(task) {
    const text = String(task || "").trim();
    if (!text) return [];
    const project = bestProjectForText(text);
    return [
      `Define success criteria and measurable output for: ${text}`,
      `Gather project context and constraints (${project})`,
      "Build smallest executable first pass",
      "Run verification + safety checks",
      "Queue next checkpoint and owner handoff"
    ].map((line) => ({ id: uid("step"), text: line }));
  }

  function renderDecomposition() {
    const list = document.getElementById("decomposeList");
    if (!list) return;
    if (!state.decomposition.length) {
      list.innerHTML = '<li class="empty">No decomposition generated yet.</li>';
      return;
    }
    list.innerHTML = state.decomposition.map((step, idx) => `
      <li class="decompose-item">
        <p class="item-title">${idx + 1}. ${esc(step.text)}</p>
      </li>
    `).join("");
  }

  function generateEodSummary() {
    const todos = coreTodos();
    const done = todos.filter((todo) => todo.done).length;
    const open = todos.filter((todo) => !todo.done).length;
    const openInbox = sortedInboxRows().filter((row) => row.status === "open").length;
    const criticalInbox = sortedInboxRows().filter((row) => row.triage === "p0" && row.status !== "resolved").length;
    const projectRows = state.latestState && state.latestState.realtime && state.latestState.realtime.projects
      ? Object.values(state.latestState.realtime.projects)
      : [];
    const failingProjects = projectRows.filter((row) => /critical|warn/i.test(String(row.status || ""))).length;

    const summary = [
      `EOD Summary (${new Date().toLocaleDateString()})`,
      "",
      `Completed tasks: ${done}`,
      `Open tasks: ${open}`,
      `Open inbox items: ${openInbox} (${criticalInbox} critical)`,
      `Projects needing attention: ${failingProjects}`,
      "",
      "Next actions:",
      "1. Clear all P0/P1 inbox items before next morning block.",
      "2. Verify project health checks before any go-live commit.",
      "3. Pre-stage tomorrow's top three outcomes in the to-do queue."
    ].join("\n");

    const output = document.getElementById("eodSummaryOutput");
    if (output) output.textContent = summary;
    return summary;
  }

  function applyFocusMode() {
    document.body.classList.toggle("focus-mode-active", Boolean(state.focusMode));
    const btn = document.getElementById("focusModeBtn");
    if (btn) btn.textContent = `Focus Mode ${state.focusMode ? "ON" : "OFF"}`;
  }

  function healthScore(row) {
    const metrics = row && row.metrics ? row.metrics : {};
    let score = 100;
    const status = String(row && row.status || "").toLowerCase();
    if (status === "critical" || status === "stale") score -= 48;
    else if (status === "warn") score -= 24;

    if (row && row.stale) score -= 34;
    if (Number(metrics.healthCheckOk) === 0) score -= 30;

    const failingChecks = Number(metrics.failingChecks || 0);
    if (Number.isFinite(failingChecks) && failingChecks > 0) score -= Math.min(30, failingChecks * 8);

    const queueDepth = Number(metrics.queueDepth || 0);
    if (Number.isFinite(queueDepth) && queueDepth > 0) score -= Math.min(22, Math.floor(queueDepth / 8));

    const missed = Number(row && row.missedIntervals || 0);
    if (Number.isFinite(missed) && missed > 0) score -= Math.min(20, missed * 5);

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  function renderProjectHealth() {
    const list = document.getElementById("projectHealthList");
    if (!list) return;

    const rows = state.latestState && state.latestState.realtime && state.latestState.realtime.projects
      ? Object.entries(state.latestState.realtime.projects)
      : [];

    if (!rows.length) {
      list.innerHTML = '<li class="empty">No realtime project rows.</li>';
      return;
    }

    const items = rows.map(([projectId, row]) => {
      const score = healthScore(row);
      return {
        projectId,
        name: row.name || projectId,
        score,
        status: row.status || "unknown",
        detail: `Health checks ${Number((row.metrics || {}).healthCheckOk || 0) ? "passing" : "failing"} | queue ${(row.metrics || {}).queueDepth ?? "n/a"}`
      };
    }).sort((a, b) => a.score - b.score);

    list.innerHTML = items.map((item) => `
      <li class="health-item">
        <div class="item-head">
          <p class="item-title">${esc(item.name)}</p>
          <span class="triage-chip ${item.score < 55 ? "triage-p0" : item.score < 75 ? "triage-p1" : "triage-p2"}">${item.score}/100</span>
        </div>
        <p class="item-sub">${esc(item.status.toUpperCase())} | ${esc(item.detail)}</p>
      </li>
    `).join("");
  }

  function deriveDependencies() {
    const contracts = state.latestState && state.latestState.projectContracts && Array.isArray(state.latestState.projectContracts.projects)
      ? state.latestState.projectContracts.projects
      : [];

    if (contracts.length) {
      const edges = [];
      for (const project of contracts) {
        const deps = Array.isArray(project.dependencies) ? project.dependencies : [];
        for (const dep of deps.slice(0, 6)) {
          edges.push({
            from: project.name || project.projectId || "project",
            to: dep.name || dep.project || dep.projectId || dep,
            risk: dep.risk || dep.impact || "medium"
          });
        }
      }
      if (edges.length) return edges;
    }

    return [
      { from: "Outreach Pipeline", to: "Command Center Ops", risk: "high" },
      { from: "Polymarket Bot (paper-first)", to: "Command Center Ops", risk: "high" },
      { from: "Outreach Pipeline", to: "Email Deliverability Controls", risk: "medium" },
      { from: "Polymarket Bot (paper-first)", to: "Risk Guard Verifier", risk: "medium" }
    ];
  }

  function renderDependencyMap() {
    const list = document.getElementById("dependencyMapList");
    if (!list) return;
    const edges = deriveDependencies();
    list.innerHTML = edges.map((edge) => {
      const level = /high|critical/i.test(String(edge.risk || "")) ? "p0" : /medium|warn/i.test(String(edge.risk || "")) ? "p1" : "p2";
      return `
        <li class="dependency-item">
          <div class="item-head">
            <p class="item-title">${esc(edge.from)} -> ${esc(edge.to)}</p>
            <span class="triage-chip ${triageClass(level)}">${esc(String(edge.risk || "medium").toUpperCase())}</span>
          </div>
        </li>
      `;
    }).join("");
  }

  function rootCauseHint(entry) {
    const text = `${entry.message || ""} ${JSON.stringify(entry.detail || {})}`.toLowerCase();
    if (/heartbeat missed|stale/.test(text)) return "Heartbeat emitter paused, path mismatch, or ingest auth failure.";
    if (/exitcode.*127|command not found/.test(text)) return "Runtime interpreter/path mismatch in automation environment.";
    if (/token|unauthorized|401/.test(text)) return "Auth token mismatch between producer and ingest/execute endpoint.";
    if (/queue|backlog/.test(text)) return "Processing queue pressure exceeded expected cadence.";
    return "Check latest verification output, then run project health + verify commands.";
  }

  function renderIncidentTimeline() {
    const list = document.getElementById("incidentTimelineList");
    if (!list) return;

    const incidents = state.latestState && state.latestState.realtime && Array.isArray(state.latestState.realtime.incidents)
      ? state.latestState.realtime.incidents
      : [];
    const audit = loadLocal("cc.v2.audit", []).slice(0, 12).map((row) => ({
      id: row.id || uid("audit"),
      ts: row.ts || nowIso(),
      severity: /(fail|error|blocked)/i.test(String(row.result || "")) ? "warn" : "ok",
      projectName: row.actor || "operator",
      message: row.action || "Action event",
      detail: { result: row.result || "", detail: row.detail || "" }
    }));

    const merged = [...incidents, ...audit]
      .sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0))
      .slice(0, 14);

    if (!merged.length) {
      list.innerHTML = '<li class="empty">No incidents yet.</li>';
      return;
    }

    list.innerHTML = merged.map((entry) => `
      <li class="timeline-item">
        <div class="item-head">
          <p class="item-title">${esc(entry.projectName || entry.projectId || "project")} | ${esc(entry.message || "event")}</p>
          <span class="status-chip ${/critical|warn|stale|error/i.test(String(entry.severity || "")) ? "status-alert" : "status-ok"}">${esc(String(entry.severity || "ok"))}</span>
        </div>
        <p class="item-sub">${esc(relTime(entry.ts))} | Hint: ${esc(rootCauseHint(entry))}</p>
      </li>
    `).join("");
  }

  async function fetchLiveState() {
    try {
      const config = await loadOperatorConfig();
      const url = `${realtimeStateUrl(config)}?ts=${Date.now()}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`state fetch failed (${response.status})`);
      state.latestState = await response.json();
      ingestIncidentInboxRows();
      renderProjectHealth();
      renderDependencyMap();
      renderIncidentTimeline();
      runFollowupSweep();
    } catch (error) {
      console.error("executive_os state fetch", error);
    }
  }

  function parseCommandFromInput() {
    const input = document.getElementById("commandInput");
    const raw = String(input && input.value || "").trim();
    if (!raw) {
      showToast("Enter a command first");
      return;
    }
    state.parsedCommand = parseCommand(raw);
    renderCommandSurface();
  }

  function runTranscriptExtraction() {
    const input = document.getElementById("meetingTranscriptInput");
    const raw = String(input && input.value || "").trim();
    state.transcriptActions = parseTranscriptActions(raw);
    renderTranscriptActions();
    showToast(state.transcriptActions.length ? `Extracted ${state.transcriptActions.length} actions` : "No clear actions found");
  }

  function runQuickAdd() {
    const sourceEl = document.getElementById("quickAddSource");
    const projectEl = document.getElementById("quickAddProject");
    const messageEl = document.getElementById("quickAddMessage");
    const source = String(sourceEl && sourceEl.value || "telegram");
    const project = String(projectEl && projectEl.value || "General");
    const message = String(messageEl && messageEl.value || "").trim();
    if (!message) {
      showToast("Enter a quick-add message");
      return;
    }
    state.inbox.unshift({
      id: uid("inbox"),
      source,
      subject: `${source.toUpperCase()} quick add`,
      body: message,
      project,
      status: "open",
      urgency: "p2",
      requiresReply: true,
      receivedAt: nowIso(),
      tags: ["quick-add"]
    });
    state.inbox = state.inbox.slice(0, 120);
    saveLocal(STORAGE.inbox, state.inbox);
    if (messageEl) messageEl.value = "";
    renderInbox();
    showToast("Inbox item added");
  }

  function hydrateControls() {
    const quickAddProject = document.getElementById("quickAddProject");
    if (quickAddProject) {
      const options = projectOptions();
      quickAddProject.innerHTML = options.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
    }

    const start = document.getElementById("sendWindowStart");
    const end = document.getElementById("sendWindowEnd");
    if (start) start.value = state.sendWindow.start || DEFAULT_SEND_WINDOW.start;
    if (end) end.value = state.sendWindow.end || DEFAULT_SEND_WINDOW.end;

    const tone = document.getElementById("toneGuardrail");
    if (tone) tone.value = state.tone;
  }

  function maybeSpeechRecognition() {
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Speech) return null;
    const rec = new Speech();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    return rec;
  }

  function setVoiceStatus(text) {
    const pill = document.getElementById("voiceStatusPill");
    if (pill) pill.textContent = text;
  }

  function startVoiceCommand(mode) {
    const rec = maybeSpeechRecognition();
    if (!rec) {
      showToast("Voice API unavailable in this browser");
      return;
    }

    setVoiceStatus("Voice: listening...");
    rec.onresult = (event) => {
      const transcript = event.results && event.results[0] && event.results[0][0]
        ? String(event.results[0][0].transcript || "").trim()
        : "";
      if (!transcript) return;

      if (mode === "thought") {
        const project = bestProjectForText(transcript);
        addTodoToCore(transcript, project);
        showToast("Thought captured to task queue");
      } else {
        const input = document.getElementById("commandInput");
        if (input) input.value = transcript;
        state.parsedCommand = parseCommand(transcript);
        renderCommandSurface();
        showToast("Voice command parsed");
      }
    };

    rec.onerror = () => {
      setVoiceStatus("Voice: error");
    };

    rec.onend = () => {
      setVoiceStatus("Voice: idle");
    };

    rec.start();
  }

  async function runAgentTeamValidation() {
    const results = [];

    const requiredIds = [
      "executiveSurfaceSection",
      "inboxPlannerSection",
      "projectIntelligenceSection",
      "agentTeamSection",
      "commandInput",
      "unifiedInboxList",
      "projectHealthList"
    ];
    const missing = requiredIds.filter((id) => !document.getElementById(id));
    results.push({
      id: "ui",
      name: "UI Subagent",
      status: missing.length ? "fail" : "pass",
      summary: missing.length ? `Missing nodes: ${missing.join(", ")}` : "Core executive UI sections are mounted."
    });

    const pairHeading = document.querySelector(".pair-heading");
    let designStatus = "warn";
    let designSummary = "Unable to inspect pair-heading style.";
    if (pairHeading) {
      const size = parseFloat(window.getComputedStyle(pairHeading).fontSize || "0");
      if (Number.isFinite(size) && size >= 20 && size <= 30) {
        designStatus = "pass";
        designSummary = `Card heading size ${size.toFixed(1)}px aligns with target scale.`;
      } else {
        designStatus = "warn";
        designSummary = `Card heading size ${Number.isFinite(size) ? size.toFixed(1) : "n/a"}px out of target range.`;
      }
    }
    results.push({ id: "design", name: "Design Subagent", status: designStatus, summary: designSummary });

    const copyChecks = [
      ["Command Surface", document.querySelector("#executiveSurfaceSection h3")],
      ["Inbox Planner", document.querySelector("#inboxPlannerSection h3")],
      ["Project Intelligence", document.querySelector("#projectIntelligenceSection h3")]
    ];
    const copyMissing = copyChecks.filter(([, node]) => !node || !String(node.textContent || "").trim());
    results.push({
      id: "copy",
      name: "Copy Subagent",
      status: copyMissing.length ? "warn" : "pass",
      summary: copyMissing.length ? `Missing copy blocks: ${copyMissing.map(([label]) => label).join(", ")}` : "Headlines and CTA copy are populated."
    });

    let fnStatus = "pass";
    let fnSummary = "State/stream/execute endpoints are reachable.";
    let executeMeta = null;
    let executeStatus = 0;
    try {
      const [stateRes, streamRes, executeRes] = await Promise.all([
        fetch("/api/state"),
        fetch("/api/stream"),
        fetch("/api/execute")
      ]);
      executeStatus = Number(executeRes.status || 0);
      executeMeta = executeRes.ok
        ? await executeRes.clone().json().catch(() => null)
        : null;
      if (!stateRes.ok || !streamRes.ok || !executeRes.ok) {
        fnStatus = "fail";
        fnSummary = `Endpoint status mismatch: state=${stateRes.status}, stream=${streamRes.status}, execute=${executeRes.status}`;
      }
    } catch (error) {
      fnStatus = "fail";
      fnSummary = String(error.message || error);
    }
    results.push({ id: "functions", name: "Functions Subagent", status: fnStatus, summary: fnSummary });

    let riskStatus = "warn";
    let riskSummary = "Execution auth guard needs verification.";
    if (executeStatus && executeStatus !== 200) {
      riskStatus = "warn";
      riskSummary = `Execution metadata endpoint returned ${executeStatus}; verify token guard and runtime wiring.`;
    } else if (executeMeta && executeMeta.tokenConfigured === true) {
      riskStatus = "pass";
      riskSummary = "Execution token guard is configured and live-action gate is active.";
    } else if (executeMeta && executeMeta.tokenConfigured === false) {
      riskStatus = "warn";
      riskSummary = "Execution token is not configured; live execution remains locked until configured.";
    }
    results.push({
      id: "risk",
      name: "Risk Subagent",
      status: riskStatus,
      summary: riskSummary
    });

    const routeSamples = [
      { text: "draft outreach follow-up email", expected: "Claude" },
      { text: "automate stale heartbeat alert", expected: "OpenClaw" },
      { text: "fix command center api route", expected: "Codex" }
    ];
    const mismatches = routeSamples.filter((sample) => routeAgent(sample.text).primary !== sample.expected);
    results.push({
      id: "router",
      name: "Router Subagent",
      status: mismatches.length ? "warn" : "pass",
      summary: mismatches.length
        ? `Routing mismatch on: ${mismatches.map((item) => item.text).join(" | ")}`
        : "Command router maps sample intents to the expected primary agent."
    });

    state.agentTeam = results;
    saveLocal(STORAGE.agentTeam, state.agentTeam);
    renderAgentTeam();
  }

  function renderAgentTeam() {
    const list = document.getElementById("agentTeamList");
    const stamp = document.getElementById("agentTeamStamp");
    if (!list || !stamp) return;

    if (!state.agentTeam.length) {
      list.innerHTML = '<li class="empty">No validation sweep yet.</li>';
      stamp.textContent = "No validation run yet.";
      return;
    }

    const passCount = state.agentTeam.filter((row) => row.status === "pass").length;
    const warnCount = state.agentTeam.filter((row) => row.status === "warn").length;
    const failCount = state.agentTeam.filter((row) => row.status === "fail").length;

    stamp.textContent = `Last sweep ${new Date().toLocaleTimeString()} | pass ${passCount} | warn ${warnCount} | fail ${failCount}`;

    list.innerHTML = state.agentTeam.map((row) => {
      const cls = row.status === "fail" ? "agent-fail" : row.status === "warn" ? "agent-warn" : "agent-pass";
      return `
        <li class="agent-item">
          <div>
            <p class="item-title"><span class="agent-dot ${cls}"></span>${esc(row.name)}</p>
            <p class="item-sub">${esc(row.summary)}</p>
          </div>
          <span class="status-chip ${row.status === "fail" ? "status-alert" : row.status === "warn" ? "status-warn" : "status-ok"}">${esc(row.status.toUpperCase())}</span>
        </li>
      `;
    }).join("");
  }

  function wireEvents() {
    const byId = (id) => document.getElementById(id);

    byId("commandParseBtn")?.addEventListener("click", parseCommandFromInput);
    byId("commandDryRunBtn")?.addEventListener("click", () => runParsedCommand(true));
    byId("commandExecuteBtn")?.addEventListener("click", () => runParsedCommand(false));
    byId("commandVoiceBtn")?.addEventListener("click", () => startVoiceCommand("command"));
    byId("thoughtCaptureBtn")?.addEventListener("click", () => startVoiceCommand("thought"));

    byId("meetingParseBtn")?.addEventListener("click", runTranscriptExtraction);
    byId("quickAddBtn")?.addEventListener("click", runQuickAdd);

    byId("unifiedInboxList")?.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const item = target.closest("[data-inbox-id]");
      if (!(item instanceof HTMLElement)) return;
      const id = String(item.getAttribute("data-inbox-id") || "");
      if (!id) return;
      state.selectedInboxId = id;
      renderInbox();
    });

    byId("draftGenerateBtn")?.addEventListener("click", generateDraftForSelected);
    byId("draftSendBtn")?.addEventListener("click", queueOrSendSelected);
    byId("draftFollowupBtn")?.addEventListener("click", scheduleFollowupForSelected);
    byId("inboxDoneBtn")?.addEventListener("click", markSelectedInboxResolved);

    byId("sendWindowStart")?.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      state.sendWindow.start = target.value || DEFAULT_SEND_WINDOW.start;
      saveLocal(STORAGE.sendWindow, state.sendWindow);
    });

    byId("sendWindowEnd")?.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      state.sendWindow.end = target.value || DEFAULT_SEND_WINDOW.end;
      saveLocal(STORAGE.sendWindow, state.sendWindow);
    });

    byId("toneGuardrail")?.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement)) return;
      state.tone = target.value || "direct";
      saveLocal(STORAGE.tone, state.tone);
      renderInboxDetail();
    });

    byId("plannerGenerateBtn")?.addEventListener("click", () => {
      state.planBlocks = generateDailyPlan();
      saveLocal(STORAGE.plan, state.planBlocks);
      renderPlanner();
      showToast("Day plan generated");
    });

    byId("decomposeBtn")?.addEventListener("click", () => {
      const input = byId("decomposeInput");
      const task = String(input && input.value || "").trim();
      if (!task) {
        showToast("Enter a task to decompose");
        return;
      }
      state.decomposition = decomposeTask(task);
      saveLocal(STORAGE.decomposition, state.decomposition);
      renderDecomposition();
      showToast("Task decomposed");
    });

    byId("eodSummaryBtn")?.addEventListener("click", () => {
      generateEodSummary();
      showToast("EOD summary generated");
    });

    byId("focusModeBtn")?.addEventListener("click", () => {
      state.focusMode = !state.focusMode;
      saveLocal(STORAGE.focusMode, state.focusMode);
      applyFocusMode();
    });

    byId("runAgentTeamBtn")?.addEventListener("click", async () => {
      await runAgentTeamValidation();
      showToast("Validation sweep complete");
    });

    byId("transcriptActionList")?.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains("transcript-add")) return;
      const id = String(target.getAttribute("data-transcript-id") || "");
      const row = state.transcriptActions.find((item) => item.id === id);
      if (!row) return;
      addTodoToCore(row.text, row.project);
      state.transcriptActions = state.transcriptActions.filter((item) => item.id !== id);
      renderTranscriptActions();
      showToast("Action added to task queue");
    });
  }

  function renderStaticSections() {
    renderCommandSurface();
    renderTranscriptActions();
    renderInbox();
    renderPlanner();
    renderDecomposition();
    renderProjectHealth();
    renderDependencyMap();
    renderIncidentTimeline();
    renderAgentTeam();
    applyFocusMode();
  }

  async function init() {
    const required = [
      "executiveSurfaceSection",
      "inboxPlannerSection",
      "projectIntelligenceSection",
      "agentTeamSection"
    ];
    if (required.some((id) => !document.getElementById(id))) return;

    seedInbox();
    hydrateControls();
    wireEvents();
    renderStaticSections();
    await fetchLiveState();
    await runAgentTeamValidation();

    pollTimer = window.setInterval(fetchLiveState, 45000);
    followupTimer = window.setInterval(runFollowupSweep, 60000);

    window.addEventListener("beforeunload", () => {
      if (pollTimer) window.clearInterval(pollTimer);
      if (followupTimer) window.clearInterval(followupTimer);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
