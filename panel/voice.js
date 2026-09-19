// Voice front end: wake word -> speech to text command -> the existing Auto loop.
//
// VoiceMachine is pure (no microphone, no timers of its own) so the transcript
// handling can be tested directly. VoiceController is the thin browser glue
// around the Web Speech API.

export const DEFAULT_WAKE_WORDS = ['hey jev', 'hey jeff', 'hey jeve', 'jev'];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 1:1 normalisation (one character in, one character out) keeps indices aligned
// with the raw transcript, so a match offset can slice the original text and the
// spoken command keeps its original wording.
function normalise(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
}

// Longest phrase first: "hey jev, open mail" must strip "hey jev", because
// matching the bare "jev" first would leave the command as "hey open mail".
export function wakePattern(words = DEFAULT_WAKE_WORDS) {
  const alts = words
    .map((w) => String(w).trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((w) => w.split(/\s+/).map(esc).join('\\s+'));
  if (!alts.length) return null;
  return new RegExp(`\\b(?:${alts.join('|')})\\b`);
}

export class VoiceMachine {
  constructor({ wakeWords = DEFAULT_WAKE_WORDS, silenceMs = 2000 } = {}) {
    this.wake = wakePattern(wakeWords);
    this.silenceMs = silenceMs;
    this.mode = 'idle';
    this.session = -1;
    this.scanFrom = 0;
    this.consumed = 0;
    this.buffer = '';
    this.scanned = '';
    this.lastText = '';
    this.lastSpeech = 0;
  }

  get listening() {
    return this.mode === 'armed';
  }

  // The recogniser gives a cumulative transcript for the session, so `text`
  // grows (and may be corrected) within one session.
  push(text, { isFinal = false, session = 0, now = Date.now() } = {}) {
    const events = [];
    if (session !== this.session) {
      this.session = session;
      this.scanFrom = 0;
      this.consumed = 0;
    }
    if (typeof text !== 'string' || !text) return events;
    this.lastText = text;
    // A cumulative transcript keeps the prefix it already had; if the prefix
    // changed, the recogniser replaced the transcript and scanning must restart.
    // Compare against the stored length: a short transcript makes it shorter
    // than the cap, and a fixed-width slice would then look like a change.
    if (this.scanned && text.slice(0, this.scanned.length) !== this.scanned) this.scanFrom = 0;
    if (text.length < this.consumed && this.mode === 'armed') this.consumed = text.length;

    if (this.mode === 'armed') {
      const delta = text.slice(this.consumed);
      this.consumed = text.length;
      if (delta.trim()) {
        this.buffer = `${this.buffer} ${delta}`.trim();
        this.lastSpeech = now;
      }
      if (isFinal && this.buffer) events.push(this.finish(text.length));
      return events;
    }

    if (!this.wake) return events;
    const m = this.wake.exec(normalise(text).slice(this.scanFrom));
    this.consumed = text.length;
    if (!m) return events;

    const at = this.scanFrom + m.index;
    this.mode = 'armed';
    this.consumed = text.length;
    this.lastSpeech = now;
    this.buffer = text.slice(at + m[0].length).replace(/^[\s,.!?]+/, '').trim();
    events.push({ type: 'wake', heard: m[0] });
    // "hey jev open the first mail" is one breath: wake and command together.
    if (isFinal && this.buffer) events.push(this.finish(text.length));
    return events;
  }

  // The recogniser can hold an interim result open indefinitely in continuous
  // mode; silence is what actually ends a spoken command.
  tick(now = Date.now()) {
    if (this.mode !== 'armed' || !this.buffer) return [];
    if (now - this.lastSpeech < this.silenceMs) return [];
    return [this.finish()];
  }

  // Push to talk: capture the next utterance without needing the wake word.
  beginCapture(now = Date.now()) {
    this.mode = 'armed';
    this.buffer = '';
    this.lastSpeech = now;
  }

  setWakeWords(words) {
    this.wake = wakePattern(words);
  }

  // A wake phrase must never survive into the command: the recogniser can
  // restart between the wake word and the goal, and the user may simply repeat
  // "hey jev" as they draw breath.
  stripWake(text) {
    if (!this.wake) return text.trim();
    let out = text;
    for (let i = 0; i < 2; i += 1) {
      out = out.replace(/^[\s,.!?]+/, '');
      const m = this.wake.exec(normalise(out).slice(0, 40));
      if (!m || m.index !== 0) break;
      out = out.slice(m[0].length);
    }
    return out.replace(/^[\s,.!?]+/, '').trim();
  }

  finish(at = this.consumed) {
    const text = this.stripWake(this.buffer);
    this.mode = 'idle';
    this.buffer = '';
    this.scanFrom = at;
    this.consumed = at;
    this.scanned = this.lastText.slice(0, 24);
    return { type: 'command', text };
  }

  reset() {
    this.mode = 'idle';
    this.scanFrom = 0;
    this.consumed = 0;
    this.buffer = '';
    this.scanned = '';
  }
}

// Records just the spoken goal so a real STT model can transcribe it. Chrome's
// own recogniser is fine for spotting a wake word but too weak for the command,
// and its transcript cannot be revisited.
//
// The microphone stream stays open for the session (one permission grant), and
// a fresh MediaRecorder is created per command: a WebM stream carries its header
// only in the first chunk, so slicing a rolling buffer would yield undecodable
// audio.
export class AudioCapture {
  constructor() {
    this.stream = null;
    this.rec = null;
    this.chunks = [];
  }

  async openStream() {
    if (this.stream) return this.stream;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return this.stream;
  }

  begin() {
    if (!this.stream || typeof MediaRecorder !== 'function') return;
    this.chunks = [];
    try {
      this.rec = new MediaRecorder(this.stream);
      this.rec.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
      this.rec.start();
    } catch {
      this.rec = null;
    }
  }

  async end() {
    const rec = this.rec;
    this.rec = null;
    if (!rec || rec.state === 'inactive') return null;
    const blob = await new Promise((resolve) => {
      rec.onstop = () => resolve(this.chunks.length ? new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }) : null);
      try { rec.stop(); } catch { resolve(null); }
      setTimeout(() => resolve(this.chunks.length ? new Blob(this.chunks, { type: 'audio/webm' }) : null), 1500);
    });
    this.chunks = [];
    return blob && blob.size > 1200 ? blob : null;
  }

  close() {
    try { this.rec?.stop(); } catch { /* already stopped */ }
    this.rec = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

export class VoiceController {
  constructor({ machine, onEvent = () => {}, onStatus = () => {}, lang = 'en-IN', tickMs = 250 } = {}) {
    this.machine = machine ?? new VoiceMachine();
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.lang = lang;
    this.tickMs = tickMs;
    this.running = false;
    this.paused = false;
    this.session = 0;
    this.rec = null;
    this.timer = null;
    this.restartTimer = null;
    this.capture = new AudioCapture();
  }

  static get available() {
    return Boolean(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition);
  }

  async start() {
    if (!VoiceController.available) throw new Error('This Chrome build has no Web Speech API.');
    // getUserMedia first: it raises the microphone prompt, so a later
    // recogniser failure cannot be mistaken for a permissions problem. The
    // stream is kept for recording the spoken goal.
    await this.capture.openStream();
    this.running = true;
    this.paused = false;
    this.machine.reset();
    this.begin();
    this.timer = setInterval(() => this.emit(this.machine.tick()), this.tickMs);
    this.onStatus({ state: 'idle' });
  }

  begin() {
    const Rec = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    const rec = new Rec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    this.rec = rec;

    rec.onstart = () => {
      this.session += 1;
      this.onStatus({ state: this.machine.listening ? 'armed' : 'idle' });
    };
    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i += 1) text += e.results[i][0].transcript;
      const isFinal = e.results[e.results.length - 1].isFinal;
      this.emit(this.machine.push(text, { isFinal, session: this.session }));
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.running = false;
        this.onStatus({ state: 'error', error: 'Microphone blocked. Allow it for this extension, then start again.' });
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.onStatus({ state: 'error', error: `Speech error: ${e.error}` });
      }
    };
    // Chrome ends continuous recognition on its own; keep it alive.
    rec.onend = () => {
      this.rec = null;
      if (this.running && !this.paused) {
        this.restartTimer = setTimeout(() => { if (this.running && !this.paused) this.begin(); }, 300);
      }
    };
    try {
      rec.start();
    } catch {
      /* already started */
    }
  }

  emit(events) {
    for (const ev of events) {
      if (ev.type === 'wake') {
        this.onStatus({ state: 'armed' });
        this.capture.begin();
      }
      if (ev.type === 'command') {
        this.onStatus({ state: 'idle' });
        // The spoken goal, for transcription by a real STT model.
        ev.audio = this.capture.end();
      }
      this.onEvent(ev);
    }
  }

  // Push to talk without the wake word.
  captureNow() {
    this.capture.begin();
  }

  // Speaking through the speakers while the microphone is open feeds the wake
  // word back into the recogniser, so listening pauses for the reply.
  speak(text, { enabled = true } = {}) {
    if (!enabled || !text) return;
    // A spoken reply is decoration: if the speech engine is missing, blocked or
    // throws, the voice command must still run.
    try {
      if (!globalThis.speechSynthesis || typeof SpeechSynthesisUtterance !== 'function') return;
      this.pause();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      const done = () => this.resume();
      u.onend = done;
      u.onerror = done;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      // onend is not guaranteed; do not stay deaf forever.
      setTimeout(done, Math.min(9000, 700 + text.length * 70));
    } catch {
      this.resume();
    }
  }

  pause() {
    this.paused = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    try { this.rec?.abort(); } catch { /* not started */ }
    this.rec = null;
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.running && !this.rec) this.begin();
  }

  stop() {
    this.running = false;
    this.pause();
    this.paused = false;
    this.capture.close();
    clearInterval(this.timer);
    this.timer = null;
    this.onStatus({ state: 'off' });
  }
}
