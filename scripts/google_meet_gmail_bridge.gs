/**
 * Google Apps Script bridge:
 * Route Google Meet "Notes:" emails from Gmail into Command Center /api/ingest.
 *
 * Setup (Apps Script > Project Settings > Script properties):
 * - CC_INGEST_URL=https://command-center-sigma-six.vercel.app/api/ingest
 * - CC_INGEST_TOKEN=<your ingest token>
 * - CC_DEFAULT_PROJECT_ID=outreach-pipeline
 * - CC_GMAIL_QUERY=subject:"Notes:" newer_than:14d
 * - CC_PROJECT_ROUTES_JSON=[{"projectId":"outreach-pipeline","keywords":["outreach","lead","campaign"]},{"projectId":"polymarket-bot-paper-first","keywords":["polymarket","trade","market"]}]
 */

function syncGoogleMeetNotesToCommandCenter() {
  const cfg = loadBridgeConfig_();
  if (!cfg.ingestUrl) throw new Error("Missing CC_INGEST_URL script property");
  if (!cfg.ingestToken) throw new Error("Missing CC_INGEST_TOKEN script property");

  const props = PropertiesService.getScriptProperties();
  const lastSeenMs = Number(props.getProperty("CC_LAST_MEET_MSG_MS") || "0");
  const threads = GmailApp.search(cfg.gmailQuery, 0, cfg.pollLimit);
  const messages = [];

  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => messages.push(message));
  });

  messages.sort((a, b) => a.getDate().getTime() - b.getDate().getTime());

  let processed = 0;
  let sent = 0;
  let maxSeenMs = lastSeenMs;

  messages.forEach((message) => {
    const messageDate = message.getDate();
    const messageMs = messageDate.getTime();
    if (messageMs <= lastSeenMs) return;

    const subject = String(message.getSubject() || "");
    if (!/^Notes:/i.test(subject)) return;
    processed += 1;

    const parsed = parseMeetingEmail_(message);
    const projectId = routeProjectId_(parsed, cfg);
    const event = buildMeetingCloudEvent_(message, parsed, projectId, cfg);
    const idempotencyKey = `gmail-meet:${message.getId()}`;
    const ok = sendEventToCommandCenter_(cfg, event, idempotencyKey);
    if (ok) {
      sent += 1;
      if (messageMs > maxSeenMs) maxSeenMs = messageMs;
    }
  });

  if (maxSeenMs > lastSeenMs) {
    props.setProperty("CC_LAST_MEET_MSG_MS", String(maxSeenMs));
  }

  Logger.log(JSON.stringify({
    ok: true,
    processed,
    sent,
    scannedThreads: threads.length,
    lastSeenMs: maxSeenMs
  }));
}

function testGoogleMeetBridgeLatest() {
  const cfg = loadBridgeConfig_();
  if (!cfg.ingestUrl) throw new Error("Missing CC_INGEST_URL script property");
  if (!cfg.ingestToken) throw new Error("Missing CC_INGEST_TOKEN script property");

  const threads = GmailApp.search(cfg.gmailQuery, 0, 5);
  const messages = [];
  threads.forEach((thread) => thread.getMessages().forEach((message) => messages.push(message)));
  messages.sort((a, b) => b.getDate().getTime() - a.getDate().getTime());

  const target = messages.find((message) => /^Notes:/i.test(String(message.getSubject() || "")));
  if (!target) {
    Logger.log("No matching Notes: message found.");
    return;
  }

  const parsed = parseMeetingEmail_(target);
  const projectId = routeProjectId_(parsed, cfg);
  const event = buildMeetingCloudEvent_(target, parsed, projectId, cfg);
  const ok = sendEventToCommandCenter_(cfg, event, `gmail-meet:test:${target.getId()}`);
  Logger.log(JSON.stringify({ ok, projectId, subject: parsed.subject, meetingTitle: parsed.meetingTitle }));
}

function loadBridgeConfig_() {
  const props = PropertiesService.getScriptProperties();
  const ingestUrl = String(props.getProperty("CC_INGEST_URL") || "").trim();
  const ingestToken = String(props.getProperty("CC_INGEST_TOKEN") || "").trim();
  const defaultProjectId = String(props.getProperty("CC_DEFAULT_PROJECT_ID") || "outreach-pipeline").trim();
  const gmailQuery = String(props.getProperty("CC_GMAIL_QUERY") || 'subject:"Notes:" newer_than:14d').trim();
  const timezone = String(props.getProperty("CC_TIMEZONE") || Session.getScriptTimeZone() || "America/New_York").trim();
  const pollLimit = Math.max(1, Math.min(50, Number(props.getProperty("CC_POLL_LIMIT") || "20")));

  let routes = [];
  const rawRoutes = String(props.getProperty("CC_PROJECT_ROUTES_JSON") || "").trim();
  if (rawRoutes) {
    try {
      const parsed = JSON.parse(rawRoutes);
      if (Array.isArray(parsed)) routes = parsed;
    } catch (_) {
      routes = [];
    }
  }

  return {
    ingestUrl,
    ingestToken,
    defaultProjectId,
    gmailQuery,
    timezone,
    pollLimit,
    routes
  };
}

function parseMeetingEmail_(message) {
  const subject = String(message.getSubject() || "").trim();
  const plainBody = String(message.getPlainBody() || "");
  const htmlBody = String(message.getBody() || "");
  const meetingTitle = extractMeetingTitle_(subject);
  const summary = extractSection_(plainBody, "Summary", "Suggested next steps");
  const suggestedNextSteps = extractBulletList_(extractSection_(plainBody, "Suggested next steps", ""));
  const notesUrl = extractNotesUrl_(htmlBody, plainBody);

  return {
    subject,
    meetingTitle,
    summary,
    suggestedNextSteps,
    notesUrl,
    plainBody,
    htmlBody
  };
}

function extractMeetingTitle_(subject) {
  const quoted = subject.match(/Notes:\s*[“"]([^”"]+)[”"]/i);
  if (quoted && quoted[1]) return quoted[1].trim();
  const fallback = subject.replace(/^Notes:\s*/i, "").trim();
  return fallback || "Untitled meeting";
}

function extractSection_(text, startLabel, endLabel) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let active = false;
  const startRe = new RegExp(`^\\s*${escapeRe_(startLabel)}\\s*$`, "i");
  const endRe = endLabel ? new RegExp(`^\\s*${escapeRe_(endLabel)}\\s*$`, "i") : null;

  lines.forEach((line) => {
    if (!active && startRe.test(line)) {
      active = true;
      return;
    }
    if (active && endRe && endRe.test(line)) {
      active = false;
      return;
    }
    if (active) out.push(line);
  });

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractBulletList_(text) {
  const items = [];
  String(text || "").split(/\r?\n/).forEach((line) => {
    const normalized = line.replace(/^\s*[•\-→]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim();
    if (normalized) items.push(normalized);
  });
  return items.slice(0, 12);
}

function extractNotesUrl_(htmlBody, plainBody) {
  const htmlMatch = String(htmlBody || "").match(/https:\/\/docs\.google\.com\/[^\s"'<>]+/i);
  if (htmlMatch && htmlMatch[0]) return htmlMatch[0];
  const plainMatch = String(plainBody || "").match(/https:\/\/docs\.google\.com\/[^\s"'<>]+/i);
  if (plainMatch && plainMatch[0]) return plainMatch[0];
  return "";
}

function routeProjectId_(parsed, cfg) {
  const haystack = `${parsed.meetingTitle} ${parsed.subject} ${parsed.summary}`.toLowerCase();
  const routes = Array.isArray(cfg.routes) ? cfg.routes : [];
  for (let i = 0; i < routes.length; i += 1) {
    const route = routes[i] || {};
    const projectId = String(route.projectId || "").trim();
    const keywords = Array.isArray(route.keywords) ? route.keywords : [];
    if (!projectId || !keywords.length) continue;
    const hit = keywords.some((keyword) => haystack.indexOf(String(keyword || "").toLowerCase()) >= 0);
    if (hit) return projectId;
  }
  return cfg.defaultProjectId;
}

function buildMeetingCloudEvent_(message, parsed, projectId, cfg) {
  const eventId = `gmail-${message.getId()}`;
  const sentAt = message.getDate().toISOString();
  return {
    specversion: "1.0",
    id: eventId,
    source: "google.meet.gmail",
    type: "commandcenter.action",
    subject: projectId,
    time: sentAt,
    datacontenttype: "application/json",
    projectid: projectId,
    channel: "google-meet-email",
    data: {
      kind: "meeting_note",
      actionType: "meeting_note",
      projectId,
      source: "google-meet-email",
      channel: "google-meet-email",
      meetingTitle: parsed.meetingTitle,
      subject: parsed.subject,
      summary: parsed.summary,
      actionItems: parsed.suggestedNextSteps,
      notesUrl: parsed.notesUrl,
      gmailMessageId: message.getId(),
      gmailThreadId: message.getThread().getId(),
      receivedAt: sentAt,
      timezone: cfg.timezone,
      status: "ok",
      severity: "ok"
    }
  };
}

function sendEventToCommandCenter_(cfg, event, idempotencyKey) {
  const response = UrlFetchApp.fetch(cfg.ingestUrl, {
    method: "post",
    muteHttpExceptions: true,
    contentType: "application/json",
    payload: JSON.stringify(event),
    headers: {
      "X-Command-Center-Ingest-Key": cfg.ingestToken,
      "Idempotency-Key": idempotencyKey
    }
  });
  const code = response.getResponseCode();
  if (code >= 200 && code < 300) return true;
  Logger.log(`Command Center ingest failed (${code}): ${response.getContentText()}`);
  return false;
}

function escapeRe_(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
