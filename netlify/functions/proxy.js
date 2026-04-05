// netlify/functions/proxy.js
//
// Routes:
//   POST  (no target)         → Anthropic API
//   GET   ?target=sheets      → Google Apps Script read (legacy, keep for now)
//   POST  ?target=sheets      → Google Apps Script write (legacy, keep for now)
//   POST  ?target=supabase    → Supabase read/write
//   POST  ?target=sync-sheet  → Write specific data to Google Sheet from Supabase
//   GET   ?target=reconcile   → Nightly reconciliation cron (called by Netlify scheduled function)

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const SUPABASE_REST     = `${process.env.SUPABASE_URL}/rest/v1`;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY;
const SHEETS_ENDPOINT   = process.env.SHEETS_ENDPOINT;
const SHEETS_SECRET     = "heavyhybrid2026";

// ─── CORS headers ────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };

  const target = event.queryStringParameters?.target;

  try {
    if (!target && event.httpMethod === "POST") return handleAnthropic(event);
    if (target === "sheets")     return handleSheets(event);
    if (target === "supabase")   return handleSupabase(event);
    if (target === "sync-sheet") return handleSyncSheet(event);
    if (target === "reconcile")  return handleReconcile();
    return respond(400, { error: "Unknown target" });
  } catch (err) {
    console.error(err);
    return respond(500, { error: err.message });
  }
}

// ─── 1. Anthropic ─────────────────────────────────────────────────────────────
async function handleAnthropic(event) {
  const body = JSON.parse(event.body);
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type":            "application/json",
      "x-api-key":               process.env.ANTHROPIC_API_KEY,
      "anthropic-version":       "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return respond(res.status, data);
}

// ─── 2. Google Apps Script (legacy — keep until sheet sync is confirmed) ──────
async function handleSheets(event) {
  if (event.httpMethod === "GET") {
    const res = await fetch(`${SHEETS_ENDPOINT}?secret=${SHEETS_SECRET}`);
    const data = await res.json();
    return respond(200, data);
  }
  const res = await fetch(SHEETS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: event.body,
  });
  const data = await res.json();
  return respond(200, data);
}

// ─── 3. Supabase ──────────────────────────────────────────────────────────────
// Body shape: { action, table, data?, filters? }
//
// action: "upsert" | "insert" | "select" | "delete"
// table:  any table name from schema
// data:   object or array of objects (for upsert/insert)
// filters: array of { column, op, value } for select/delete
//          op: "eq" | "gte" | "lte" | "gt" | "lt" | "like"
//
// Examples:
//   Upsert a daily summary row:
//     { action:"upsert", table:"daily_summary", data:{ date:"2026-04-05", calories:2100, ... } }
//
//   Select today's meals:
//     { action:"select", table:"meals", filters:[{ column:"date", op:"eq", value:"2026-04-05" }] }
//
//   Insert a meal:
//     { action:"insert", table:"meals", data:{ date:"2026-04-05", meal_type:"Lunch", ... } }
//
//   Delete a meal by id:
//     { action:"delete", table:"meals", filters:[{ column:"id", op:"eq", value:"uuid-here" }] }

async function handleSupabase(event) {
  const { action, table, data, filters } = JSON.parse(event.body);

  const headers = {
    "Content-Type":  "application/json",
    "apikey":        SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Prefer":        action === "upsert" ? "resolution=merge-duplicates" : "",
  };

  let url = `${SUPABASE_REST}/${table}`;

  // Append filter query params for select/delete
  if (filters?.length) {
    const params = filters.map(f => `${f.column}=${f.op}.${f.value}`).join("&");
    url += `?${params}`;
  }

  const method =
    action === "select" ? "GET"    :
    action === "upsert" ? "PATCH"  :  // PATCH + merge-duplicates = upsert
    action === "insert" ? "POST"   :
    action === "delete" ? "DELETE" : "GET";

  // Supabase upsert via POST + Prefer: resolution=merge-duplicates
  const finalMethod = action === "upsert" ? "POST" : method;

  const res = await fetch(url, {
    method: finalMethod,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });

  const result = res.status === 204 ? { ok: true } : await res.json();
  return respond(res.status < 400 ? 200 : res.status, result);
}

// ─── 4. Sheet sync ────────────────────────────────────────────────────────────
// Body shape: { tab, date? }
// Fetches fresh data from Supabase for the given tab and writes to sheet.
//
// Supported tabs:
//   "daily_summary"    — upserts today's row (or date if provided)
//   "weekly_summary"   — upserts current week row
//   "today_meals"      — replaces today's meals tab
//   "last_session"     — replaces last session tab
//   "body_composition" — appends latest Omron entry
//   "activities"       — appends latest activity
//   "training_sessions"— appends latest session summary

async function handleSyncSheet(event) {
  const { tab, date } = JSON.parse(event.body);
  const today = date || new Date().toISOString().split("T")[0];

  let sheetData;

  switch (tab) {
    case "daily_summary": {
      const row = await supabaseSelect("daily_summary", [{ column:"date", op:"eq", value:today }]);
      const meals = await supabaseSelect("meals", [{ column:"date", op:"eq", value:today }]);
      // Recalculate weekly summary while we're here
      await recalcWeeklySummary(today);
      sheetData = { tab, row: row[0], meals };
      break;
    }
    case "weekly_summary": {
      const weekKey = getWeekKey(today);
      const row = await supabaseSelect("weekly_summary", [{ column:"week_key", op:"eq", value:weekKey }]);
      sheetData = { tab, row: row[0] };
      break;
    }
    case "today_meals": {
      const meals = await supabaseSelect("meals", [{ column:"date", op:"eq", value:today }]);
      sheetData = { tab, meals };
      break;
    }
    case "last_session": {
      // Get most recent session
      const sessions = await supabaseSelect("training_sessions", [], "date.desc", 1);
      if (!sessions.length) return respond(200, { ok: true, message: "No sessions yet" });
      const sets = await supabaseSelect("session_sets", [{ column:"session_id", op:"eq", value:sessions[0].id }]);
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
      return respond(400, { error: `Unknown tab: ${tab}` });
  }

  // Send to Apps Script
  const res = await fetch(SHEETS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: SHEETS_SECRET, ...sheetData }),
  });
  const result = await res.json();
  return respond(200, result);
}

// ─── 5. Nightly reconciliation ────────────────────────────────────────────────
// Called by Netlify scheduled function at midnight.
// Syncs all tabs for the closing day as a safety net.
async function handleReconcile() {
  const today = new Date().toISOString().split("T")[0];
  const tabs = ["daily_summary", "weekly_summary", "today_meals"];
  for (const tab of tabs) {
    await handleSyncSheet({ body: JSON.stringify({ tab, date: today }) });
  }
  return respond(200, { ok: true, reconciled: tabs });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function supabaseSelect(table, filters = [], order = "", limit = null) {
  let url = `${SUPABASE_REST}/${table}`;
  const params = [];
  if (filters.length) params.push(...filters.map(f => `${f.column}=${f.op}.${f.value}`));
  if (order)  params.push(`order=${order}`);
  if (limit)  params.push(`limit=${limit}`);
  if (params.length) url += `?${params.join("&")}`;

  const res = await fetch(url, {
    headers: {
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
    },
  });
  return res.json();
}

async function recalcWeeklySummary(date) {
  const weekStart = getWeekStart(date);
  const weekEnd   = getWeekEnd(date);
  const weekKey   = getWeekKey(date);

  const days = await supabaseSelect("daily_summary", [
    { column:"date", op:"gte", value:weekStart },
    { column:"date", op:"lte", value:weekEnd },
  ]);

  const sessions = await supabaseSelect("training_sessions", [
    { column:"date", op:"gte", value:weekStart },
    { column:"date", op:"lte", value:weekEnd },
  ]);

  if (!days.length) return;

  const avg = (arr, key) => arr.reduce((s, r) => s + (r[key] || 0), 0) / arr.length;
  const sum = (arr, key) => arr.reduce((s, r) => s + (r[key] || 0), 0);

  const proteinHits = days.filter(d => d.protein >= d.protein_goal).length;

  const weekly = {
    week_key:            weekKey,
    week_start:          weekStart,
    days_logged:         days.length,
    avg_calories:        Math.round(avg(days, "calories")),
    avg_protein:         Math.round(avg(days, "protein")),
    protein_compliance:  Math.round((proteinHits / days.length) * 100),
    calorie_compliance:  Math.round(days.filter(d => Math.abs(d.calorie_delta) <= 100).length / days.length * 100),
    eat_out_meals:       sum(days, "eat_out_meals"),
    sessions:            sessions.length,
    total_difficulty:    sum(sessions, "difficulty_kg"),
    avg_energy_balance:  Math.round(avg(days, "energy_balance")),
    updated_at:          new Date().toISOString(),
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
  const d = new Date(date);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  return new Date(d.setDate(diff)).toISOString().split("T")[0];
}

function getWeekEnd(date) {
  const start = new Date(getWeekStart(date));
  start.setDate(start.getDate() + 6);
  return start.toISOString().split("T")[0];
}

function respond(status, body) {
  return { statusCode: status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
