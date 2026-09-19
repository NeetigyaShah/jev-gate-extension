// MV3 service worker: owns side-panel open, per-tab run state, Jev calls.
// Keys live in chrome.storage.local (set from panel), never in source.
const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
// OpenRouter serves decisions-only models (tilde slug, e.g. ~typesafe/jev-latest)
// on a separate endpoint with the same {state, questions} shape.
const OR_DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const OR_DECISIONS_MODEL = '~typesafe/jev-latest';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// A browser restart tears down the offscreen document; restore the 24/7 listener.
chrome.runtime.onStartup.addListener(async () => {
  const { alwaysOn, wakeWords } = await chrome.storage.local.get(['alwaysOn', 'wakeWords']);
  if (alwaysOn) await startWake(wakeWords);
});

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id != null) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

// If the content script is not listening (extension reloaded after page
// load), inject it on demand, then retry once.
async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    const s = String(e);
    const noReceiver = s.includes('Receiving end does not exist') || s.includes('Could not establish connection');
    if (!noReceiver) return { ok: false, error: s };
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['content/snapshot.js'] });
    } catch (injectErr) {
      return { ok: false, error: `inject-failed: ${String(injectErr)}. Reload the page and retry.` };
    }
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e2) {
      return { ok: false, error: `${String(e2)}. Reload the page and retry.` };
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'JEV_DECIDE') {
    decide(msg.payload).then(sendResponse);
    return true;
  }
  if (msg?.type === 'SNAPSHOT' || msg?.type === 'EXECUTE') {
    (async () => {
      const tabId = await activeTabId();
      if (!tabId) return sendResponse({ ok: false, error: 'no-active-tab' });
      sendResponse(await sendToTab(tabId, msg.type === 'SNAPSHOT' ? { type: 'SNAPSHOT' } : { type: 'EXECUTE', action: msg.action }));
    })();
    return true;
  }
  if (msg?.type === 'OR_CHECK') {
    checkOpenRouter(msg.model).then(sendResponse);
    return true;
  }
  if (msg?.type === 'TEXT_GEN') {
    generateText(msg.payload).then(sendResponse);
    return true;
  }
  if (msg?.type === 'STT') {
    transcribe(msg.payload).then(sendResponse);
    return true;
  }
  if (msg?.type === 'WAKE_ON') {
    startWake(msg.words).then(sendResponse);
    return true;
  }
  if (msg?.type === 'WAKE_OFF') {
    stopWake().then(sendResponse);
    return true;
  }
  if (msg?.type === 'GET_PENDING') {
    const command = pending.command;
    pending.command = null;
    sendResponse({ ok: true, command: command ?? null });
    return true;
  }
  if (msg?.type === 'VOICE_WAKE') {
    announceWake(msg.heard).then(sendResponse);
    return true;
  }
  if (msg?.type === 'VOICE_COMMAND') {
    handleWakeCommand(msg).then(sendResponse);
    return true;
  }
});

// ------------------------------------------------------- 24/7 wake listener --
//
// The side panel is a document, so it cannot listen while closed. An offscreen
// document can, and USER_MEDIA is the reason that permits getUserMedia there.
// Note: getUserMedia in an offscreen document never shows a prompt, so the
// microphone must already be granted to the extension origin (press Listen in
// the panel once).
const OFFSCREEN_PATH = 'offscreen.html';
const PANEL_PATH = 'sidepanel.html';
let creatingOffscreen = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (contexts.length) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Keep listening for the wake word while the side panel is closed.',
    })
    .finally(() => { creatingOffscreen = null; });
  return creatingOffscreen;
}

async function startWake(words) {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `offscreen-failed: ${e?.message || e}` };
  }
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'WAKE_START', words });
  if (res?.error === 'offscreen-mic-denied') {
    return { ok: false, error: 'Microphone is not granted to the extension yet. Press Listen once in the panel (or use Open as tab) to grant it, then turn Always on back on.' };
  }
  return res ?? { ok: false, error: 'offscreen-no-response' };
}

async function stopWake() {
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'WAKE_STOP' });
  } catch { /* document may already be gone */ }
  try {
    await chrome.offscreen.closeDocument();
  } catch { /* not open */ }
  return { ok: true };
}

// Wake heard: show the UI. chrome.sidePanel.open() only works from a user
// gesture (action click, shortcut, context menu, gesture on an extension page),
// and a spoken wake word is not one, so the side panel is attempted first and a
// popup window is the fallback that always works.
async function announceWake(heard) {
  const opened = await showUi();
  chrome.runtime.sendMessage({ type: 'VOICE_WAKE_UI', heard, opened }).catch(() => {});
  return { ok: true, opened };
}

async function showUi() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (tab?.windowId != null) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return 'side-panel';
    } catch { /* gesture required */ }
  }
  const panelUrl = chrome.runtime.getURL(PANEL_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['TAB'],
    documentUrls: [panelUrl],
  }).catch(() => []);
  if (existing.length) {
    try { await chrome.windows.update(existing[0].windowId, { focused: true }); } catch { /* gone */ }
    return 'existing-window';
  }
  try {
    await chrome.windows.create({
      url: panelUrl,
      type: 'popup',
      width: 460,
      height: 820,
    });
    return 'popup-window';
  } catch (e) {
    return `failed: ${e?.message || e}`;
  }
}

// A spoken goal heard while the panel was closed: transcribe it here so the text
// is ready before the UI appears, then hold it until the panel asks for it.
const pending = { command: null };

async function handleWakeCommand({ text, audioB64, mime }) {
  let final = text;
  const { groqKey, sttLang } = await chrome.storage.local.get(['groqKey', 'sttLang']);
  if (audioB64 && groqKey) {
    const stt = await transcribe({ audioB64, mime, lang: sttLang || 'en' });
    if (stt?.ok) final = stt.text;
  }
  const letters = String(final || '').replace(/[^a-z0-9]/gi, '');
  if (letters.length < 3) {
    chrome.runtime.sendMessage({ type: 'VOICE_TOO_SHORT', text: final }).catch(() => {});
    return { ok: true, ignored: 'too-short' };
  }
  pending.command = final;
  await showUi();
  chrome.runtime.sendMessage({ type: 'VOICE_COMMAND_READY', text: final }).catch(() => {});
  return { ok: true, text: final };
}

// Chrome's own recogniser is good enough to spot a wake word but too weak for
// the spoken goal. When a Groq key is present the recorded goal audio is
// transcribed by Whisper instead, and the panel prefers that text.
async function transcribe({ audioB64, mime, lang }) {
  const { groqKey, sttModel } = await chrome.storage.local.get(['groqKey', 'sttModel']);
  if (!groqKey) return { ok: false, error: 'missing-groq-key' };
  if (!audioB64) return { ok: false, error: 'no-audio' };
  try {
    const bytes = Uint8Array.from(atob(audioB64), (c) => c.charCodeAt(0));
    const ext = (mime || '').includes('ogg') ? 'ogg' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime || 'audio/webm' }), `goal.${ext}`);
    form.append('model', sttModel || 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    // Whisper accepts ISO-639-1 only ("en"); Chrome's recogniser wants the full
    // tag ("en-IN"). Passing the tag through returns 400 unsupported language.
    const iso = String(lang || '').split('-')[0].trim().toLowerCase();
    if (iso) form.append('language', iso);
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.message || `stt-${res.status}` };
    const text = (data?.text ?? '').trim();
    if (!text) return { ok: false, error: 'empty-transcript' };
    return { ok: true, text, model: data?.model, bytes: bytes.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Jev cannot write strings, so free text is generated by a small LLM — the same
// split jev-ultrafast uses (Jev decides, a text model only fills input fields).
async function generateText({ goal, field, recent }) {
  const { orKey, textModel } = await chrome.storage.local.get(['orKey', 'textModel']);
  if (!orKey) return { ok: false, error: 'missing-openrouter-key' };
  const model = textModel || 'deepseek/deepseek-v4-flash-0731';
  const prompt =
    `Write ONLY the exact text to type into a web form field. No quotes, no explanation, no labels.\n` +
    `Goal: ${goal}\nField: ${field}\n` +
    (recent ? `Already done: ${recent}\n` : '') +
    `Reply with the literal value only. If the goal does not contain the value, reply with the single word NONE.`;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orKey}` },
      body: JSON.stringify({
        model,
        reasoning: { enabled: false },
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 40,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.message || `text-${res.status}` };
    let text = (data?.choices?.[0]?.message?.content ?? '').trim();
    text = text.replace(/^["'`]|["'`]$/g, '').trim();
    if (!text || /^none$/i.test(text)) return { ok: false, error: 'no-value-in-goal' };
    return { ok: true, text, model: data?.model };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Default path: OpenRouter decisions endpoint with the stored OR key.
// Falls back to direct TypeSafe only if no OR key is set.
async function decide({ state, questions }) {
  const { jevKey, orKey } = await chrome.storage.local.get(['jevKey', 'orKey']);
  if (orKey) {
    try {
      const res = await fetch(OR_DECISIONS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orKey}` },
        body: JSON.stringify({ model: OR_DECISIONS_MODEL, state, questions }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data?.error?.message || `openrouter-${res.status}` };
      return { ok: true, answers: data.answers ?? {}, usage: data.usage ?? {}, model: data.model };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  if (!jevKey) return { ok: false, error: 'missing-key: paste OpenRouter key (recommended) or TypeSafe key' };
  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jevKey}` },
      body: JSON.stringify({ state, model: JEV_MODEL, questions }),
    });
    if (!res.ok) return { ok: false, error: `jev-${res.status}` };
    const data = await res.json();
    return { ok: true, answers: data.answers ?? {}, usage: data.usage ?? {} };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Probe OpenRouter decisions endpoint for the Jev model using stored OR key.
async function checkOpenRouter(model) {
  const { orKey } = await chrome.storage.local.get('orKey');
  if (!orKey) return { ok: false, error: 'missing-openrouter-key' };
  try {
    const res = await fetch(OR_DECISIONS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orKey}` },
      body: JSON.stringify({
        model: model || OR_DECISIONS_MODEL,
        state: 'Reply with the word ok.',
        questions: { ok: { type: 'noul', instructions: 'Is this a check?' } },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.message || `openrouter-${res.status}` };
    return { ok: true, model: data?.model ?? model, answers: data.answers, usage: data.usage };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
