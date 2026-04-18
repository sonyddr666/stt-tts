// TTS via Inworld. Chame `listVoices()` pra listar; `voices()` pra estática curada.
// Em produção, passe `endpoint` apontando pro seu proxy server (NÃO exponha a key no browser).

const DEFAULT_ENDPOINT = "https://api.inworld.ai/tts/v1/voice";
const DEFAULT_STREAM = "https://api.inworld.ai/tts/v1/voice:stream";
const VOICES_ENDPOINT = "https://api.inworld.ai/tts/v1/voices";

// Lista curada de vozes conhecidas. Use listVoices() pra buscar tudo via API.
export const KNOWN_VOICES = [
  { id: "Alex",     gender: "male",   accent: "en-US", desc: "Neutro, narrativo" },
  { id: "Ashley",   gender: "female", accent: "en-US", desc: "Jovem, energética" },
  { id: "Dennis",   gender: "male",   accent: "en-US", desc: "Grave, maduro" },
  { id: "Edward",   gender: "male",   accent: "en-GB", desc: "Britânico formal" },
  { id: "Hades",    gender: "male",   accent: "en-US", desc: "Profundo, vilão" },
  { id: "Julia",    gender: "female", accent: "en-US", desc: "Clara, profissional" },
  { id: "Mark",     gender: "male",   accent: "en-US", desc: "Casual, amigável" },
  { id: "Olivia",   gender: "female", accent: "en-GB", desc: "Britânica suave" },
  { id: "Priya",    gender: "female", accent: "en-IN", desc: "Indiana clara" },
  { id: "Ronald",   gender: "male",   accent: "en-US", desc: "Autoritário" },
  { id: "Sarah",    gender: "female", accent: "en-US", desc: "Default, neutra" },
  { id: "Shaun",    gender: "male",   accent: "en-AU", desc: "Australiano" },
  { id: "Theodore", gender: "male",   accent: "en-US", desc: "Velho sábio" },
  { id: "Timothy",  gender: "male",   accent: "en-US", desc: "Narrador jovem" },
  { id: "Wendy",    gender: "female", accent: "en-US", desc: "Animada" },
];

export class InworldTTS {
  constructor({
    apiKey,
    voiceId = "Sarah",
    modelId = "inworld-tts-1.5-max",
    endpoint = DEFAULT_ENDPOINT,
    streamEndpoint = DEFAULT_STREAM,
    voicesEndpoint = VOICES_ENDPOINT,
    headers = {},
    AudioCtor,
  } = {}) {
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.modelId = modelId;
    this.endpoint = endpoint;
    this.streamEndpoint = streamEndpoint;
    this.voicesEndpoint = voicesEndpoint;
    this.headers = headers;
    this.Audio = AudioCtor ?? (typeof Audio !== "undefined" ? Audio : null);

    this.queue = [];
    this.current = null;
    this.playing = false;
    this._handlers = { start: new Set(), end: new Set(), error: new Set() };
  }

  _emit(e, d) { for (const h of this._handlers[e]) { try { h(d); } catch {} } }
  on(e, h) { this._handlers[e].add(h); return () => this._handlers[e].delete(h); }

  _authHeaders() {
    const h = { "Content-Type": "application/json", ...this.headers };
    if (this.apiKey) h.Authorization = `Basic ${this.apiKey}`;
    return h;
  }

  // Lista de vozes curada (offline, sem request).
  voices() { return [...KNOWN_VOICES]; }

  // Busca vozes da API. Em browser sem proxy precisa da apiKey; idealmente chame no backend.
  async listVoices() {
    try {
      const res = await fetch(this.voicesEndpoint, { headers: this._authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // resposta tentativa: { voices: [{ voiceId, displayName, languageCodes, ... }] }
      const list = data.voices ?? data ?? [];
      if (Array.isArray(list) && list.length) return list.map(v => ({
        id: v.voiceId ?? v.id ?? v.name,
        name: v.displayName ?? v.name ?? v.voiceId,
        gender: v.gender ?? "",
        accent: (v.languageCodes?.[0]) ?? v.language ?? "",
        desc: v.description ?? "",
      }));
      return KNOWN_VOICES;
    } catch (e) {
      this._emit("error", `listVoices falhou, usando curada: ${e.message}`);
      return KNOWN_VOICES;
    }
  }

  setVoice(voiceId) {
    this.voiceId = voiceId;
    return this;
  }

  setModel(modelId) {
    this.modelId = modelId;
    return this;
  }

  async _fetchMp3(texto, signal) {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this._authHeaders(),
      body: JSON.stringify({
        voiceId: this.voiceId,
        modelId: this.modelId,
        text: texto,
        audioConfig: { audioEncoding: "MP3", sampleRateHertz: 24000 },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Inworld ${res.status}: ${await res.text()}`);
    const { audioContent } = await res.json();
    const bytes = Uint8Array.from(atob(audioContent), c => c.charCodeAt(0));
    return bytes;
  }

  speak(texto) {
    return new Promise((resolve, reject) => {
      this.queue.push({ texto, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this.playing || !this.queue.length) return;
    this.playing = true;
    const { texto, resolve, reject } = this.queue.shift();
    const ctrl = new AbortController();
    try {
      const bytes = await this._fetchMp3(texto, ctrl.signal);
      if (!this.Audio) {
        // ambiente node: emite bytes, não reproduz
        this._emit("start", { texto, bytes });
        this._emit("end", { texto });
        resolve(); this._next(); return;
      }
      const blob = new Blob([bytes], { type: "audio/mp3" });
      const url = URL.createObjectURL(blob);
      const audio = new this.Audio(url);
      this.current = { audio, abort: () => ctrl.abort() };
      this._emit("start", { texto });
      audio.onended = () => { URL.revokeObjectURL(url); this._emit("end", { texto }); resolve(); this._next(); };
      audio.onerror = (e) => { URL.revokeObjectURL(url); this._emit("error", e); reject(e); this._next(); };
      await audio.play();
    } catch (e) { this._emit("error", e); reject(e); this._next(); }
  }

  _next() { this.current = null; this.playing = false; this._drain(); }

  stop() {
    this.queue = [];
    if (this.current) {
      this.current.abort?.();
      try { this.current.audio.pause(); this.current.audio.currentTime = 0; } catch {}
      this.current = null;
    }
    this.playing = false;
  }

  get isPlaying() { return this.playing; }
}
