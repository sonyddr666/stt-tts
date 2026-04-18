// Orquestrador: STT -> LLM -> TTS, com barge-in e anti-feedback.
// Qualquer `stt` precisa expor: on("final"|"interim"|"error"|"state"), start/stop/pause/resume.
// Qualquer `tts` precisa expor: speak(text), stop(), on("start"|"end"|"error"), isPlaying.
// `llm` é uma função async: (messages) => AsyncIterable<string> | string
export class VoiceLoop {
  constructor({
    stt,
    tts,
    llm,
    system = "Você é um assistente de voz em PT-BR. Respostas curtas.",
    bufferMs = 300,          // pausa após TTS antes de religar mic
    bargeIn = true,           // se falar enquanto toca, corta TTS
    stream = true,            // usa streaming do LLM por sentenças
    onTranscript,             // (text, { final }) => void
    onReply,                  // (text, { delta, done }) => void
    onState,                  // (state) => void
    onError,                  // (err) => void
  } = {}) {
    if (!stt || !tts || !llm) throw new Error("VoiceLoop precisa de stt, tts e llm.");
    this.stt = stt; this.tts = tts; this.llm = llm;
    this.bufferMs = bufferMs;
    this.bargeIn = bargeIn;
    this.stream = stream;
    this.hooks = { onTranscript, onReply, onState, onError };
    this.history = [{ role: "system", content: system }];
    this._state = "idle";
    this._unsub = [];
    this._currentAbort = null;
  }

  _setState(s) { this._state = s; this.hooks.onState?.(s); }

  start() {
    this._unsub.push(this.stt.on("interim", (t) => this.hooks.onTranscript?.(t, { final: false })));
    this._unsub.push(this.stt.on("final", (t) => this._handleUser(t)));
    this._unsub.push(this.stt.on("error", (e) => this.hooks.onError?.(e)));
    this.stt.start();
    this._setState("listening");
  }

  stop() {
    for (const u of this._unsub) u();
    this._unsub = [];
    this.stt.stop();
    this.tts.stop();
    this._currentAbort?.abort();
    this._setState("idle");
  }

  // barge-in: se o usuário falou enquanto TTS tocava, corta
  async _handleUser(text) {
    if (!text) return;
    if (this.tts.isPlaying) {
      if (!this.bargeIn) return;
      this.tts.stop();
      this._currentAbort?.abort();
    }

    this.hooks.onTranscript?.(text, { final: true });
    this.history.push({ role: "user", content: text });
    this.stt.pause();
    this._setState("thinking");

    this._currentAbort = new AbortController();
    try {
      if (this.stream) await this._runStream(this._currentAbort.signal);
      else await this._runBlocking(this._currentAbort.signal);
    } catch (e) {
      if (e.name !== "AbortError") this.hooks.onError?.(e);
      this.history.pop();
    } finally {
      this._currentAbort = null;
      await new Promise(r => setTimeout(r, this.bufferMs));
      this.stt.resume();
      this._setState("listening");
    }
  }

  async _runStream(signal) {
    this._setState("speaking");
    let buf = "", full = "";
    const sentenceRe = /^([\s\S]*?[.!?…])\s+/;
    const speakQueue = [];
    let speaking = Promise.resolve();

    const flush = (piece) => {
      if (!piece.trim()) return;
      speakQueue.push(piece);
      speaking = speaking.then(() => this.tts.speak(piece));
    };

    for await (const delta of this.llm(this.history, { signal })) {
      if (typeof delta !== "string") continue;
      buf += delta; full += delta;
      this.hooks.onReply?.(full, { delta, done: false });
      let m;
      while ((m = buf.match(sentenceRe))) { flush(m[1]); buf = buf.slice(m[0].length); }
    }
    if (buf.trim()) flush(buf);
    await speaking;
    this.history.push({ role: "assistant", content: full });
    this.hooks.onReply?.(full, { delta: "", done: true });
  }

  async _runBlocking(signal) {
    const out = this.llm(this.history, { signal });
    const text = typeof out?.then === "function" ? await out : out;
    this.history.push({ role: "assistant", content: text });
    this.hooks.onReply?.(text, { delta: text, done: true });
    this._setState("speaking");
    await this.tts.speak(text);
  }

  reset(system) {
    this.history = [{ role: "system", content: system ?? this.history[0].content }];
  }

  get state() { return this._state; }
  get transcript() { return this.history.slice(1); }
}
