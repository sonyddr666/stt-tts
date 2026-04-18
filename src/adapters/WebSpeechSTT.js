// Browser-only. Chrome/Edge com HTTPS ou localhost.
export class WebSpeechSTT {
  static available() {
    return typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  constructor({ lang = "pt-BR", continuous = true, interimResults = true } = {}) {
    if (!WebSpeechSTT.available()) throw new Error("Web Speech API indisponível neste browser.");
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.rec = new SR();
    this.rec.lang = lang;
    this.rec.continuous = continuous;
    this.rec.interimResults = interimResults;

    this.wantOn = false;
    this.paused = false;
    this._handlers = { final: new Set(), interim: new Set(), error: new Set(), state: new Set() };

    this.rec.onresult = (ev) => {
      let interim = "", final = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) final += t; else interim += t;
      }
      if (final) this._emit("final", final.trim());
      else if (interim) this._emit("interim", interim);
    };
    this.rec.onerror = (e) => {
      if (e.error === "not-allowed") { this.wantOn = false; this._emit("state", "blocked"); }
      this._emit("error", e.error ?? String(e));
    };
    this.rec.onend = () => {
      this._emit("state", "ended");
      if (this.wantOn && !this.paused) { try { this.rec.start(); } catch {} }
    };
    this.rec.onstart = () => this._emit("state", "listening");
  }

  _emit(evt, data) { for (const h of this._handlers[evt]) { try { h(data); } catch {} } }

  on(evt, handler) {
    if (!this._handlers[evt]) throw new Error(`Evento desconhecido: ${evt}`);
    this._handlers[evt].add(handler);
    return () => this._handlers[evt].delete(handler);
  }

  start()  { this.wantOn = true;  try { this.rec.start(); } catch {} }
  stop()   { this.wantOn = false; try { this.rec.stop();  } catch {} }
  pause()  { this.paused = true;  try { this.rec.stop();  } catch {} }
  resume() { this.paused = false; if (this.wantOn) try { this.rec.start(); } catch {} }
  get state() { return this.wantOn ? (this.paused ? "paused" : "listening") : "stopped"; }
}
