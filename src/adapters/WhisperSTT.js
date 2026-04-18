// STT via servidor (OpenAI Whisper ou compatível). Grava áudio do mic e envia blob.
// Usa MediaRecorder no browser. Server-side precisa receber e chamar a API Whisper.
export class WhisperSTT {
  static available() {
    return typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && navigator.mediaDevices?.getUserMedia;
  }

  constructor({ endpoint = "/api/transcribe", lang = "pt", chunkMs = 3000 } = {}) {
    if (!WhisperSTT.available()) throw new Error("MediaRecorder/mic indisponível.");
    this.endpoint = endpoint;
    this.lang = lang;
    this.chunkMs = chunkMs;
    this.wantOn = false;
    this.paused = false;
    this.rec = null;
    this.stream = null;
    this._handlers = { final: new Set(), interim: new Set(), error: new Set(), state: new Set() };
  }
  _emit(e, d) { for (const h of this._handlers[e]) { try { h(d); } catch {} } }
  on(e, h) { this._handlers[e].add(h); return () => this._handlers[e].delete(h); }

  async _ensureStream() {
    if (!this.stream) this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  }

  async _transcribe(blob) {
    const form = new FormData();
    form.append("file", blob, "chunk.webm");
    form.append("language", this.lang);
    const res = await fetch(this.endpoint, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Whisper ${res.status}`);
    const { text } = await res.json();
    return text;
  }

  async start() {
    this.wantOn = true;
    await this._ensureStream();
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    const chunks = [];
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    this.rec.onstop = async () => {
      if (!chunks.length) return;
      const blob = new Blob(chunks.splice(0), { type: this.rec.mimeType });
      try { const text = await this._transcribe(blob); if (text) this._emit("final", text.trim()); }
      catch (e) { this._emit("error", e.message); }
      if (this.wantOn && !this.paused) this._loop();
    };
    this._emit("state", "listening");
    this._loop();
  }

  _loop() {
    if (!this.wantOn || this.paused) return;
    this.rec.start();
    setTimeout(() => { try { this.rec.state === "recording" && this.rec.stop(); } catch {} }, this.chunkMs);
  }

  stop() { this.wantOn = false; try { this.rec?.stop(); } catch {} this.stream?.getTracks().forEach(t => t.stop()); this.stream = null; this._emit("state", "stopped"); }
  pause() { this.paused = true; try { this.rec?.stop(); } catch {} this._emit("state", "paused"); }
  resume() { this.paused = false; if (this.wantOn) this._loop(); this._emit("state", "listening"); }
  get state() { return this.wantOn ? (this.paused ? "paused" : "listening") : "stopped"; }
}
