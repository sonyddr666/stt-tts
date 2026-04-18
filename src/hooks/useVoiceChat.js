// Hook React. Uso:
//   import { useVoiceChat } from "voice-chat-kit/hooks/react";
// Requer React 18+ como peerDep (não instalado aqui).
import { useEffect, useRef, useState } from "react";
import { createVoiceChat } from "../index.js";

export function useVoiceChat({ stt = "web-speech", tts = "inworld", llm, sttOptions, ttsOptions, system, autoStart = false } = {}) {
  const [state, setState] = useState("idle");
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState(null);
  const loopRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const loop = await createVoiceChat({
          stt, tts, llm, sttOptions, ttsOptions, system,
          onState: (s) => alive && setState(s),
          onTranscript: (t, { final }) => alive && (final ? (setTranscript(t), setInterim("")) : setInterim(t)),
          onReply: (t) => alive && setReply(t),
          onError: (e) => alive && setError(e),
        });
        if (!alive) return;
        loopRef.current = loop;
        if (autoStart) loop.start();
      } catch (e) { alive && setError(e); }
    })();
    return () => { alive = false; loopRef.current?.stop(); };
  }, []); // eslint-disable-line

  return {
    state, transcript, interim, reply, error,
    start: () => loopRef.current?.start(),
    stop: () => loopRef.current?.stop(),
    reset: (sys) => loopRef.current?.reset(sys),
    history: () => loopRef.current?.transcript ?? [],
  };
}
