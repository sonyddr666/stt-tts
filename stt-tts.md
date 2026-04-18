# Manual — STT + TTS em JS (Browser)

> Web Speech API para entrada de voz + Inworld TTS para saída de voz.
> Stack focada em browser com Chrome/Edge. Fluxo: mic → texto → LLM → áudio.

---

## Visão geral

| Componente | Tecnologia | Custo |
|---|---|---|
| STT | Web Speech API nativa | Grátis |
| TTS | Inworld API REST | ~US$5–10/milhão de chars |
| Orquestração | JS vanilla, sem deps | — |

**Fluxo completo:** microfone → transcrição → Codex → resposta em texto → síntese de voz → reprodução → reinicia escuta.

---

## 1. STT — Web Speech API

### Requisitos obrigatórios

- Chrome ou Edge. Firefox e Safari não têm suporte confiável.
- Página servida em `https://` ou `localhost`. `file://` não funciona.
- Permissão de microfone (o browser solicita na primeira vez).
- Contexto browser — não funciona em Node, Electron sem polyfill, ou ambientes CLI.

### Como funciona

O `SpeechRecognition` abre o mic, envia o áudio para os servidores do Google e retorna a transcrição por eventos. O desenvolvedor consome apenas os eventos — não tem acesso direto ao stream de áudio.

### Eventos principais

| Evento | Quando dispara | O que fazer |
|---|---|---|
| `onresult` | A cada fragmento reconhecido | Exibir interim ou processar final |
| `onerror` | Erro de captura, rede ou permissão | Tratar conforme o tipo |
| `onend` | Sempre que o reconhecimento para | Religar se `continuous: true` |

O Chrome pode encerrar a captura sozinho após ~60s de silêncio mesmo com `continuous: true`. O `onend` deve religar automaticamente.

### stt.js — Classe completa

```js
// stt.js
export class STT {
  constructor({ lang = "pt-BR", onFinal, onInterim, onError } = {}) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error("Browser sem Web Speech API");

    this.rec = new SR();
    this.rec.lang           = lang;
    this.rec.continuous     = true;
    this.rec.interimResults = true;

    this.wantOn = false; // estado desejado pelo usuário
    this.paused = false; // pausado temporariamente (TTS falando)

    this.rec.onresult = (ev) => {
      let interim = "";
      let final   = "";

      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const text = ev.results[i][0]?.transcript ?? "";
        if (ev.results[i].isFinal) final   += text;
        else                       interim += text;
      }

      if (final.trim())   onFinal?.(final.trim());
      else if (interim.trim()) onInterim?.(interim.trim());
    };

    this.rec.onerror = (e) => {
      onError?.(e);
      // not-allowed = permissão negada permanentemente; para de tentar
      if (e.error === "not-allowed") this.wantOn = false;
      // outros erros (network, audio-capture, no-speech): onend vai religar
    };

    this.rec.onend = () => {
      if (this.wantOn && !this.paused) {
        try { this.rec.start(); } catch {} // ignora "already started"
      }
    };
  }

  /** Começa a escutar. Religar automático em caso de pausa/queda. */
  start() {
    this.wantOn = true;
    try { this.rec.start(); } catch {}
  }

  /** Para definitivamente. */
  stop() {
    this.wantOn = false;
    try { this.rec.stop(); } catch {}
  }

  /** Pausa temporária (ex.: TTS falando). Não muda wantOn. */
  pause() {
    this.paused = true;
    try { this.rec.stop(); } catch {}
  }

  /** Retoma após pausa. Liga novamente se wantOn === true. */
  resume() {
    this.paused = false;
    if (this.wantOn) {
      try { this.rec.start(); } catch {}
    }
  }
}
```

### Uso básico

```js
import { STT } from "./stt.js";

const stt = new STT({
  onInterim: (text) => ui.showInterim(text),
  onFinal:   (text) => enviarParaLLM(text),
  onError:   (err)  => console.error("STT:", err.error),
});

document.querySelector("#mic").addEventListener("click", () => stt.start());
```

---

## 2. TTS — Inworld API

### Setup

1. Criar conta em `platform.inworld.ai` e gerar API key.
2. Em projeto pessoal/local, pode usar a key direto no frontend.
3. Em web pública, **montar proxy backend** — a key não pode ficar exposta no JS do browser.

### Modelos disponíveis

| Modelo | Uso |
|---|---|
| `inworld-tts-1.5-max` | Melhor qualidade |
| `inworld-tts-1` | Mais barato |

Vozes: `Sarah`, `Ashley` e outras disponíveis na documentação da Inworld.

### Endpoint

```
POST https://api.inworld.ai/tts/v1/voice
Authorization: Basic <API_KEY>
Content-Type: application/json
```

Resposta: JSON com `audioContent` em base64 (MP3).

### tts.js — Classe com fila e cancelamento

```js
// tts.js
export class TTS {
  constructor({
    apiKey,
    voiceId  = "Sarah",
    modelId  = "inworld-tts-1.5-max",
    endpoint = "https://api.inworld.ai/tts/v1/voice",
  }) {
    this.apiKey   = apiKey;
    this.voiceId  = voiceId;
    this.modelId  = modelId;
    this.endpoint = endpoint;

    this.queue   = [];
    this.current = null; // { audio, abort }
    this.playing = false;
  }

  async _fetchAudio(text, signal) {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization:  `Basic ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        voiceId:     this.voiceId,
        modelId:     this.modelId,
        text,
        audioConfig: {
          audioEncoding:   "MP3",
          sampleRateHertz: 24000,
        },
      }),
      signal,
    });

    if (!res.ok) throw new Error(`Inworld ${res.status}: ${await res.text()}`);

    const { audioContent } = await res.json();
    const bytes = Uint8Array.from(atob(audioContent), c => c.charCodeAt(0));
    return new Blob([bytes], { type: "audio/mp3" });
  }

  /** Enfileira texto para fala. Retorna Promise que resolve quando o áudio termina. */
  speak(text) {
    return new Promise((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this.playing || !this.queue.length) return;

    this.playing = true;
    const { text, resolve, reject } = this.queue.shift();
    const ctrl = new AbortController();

    try {
      const blob  = await this._fetchAudio(text, ctrl.signal);
      const url   = URL.createObjectURL(blob);
      const audio = new Audio(url);

      this.current = { audio, abort: () => ctrl.abort() };

      audio.onended = () => {
        URL.revokeObjectURL(url);
        resolve();
        this._next();
      };

      audio.onerror = (err) => {
        URL.revokeObjectURL(url);
        reject(err);
        this._next();
      };

      await audio.play();
    } catch (err) {
      reject(err);
      this._next();
    }
  }

  _next() {
    this.current = null;
    this.playing = false;
    this._drain();
  }

  /** Para a fala atual e limpa a fila. */
  stop() {
    this.queue = [];

    if (this.current) {
      this.current.abort?.();
      this.current.audio.pause();
      this.current.audio.currentTime = 0;
      this.current = null;
    }

    this.playing = false;
  }
}
```

---

## 3. Textos longos — split por sentença

Streaming de áudio chunk a chunk no browser exige `MediaSource`, que é trabalhoso.
A alternativa prática é quebrar o texto em sentenças e processar cada uma em série.
Isso reduz a latência percebida sem complexidade extra.

```js
export function splitSentences(text) {
  return (
    text.match(/[^.!?…]+[.!?…]+|\S+$/g)
        ?.map(s => s.trim())
        .filter(Boolean) ?? [text]
  );
}

export async function speakLong(tts, text) {
  for (const sentence of splitSentences(text)) {
    tts.speak(sentence); // enfileira sem await — toca em ordem
  }
}
```

---

## 4. Orquestração — loop STT → LLM → TTS

### O problema central

Se o TTS reproduz enquanto o mic está aberto, a voz sintetizada
entra de volta no STT e gera loop infinito.

### Solução: pausar STT durante TTS

```
usuário fala
  → onFinal dispara
  → stt.pause()          ← para de ouvir
  → LLM processa
  → tts.speak() aguarda  ← fala a resposta
  → buffer 300ms         ← anti-eco
  → stt.resume()         ← volta a ouvir
```

### voice-loop.js — integração completa

```js
// voice-loop.js
import { STT } from "./stt.js";
import { TTS, speakLong, splitSentences } from "./tts.js";
import { CodexClient } from "./codexClient.js";

const codex = new CodexClient({ model: "gpt-5.4-mini" });
const tts   = new TTS({ apiKey: INWORLD_API_KEY });

const stt = new STT({
  onFinal: async (userText) => {
    try {
      stt.pause();

      const answer = await codex.chat([
        { role: "system", content: "Assistente de voz. Respostas curtas e diretas." },
        { role: "user",   content: userText },
      ]);

      await speakLong(tts, answer);
      await new Promise(resolve => setTimeout(resolve, 300)); // buffer anti-eco
    } catch (err) {
      console.error("Voice loop error:", err);
    } finally {
      stt.resume();
    }
  },
});

// Barge-in: usuário interrompe o assistente com Esc
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    tts.stop();
    stt.resume();
  }
});

stt.start();
```

---

## 5. Streaming de ponta-a-ponta

Para ainda mais velocidade: não espera o Codex terminar a resposta inteira.
Vai acumulando deltas e dispara TTS por sentença completa.
Primeira fala sai em ~1s.

```js
stt.pause();

let buffer = "";

for await (const delta of codex.stream(messages)) {
  if (typeof delta !== "string") continue;

  buffer += delta;

  // dispara quando fecha uma sentença
  const match = buffer.match(/^(.*?[.!?…])\s+/s);
  if (match) {
    const sentence = match[1];
    tts.speak(sentence);
    buffer = buffer.slice(match[0].length);
  }
}

// sobra sem pontuação final
if (buffer.trim()) tts.speak(buffer.trim());
```

---

## 6. Adapter plugável — BrowserVoiceAgent

Para reaproveitamento entre projetos, encapsule num adapter único:

```js
// browserVoiceAgent.js
import { STT }         from "./stt.js";
import { TTS, speakLong } from "./tts.js";

export class BrowserVoiceAgent {
  constructor({ codex, tts, systemPrompt = "Assistente de voz." }) {
    this.codex        = codex;
    this.tts          = tts;
    this.systemPrompt = systemPrompt;
    this.history      = [{ role: "system", content: systemPrompt }];
    this.busy         = false;

    this.stt = new STT({
      onFinal: (text) => this.handleTurn(text),
    });
  }

  start() { this.stt.start(); }
  stop()  { this.tts.stop(); this.stt.stop(); }

  async handleTurn(text) {
    if (this.busy) return;
    this.busy = true;

    try {
      this.stt.pause();
      this.history.push({ role: "user", content: text });

      const answer = await this.codex.chat(this.history);
      this.history.push({ role: "assistant", content: answer });

      await speakLong(this.tts, answer);
      await new Promise(r => setTimeout(r, 300));
    } finally {
      this.busy = false;
      this.stt.resume();
    }
  }
}
```

**Uso:**

```js
import { CodexClient }      from "./codexClient.js";
import { TTS }              from "./tts.js";
import { BrowserVoiceAgent } from "./browserVoiceAgent.js";

const agent = new BrowserVoiceAgent({
  codex:        new CodexClient({ model: "gpt-5.4-mini" }),
  tts:          new TTS({ apiKey: INWORLD_API_KEY }),
  systemPrompt: "Você é um assistente de voz curto e objetivo.",
});

agent.start();
```

---

## 7. Gotchas

### Autoplay bloqueado

`audio.play()` falha sem interação prévia do usuário.
Sempre inicie TTS após um `click` ou `keydown`.
Opcional: tocar um `new Audio()` silencioso no primeiro gesto para "destravar" o contexto de áudio.

### Mic travado por outra aba

Apenas uma aba por vez consegue usar `getUserMedia`.
Se o mic não iniciar, verifique outras abas abertas.

### `recognition.start()` duplicado

Sempre envolva em `try/catch`. Chamar `start()` numa instância já ativa lança `InvalidStateError`.

### Idioma misto

`pt-BR` reconhece mal termos técnicos em inglês.
Não há solução elegante na Web Speech API — alternativa: Whisper via backend.

### Eco com caixa de som

Além de pausar o mic, use headset.
O `getUserMedia` aceita `{ audio: { echoCancellation: true } }`, mas a Web Speech API não
permite passar a `MediaStream` diretamente — o `echoCancellation` não afeta o STT nativo.

### Cache de frases fixas

Saudações, erros e mensagens padrão devem ser cacheados em memória como `Blob` ou `ObjectURL`.
Não repague Inworld para o mesmo texto.

```js
const cache = new Map();

async function speakCached(tts, text) {
  if (!cache.has(text)) {
    // pré-gera e guarda o Blob
    const blob = await tts._fetchAudio(text, new AbortController().signal);
    cache.set(text, blob);
  }
  const url   = URL.createObjectURL(cache.get(text));
  const audio = new Audio(url);
  await audio.play();
}
```

---

## 8. Quando trocar a stack

| Necessidade | Alternativa |
|---|---|
| Firefox / Safari confiável | Whisper (backend) |
| STT offline / sem Google | `whisper.cpp` WASM no browser |
| Voz clonada ou com emoção | ElevenLabs |
| Tudo local sem API key | Piper TTS + Vosk STT |
| Multiambiente (Electron, Node, mobile) | Abstrair STT/TTS por provider interface |

---

## 9. Checklist de integração

- [ ] Página em `https://` ou `localhost`
- [ ] Chrome ou Edge
- [ ] Permissão de microfone liberada
- [ ] API key da Inworld configurada (ou proxy montado)
- [ ] `audio.play()` chamado após gesto do usuário
- [ ] STT pausado antes do TTS falar
- [ ] Buffer de 300ms após TTS antes de retomar STT
- [ ] Barge-in implementado (tts.stop + stt.resume)
- [ ] Cache de frases fixas configurado
- [ ] Fallback para erro de mic (onError tratado)
- [ ] Proxy backend configurado para produção pública
