// Proxy server: esconde chaves TTS e ponte pro Codex. Serve também o demo estático.
// Uso: INWORLD_KEY=... node server/proxy.js
// Endpoints:
//   GET  /tts/voices?provider=inworld|elevenlabs   -> lista vozes
//   POST /tts                 { text, voiceId, provider }   -> binário MP3
//   POST /api/transcribe      multipart file                 -> { text }  (stub, implemente seu Whisper)
//   POST /llm/chat/:sid       { content }                    -> SSE deltas (reutiliza llm-codex se disponível)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = path.resolve(__dirname, "../demo");

const INWORLD_KEY = process.env.INWORLD_KEY ?? "";
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY ?? "";
const PORT = Number(process.env.PORT ?? 3002);

let codex = null;
try {
  const mod = await import("../../llm-codex/src/index.js");
  codex = new mod.CodexClient({ authPath: process.env.CODEX_AUTH ?? "../Arcana/armazen/auth.json" });
  console.log("[proxy] llm-codex carregado");
} catch (e) { console.warn("[proxy] llm-codex indisponível:", e.message); }

const sessions = new Map();
const inflight = new Map();

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buf = Buffer.concat(chunks);
  const ct = req.headers["content-type"] ?? "";
  if (ct.includes("application/json")) { try { return JSON.parse(buf.toString("utf8")); } catch { return {}; } }
  return buf;
}

async function handleVoices(req, res, url) {
  const provider = url.searchParams.get("provider") ?? "inworld";
  try {
    if (provider === "inworld") {
      if (!INWORLD_KEY) return json(res, 200, { voices: defaultInworld() });
      const r = await fetch("https://api.inworld.ai/tts/v1/voices", { headers: { Authorization: `Basic ${INWORLD_KEY}` } });
      if (!r.ok) return json(res, 200, { voices: defaultInworld() });
      const data = await r.json();
      const list = (data.voices ?? data ?? []).map(v => ({
        id: v.voiceId ?? v.id ?? v.name, name: v.displayName ?? v.name,
        gender: v.gender ?? "", accent: v.languageCodes?.[0] ?? "", desc: v.description ?? "",
      }));
      return json(res, 200, { voices: list.length ? list : defaultInworld() });
    }
    if (provider === "elevenlabs") {
      if (!ELEVENLABS_KEY) return json(res, 400, { error: "ELEVENLABS_KEY não setada" });
      const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ELEVENLABS_KEY } });
      const { voices } = await r.json();
      return json(res, 200, { voices: voices.map(v => ({ id: v.voice_id, name: v.name, gender: v.labels?.gender ?? "", accent: v.labels?.accent ?? "", desc: v.labels?.description ?? "" })) });
    }
    json(res, 400, { error: `provider desconhecido: ${provider}` });
  } catch (e) { json(res, 500, { error: e.message }); }
}

function defaultInworld() {
  return [
    { id: "Sarah",    name: "Sarah",    gender: "female", accent: "en-US", desc: "Default neutra" },
    { id: "Ashley",   name: "Ashley",   gender: "female", accent: "en-US", desc: "Jovem energética" },
    { id: "Alex",     name: "Alex",     gender: "male",   accent: "en-US", desc: "Narrativo" },
    { id: "Dennis",   name: "Dennis",   gender: "male",   accent: "en-US", desc: "Grave maduro" },
    { id: "Edward",   name: "Edward",   gender: "male",   accent: "en-GB", desc: "Britânico formal" },
    { id: "Hades",    name: "Hades",    gender: "male",   accent: "en-US", desc: "Vilão profundo" },
    { id: "Julia",    name: "Julia",    gender: "female", accent: "en-US", desc: "Profissional" },
    { id: "Olivia",   name: "Olivia",   gender: "female", accent: "en-GB", desc: "Britânica suave" },
    { id: "Priya",    name: "Priya",    gender: "female", accent: "en-IN", desc: "Indiana" },
    { id: "Shaun",    name: "Shaun",    gender: "male",   accent: "en-AU", desc: "Australiano" },
    { id: "Theodore", name: "Theodore", gender: "male",   accent: "en-US", desc: "Velho sábio" },
    { id: "Wendy",    name: "Wendy",    gender: "female", accent: "en-US", desc: "Animada" },
  ];
}

async function handleTTS(req, res) {
  const body = await readBody(req);
  const { text, voiceId = "Sarah", provider = "inworld", modelId } = body;
  if (!text) return json(res, 400, { error: "text obrigatório" });
  try {
    let buf;
    if (provider === "inworld") {
      if (!INWORLD_KEY) return json(res, 400, { error: "INWORLD_KEY não setada" });
      const r = await fetch("https://api.inworld.ai/tts/v1/voice", {
        method: "POST",
        headers: { Authorization: `Basic ${INWORLD_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ voiceId, modelId: modelId ?? "inworld-tts-1.5-max", text, audioConfig: { audioEncoding: "MP3", sampleRateHertz: 24000 } }),
      });
      if (!r.ok) return json(res, r.status, { error: await r.text() });
      const { audioContent } = await r.json();
      buf = Buffer.from(audioContent, "base64");
    } else if (provider === "elevenlabs") {
      if (!ELEVENLABS_KEY) return json(res, 400, { error: "ELEVENLABS_KEY não setada" });
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "xi-api-key": ELEVENLABS_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: modelId ?? "eleven_multilingual_v2" }),
      });
      if (!r.ok) return json(res, r.status, { error: await r.text() });
      buf = Buffer.from(await r.arrayBuffer());
    } else { return json(res, 400, { error: `provider desconhecido: ${provider}` }); }

    res.writeHead(200, { "Content-Type": "audio/mpeg", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    res.end(buf);
  } catch (e) { json(res, 500, { error: e.message }); }
}

async function handleChat(req, res, sid) {
  if (!codex) return json(res, 501, { error: "llm-codex não disponível" });
  const body = await readBody(req);
  const { content } = body ?? {};
  if (!content) return json(res, 400, { error: "content obrigatório" });

  const hist = sessions.get(sid) ?? [{ role: "system", content: "Assistente de voz em PT-BR, respostas curtas." }];
  hist.push({ role: "user", content });

  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
    Connection: "keep-alive", "Access-Control-Allow-Origin": "*",
  });

  const ctrl = new AbortController();
  inflight.set(sid, ctrl);
  req.on("close", () => ctrl.abort());

  let full = "";
  try {
    for await (const d of codex.stream(hist, { signal: ctrl.signal })) {
      if (typeof d === "string") { full += d; res.write(`data: ${JSON.stringify({ delta: d })}\n\n`); }
    }
    hist.push({ role: "assistant", content: full });
    sessions.set(sid, hist);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    hist.pop();
  } finally { inflight.delete(sid); res.end(); }
}

function serveStatic(req, res, url) {
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const p = path.join(DEMO_DIR, rel);
  if (!p.startsWith(DEMO_DIR)) return json(res, 403, { error: "forbidden" });
  fs.readFile(p, (err, data) => {
    if (err) return json(res, 404, { error: "não encontrado" });
    const ext = path.extname(p);
    const type = ext === ".html" ? "text/html" : ext === ".js" ? "application/javascript" : ext === ".css" ? "text/css" : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type }); res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Allow-Headers": "*" });
    return res.end();
  }
  if (req.method === "GET"  && url.pathname === "/tts/voices") return handleVoices(req, res, url);
  if (req.method === "POST" && url.pathname === "/tts") return handleTTS(req, res);
  if (req.method === "POST" && url.pathname.startsWith("/llm/chat/")) return handleChat(req, res, url.pathname.split("/").pop());
  if (req.method === "GET") return serveStatic(req, res, url);
  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`voice-chat-kit proxy em http://localhost:${PORT}`);
  console.log(`demo:       http://localhost:${PORT}/`);
  console.log(`voices:     http://localhost:${PORT}/tts/voices?provider=inworld`);
  if (!INWORLD_KEY) console.log("[aviso] defina INWORLD_KEY pra testar TTS Inworld real");
});
