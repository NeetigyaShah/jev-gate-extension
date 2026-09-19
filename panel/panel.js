import { buildQuestions, gateDecision, autoStopReason } from './jev.js';
import { VoiceController, VoiceMachine, DEFAULT_WAKE_WORDS } from './voice.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const pendingEl = $('pending');
const statusEl = $('status');
const elementsEl = $('elements');
const countEl = $('count');
let running = false;
let skill = [];
let history = [];

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

function log(msg, first = false) {
  const div = document.createElement('div');
  div.className = 'step' + (first ? ' first' : '');
  div.textContent = msg;
  logEl.prepend(div);
}

function showElements(snap) {
  const els = snap.elements || [];
  countEl.textContent = String(els.length);
  elementsEl.textContent = els.slice(0, 80)
    .map((e) => `[${e.id}] ${e.tag} role=${e.role || '-'} text=${(e.text || '').slice(0, 60)}`)
    .join('\n') || '(no controls found)';
}

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

function doneThreshold() {
  const v = Number($('doneThreshold')?.value);
  return Number.isFinite(v) && v >= 0.5 && v <= 0.99 ? v : 0.8;
}

chrome.storage.local.get(['jevKey', 'orKey', 'textModel', 'doneThreshold']).then((s) => {
  if (s.jevKey) $('key').value = s.jevKey;
  if (s.orKey) $('orkey').value = s.orKey;
  if (s.textModel) $('textmodel').value = s.textModel;
  if (s.doneThreshold) $('doneThreshold').value = s.doneThreshold;
});
$('doneThreshold').addEventListener('change', (e) => {
  chrome.storage.local.set({ doneThreshold: doneThreshold() });
  log(`DONE threshold set to ${doneThreshold()}.`);
});
$('key').addEventListener('change', (e) => {
  chrome.storage.local.set({ jevKey: e.target.value.trim() });
  log('TypeSafe key saved locally.');
});
$('orkey').addEventListener('change', (e) => {
  chrome.storage.local.set({ orKey: e.target.value.trim() });
  log('OpenRouter key saved locally.');
});
$('textmodel').addEventListener('change', (e) => {
  chrome.storage.local.set({ textModel: e.target.value.trim() });
  log(`Text model set to ${e.target.value.trim()}.`);
});
$('textprovider').addEventListener('change', (e) => {
  const provider = e.target.value;
  chrome.storage.local.set({ textProvider: provider });
  // Suggest the model that is known to answer directly on this provider.
  const fallback = provider === 'groq' ? 'qwen/qwen3.8-27b' : 'deepseek/deepseek-v4-flash-0731';
  $('textmodel').placeholder = fallback;
  log(`Text model provider set to ${provider}. Default model: ${fallback}.`);
});

$('orcheck').onclick = async () => {
  const model = $('ormodel').value;
  setStatus(`Checking ${model} on OpenRouter…`);
  const res = await send('OR_CHECK', { model });
  if (res?.ok) {
    setStatus(`Jev is live: ${res.model} (noul=${res.answers?.ok?.noul})`, 'ok');
    log(`OpenRouter Jev check ok: model=${res.model} answers=${JSON.stringify(res.answers)} cost=${res.usage?.cost}`, true);
  } else {
    setStatus(`Jev check failed: ${res?.error}`, 'err');
    log(`OpenRouter Jev check failed: ${res?.error}`, true);
  }
};

async function snapshotOnly() {
  setStatus('Snapshotting…');
  const snap = await send('SNAPSHOT');
  if (!snap?.ok) {
    setStatus(`Snapshot failed: ${snap?.error}`, 'err');
    log(`Snapshot failed: ${snap?.error}.`, true);
    return null;
  }
  showElements(snap.snapshot);
  setStatus(`Snapshot ok: ${snap.snapshot.elements.length} controls.`, 'ok');
  log(`Snapshot: ${snap.snapshot.elements.length} controls on ${snap.snapshot.title || snap.snapshot.url}`, true);
  return snap.snapshot;
}

// One observe -> decide -> gate -> act cycle. Returns the history entry.
async function cycle() {
  const goal = $('goal').value.trim();
  if (!goal) {
    log('Set a goal first.', true);
    return { verdict: 'blocked', error: 'no-goal' };
  }
  setStatus('Thinking…');
  const snap = await send('SNAPSHOT');
  if (!snap?.ok) {
    setStatus(`Snapshot failed: ${snap?.error}`, 'err');
    log(`Snapshot failed: ${snap?.error}.`, true);
    return { verdict: 'blocked', execOk: false };
  }
  showElements(snap.snapshot);
  const els = snap.snapshot.elements;
  log(`Snapshot: ${els.length} controls on ${snap.snapshot.title || snap.snapshot.url}`);
  const questions = buildQuestions(els, goal);
  const state = {
    goal,
    url: snap.snapshot.url,
    page_text: snap.snapshot.text,
    recent_actions: history.slice(-6).map((h, i, arr) =>
      `${arr.length - i}. ${h.op}[${h.target ?? '-'}] -> ${h.verdict}${h.execOk === false ? ' (no effect)' : ''}`),
    elements: els.slice(0, 60).map((e) => `[${e.id}] ${e.tag} role=${e.role} text=${e.text} value=${e.value}`),
  };
  const res = await send('JEV_DECIDE', { payload: { state, questions } });
  if (!res?.ok) {
    setStatus(`Jev failed: ${res?.error}`, 'err');
    log(`Jev failed: ${res?.error}`, true);
    return { verdict: 'blocked', execOk: false };
  }
  const verdict = gateDecision(res.answers, { doneThreshold: doneThreshold() });
  const op = res.answers.operation;
  const entry = {
    op: op?.choice,
    target: verdict.action?.target ?? null,
    verdict: verdict.verdict,
    execOk: null,
  };
  setStatus(`Jev: ${op?.choice} (${((op?.confidence ?? 0) * 100).toFixed(0)}%) → ${verdict.verdict}`, verdict.verdict === 'auto' || verdict.verdict === 'done' ? 'ok' : '');
  log(`Jev: op=${op?.choice} conf=${(op?.confidence ?? 0).toFixed(2)} verdict=${verdict.verdict}`);

  if (verdict.verdict === 'done') {
    log(`DONE verified (done_check=${verdict.confidence?.toFixed?.(2)}).`);
    persistSkill(goal, 'done');
    return entry;
  }
  if (verdict.verdict === 'blocked') {
    log('Blocked: no valid action on this page.');
    return entry;
  }
  if (verdict.verdict === 'reobserve') {
    log(`Skipped: ${verdict.reason}.`);
    return entry;
  }
  if (verdict.verdict === 'approve') {
    return await askApproval(verdict.action, goal, entry);
  }
  await runAction(verdict.action, goal, entry);
  return entry;
}

async function resolveText(action, goal) {
  if (action.op !== 'TYPE_TEXT' || action.text) return action.text;
  setStatus('Writing value…');
  const recent = history.map((h) => `${h.op}[${h.target}]`).join(' ');
  const gen = await send('TEXT_GEN', { payload: { goal, field: `[${action.target}]`, recent } });
  if (gen?.ok) {
    log(`Text model (${gen.model}) wrote "${gen.text}"`);
    return gen.text;
  }
  log(`Text model unavailable (${gen?.error}) — type the value in the card.`);
  return null;
}

async function runAction(action, goal, entry) {
  if (action.target == null) {
    log('No target — skipping.');
    if (entry) entry.execOk = false;
    return;
  }
  action.text = await resolveText(action, goal);
  if (action.op === 'TYPE_TEXT' && !action.text) {
    if (entry) entry.execOk = false;
    return askApproval(action, goal, entry, 'type-value');
  }
  setStatus(`Executing ${action.op} [${action.target}]…`);
  const res = await send('EXECUTE', { action });
  if (entry) entry.execOk = Boolean(res?.ok);
  setStatus(res?.ok ? 'Executed.' : `Failed: ${res?.error}`, res?.ok ? 'ok' : 'err');
  log(`Execute ${action.op} [${action.target}]${action.text ? ` "${action.text}"` : ''}: ${res?.ok ? 'ok' : 'FAILED ' + res?.error}`);
  persistSkill(goal, `${action.op}[${action.target}]`);
}

// Inline approval card: editable value field for TYPE_TEXT (never a native
// prompt, which blocks the panel and stalls Auto).
function askApproval(action, goal, entry, mode = 'act') {
  pendingEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'pending';
  const span = document.createElement('span');
  span.textContent = mode === 'type-value'
    ? `${action.op} [${action.target}] needs a value`
    : `Approve ${action.op} [${action.target}]? op ${((action.opConfidence ?? 0) * 100).toFixed(0)}% tgt ${((action.targetConfidence ?? 0) * 100).toFixed(0)}% risk ${action.risk ?? '?'}`;
  const input = document.createElement('input');
  input.placeholder = 'value to type';
  input.value = action.text || '';
  input.style.display = action.op === 'TYPE_TEXT' ? 'block' : 'none';
  const btn = document.createElement('button');
  btn.textContent = mode === 'type-value' ? 'Type' : 'Approve';
  btn.onclick = async () => {
    if (action.op === 'TYPE_TEXT') {
      const v = input.value.trim();
      if (!v) return;
      action.text = v;
    }
    pendingEl.innerHTML = '';
    await runAction(action, goal, entry);
  };
  const no = document.createElement('button');
  no.textContent = 'Skip';
  no.onclick = () => {
    pendingEl.innerHTML = '';
    if (entry) entry.execOk = false;
    setStatus('Skipped by user.');
    log('Skipped by user.');
  };
  div.append(span, input, btn, no);
  pendingEl.append(div);
}

function persistSkill(goal, step) {
  skill.push({ goal, step, at: Date.now() });
  chrome.storage.local.set({ skill: skill.slice(-200) });
}

$('snap').onclick = snapshotOnly;
$('step').onclick = async () => {
  const entry = await cycle();
  history.push(entry);
};

// Shared by the Auto button and by voice commands.
async function runAuto() {
  if (running) return null;
  running = true;
  history = [];
  setStatus('Auto-running… (Stop to halt)');
  log('Auto-run started.');
  let reason = null;
  while (running) {
    const entry = await cycle();
    history.push(entry);
    reason = autoStopReason(history);
    if (reason) break;
    await new Promise((r) => setTimeout(r, 1400));
  }
  const halted = !running && !reason;
  running = false;
  if (reason) {
    setStatus(`Auto-run stopped: ${reason}`, reason === 'done' ? 'ok' : '');
    log(`Auto-run stopped: ${reason} after ${history.length} step(s).`, true);
  } else if (halted) {
    setStatus('Auto-run halted by user.');
    log(`Auto-run halted by user after ${history.length} step(s).`, true);
  }
  return reason;
}

$('auto').onclick = () => runAuto();
$('stop').onclick = () => {
  running = false;
  setStatus('Stopped.');
};

// ---------------------------------------------------------------- voice ----

const machine = new VoiceMachine({
  wakeWords: DEFAULT_WAKE_WORDS,
  silenceMs: 2000,
});

const voice = new VoiceController({
  machine,
  onEvent: onVoiceEvent,
  onStatus: onVoiceStatus,
});

function voiceFlag(id) {
  return Boolean($(id)?.checked);
}

function setVoiceState(state, text) {
  const dot = $('vdot');
  dot.className = 'vdot' + (state === 'off' ? '' : state === 'armed' ? ' armed' : ' live');
  $('vtext').textContent = text;
  $('voice').textContent = state === 'off' ? 'Listen' : 'Stop';
}

function onVoiceStatus(s) {
  if (s.state === 'off') setVoiceState('off', 'Voice off');
  else if (s.state === 'idle') setVoiceState('idle', `Listening for "${wakeWords()[0]}"…`);
  else if (s.state === 'armed') setVoiceState('armed', 'Listening for the goal…');
  else if (s.state === 'error') { setVoiceState('off', s.error); log(s.error); setStatus(s.error, 'err'); }
}

async function onVoiceEvent(ev) {
  if (ev.type === 'wake') {
    log(`Wake word "${ev.heard}" heard.`);
    setStatus('Heard you. What should I do?');
    voice.speak('Yes?', { enabled: voiceFlag('voiceSpeak') && !voiceFlag('voiceAuto') });
    return;
  }
  if (ev.type !== 'command') return;
  let text = ev.text;
  const audio = await ev.audio;
  let b64 = null;
  if (audio && ($('groqkey')?.value || '').trim()) {
    try { b64 = await blobToBase64(audio); } catch { b64 = null; }
  }
  await handleVoiceCommand(text, b64, audio?.type);
}

// Shared by in-panel listening, push to talk, and the 24/7 offscreen listener.
async function handleVoiceCommand(rawText, audioB64, mime) {
  let text = rawText;
  if (audioB64 && ($('groqkey')?.value || '').trim()) {
    setStatus('Transcribing your goal…');
    const stt = await send('STT', { payload: { audioB64, mime: mime || 'audio/webm', lang: sttLang() } });
    if (stt?.ok) {
      log(`Whisper (${stt.model}) heard: "${stt.text}"`);
      text = stt.text;
    } else {
      log(`Whisper unavailable (${stt?.error}) — using Chrome's transcript.`);
    }
  }

  // Chrome's recogniser sometimes returns a fragment like "y". Running a goal
  // that short wastes a cycle and looks broken, so ask again instead.
  const letters = String(text || '').replace(/[^a-z0-9]/gi, '');
  if (letters.length < 3) {
    log(`Heard only "${text}" — that is too short to act on. Say the goal again.`);
    setStatus('Did not catch that. Say the goal again.', 'err');
    voice.speak('Sorry, say that again.', { enabled: voiceFlag('voiceSpeak') });
    machine.beginCapture();
    voice.captureNow();
    setVoiceState('armed', 'Listening for the goal…');
    return;
  }

  log(`Voice goal: "${text}"`);
  $('goal').value = text;
  setStatus(`Voice goal: ${text}`);
  if (!voiceFlag('voiceAuto')) {
    voice.speak('Ready. Press Auto when you want me to run it.', { enabled: voiceFlag('voiceSpeak') });
    return;
  }
  voice.speak('On it.', { enabled: voiceFlag('voiceSpeak') });
  let reason = null;
  try {
    reason = await runAuto();
  } catch (e) {
    log(`Auto-run failed: ${e?.message || e}`);
    setStatus(`Auto-run failed: ${e?.message || e}`, 'err');
  }
  const spoken = reason === 'done' ? 'Done.'
    : reason === 'no-progress' ? 'I stopped. I was going in circles.'
    : reason === 'step-cap' ? 'I stopped. That took too many steps.'
    : reason === 'error-streak' ? 'I stopped. Actions kept failing.'
    : reason === 'blocked' ? 'I stopped. I could not find a next step.'
    : reason ? `I stopped. ${reason}.`
    : 'Stopped.';
  voice.speak(spoken, { enabled: voiceFlag('voiceSpeak') });
}

function wakeWords() {
  const raw = ($('wake')?.value || '').trim();
  const list = raw.split(',').map((w) => w.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_WAKE_WORDS;
}

function sttLang() {
  return ($('sttlang')?.value || 'en').trim().slice(0, 5) || 'en';
}

function silenceMs() {
  const v = Number($('silence')?.value);
  return Number.isFinite(v) && v >= 400 && v <= 10000 ? v : 2000;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// MV3 has no "microphone" manifest permission, so the extension details page has
// no mic toggle. The microphone is a site permission granted to the extension's
// own origin, which lives under Site settings.
function micOrigin() {
  return `chrome-extension://${chrome.runtime.id}`;
}

function micSettingsUrl() {
  return `chrome://settings/content/siteDetails?site=${encodeURIComponent(micOrigin())}`;
}

function micHint(err) {
  const origin = micOrigin();
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return [
      `Microphone was denied for ${origin}.`,
      `Allow it at ${micSettingsUrl()} (Microphone -> Allow).`,
      `Or add ${origin} under chrome://settings/content/microphone.`,
      'On Windows also check Settings > Privacy & security > Microphone.',
      'If no prompt appeared at all, use "Open as tab" and press Listen there.',
    ];
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return ['No microphone device found. Plug one in or enable it in Windows sound settings.'];
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return ['The microphone is busy or blocked by the OS. Close other apps using it and check Windows privacy settings.'];
  }
  return [`Microphone unavailable (${name || 'unknown'}): ${err?.message || err}`];
}

async function micReport() {
  const out = [`Extension origin: ${micOrigin()}`];
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    out.push(`Permission state: ${p.state}`);
  } catch (e) {
    out.push(`Permission query unsupported here: ${e.message}`);
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    out.push('Microphone: working.');
  } catch (e) {
    out.push(...micHint(e));
  }
  return out;
}

function openTab(url) {
  try {
    chrome.tabs.create({ url });
    return true;
  } catch (e) {
    log(`Could not open ${url} (${e.message}). Paste it into the address bar.`);
    return false;
  }
}

$('miccheck').onclick = async () => {
  setStatus('Checking microphone…');
  const lines = await micReport();
  const summary = lines[lines.length - 1];
  for (const l of [...lines].reverse()) log(l);
  const ok = lines.some((l) => l.includes('working'));
  setStatus(ok ? 'Microphone works.' : summary, ok ? 'ok' : 'err');
};

$('micfix').onclick = () => {
  const url = micSettingsUrl();
  log(`Opening ${url}`);
  if (openTab(url)) log('Set Microphone to Allow there, then press Listen again.');
};

$('openTab').onclick = () => {
  openTab(chrome.runtime.getURL('sidepanel.html'));
  log('Opened the panel as a normal tab. Press Listen there: a tab shows the microphone prompt, a side panel may not.');
};

$('voice').onclick = async () => {
  if (voice.running) {
    voice.stop();
    setVoiceState('off', 'Voice off');
    log('Voice stopped.');
    return;
  }
  setVoiceState('idle', 'Starting…');
  try {
    await voice.start();
    log(`Voice listening. Wake words: ${wakeWords().join(', ')}.`);
  } catch (e) {
    const msg = `Voice unavailable: ${e?.message || e}`;
    setVoiceState('off', msg);
    setStatus(msg, 'err');
    for (const line of micHint(e).reverse()) log(line);
  }
};

$('ptt').onclick = async () => {
  if (!voice.running) {
    log('Press Listen first.');
    setStatus('Start listening before using Talk.', 'err');
    return;
  }
  machine.beginCapture();
  voice.captureNow();
  setVoiceState('armed', 'Listening for the goal…');
  setStatus('Listening for the goal…');
};

$('sttlang').addEventListener('change', () => {
  const lang = $('sttlang').value;
  voice.lang = lang.includes('-') ? lang : 'en-IN';
  chrome.storage.local.set({ sttLang: lang });
  log(`Speech language set to ${lang}. Restart listening to apply.`);
});

$('silence').addEventListener('change', () => {
  const ms = silenceMs();
  machine.silenceMs = ms;
  chrome.storage.local.set({ silenceMs: ms });
  log(`Silence before running: ${(ms / 1000).toFixed(1)}s.`);
});

$('wake').value = DEFAULT_WAKE_WORDS.join(', ');
$('wake').addEventListener('change', () => {
  const words = wakeWords();
  machine.setWakeWords(words);
  chrome.storage.local.set({ wakeWords: words });
  log(`Wake words: ${words.join(', ')}`);
  if (voice.running) setVoiceState(machine.listening ? 'armed' : 'idle', machine.listening ? 'Listening for the goal…' : `Listening for "${words[0]}"…`);
});

chrome.storage.local.get(['wakeWords', 'voiceAuto', 'voiceSpeak', 'sttLang', 'silenceMs', 'groqKey', 'sttModel', 'alwaysOn', 'textProvider', 'textModel']).then((s) => {
  if (Array.isArray(s.wakeWords) && s.wakeWords.length) {
    $('wake').value = s.wakeWords.join(', ');
    machine.setWakeWords(s.wakeWords);
  }
  if (s.voiceAuto === false) $('voiceAuto').checked = false;
  if (s.voiceSpeak === false) $('voiceSpeak').checked = false;
  if (s.sttLang) { $('sttlang').value = s.sttLang; voice.lang = s.sttLang; }
  if (s.silenceMs) { $('silence').value = s.silenceMs; machine.silenceMs = s.silenceMs; }
  if (s.groqKey) $('groqkey').value = s.groqKey;
  if (s.sttModel) $('sttmodel').value = s.sttModel;
  if (s.textProvider) $('textprovider').value = s.textProvider;
  if (s.textModel) $('textmodel').value = s.textModel;
  if (s.textProvider === 'openrouter') $('textmodel').placeholder = 'deepseek/deepseek-v4-flash-0731';
  if (s.alwaysOn) {
    // A reload tears down the offscreen document; bring the listener back.
    $('alwaysOn').checked = true;
    send('WAKE_ON', { words: Array.isArray(s.wakeWords) && s.wakeWords.length ? s.wakeWords : wakeWords() }).then((res) => {
      if (res?.ok) setVoiceState('idle', 'Always on · listening for the wake word');
      else {
        $('alwaysOn').checked = false;
        chrome.storage.local.set({ alwaysOn: false });
        setStatus(`Always on failed: ${res?.error}`, 'err');
        log(`Always on failed: ${res?.error}`);
      }
    });
  }
});
$('groqkey').addEventListener('change', (e) => {
  chrome.storage.local.set({ groqKey: e.target.value.trim() });
  log('Groq key saved. Spoken goals are now transcribed by Whisper.');
});
$('sttmodel').addEventListener('change', (e) => {
  chrome.storage.local.set({ sttModel: e.target.value.trim() });
  log(`Whisper model set to ${e.target.value.trim()}.`);
});
$('voiceAuto').addEventListener('change', (e) => chrome.storage.local.set({ voiceAuto: e.target.checked }));
$('voiceSpeak').addEventListener('change', (e) => chrome.storage.local.set({ voiceSpeak: e.target.checked }));

$('alwaysOn').addEventListener('change', async (e) => {
  const on = e.target.checked;
  chrome.storage.local.set({ alwaysOn: on });
  if (on) {
    if (voice.running) {
      voice.stop();
      setVoiceState('off', 'Voice off');
    }
    setStatus('Starting the 24/7 listener…');
    const res = await send('WAKE_ON', { words: wakeWords() });
    if (res?.ok) {
      setVoiceState('idle', 'Always on · listening for the wake word');
      setStatus('Always on. Works with the panel closed.', 'ok');
      log('24/7 listener started in an offscreen document. It keeps listening with the panel closed.');
    } else {
      e.target.checked = false;
      setVoiceState('off', 'Voice off');
      setStatus(`Always on failed: ${res?.error}`, 'err');
      log(`Always on failed: ${res?.error}`);
    }
  } else {
    await send('WAKE_OFF');
    setVoiceState('off', 'Voice off');
    setStatus('Always on stopped.');
    log('24/7 listener stopped.');
  }
});

// Messages from the offscreen listener, relayed by the service worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'VOICE_STATUS' && $('alwaysOn')?.checked) {
    if (msg.state === 'idle') setVoiceState('idle', 'Always on · listening for the wake word');
    else if (msg.state === 'armed') setVoiceState('armed', 'Listening for the goal…');
    else if (msg.state === 'off') setVoiceState('off', 'Voice off');
    else if (msg.state === 'error') { setVoiceState('off', msg.error || 'Voice error'); log(msg.error || 'Voice error'); }
    return;
  }
  if (msg?.type === 'VOICE_WAKE_UI') {
    log(`Wake word "${msg.heard}" heard with the panel closed. UI opened as: ${msg.opened}.`);
    if (String(msg.opened).startsWith('failed')) {
      log('Chrome refused to open the panel. Press Ctrl+Shift+J (or click the toolbar icon) to open it manually.');
    }
    return;
  }
  if (msg?.type === 'VOICE_TOO_SHORT') {
    log(`Heard only "${msg.text}" while closed — ignored.`);
    return;
  }
  if (msg?.type === 'VOICE_COMMAND_READY') {
    handleVoiceCommand(msg.text, null, null);
  }
});

// A goal spoken while this panel was closed is held by the service worker.
send('GET_PENDING').then((res) => {
  if (res?.command) {
    log(`Picked up the goal heard while closed: "${res.command}"`);
    handleVoiceCommand(res.command, null, null);
  }
});

log('Panel loaded.');
setStatus('Ready.');
