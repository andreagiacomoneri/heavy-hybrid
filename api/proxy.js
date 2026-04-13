// api/proxy.js
//
// Routes:
//   POST  (no target)         → Anthropic API
//   GET   ?target=sheets      → Google Apps Script read (legacy)
//   POST  ?target=sheets      → Google Apps Script write (legacy)
//   POST  ?target=supabase    → Supabase read/write
//   POST  ?target=sync-sheet  → Write specific data to Google Sheet from Supabase
//   GET   ?target=reconcile   → Nightly reconciliation (called by Vercel cron)

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const SUPABASE_REST     = `${process.env.SUPABASE_URL}/rest/v1`;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY;
const SHEETS_ENDPOINT   = process.env.SHEETS_ENDPOINT;
const SHEETS_SECRET     = "heavyhybrid2026";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const target = req.query.target;

  try {
    if (!target && req.method === "POST") return handleAnthropic(req, res);
    if (target === "sheets")     return handleSheets(req, res);
    if (target === "supabase")   return handleSupabase(req, res);
    if (target === "sync-sheet") return handleSyncSheet(req, res);
    if (target === "reconcile")  return handleReconcile(req, res);
    return res.status(400).json({ error: "Unknown target" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── 1. Anthropic ─────────────────────────────────────────────────────────────
async function handleAnthropic(req, res) {
  const body = req.body;
  const r = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  return res.status(r.status).json(data);
}

// ─── 2. Google Apps Script (legacy) ───────────────────────────────────────────
async function handleSheets(req, res) {
  if (req.method === "GET") {
    const r = await fetch(`${SHEETS_ENDPOINT}?secret=${SHEETS_SECRET}`);
    const data = await r.json();
    return res.status(200).json(data);
  }
  const r = await fetch(SHEETS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req.body),
  });
  const data = await r.json();
  return res.status(200).json(data);
}

// ─── 3. Supabase ──────────────────────────────────────────────────────────────
// Body shape: { action, table, data?, filters?, order?, limit? }
//
// action: "upsert" | "insert" | "select" | "delete"
// table:  any table name from schema
// data:   object or array of objects (for upsert/insert)
// filters: [{ column, op, value }]  op: eq | gte | lte | gt | lt | like
// order:  "column.asc" | "column.desc"
// limit:  number

async function handleSupabase(req, res) {
  const { action, table, data, filters, order, limit } = req.body;

  const prefer =
    action === "upsert" ? "resolution=merge-duplicates,return=representation" :
    action === "insert" ? "return=representation" : "";

  const headers = {
    "Content-Type":  "application/json",
    "apikey":        SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    ...(prefer ? { "Prefer": prefer } : {}),
  };

  let url = `${SUPABASE_REST}/${table}`;
  const params = [];
  if (filters?.length) params.push(...filters.map(f => `${f.column}=${f.op}.${f.value}`));
  if (order)  params.push(`order=${order}`);
  if (limit)  params.push(`limit=${limit}`);
  if (params.length) url += `?${params.join("&")}`;

  const method =
    action === "select" ? "GET"    :
    action === "upsert" ? "POST"   :
    action === "insert" ? "POST"   :
    action === "delete" ? "DELETE" : "GET";

  const r = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });

  const result = r.status === 204 ? { ok: true } : await r.json();
  return res.status(r.status < 400 ? 200 : r.status).json(result);
}

// ─── 4. Sheet rebuild ─────────────────────────────────────────────────────────
// Rebuilds all Google Sheet tabs from Supabase data.
// Called on every write action and by nightly cron.

async function handleSyncSheet(req, res) {
  try {
    // Recalculate weekly summary before rebuilding sheet
    const today = new Date().toISOString().split("T")[0];
    await recalcWeeklySummary(today);

    const [
      dailySummary,
      meals,
      trainingSessions,
      sessionSets,
      activities,
      bodyComp,
      weeklySummary
    ] = await Promise.all([
      supabaseSelect("daily_summary", [], "date.asc"),
      supabaseSelect("meals", [{ column: "date", op: "eq", value: today }], "logged_at.asc"),
      supabaseSelect("training_sessions", [], "date.asc"),
      supabaseSelect("session_sets", [], "date.asc"),
      supabaseSelect("activities", [], "date.asc"),
      supabaseSelect("body_composition", [], "entry_date.asc"),
      supabaseSelect("weekly_summary", [], "week_start.asc"),
    ]);

// Get last session for Last Session Detail tab
    const lastSession = trainingSessions.length ? trainingSessions[trainingSessions.length - 1] : null;
    const lastSessionSets = lastSession
      ? sessionSets.filter(s => s.session_id === lastSession.id)
      : [];

    // Send session CSV to Telegram
    if (lastSession && lastSessionSets.length) {
      const header = "Date,Title,Block,Exercise,Set,Target Reps,Target Kg,Actual Reps,Actual Kg,RIR Score,RIR Label,Peak HR";
      const rows = lastSessionSets.map(r =>
        [lastSession.date, lastSession.title, r.block, r.exercise, r.set_number, r.target_reps, r.target_kg, r.actual_reps, r.actual_kg, r.rir_score, r.rir_label, r.peak_hr || ""]
        .map(v => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(",")
      ).join("\n");
      const csv = `${header}\n${rows}`;
      const summary = `*${lastSession.title}* — ${lastSession.date}\nDifficulty: ${lastSession.difficulty_kg} kg · Completion: ${lastSession.completion_pct}%\n\n\`\`\`\n${csv}\n\`\`\``;
      await sendTelegram(summary);
    }

    const payload = {
      secret: SHEETS_SECRET,
      action: "rebuildAll",
      today,
      dailySummary,
      meals,
      trainingSessions,
      lastSession,
      lastSessionSets,
      activities,
      bodyComp,
      weeklySummary,
    };

    const r = await fetch(SHEETS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await r.json();
    return res.status(200).json(result);
  } catch (err) {
    console.error("rebuildSheet error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── 5. Nightly reconciliation ────────────────────────────────────────────────
async function handleReconcile(req, res) {
  return handleSyncSheet(req, res);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function supabaseSelect(table, filters = [], order = "", limit = null) {
  let url = `${SUPABASE_REST}/${table}`;
  const params = [];
  if (filters.length) params.push(...filters.map(f => `${f.column}=${f.op}.${f.value}`));
  if (order)  params.push(`order=${order}`);
  if (limit)  params.push(`limit=${limit}`);
  if (params.length) url += `?${params.join("&")}`;

  const r = await fetch(url, {
    headers: {
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
    },
  });
  return r.json();
}

async function recalcWeeklySummary(date) {
  const weekStart = getWeekStart(date);
  const weekEnd   = getWeekEnd(date);
  const weekKey   = getWeekKey(date);

  const days     = await supabaseSelect("daily_summary", [
    { column: "date", op: "gte", value: weekStart },
    { column: "date", op: "lte", value: weekEnd },
  ]);
  const sessions = await supabaseSelect("training_sessions", [
    { column: "date", op: "gte", value: weekStart },
    { column: "date", op: "lte", value: weekEnd },
  ]);

  if (!days.length) return;

  const avg = (arr, key) => arr.reduce((s, r) => s + (r[key] || 0), 0) / arr.length;
  const sum = (arr, key) => arr.reduce((s, r) => s + (r[key] || 0), 0);
  const allMeals = await supabaseSelect("meals", [
    { column: "date", op: "gte", value: weekStart },
    { column: "date", op: "lte", value: weekEnd },
  ]);
  const homeMeals  = allMeals.filter(m => !m.is_eat_out).length;
  const eatOutMeals = allMeals.filter(m => m.is_eat_out).length;
  const totalMeals = allMeals.length;

  const proteinHits = days.filter(d => d.protein >= d.protein_goal).length;

  const weekly = {
    week_key:           weekKey,
    week_start:         weekStart,
    days_logged:        days.length,
    avg_calories:       Math.round(avg(days, "calories")),
    avg_protein:        Math.round(avg(days, "protein")),
    protein_compliance: Math.round((proteinHits / days.length) * 100),
    calorie_compliance: Math.round(days.filter(d => Math.abs(d.calorie_delta) <= 100).length / days.length * 100),
    eat_out_meals:      eatOutMeals,
    home_meals:         homeMeals,
    total_meals:        totalMeals,
    sessions:           sessions.length,
    total_difficulty:   sum(sessions, "difficulty_kg"),
    avg_energy_balance: Math.round(avg(days, "energy_balance")),
    updated_at:         new Date().toISOString(),
  };

  await fetch(`${SUPABASE_REST}/weekly_summary`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Prefer":        "resolution=merge-duplicates",
    },
    body: JSON.stringify(weekly),
  });
}

function getWeekKey(date) {
  const d = new Date(date + "T12:00:00");
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + 1) / 7);
  return `${d.getFullYear()}_W${String(week).padStart(2, "0")}`;
}

function getWeekStart(date) {
  const d   = new Date(date + "T12:00:00");
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.toISOString().split("T")[0];
}

function getWeekEnd(date) {
  const d = new Date(getWeekStart(date) + "T12:00:00");
  d.setDate(d.getDate() + 6);
  return d.toISOString().split("T")[0];
}
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  }).catch(err => console.error("Telegram error:", err));
}
