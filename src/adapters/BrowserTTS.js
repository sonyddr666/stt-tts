// TTS nativo do browser (SpeechSynthesis). Zero key, zero latência de rede.
// Qualidade varia por OS. Não funciona em Node.
export class BrowserTTS {
  static available() { return typeof window !== "undefined" && !!window.speechSynthesis; }

  constructor({ voiceName, lang = "pt-BR", rate = 1, pitch = 1, volume = 1 } = {}) {
    if (!BrowserTTS.available()) throw new Error("SpeechSynthesis indisponível.");
    this.synth = window.speechSynthesis;
    this.lang = lang;
    this.rate = rate; this.pitch = pitch; this.volume = volume;
    this.voiceName = voiceName;
    this._voice = null;
    this._handlers = { start: new Set(), end: new Set(), error: new Set() };
    this._loadVoice();
    this.synth.onvoiceschanged = () => this._loadVoice();
  }
  _emit(e, d) { for (const h of this._handlers[e]) { try { h(d); } catch {} } }
  on(e, h) { this._handlers[e].add(h); return () => this._handlers[e].delete(h); }

  _loadVoice() {
    const all = this.synth.getVoices();
    this._voice = (this.voiceName && all.find(v => v.name === this.voiceName))
      ?? all.find(v => v.lang === this.lang)
      ?? all[0] ?? null;
  }

  voices() {
    return this.synth.getVoices().map(v => ({
      id: v.name, name: v.name, lang: v.lang, local: v.localService, default: v.default,
    }));
  }
  async listVoices() { return this.voices(); }
  setVoice(name) { this.voiceName = name; this._loadVoice(); return this; }

  speak(texto) {
    return new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(texto);
      u.lang = this.lang; u.rate = this.rate; u.pitch = this.pitch; u.volume = this.volume;
      if (this._voice) u.voice = this._voice;
      u.onstart = () => this._emit("start", { texto });
      u.onend = () => { this._emit("end", { texto }); resolve(); };
      u.onerror = (e) => { this._emit("error", e); reject(e); };
      this.synth.speak(u);
    });
  }
  stop() { try { this.synth.cancel(); } catch {} }
  get isPlaying() { return this.synth.speaking; }
}
