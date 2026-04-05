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

// ─── 4. Sheet sync ────────────────────────────────────────────────────────────
// Body shape: { tab, date? }

async function handleSyncSheet(req, res) {
  const { tab, date } = req.body;
  const today = date || new Date().toISOString().split("T")[0];

  let sheetData;

  switch (tab) {
    case "daily_summary": {
      const row   = await supabaseSelect("daily_summary", [{ column: "date", op: "eq", value: today }]);
      const meals = await supabaseSelect("meals", [{ column: "date", op: "eq", value: today }]);
      await recalcWeeklySummary(today);
      sheetData = { tab, row: row[0], meals };
      break;
    }
    case "weekly_summary": {
      const weekKey = getWeekKey(today);
      const row = await supabaseSelect("weekly_summary", [{ column: "week_key", op: "eq", value: weekKey }]);
      sheetData = { tab, row: row[0] };
      break;
    }
    case "today_meals": {
      const meals = await supabaseSelect("meals", [{ column: "date", op: "eq", value: today }]);
      sheetData = { tab, meals };
      break;
    }
    case "last_session": {
      const sessions = await supabaseSelect("training_sessions", [], "date.desc", 1);
      if (!sessions.length) return res.status(200).json({ ok: true, message: "No sessions yet" });
      const sets = await supabaseSelect("session_sets", [{ column: "session_id", op: "eq", value: sessions[0].id }]);
      sheetData = { tab, session: sessions[0], sets };
      break;
    }
    case "body_composition": {
      const rows = await supabaseSelect("body_composition", [], "entry_date.desc", 1);
      sheetData = { tab, row: rows[0] };
      break;
    }
    case "activities": {
      const rows = await supabaseSelect("activities", [], "date.desc", 1);
      sheetData = { tab, row: rows[0] };
      break;
    }
    case "training_sessions": {
      const rows = await supabaseSelect("training_sessions", [], "date.desc", 1);
      sheetData = { tab, row: rows[0] };
      break;
    }
    default:
      return res.status(400).json({ error: `Unknown tab: ${tab}` });
  }

  const r = await fetch(SHEETS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: SHEETS_SECRET, ...sheetData }),
  });
  const result = await r.json();
  return res.status(200).json(result);
}

// ─── 5. Nightly reconciliation ────────────────────────────────────────────────
async function handleReconcile(req, res) {
  const today = new Date().toISOString().split("T")[0];
  const tabs = ["daily_summary", "weekly_summary", "today_meals"];
  for (const tab of tabs) {
    await handleSyncSheet({ body: { tab, date: today } }, { status: () => ({ json: () => {} }) });
  }
  return res.status(200).json({ ok: true, reconciled: tabs });
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
  const proteinHits = days.filter(d => d.protein >= d.protein_goal).length;

  const weekly = {
    week_key:           weekKey,
    week_start:         weekStart,
    days_logged:        days.length,
    avg_calories:       Math.round(avg(days, "calories")),
    avg_protein:        Math.round(avg(days, "protein")),
    protein_compliance: Math.round((proteinHits / days.length) * 100),
    calorie_compliance: Math.round(days.filter(d => Math.abs(d.calorie_delta) <= 100).length / days.length * 100),
    eat_out_meals:      sum(days, "eat_out_meals"),
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
  const d    = new Date(date + "T12:00:00");
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
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
