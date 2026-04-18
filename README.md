# voice-chat-kit (stt-tts)

Kit modular de voz para browser/Node. Três camadas desacopladas:

```
STTAdapter  →  VoiceLoop (orquestrador)  →  TTSAdapter
                       ↓
                  LLM (qualquer)
```

Adapters intercambiáveis, barge-in embutido, seletor de vozes via API, proxy server pra esconder chaves, hook React pronto, demo HTML funcional.

## Estrutura

```
stt-tts/
├── src/
│   ├── VoiceLoop.js           # orquestrador STT→LLM→TTS
│   ├── index.js               # export central + factory
│   ├── adapters/
│   │   ├── WebSpeechSTT.js    # browser nativo (Chrome/Edge)
│   │   ├── WhisperSTT.js      # MediaRecorder → /api/transcribe
│   │   ├── InworldTTS.js      # Inworld + listVoices() + voices()
│   │   ├── ElevenLabsTTS.js   # ElevenLabs + listVoices()
│   │   └── BrowserTTS.js      # SpeechSynthesis nativo
│   └── hooks/
│       └── useVoiceChat.js    # hook React
├── server/
│   └── proxy.js               # esconde chaves + ponte pro llm-codex
└── demo/
    ├── index.html             # demo completo browser
    ├── node-demo.js           # lista vozes + gera MP3 no Node
    └── react-example.jsx      # exemplo React
```

## Quickstart

### 1. Demo completo (browser + LLM Codex)

```bash
cd stt-tts
INWORLD_KEY=sua_key_aqui node server/proxy.js
# abre http://localhost:3002
```

A demo traz: seletor de provider (Inworld/ElevenLabs/Browser), dropdown de **vozes listadas direto da API** com botão "↻" para recarregar, botão de teste de voz, barge-in, streaming por sentença.

### 2. Listar vozes Inworld no Node

```bash
INWORLD_KEY=... node demo/node-demo.js Julia
```

Saída esperada:
```
=== vozes curadas (offline) ===
  Sarah        female  en-US   Default, neutra
  Ashley       female  en-US   Jovem, energética
  ...
=== vozes via API ===
  Sarah-en-US  Sarah            en-US
  ...
=== gerando MP3 com voz "Julia" ===
salvo: out.mp3 (38712 bytes)
```

## API

### `new VoiceLoop({ stt, tts, llm, ... })`

| opção      | descrição |
|------------|-----------|
| `stt`      | Instância com `on`, `start`, `pause`, `resume`, `stop` |
| `tts`      | Instância com `speak(text)`, `stop()`, `on`, `isPlaying` |
| `llm`      | `async function*(messages, {signal})` yielding deltas de string |
| `system`   | Prompt inicial |
| `bargeIn`  | `true` — corta TTS quando usuário fala |
| `stream`   | `true` — fala por sentença conforme LLM streama |
| `bufferMs` | `300` — pausa após TTS antes de religar mic |
| `onState`, `onTranscript`, `onReply`, `onError` | callbacks |

### Listagem de vozes — **todos os TTS expõem:**

```js
tts.voices()          // lista curada estática (offline, instantâneo)
await tts.listVoices() // busca da API — fallback pra curada em erro
tts.setVoice(id)       // troca de voz
tts.setModel(id)       // troca modelo (Inworld/ElevenLabs)
```

Formato uniforme:
```js
{ id, name, gender, accent, desc }
```

### Factory conveniente

```js
import { createVoiceChat } from "voice-chat-kit";

const loop = await createVoiceChat({
  stt: "web-speech",            // ou "whisper"
  tts: "inworld",               // ou "elevenlabs" | "browser"
  sttOptions: { lang: "pt-BR" },
  ttsOptions: { apiKey: KEY, voiceId: "Julia" },
  llm: codexStream,             // async generator
  system: "...",
  bargeIn: true,
});
loop.start();
```

### Hook React

```jsx
import { useVoiceChat } from "voice-chat-kit/hooks/react";

const { state, transcript, interim, reply, start, stop } = useVoiceChat({
  stt: "web-speech", tts: myTTSInstance, llm: myLLM,
  system: "Curto e direto.", autoStart: false,
});
```

Ver [demo/react-example.jsx](demo/react-example.jsx).

## Proxy server

`server/proxy.js` (zero deps, só Node 18+):

- `GET /tts/voices?provider=inworld|elevenlabs` → lista vozes da API
- `POST /tts` `{ text, voiceId, provider }` → MP3 binário
- `POST /api/transcribe` → stub para Whisper (implemente)
- `POST /llm/chat/:sid` → SSE usando `llm-codex` (se instalado ao lado)

**Segurança:** nunca coloque `INWORLD_KEY` no browser. Use este proxy.

## Adapters disponíveis

| Adapter | Runtime | Deps | Custo | Notas |
|---------|---------|------|-------|-------|
| `WebSpeechSTT`   | Chrome/Edge | — | grátis | HTTPS ou localhost obrigatório |
| `WhisperSTT`     | Qualquer browser | backend | pago | Precisa de `/api/transcribe` |
| `InworldTTS`     | Browser + Node | — | ~$5/M chars | 15+ vozes curadas + API |
| `ElevenLabsTTS`  | Browser + Node | — | pago | Multilingual v2 por padrão |
| `BrowserTTS`     | Browser | — | grátis | Qualidade varia por OS |

Todos implementam a mesma interface — trocar é uma linha:
```js
// const tts = new InworldTTS({ apiKey });
const tts = new ElevenLabsTTS({ apiKey });  // funciona igual
```

## Integração com llm-codex

O proxy detecta automaticamente o pacote irmão [../llm-codex/](../llm-codex/) e expõe `/llm/chat/:sid`. Juntos formam um **voice chat completo**:

```
🎙 Mic → WebSpeechSTT → VoiceLoop → CodexClient (gpt-5.4-mini) → InworldTTS → 🔊
                           ↑↓                                              ↓
                      barge-in                                     proxy /tts
```

Veja [demo/index.html](demo/index.html) para o código completo.

## Limitações

1. **Web Speech API** — só Chrome/Edge. Firefox/Safari: trocar pra `WhisperSTT`.
2. **Autoplay** — browsers bloqueiam `audio.play()` antes de interação. A demo resolve porque o usuário clica em "Iniciar".
3. **Eco real em speaker aberto** — use headset. `echoCancellation: true` ajuda no Whisper STT, não no Web Speech.
4. **Inworld API exige key paga** — free tier limitado. Curadas funcionam offline como catálogo de referência.
5. **Sem MediaSource streaming TTS** — o "streaming" aqui é por sentença (latência ~200-400ms pra primeira fala), não chunks MP3 em tempo real.

## Próximos adapters sugeridos

- `OpenAITTS` — tts-1 / tts-1-hd
- `AzureTTS` — Neural voices
- `PiperTTS` — 100% local via WASM
- `VoskSTT` — STT offline no browser

Interface já está pronta — basta implementar `speak/stop/on/voices/listVoices`.
