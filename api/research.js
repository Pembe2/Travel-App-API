export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const { trip, options } = req.body || {};
    const destinationQuery = (trip?.destination_query || "").trim();
    if (!destinationQuery) {
      res.status(400).send("Missing trip.destination_query");
      return;
    }

    const maxPlaces = clampInt(options?.max_places, 5, 25, 15);
    const interests = Array.isArray(trip?.interests) ? trip.interests.slice(0, 12) : [];
    const ask = (trip?.ask || "").trim();

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

    if (!OPENAI_API_KEY) {
      res.status(500).send("Server missing OPENAI_API_KEY");
      return;
    }
    if (!MAPBOX_TOKEN) {
      res.status(500).send("Server missing MAPBOX_TOKEN");
      return;
    }

    // 1) Ask LLM for candidate places (names + UI fields; NO coordinates)
    const llmJson = await getCandidatePlacesFromLLM({
      openaiKey: OPENAI_API_KEY,
      model: OPENAI_MODEL,
      destinationQuery,
      interests,
      ask,
      maxPlaces
    });

    const candidates = Array.isArray(llmJson?.places) ? llmJson.places : [];
    if (!candidates.length) {
      res.status(200).json({
        destination: { query: destinationQuery },
        places: [],
        meta: { generated_at: new Date().toISOString(), cache_hit: false }
      });
      return;
    }

    // 2) Geocode destination to get a loose bbox (optional but helpful)
    const destGeo = await mapboxGeocode({
      token: MAPBOX_TOKEN,
      query: destinationQuery,
      limit: 1,
      types: "place,region,country"
    });

    const destBbox = destGeo?.features?.[0]?.bbox || null;

    // 3) Geocode each candidate place name + destination
    const geocoded = [];
    for (const c of candidates.slice(0, maxPlaces)) {
      const name = (c?.name || "").trim();
      if (!name) continue;

      const q = `${name}, ${destinationQuery}`;
      const r = await mapboxGeocode({
        token: MAPBOX_TOKEN,
        query: q,
        limit: 1,
        types: "poi,neighborhood,place,address",
        bbox: destBbox
      });

      const f = r?.features?.[0];
      if (!f || !Array.isArray(f.center) || f.center.length !== 2) continue;

      const [lng, lat] = f.center;

      geocoded.push({
        id: safeId(c?.id || slugify(name)),
        name,
        category: safeCategory(c?.category),
        lat,
        lng,
        highlights: safeStringArray(c?.highlights, 6, 80),
        why_go: safeString(c?.why_go, 260),
        time_needed_hours: safeNumber(c?.time_needed_hours, 0.5, 12),
        best_time_of_day: safeEnum(c?.best_time_of_day, ["morning","afternoon","evening","late_afternoon","night"], "afternoon"),
        tags: safeStringArray(c?.tags, 8, 30),
        confidence: geocodeConfidence(f),
      });
    }

    // 4) Light dedupe by id/name
    const deduped = dedupePlaces(geocoded);

    res.status(200).json({
      destination: {
        query: destinationQuery,
        bbox: destBbox
      },
      places: deduped,
      meta: {
        generated_at: new Date().toISOString(),
        geocode_provider: "mapbox",
        cache_hit: false
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send(err?.message || "Server error");
  }
}

/* ---------------- OpenAI ---------------- */

async function getCandidatePlacesFromLLM({ openaiKey, model, destinationQuery, interests, ask, maxPlaces }) {
  const schemaHint = {
    places: [{
      id: "string_slug",
      name: "string",
      category: "sight|museum|neighborhood|food|viewpoint|day_trip|nature|activity",
      highlights: ["string", "string"],
      why_go: "string",
      time_needed_hours: 1.5,
      best_time_of_day: "morning|afternoon|evening|late_afternoon|night",
      tags: ["string"]
    }]
  };

  const prompt = `
You are generating candidate travel places to pin on a map.
Return ONLY valid JSON. No markdown. No commentary. No coordinates.

Destination: ${destinationQuery}
Interests: ${interests.join(", ") || "none specified"}
User ask: ${ask || "(none)"}
Count: ${maxPlaces}

Rules:
- Output shape must be: { "places": [ ... ] }
- Each place must have: id, name, category, highlights (3-5), why_go (1-2 sentences), time_needed_hours (number), best_time_of_day, tags (1-6)
- Names must be searchable (common/official name). Include neighborhoods if relevant.
- Do NOT include latitude/longitude or addresses.
- Avoid duplicates and overly niche entries.

Example schema (for reference only): ${JSON.stringify(schemaHint)}
`.trim();

  // Using Chat Completions for broad compatibility
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.6,
      messages: [
        { role: "system", content: "You output strict JSON only." },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI error (${resp.status}): ${t || resp.statusText}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "";

  // Parse JSON, with a small tolerance for accidental leading/trailing text
  const parsed = safeJsonParse(extractJsonObject(content));
  if (!parsed) throw new Error("LLM did not return valid JSON.");
  return parsed;
}

/* ---------------- Mapbox Geocoding ---------------- */

async function mapboxGeocode({ token, query, limit = 1, types, bbox }) {
  const url = new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("autocomplete", "false");
  if (types) url.searchParams.set("types", types);
  if (bbox && Array.isArray(bbox) && bbox.length === 4) {
    url.searchParams.set("bbox", bbox.join(","));
  }

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Mapbox geocode error (${resp.status}): ${t || resp.statusText}`);
  }
  return resp.json();
}

function geocodeConfidence(feature) {
  // Heuristic: if result is POI/address with high relevance, score higher.
  // Mapbox provides "relevance" in many responses (0..1). Use it if present.
  const rel = typeof feature?.relevance === "number" ? feature.relevance : null;
  if (rel != null) return clamp(rel, 0, 1);
  // fallback: treat POIs as moderately confident
  const types = feature?.place_type || [];
  if (types.includes("poi")) return 0.78;
  if (types.includes("neighborhood")) return 0.72;
  return 0.65;
}

/* ---------------- Helpers ---------------- */

function dedupePlaces(places) {
  const seen = new Set();
  const out = [];
  for (const p of places) {
    const key = `${(p.id || "").toLowerCase()}|${(p.name || "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function safeCategory(v) {
  const allowed = new Set(["sight","museum","neighborhood","food","viewpoint","day_trip","nature","activity"]);
  const s = String(v || "").trim();
  return allowed.has(s) ? s : "sight";
}

function safeEnum(v, allowed, fallback) {
  const s = String(v || "").trim();
  return allowed.includes(s) ? s : fallback;
}

function safeString(v, maxLen) {
  const s = String(v || "").trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen - 1).trim() : s;
}

function safeStringArray(v, maxItems, maxItemLen) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = safeString(item, maxItemLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function safeNumber(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return clamp(n, min, max);
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64) || "place";
}

function safeId(s) {
  const id = slugify(s);
  return id || `place-${Math.random().toString(16).slice(2)}`;
}

function extractJsonObject(text) {
  const t = String(text || "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
