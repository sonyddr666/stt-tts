// ElevenLabs TTS. Mesma interface do InworldTTS (speak/stop/on/voices/listVoices/setVoice).
const API = "https://api.elevenlabs.io/v1";

export const KNOWN_EL_VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel",  gender: "female", desc: "Calma, narrativa (EN)" },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi",    gender: "female", desc: "Forte, confiante" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella",   gender: "female", desc: "Suave, jovem" },
  { id: "ErXwobaYiN019PkySvjV", name: "Antoni",  gender: "male",   desc: "Bem-ajustado" },
  { id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli",    gender: "female", desc: "Emotiva" },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh",    gender: "male",   desc: "Jovem grave" },
  { id: "VR6AewLTigWG4xSOukaG", name: "Arnold",  gender: "male",   desc: "Grave autoritário" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam",    gender: "male",   desc: "Profundo" },
  { id: "yoZ06aMxZJJ28mfd3POQ", name: "Sam",     gender: "male",   desc: "Neutro" },
];

export class ElevenLabsTTS {
  constructor({
    apiKey,
    voiceId = "21m00Tcm4TlvDq8ikWAM",
    modelId = "eleven_multilingual_v2",
    endpoint = API,
    AudioCtor,
    stability = 0.5,
    similarity = 0.75,
  } = {}) {
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.modelId = modelId;
    this.endpoint = endpoint;
    this.stability = stability;
    this.similarity = similarity;
    this.Audio = AudioCtor ?? (typeof Audio !== "undefined" ? Audio : null);

    this.queue = [];
    this.current = null;
    this.playing = false;
    this._handlers = { start: new Set(), end: new Set(), error: new Set() };
  }
  _emit(e, d) { for (const h of this._handlers[e]) { try { h(d); } catch {} } }
  on(e, h) { this._handlers[e].add(h); return () => this._handlers[e].delete(h); }

  _headers() { return { "xi-api-key": this.apiKey ?? "", "Content-Type": "application/json", Accept: "audio/mpeg" }; }

  voices() { return [...KNOWN_EL_VOICES]; }

  async listVoices() {
    try {
      const res = await fetch(`${this.endpoint}/voices`, { headers: { "xi-api-key": this.apiKey ?? "" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { voices } = await res.json();
      return (voices ?? []).map(v => ({
        id: v.voice_id,
        name: v.name,
        gender: v.labels?.gender ?? "",
        accent: v.labels?.accent ?? "",
        desc: v.labels?.description ?? v.description ?? "",
      }));
    } catch (e) { this._emit("error", `listVoices falhou: ${e.message}`); return KNOWN_EL_VOICES; }
  }

  setVoice(id) { this.voiceId = id; return this; }
  setModel(id) { this.modelId = id; return this; }

  async _fetchMp3(texto, signal) {
    const res = await fetch(`${this.endpoint}/text-to-speech/${this.voiceId}`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        text: texto,
        model_id: this.modelId,
        voice_settings: { stability: this.stability, similarity_boost: this.similarity },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  speak(texto) { return new Promise((resolve, reject) => { this.queue.push({ texto, resolve, reject }); this._drain(); }); }

  async _drain() {
    if (this.playing || !this.queue.length) return;
    this.playing = true;
    const { texto, resolve, reject } = this.queue.shift();
    const ctrl = new AbortController();
    try {
      const bytes = await this._fetchMp3(texto, ctrl.signal);
      if (!this.Audio) { this._emit("start", { texto, bytes }); this._emit("end", { texto }); resolve(); this._next(); return; }
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
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
    if (this.current) { this.current.abort?.(); try { this.current.audio.pause(); } catch {} this.current = null; }
    this.playing = false;
  }
  get isPlaying() { return this.playing; }
}
