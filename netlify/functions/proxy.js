exports.handler = async function(event) {
  var headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: headers, body: "" };
  }

  try {
    var params = event.queryStringParameters || {};
    var target = params.target || "anthropic";

    // ── GOOGLE SHEETS READ ────────────────────────────────────
    if (event.httpMethod === "GET" && target === "sheets") {
      var SHEETS_URL = process.env.SHEETS_ENDPOINT;
      var SHEETS_SECRET = process.env.SHEETS_SECRET || "heavyhybrid2026";
      var qs = Object.keys(params)
        .filter(function(k) { return k !== "target"; })
        .map(function(k) { return k + "=" + encodeURIComponent(params[k]); })
        .join("&");
      var url = SHEETS_URL + "?secret=" + SHEETS_SECRET + "&" + qs;
      var res = await fetch(url);
      var text = await res.text();
      return { statusCode: 200, headers: headers, body: text };
    }

    // ── GOOGLE SHEETS WRITE ───────────────────────────────────
    if (event.httpMethod === "POST" && target === "sheets") {
      var SHEETS_URL = process.env.SHEETS_ENDPOINT;
      var body = JSON.parse(event.body);
      body.secret = process.env.SHEETS_SECRET || "heavyhybrid2026";
      var res = await fetch(SHEETS_URL, {
        method: "POST",
        body: JSON.stringify(body)
      });
      var text = await res.text();
      return { statusCode: 200, headers: headers, body: text };
    }

    // ── ANTHROPIC API ─────────────────────────────────────────
    if (event.httpMethod === "POST") {
      var body = JSON.parse(event.body);
      var res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": process.env.ANTHROPIC_API_KEY
        },
        body: JSON.stringify(body)
      });
      var data = await res.json();
      return { statusCode: res.status, headers: headers, body: JSON.stringify(data) };
    }

    return { statusCode: 405, headers: headers, body: "Method not allowed" };

  } catch(e) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: e.message }) };
  }
};
