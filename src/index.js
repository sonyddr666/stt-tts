export { VoiceLoop } from "./VoiceLoop.js";
export { WebSpeechSTT } from "./adapters/WebSpeechSTT.js";
export { WhisperSTT } from "./adapters/WhisperSTT.js";
export { InworldTTS, KNOWN_VOICES as INWORLD_VOICES } from "./adapters/InworldTTS.js";
export { ElevenLabsTTS, KNOWN_EL_VOICES as ELEVENLABS_VOICES } from "./adapters/ElevenLabsTTS.js";
export { BrowserTTS } from "./adapters/BrowserTTS.js";

// Factory conveniente: cria VoiceLoop com nomes de adapters.
export async function createVoiceChat({
  stt = "web-speech",
  tts = "inworld",
  llm,
  sttOptions = {},
  ttsOptions = {},
  ...loopOpts
} = {}) {
  const { VoiceLoop } = await import("./VoiceLoop.js");
  const sttAdapter = typeof stt === "string" ? await buildSTT(stt, sttOptions) : stt;
  const ttsAdapter = typeof tts === "string" ? await buildTTS(tts, ttsOptions) : tts;
  return new VoiceLoop({ stt: sttAdapter, tts: ttsAdapter, llm, ...loopOpts });
}

async function buildSTT(name, opts) {
  switch (name) {
    case "web-speech": { const { WebSpeechSTT } = await import("./adapters/WebSpeechSTT.js"); return new WebSpeechSTT(opts); }
    case "whisper":    { const { WhisperSTT } = await import("./adapters/WhisperSTT.js"); return new WhisperSTT(opts); }
    default: throw new Error(`STT adapter desconhecido: ${name}`);
  }
}
async function buildTTS(name, opts) {
  switch (name) {
    case "inworld":    { const { InworldTTS } = await import("./adapters/InworldTTS.js"); return new InworldTTS(opts); }
    case "elevenlabs": { const { ElevenLabsTTS } = await import("./adapters/ElevenLabsTTS.js"); return new ElevenLabsTTS(opts); }
    case "browser":    { const { BrowserTTS } = await import("./adapters/BrowserTTS.js"); return new BrowserTTS(opts); }
    default: throw new Error(`TTS adapter desconhecido: ${name}`);
  }
}
