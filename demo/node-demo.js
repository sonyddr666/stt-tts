// Demo Node: lista vozes Inworld via API e gera 1 MP3 de teste.
// Uso: INWORLD_KEY=... node demo/node-demo.js [voiceId]
import fs from "node:fs";
import { InworldTTS } from "../src/adapters/InworldTTS.js";

const key = process.env.INWORLD_KEY;
if (!key) { console.error("Defina INWORLD_KEY"); process.exit(1); }

const tts = new InworldTTS({ apiKey: key });

console.log("\n=== vozes curadas (offline) ===");
tts.voices().forEach(v => console.log(`  ${v.id.padEnd(12)} ${v.gender.padEnd(7)} ${v.accent.padEnd(7)} ${v.desc}`));

console.log("\n=== vozes via API ===");
const apiVoices = await tts.listVoices();
apiVoices.slice(0, 20).forEach(v => console.log(`  ${String(v.id).padEnd(24)} ${String(v.name).padEnd(16)} ${v.accent ?? ""}`));

const voice = process.argv[2] ?? "Sarah";
tts.setVoice(voice);
console.log(`\n=== gerando MP3 com voz "${voice}" ===`);
tts.on("start", ({ bytes }) => {
  if (bytes) { fs.writeFileSync("out.mp3", bytes); console.log("salvo: out.mp3 (" + bytes.length + " bytes)"); }
});
await tts.speak("Olá! Esta é uma demonstração do voice chat kit em português.");
console.log("pronto.");
