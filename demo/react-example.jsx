// Exemplo React usando o hook. Só cola num app Vite/Next com react>=18.
import React, { useEffect, useState } from "react";
import { useVoiceChat } from "voice-chat-kit/hooks/react";

// LLM: fetch SSE de um backend qualquer (aqui o proxy deste pacote).
async function* llm(messages, { signal } = {}) {
  const last = [...messages].reverse().find(m => m.role === "user")?.content;
  const r = await fetch("/llm/chat/react-demo", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: last }), signal,
  });
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n"); buf = parts.pop();
    for (const ev of parts) {
      const data = JSON.parse(ev.replace(/^data: /, ""));
      if (data.done) return;
      if (data.delta) yield data.delta;
    }
  }
}

export default function VoiceChat() {
  const [voices, setVoices] = useState([]);
  const [voiceId, setVoiceId] = useState("Sarah");

  useEffect(() => {
    fetch("/tts/voices?provider=inworld").then(r => r.json()).then(d => setVoices(d.voices ?? []));
  }, []);

  // Nota: ProxyTTS (inline abaixo) reusa o backend pra esconder a chave.
  const tts = useInlineProxyTTS(voiceId);

  const { state, transcript, interim, reply, start, stop } = useVoiceChat({
    stt: "web-speech",
    tts, // passa instância já criada
    llm,
    sttOptions: { lang: "pt-BR" },
    system: "Você é um assistente de voz em PT-BR. Curto e direto.",
    autoStart: false,
  });

  return (
    <div style={{ padding: 20, fontFamily: "system-ui" }}>
      <h2>Voice Chat (React)</h2>
      <select value={voiceId} onChange={e => setVoiceId(e.target.value)}>
        {voices.map(v => <option key={v.id} value={v.id}>{v.name} — {v.accent}</option>)}
      </select>
      <div>
        <button onClick={start} disabled={state !== "idle"}>🎙 Start</button>
        <button onClick={stop}>■ Stop</button>
        <span> estado: <b>{state}</b></span>
      </div>
      <p style={{ color: "#888" }}>{interim && "🗣 " + interim}</p>
      <p><b>Você:</b> {transcript}</p>
      <p><b>Bot:</b> {reply}</p>
    </div>
  );
}

// helper inline — em projeto real use voice-chat-kit/adapters
import { useRef } from "react";
function useInlineProxyTTS(voiceId) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = {
      isPlaying: false, _q: [], _cur: null, _h: { start: new Set(), end: new Set(), error: new Set() },
      on(e, h) { this._h[e].add(h); return () => this._h[e].delete(h); },
      voiceId,
      speak(text) { return new Promise((res, rej) => { this._q.push({ text, res, rej }); this._drain(); }); },
      async _drain() {
        if (this.isPlaying || !this._q.length) return;
        this.isPlaying = true;
        const { text, res, rej } = this._q.shift();
        try {
          const r = await fetch("/tts", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, voiceId: this.voiceId, provider: "inworld" }),
          });
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          this._cur = audio;
          audio.onended = () => { URL.revokeObjectURL(url); res(); this.isPlaying = false; this._drain(); };
          audio.onerror = rej;
          await audio.play();
        } catch (e) { rej(e); this.isPlaying = false; this._drain(); }
      },
      stop() { this._q = []; try { this._cur?.pause(); } catch {} this.isPlaying = false; },
    };
  }
  ref.current.voiceId = voiceId;
  return ref.current;
}
