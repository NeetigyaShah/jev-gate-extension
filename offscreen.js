// 24/7 wake listener. Lives in an offscreen document so it keeps running with
// the side panel closed. `runtime` is the only extension API available here, so
// everything else is reported to the service worker, which owns opening the UI.
import { VoiceController, VoiceMachine, DEFAULT_WAKE_WORDS } from './panel/voice.js';

const machine = new VoiceMachine({ wakeWords: DEFAULT_WAKE_WORDS, silenceMs: 2000 });
const voice = new VoiceController({ machine, onEvent: onEvent, onStatus: onStatus });

let wakeWords = DEFAULT_WAKE_WORDS;
let running = false;

function tell(type, extra = {}) {
  chrome.runtime.sendMessage({ type, from: 'offscreen', ...extra }).catch(() => {});
}

function onStatus(s) {
  tell('VOICE_STATUS', { state: s.state, error: s.error });
}

async function onEvent(ev) {
  if (ev.type === 'wake') {
    tell('VOICE_WAKE', { heard: ev.heard });
    return;
  }
  if (ev.type !== 'command') return;
  const audio = await ev.audio;
  let audioB64 = null;
  if (audio) {
    try {
      audioB64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1] || null);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(audio);
      });
    } catch {
      audioB64 = null;
    }
  }
  tell('VOICE_COMMAND', { text: ev.text, audioB64, mime: audio?.type || 'audio/webm' });
}

async function start(words) {
  if (running) return { ok: true, already: true };
  if (!VoiceController.available) return { ok: false, error: 'offscreen-no-speech-api' };
  wakeWords = words?.length ? words : wakeWords;
  machine.setWakeWords(wakeWords);
  try {
    await voice.start();
    running = true;
    tell('VOICE_STATUS', { state: 'idle', words: wakeWords });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.name === 'NotAllowedError' ? 'offscreen-mic-denied' : String(e?.message || e) };
  }
}

function stop() {
  voice.stop();
  running = false;
  tell('VOICE_STATUS', { state: 'off' });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return undefined;
  if (msg.type === 'WAKE_START') { start(msg.words).then(sendResponse); return true; }
  if (msg.type === 'WAKE_STOP') { sendResponse(stop()); return true; }
  if (msg.type === 'WAKE_PING') { sendResponse({ ok: true, running, words: wakeWords }); return true; }
  return undefined;
});

tell('VOICE_STATUS', { state: 'booted' });
