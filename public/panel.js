// Control panel logic for WinGo Engine V2 (Deposit Unlock & UID Verification)

const KEY = "wingo_panel_key";
const TAB_KEY = "wingo_active_tab";
let key = sessionStorage.getItem(KEY) || "";
let S = null;              // last snapshot from /api/state
let tickBase = 0;          // used to count the round down smoothly between refreshes

// Pagination & Filter States
let subSearch = "";
let subFilter = "all"; // 'all' | 'pending' | 'verified' | 'live'
let subPage = 1;
const SUB_PER_PAGE = 8;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, m =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {}, { "x-panel-key": key });
  if (opts.body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
  return res.json();
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });

function showLogin() {
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
}
function showApp() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  restoreActiveTab();
}

function logout() {
  sessionStorage.removeItem(KEY);
  key = "";
  showLogin();
}

async function login() {
  const pw = $("pw").value.trim();
  if (!pw) return;
  key = pw;
  try {
    S = await api("/api/state");
    sessionStorage.setItem(KEY, key);
    $("loginErr").textContent = "";
    showApp();
    render();
  } catch (e) {
    $("loginErr").textContent = "❌ Invalid password";
    key = "";
  }
}
$("pw").addEventListener("keydown", e => { if (e.key === "Enter") login(); });

// ================= TAB NAVIGATION =================
function switchTab(tabId) {
  sessionStorage.setItem(TAB_KEY, tabId);
  document.querySelectorAll(".nav-tab[data-tab]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-pane").forEach(pane => {
    pane.classList.toggle("hidden", pane.id !== tabId);
  });
}

function restoreActiveTab() {
  const savedTab = sessionStorage.getItem(TAB_KEY) || "tab-hud";
  switchTab(savedTab);
}

async function refresh() {
  if (!key || $("app").classList.contains("hidden")) return;
  try {
    S = await api("/api/state");
    tickBase = Date.now();
    render();
  } catch (e) { /* retry automatically on next interval */ }
}

// ------------------------------------------------------------------ render

function signalText(run) {
  const p = run.prediction;
  if (!p) return "—";
  if (p === "SKIP") return "⏳ SKIP (PAUSED)";
  const lvl = (run.level && run.level > 0) ? ` [L${run.level}]` : "";
  const balls = (run.numbers || []).join(", ");
  return balls ? `${p}${lvl} [${balls}]` : `${p}${lvl}`;
}

function render() {
  if (!S) return;

  // Header & Status
  $("headLine").textContent = `Uptime ${fmtUptime(S.uptimeSeconds)} · Node Service · Game ${S.feed.game}`;
  const eng = S.engine.enabled;
  $("enginePill").textContent = eng ? "ACTIVE" : "PAUSED";
  $("enginePill").className = "pill " + (eng ? "on" : "");
  $("modePill").textContent = eng ? "LIVE RUNNING" : "STOPPED";
  $("modePill").className = "pill " + (eng ? "on" : "");
  $("btnEngineOn").disabled = eng;
  $("btnEngineOff").disabled = !eng;
  $("engineNote").textContent = eng
    ? "Engine is actively polling lottery draws and streaming prediction signals to verified subscribers."
    : "Engine is paused. Polling and broadcasts are halted.";

  // Signal & Timer
  $("kStage").textContent = S.run.mode || "FLOW";
  $("kPred").textContent = signalText(S.run);
  $("kPeriod").textContent = S.round.nextPeriod ? `..${String(S.round.nextPeriod).slice(-4)}` : "—";
  $("kHist").textContent = `${S.history.depth} / ${S.history.max} rounds`;
  $("kLossRun").textContent = `${S.run.consecutiveLosses || 0} in a row`;

  const bigSig = signalText(S.run);
  $("kBigSig").textContent = bigSig !== "—" ? `${S.round.nextPeriod ? "PERIOD .." + String(S.round.nextPeriod).slice(-4) + " → " : ""}${bigSig}` : "AWAITING NEXT ROUND DRAW";

  // Win/Loss Metrics
  const w = S.stats.wins, j = S.stats.jackpots, l = S.stats.losses;
  const total = w + j + l;
  $("kWins").textContent = w;
  $("kJack").textContent = j;
  $("kLoss").textContent = l;
  $("kRate").textContent = total ? `${Math.round(((w + j) / total) * 100)}% (${total} rounds)` : "—";

  // Data Feed
  const feedOk = Date.now() - S.feed.lastOk < 20000;
  $("feedPill").textContent = feedOk ? "ONLINE" : (S.feed.lastError ? "ATTENTION" : "INITIALIZING");
  $("feedPill").className = "pill " + (feedOk ? "on" : "");
  $("kFeedOk").textContent = S.feed.lastOk ? `${Math.round((Date.now() - S.feed.lastOk) / 1000)}s ago` : "never";
  $("kFeedStatus").textContent = S.feed.lastStatus ? `HTTP ${S.feed.lastStatus}` : "—";
  $("kFeedRounds").textContent = S.feed.lastRounds || "—";
  $("kFeedPath").textContent = S.feed.host ? `draw.${S.feed.host}.com` : "—";
  $("kFeedCounts").textContent = `${S.feed.ok} ok / ${S.feed.failed} failed`;
  $("feedNote").textContent = S.feed.lastError
    ? `⚠️ Recent feed issue: ${S.feed.lastError}`
    : `Connected to mirror draw.${S.feed.host || "auto"}.com. Polling every 2s.`;

  // Recent Log Table
  renderLog(S.log);

  // Totals & Subscriber Counters
  if ($("kTotalUsers")) $("kTotalUsers").textContent = S.totals.users || 0;
  if ($("kPendingUidUsers")) $("kPendingUidUsers").textContent = S.totals.pendingUid || 0;
  if ($("kDepositPendingUsers")) $("kDepositPendingUsers").textContent = S.totals.depositPending || 0;
  if ($("kPendingUsers")) $("kPendingUsers").textContent = S.totals.pending || 0;
  if ($("kVerifiedUsers")) $("kVerifiedUsers").textContent = S.totals.verified || 0;

  if ($("cntAll")) $("cntAll").textContent = S.totals.users || 0;
  if ($("cntPendingUid")) $("cntPendingUid").textContent = S.totals.pendingUid || 0;
  if ($("cntDeposit")) $("cntDeposit").textContent = S.totals.depositPending || 0;
  if ($("cntPending")) $("cntPending").textContent = S.totals.pending || 0;
  if ($("cntVerified")) $("cntVerified").textContent = S.totals.verified || 0;
  if ($("cntLive")) $("cntLive").textContent = S.totals.live || 0;

  const totalActionNeeded = (S.totals.depositPending || 0) + (S.totals.pendingUid || 0) + (S.totals.pending || 0);
  if ($("navSubBadge")) {
    $("navSubBadge").textContent = totalActionNeeded
      ? `${totalActionNeeded} PENDING`
      : (S.totals.users || 0);
  }

  // Bot & Media Settings Form
  if (!document.activeElement || !["inpToken", "inpHeader", "inpFooter", "inpUidMessage", "inpCustomLink", "inpCustomLinkText"].includes(document.activeElement.id)) {
    if ($("inpToken")) $("inpToken").value = S.cfg.botToken || "";
    if ($("inpUidMessage")) $("inpUidMessage").value = S.cfg.uidMessage || "";
    if ($("inpCustomLink")) $("inpCustomLink").value = S.cfg.customLink || "";
    if ($("inpCustomLinkText")) $("inpCustomLinkText").value = S.cfg.customLinkText || "👉 REGISTER / OPEN LINK";
    if ($("inpHeader")) $("inpHeader").value = S.cfg.header || "";
    if ($("inpFooter")) $("inpFooter").value = S.cfg.footer || "";
    if ($("swAutoVerify")) $("swAutoVerify").classList.toggle("on", S.cfg.autoVerifyUid !== false);
  }

  const lRun = S.listener.running;
  $("listenerPill").textContent = lRun ? "LISTENING" : "IDLE";
  $("listenerPill").className = "pill " + (lRun ? "on" : "");

  // Subscribers List
  renderSubscribers(S.subscribers);

  // Channel / Group Forward Status
  const ch = S.channelForward || {};
  if ($("chStatusPill")) {
    $("chStatusPill").textContent = ch.active ? "RUNNING (ACTIVE)" : (ch.status || "IDLE");
    $("chStatusPill").className = "pill " + (ch.active ? "on" : "");
  }
  if ($("navChBadge")) {
    $("navChBadge").style.display = ch.active ? "inline-block" : "none";
  }
  if ($("chWinsBadge")) {
    $("chWinsBadge").textContent = `${ch.sessionWins || 0} / ${ch.targetWins || 5} Wins`;
    $("chWinsBadge").className = "pill " + ((ch.sessionWins >= (ch.targetWins || 5)) ? "ok" : (ch.active ? "on" : ""));
  }
  if ($("btnChStart")) $("btnChStart").disabled = !ch.verified || ch.active;
  if ($("btnChStop")) $("btnChStop").disabled = !ch.active;

  if (ch.verified && ch.title) {
    if ($("chVerifyResult")) $("chVerifyResult").classList.remove("hidden");
    if ($("chTitle")) $("chTitle").textContent = ch.title || "—";
    if ($("chUsername")) $("chUsername").textContent = ch.username || "—";
    if ($("chChatId")) $("chChatId").textContent = ch.chatId || "—";
    if ($("chAdminStatus")) $("chAdminStatus").textContent = "VERIFIED ADMIN ✅";
    if ($("chInput") && !$("chInput").value && ch.target) {
      $("chInput").value = ch.target;
    }
  }

  // Console Logs
  const logBox = $("logBox");
  if (Array.isArray(S.logs)) {
    logBox.textContent = S.logs.map(e => `[${new Date(e.t).toISOString().slice(11, 19)}] [${e.level.toUpperCase()}] ${e.msg}`).join("\n");
  }
}

function renderLog(log) {
  const b = $("logBody");
  if (!log || !log.length) {
    b.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;">No rounds settled in this session yet.</td></tr>';
    return;
  }
  b.innerHTML = log.map(r => {
    let tagClass = "off";
    if (r.resultText.includes("WIN") || r.resultText.includes("JACKPOT")) tagClass = "ok";
    else if (r.resultText.includes("LOSE") || r.resultText.includes("LOSS")) tagClass = "err";
    else if (r.resultText.includes("SKIP")) tagClass = "warn";
    else if (r.resultText.includes("PENDING")) tagClass = "user";

    return `<tr>
      <td><b>..${String(r.period).slice(-4)}</b></td>
      <td>${esc(r.label)}</td>
      <td><b>${esc(r.actual)}</b></td>
      <td><span class="badge ${tagClass}">${esc(r.resultText)}</span></td>
    </tr>`;
  }).join("");
}

// ================= SUBSCRIBERS LIST & PAGINATION =================

function onSubSearch(val) {
  subSearch = (val || "").toLowerCase().trim();
  subPage = 1;
  if (S) renderSubscribers(S.subscribers);
}

function setSubFilter(filter) {
  subFilter = filter;
  subPage = 1;
  $("subFilterAll")?.classList.toggle("active", filter === "all");
  $("subFilterPendingUid")?.classList.toggle("active", filter === "pending_uid");
  $("subFilterDeposit")?.classList.toggle("active", filter === "deposit");
  $("subFilterPending")?.classList.toggle("active", filter === "pending");
  $("subFilterVerified")?.classList.toggle("active", filter === "verified");
  $("subFilterLive")?.classList.toggle("active", filter === "live");
  if (S) renderSubscribers(S.subscribers);
}

function changeSubPage(delta) {
  subPage += delta;
  if (S) renderSubscribers(S.subscribers);
}

function renderSubscribers(subs) {
  $("subCount").textContent = subs.length;
  const box = $("subList");
  if (!subs.length) {
    box.innerHTML = '<p class="note">No members registered yet. Users who /start the bot will appear here.</p>';
    $("subPager").classList.add("hidden");
    return;
  }

  // Filter
  const filtered = subs.filter(s => {
    if (subFilter === "pending_uid" && s.uidStatus !== "PENDING_UID") return false;
    if (subFilter === "deposit" && s.uidStatus !== "DEPOSIT_PENDING") return false;
    if (subFilter === "pending" && s.uidStatus !== "PENDING") return false;
    if (subFilter === "verified" && s.uidStatus !== "VERIFIED") return false;
    if (subFilter === "live" && !(s.active && s.uidStatus === "VERIFIED")) return false;
    if (!subSearch) return true;
    return String(s.name || "").toLowerCase().includes(subSearch) ||
           String(s.username || "").toLowerCase().includes(subSearch) ||
           String(s.uid || "").toLowerCase().includes(subSearch) ||
           String(s.id).toLowerCase().includes(subSearch);
  });

  const totalPages = Math.ceil(filtered.length / SUB_PER_PAGE) || 1;
  if (subPage > totalPages) subPage = totalPages;
  if (subPage < 1) subPage = 1;

  const start = (subPage - 1) * SUB_PER_PAGE;
  const pageItems = filtered.slice(start, start + SUB_PER_PAGE);

  $("subPageInfo").textContent = `Showing ${filtered.length ? start + 1 : 0}–${Math.min(start + SUB_PER_PAGE, filtered.length)} of ${filtered.length} (Page ${subPage}/${totalPages})`;
  $("subPrevBtn").disabled = subPage <= 1;
  $("subNextBtn").disabled = subPage >= totalPages;
  $("subPager").classList.remove("hidden");

  if (!pageItems.length) {
    box.innerHTML = '<p class="note">No subscribers matched your current search/filter.</p>';
    return;
  }

  box.innerHTML = pageItems.map(s => {
    let statusBadge = '<span class="badge off">NO UID YET</span>';
    let actionButtons = '';

    const msgBtn = `<button class="primary" style="background:#2563eb; color:#fff; font-weight:700; border:none; padding:6px 12px; border-radius:6px; cursor:pointer;" onclick="openSendUserModal('${s.id}','${esc(s.name)}')">💬 SEND MESSAGE</button>`;

    if (s.uidStatus === "VERIFIED") {
      statusBadge = '<span class="badge ok">✅ VERIFIED</span>';
      actionButtons = `
        ${msgBtn}
        <button class="danger" onclick="subAction('delete','${s.id}')">🗑 DEL</button>
      `;
    } else if (s.uidStatus === "DEPOSIT_PENDING") {
      statusBadge = '<span class="badge warn" style="font-weight:800;">⚠️ DEPOSIT CLAIMED REVIEW</span>';
      actionButtons = `
        <button class="primary" style="background:#00ff88;color:#000;font-weight:800;" onclick="subAction('verify','${s.id}')">✅ ACCEPT / FULL VERIFY</button>
        <button class="warn-btn" onclick="subAction('ask_deposit','${s.id}')">⚠️ ASK DEPOSIT</button>
        ${msgBtn}
        <button onclick="subAction('reject','${s.id}')">❌ REJECT</button>
        <button class="danger" onclick="subAction('delete','${s.id}')">🗑 DEL</button>
      `;
    } else if (s.uidStatus === "PENDING") {
      statusBadge = '<span class="badge" style="background:rgba(0,229,255,0.15);color:var(--cyan);border:1px solid rgba(0,229,255,0.3);font-weight:700;">⏳ PENDING</span>';
      actionButtons = `
        <button class="primary" style="background:#00ff88;color:#000;font-weight:800;" onclick="subAction('verify','${s.id}')">✅ FULL VERIFY</button>
        <button class="warn-btn" onclick="subAction('ask_deposit','${s.id}')">⚠️ ASK DEPOSIT</button>
        ${msgBtn}
        <button onclick="subAction('reject','${s.id}')">❌ REJECT</button>
        <button class="danger" onclick="subAction('delete','${s.id}')">🗑 DEL</button>
      `;
    } else if (s.uidStatus === "PENDING_UID") {
      statusBadge = '<span class="badge user">⏳ PENDING UID</span>';
      actionButtons = `
        <button class="primary" style="background:#00e5ff;color:#000;font-weight:700;" onclick="subAction('verify_id','${s.id}')">🔍 VERIFY ID</button>
        ${msgBtn}
        <button onclick="subAction('reject','${s.id}')">❌ REJECT</button>
        <button class="danger" onclick="subAction('delete','${s.id}')">🗑 DEL</button>
      `;
    } else if (s.uidStatus === "REJECTED") {
      statusBadge = '<span class="badge err">❌ REJECTED</span>';
      actionButtons = `
        <button class="primary" style="background:#00e5ff;color:#000;font-weight:700;" onclick="subAction('verify_id','${s.id}')">🔍 VERIFY ID</button>
        ${msgBtn}
        <button class="danger" onclick="subAction('delete','${s.id}')">🗑 DEL</button>
      `;
    } else {
      statusBadge = '<span class="badge off">NO UID YET</span>';
      actionButtons = `
        ${msgBtn}
        <button class="danger" onclick="subAction('delete','${s.id}')">🗑 DEL</button>
      `;
    }

    const liveBadge = (s.active && s.uidStatus === "VERIFIED")
      ? '<span class="badge ok">🟢 LIVE SIGNALS</span>'
      : '<span class="badge off">⏸ PAUSED</span>';

    const now = Date.now();
    const cooldownBadge = (s.cooldownUntil && now < s.cooldownUntil)
      ? `<span class="badge warn">⏳ COOLDOWN (${Math.ceil((s.cooldownUntil - now)/60000)}m left)</span>`
      : '';

    return `<div class="ch" style="${s.uidStatus === 'DEPOSIT_PENDING' ? 'border-color:rgba(255,183,0,0.5);' : ''}">
      <div class="top">
        <div>
          <div class="lbl">${esc(s.name)} ${statusBadge} ${liveBadge} ${cooldownBadge}</div>
          <div class="id">TG ID: <b style="color:var(--cyan); font-family:monospace; font-size:13px;">${s.id}</b> <button type="button" style="background:#2563eb; color:#fff; font-size:11px; font-weight:700; border:none; padding:3px 9px; border-radius:4px; margin-left:6px; cursor:pointer;" onclick="openSendUserModal('${s.id}','${esc(s.name)}')">💬 Send Message</button> · ${s.username ? "@" + esc(s.username) : "no username"}</div>
        </div>
        <div class="row">
          ${actionButtons}
        </div>
      </div>
      <div class="meta" style="margin-top:6px;">
        Account UID: <b style="color:var(--cyan); font-size:13px;">${esc(s.uid || "None submitted")}</b> <button type="button" style="background:#1d4ed8; color:#fff; font-size:10.5px; font-weight:700; border:none; padding:2px 8px; border-radius:4px; margin-left:6px; cursor:pointer;" onclick="openSendUserModal('${s.id}','${esc(s.name)}')">✉️ Text User</button>
        ${s.uidSubmittedAt ? ' · Submitted ' + new Date(s.uidSubmittedAt).toLocaleTimeString() : ''}
        · <b>Session ${s.sessionNumber || 1}</b> (${s.sessionWins || 0}/5 wins)
        · <b>Daily:</b> ${s.dailyWins || 0}/20 wins
        · ${s.tracked || 0} messages tracked in DM
      </div>
    </div>`;
  }).join("");
}

async function subAction(action, id) {
  if (action === "delete" && !confirm("Remove this user? This will also wipe their saved DM history.")) return;
  const r = await post("/api/subscribers", { action, id });
  if (!r.ok) alert(r.error || "Action failed");
  refresh();
}

// ================= USER PRIVATE MESSAGE MODAL =================
let currentMsgUserId = null;
let currentMsgUserName = "";

function openSendUserModal(id, name) {
  currentMsgUserId = id;
  currentMsgUserName = name || `User ${id}`;
  const title = $("userMsgTitle");
  if (title) title.textContent = `💬 Send Private Message`;
  const target = $("userMsgTarget");
  if (target) target.textContent = `${currentMsgUserName} (TG ID: ${id})`;
  const input = $("userMsgInput");
  if (input) input.value = "";
  const modal = $("userMsgModal");
  if (modal) modal.classList.remove("hidden");
  setTimeout(() => { if (input) input.focus(); }, 60);
}

function closeUserMsgModal() {
  const modal = $("userMsgModal");
  if (modal) modal.classList.add("hidden");
  currentMsgUserId = null;
}

async function submitUserMsg() {
  if (!currentMsgUserId) return;
  const input = $("userMsgInput");
  const text = input ? input.value.trim() : "";
  if (!text) {
    alert("Kripya message likhein!");
    return;
  }
  const btn = $("userMsgSendBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending...";
  }
  try {
    const r = await post("/api/subscribers", {
      action: "send_message",
      id: currentMsgUserId,
      message: text
    });
    if (r.ok) {
      alert(`✅ Message successfully sent to ${currentMsgUserName}!`);
      closeUserMsgModal();
    } else {
      alert(`❌ Message nahi ja saka: ${r.error || "Unknown error"}`);
    }
  } catch (err) {
    alert(`❌ Error sending message: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🚀 Send Message";
    }
  }
}

// ================= ACTIONS & CONFIG =================

async function engineAction(action) {
  await post("/api/engine", { action });
  refresh();
}

async function listenerAction(action) {
  await post("/api/listener", { action });
  refresh();
}

async function testFeed() {
  $("feedTestOut").textContent = "Pinging feed mirrors…";
  const r = await post("/api/test-feed");
  $("feedTestOut").textContent = r.ok
    ? `✅ Feed OK: ${r.rounds} rounds received in ${r.ms}ms. Latest Period: ..${String(r.newest?.period).slice(-4)}`
    : `❌ Feed Error: ${r.error} (${r.ms}ms)`;
  refresh();
}

function toggleAutoVerify() {
  $("swAutoVerify").classList.toggle("on");
}

function toggleToken() {
  const el = $("inpToken");
  el.type = el.type === "password" ? "text" : "password";
}

async function verifyToken() {
  const token = $("inpToken").value.trim();
  if (!token) {
    alert("Please enter a bot token first.");
    return;
  }
  const r = await post("/api/verify-token", { botToken: token });
  if (r.ok) {
    alert(`✅ Valid Bot Token!\nActive as @${r.username} (${r.name})\nBot listener has been started automatically!`);
  } else {
    alert(`❌ Token Error: ${r.error}`);
  }
  refresh();
}

async function saveConfig() {
  const body = {
    botToken: $("inpToken") ? $("inpToken").value.trim() : "",
    customLink: $("inpCustomLink") ? $("inpCustomLink").value.trim() : "",
    customLinkText: $("inpCustomLinkText") ? $("inpCustomLinkText").value.trim() : "",
    uidMessage: $("inpUidMessage") ? $("inpUidMessage").value : "",
    header: $("inpHeader") ? $("inpHeader").value : "",
    footer: $("inpFooter") ? $("inpFooter").value.trim() : "",
    autoVerifyUid: $("swAutoVerify") ? $("swAutoVerify").classList.contains("on") : false
  };
  const r = await post("/api/config", body);
  $("cfgNote").textContent = r.ok ? "✅ Settings saved successfully." : "❌ Failed to save settings.";
  setTimeout(() => { $("cfgNote").textContent = "—"; }, 4000);
  refresh();
}

async function verifyChannel() {
  const target = $("chInput") ? $("chInput").value.trim() : "";
  if (!target) {
    if ($("chVerifyError")) $("chVerifyError").textContent = "⚠️ Please enter a channel or group username / link";
    return;
  }
  if ($("btnChVerify")) $("btnChVerify").disabled = true;
  if ($("chVerifyError")) $("chVerifyError").textContent = "Checking Bot Admin status...";
  try {
    const r = await post("/api/channel/verify", { target });
    if (r.ok) {
      if ($("chVerifyError")) $("chVerifyError").textContent = "";
      alert(`✅ Verified! Bot is Administrator in: ${r.chat?.title || target}`);
    } else {
      if ($("chVerifyError")) $("chVerifyError").textContent = `❌ ${r.error || "Verification failed"}`;
    }
    refresh();
  } catch (e) {
    if ($("chVerifyError")) $("chVerifyError").textContent = `❌ Error: ${e.message}`;
  } finally {
    if ($("btnChVerify")) $("btnChVerify").disabled = false;
  }
}

async function toggleChannelForward(action) {
  try {
    const r = await post("/api/channel/toggle", { action });
    if (!r.ok) {
      alert(`⚠️ ${r.error || "Action failed"}`);
    }
    refresh();
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

async function clearHistory() {
  if (!confirm("Clear rolling rounds history?")) return;
  await post("/api/clear-history");
  refresh();
}

async function resetStats() {
  if (!confirm("Reset total Wins, Jackpots, and Losses to 0?")) return;
  await post("/api/reset-stats");
  refresh();
}

async function exportCfg() {
  const r = await api("/api/export");
  if (r.ok) $("cfgBox").value = JSON.stringify(r.config, null, 2);
}

async function importCfg() {
  try {
    const cfg = JSON.parse($("cfgBox").value.trim());
    await post("/api/import", { config: cfg });
    alert("Config imported successfully!");
    refresh();
  } catch (e) {
    alert("Invalid JSON format in config box.");
  }
}

function fmtUptime(sec) {
  if (!sec) return "0s";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

// Smooth countdown loop
setInterval(() => {
  if (!S || !S.round || S.round.secondsLeft === null) return;
  const elapsed = Math.floor((Date.now() - tickBase) / 1000);
  const rem = Math.max(0, S.round.secondsLeft - elapsed);
  $("kTimer").textContent = `${rem}s`;
}, 1000);

// Auto-refresh interval
setInterval(refresh, 3000);

// Auto-login on boot
if (key) {
  api("/api/state").then(s => {
    S = s;
    showApp();
    render();
  }).catch(() => { showLogin(); });
} else {
  showLogin();
}
