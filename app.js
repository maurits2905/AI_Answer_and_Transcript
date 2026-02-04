const el = (id) => document.getElementById(id);

/* -------------------- Elements -------------------- */
const modeEl = el("mode");

const startTabBtn = el("startTab");
const tabSettings = el("tabSettings");
const tabHint = el("tabHint");

const pttSettings = el("pttSettings");
const pttToggleEl = el("pttToggle");
const pttDot = el("pttDot");
const pttText = el("pttText");
const pttHelpBtn = el("pttHelpBtn");

const transcriptEl = el("transcript");         // hidden debug
const transcriptBigEl = el("transcriptBig");   // big readable transcript

const transcriptBiggerBtn = el("transcriptBigger");
const transcriptSmallerBtn = el("transcriptSmaller");

const outputEl = el("output");

const statusDot = el("statusDot");
const statusText = el("statusText");

const apiKeyEl = el("apiKey");
const saveKeyBtn = el("saveKey");
const systemPromptEl = el("systemPrompt");
const clearBtn = el("clearBtn");

const biggerBtn = el("bigger");
const smallerBtn = el("smaller");

/* TAB mode controls */
const autoAnswerEl = el("autoAnswer");
const silenceSecEl = el("silenceSec");
const minCharsEl = el("minChars");

/* -------------------- State -------------------- */
let audioCtx = null;
let audioDest = null;
let audioSourceNode = null;
let audioOnlyStream = null;

let recognition = null;          // Web Speech API (PTT mode)
let listening = false;

let silenceTimer = null;
let generating = false;

let pttHeld = false;
let pttEnabled = true;

let lastTranscriptSent = "";
let lastTextUpdateAt = 0;

// TAB CAPTURE + WHISPER
let displayStream = null;
let mediaRecorder = null;
let isCapturing = false;
let whisperQueue = [];
let whisperBusy = false;
let capturedChunks = [];
let chunkTimer = null;

/* -------------------- Helpers -------------------- */
function setStatus(text, ok = false) {
  statusText.textContent = text;
  statusDot.style.background = ok ? "#3ad17a" : "#666";
}

function setPttIndicator(active) {
  pttDot.style.background = active ? "#3ad17a" : "#666";
  pttText.textContent = active ? "PTT ACTIVE (holding Space)" : "PTT inactive";
}

function getKey() {
  return apiKeyEl.value.trim();
}

function loadKey() {
  apiKeyEl.value = localStorage.getItem("llm_api_key") || "";
}
loadKey();

saveKeyBtn.onclick = () => {
  localStorage.setItem("llm_api_key", apiKeyEl.value.trim());
  setStatus("Key saved", true);
  setTimeout(() => setStatus("Idle"), 700);
};

function renderBigTranscript(text) {
  transcriptEl.value = text || "";
  transcriptBigEl.textContent = text ? text : "Transcript will appear here…";
  transcriptBigEl.scrollTop = transcriptBigEl.scrollHeight;
}

function appendToTranscript(extra) {
  const current = transcriptEl.value.trim();
  const combined = (current ? (current + " ") : "") + extra.trim();
  renderBigTranscript(combined);
  lastTextUpdateAt = Date.now();
  scheduleAutoAnswer(combined);
}

function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/* -------------------- Auto-answer -------------------- */
function scheduleAutoAnswer(currentText) {
  if (generating) return;

  const mode = modeEl.value;

  // TAB mode respects autoAnswer toggle
  if (mode === "tab" && autoAnswerEl.value !== "on") return;

  // PTT mode only if enabled
  if (mode === "ptt" && !pttEnabled) return;

  const minChars = Number(minCharsEl?.value || 20);
  if (!currentText || currentText.length < minChars) return;

  clearTimeout(silenceTimer);

  const silenceMs = Math.max(300, Number((silenceSecEl?.value || 1.2)) * 1000);

  silenceTimer = setTimeout(() => {
    const latest = transcriptEl.value.trim();
    if (!latest || latest.length < minChars) return;
    if (latest === lastTranscriptSent) return;

    // Only trigger if we've had no new text recently (important for Whisper chunking)
    const msSinceUpdate = Date.now() - lastTextUpdateAt;
    if (msSinceUpdate < silenceMs - 50) return;

    lastTranscriptSent = latest;

    // Stop PTT listening while generating
    stopListeningPTT();

    generateAnswer(latest);
  }, silenceMs);
}

/* -------------------- LLM Answer -------------------- */
async function generateAnswer(userText) {
  const key = getKey();
  if (!key) {
    alert("Add an API key first (stored locally).");
    return;
  }

  generating = true;
  setStatus("Generating…", true);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.6,
        messages: [
          { role: "system", content: systemPromptEl.value.trim() },
          { role: "user", content: userText }
        ]
      })
    });

    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || "(No response)";
    outputEl.textContent = answer;

    setStatus("Done", true);
    setTimeout(() => setStatus(isCapturing ? "Capturing…" : "Idle"), 900);
  } catch (e) {
    outputEl.textContent = "Error: " + (e?.message || e);
    setStatus("Error");
  } finally {
    generating = false;
  }
}

/* =========================================================
   PTT MODE (Web Speech API, mic)
   ========================================================= */
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert("SpeechRecognition not supported. Use Chrome or Edge.");
    return null;
  }

  const r = new SR();
  r.lang = "en-US";
  r.interimResults = true;
  r.continuous = true;

  let finalText = "";

  r.onresult = (event) => {
    let interim = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }

    const full = (finalText + " " + interim).trim();
    renderBigTranscript(full);
    lastTextUpdateAt = Date.now();
    scheduleAutoAnswer(full);
  };

  r.onerror = (e) => {
    setStatus("Speech error: " + (e?.error || "unknown"));
  };

  r.onend = () => {
    if (listening) {
      try { r.start(); } catch {}
    }
  };

  return r;
}

function startListeningPTT() {
  if (listening) return;

  if (!recognition) recognition = initRecognition();
  if (!recognition) return;

  listening = true;
  setStatus("Listening…", true);

  try { recognition.start(); } catch {}
}

function stopListeningPTT() {
  listening = false;
  if (recognition) {
    try { recognition.stop(); } catch {}
  }
  if (!isCapturing) setStatus("Idle");
}

/* =========================================================
   TAB CAPTURE MODE (Whisper STT on captured tab audio)
   ========================================================= */

async function startTabCapture() {
  const key = getKey();
  if (!key) {
    alert("Add an API key first. Tab capture needs STT via API.");
    return;
  }

  stopListeningPTT();

  // You typically need video:true to be allowed to share tab audio
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });
  } catch {
    return;
  }

  const audioTracks = displayStream.getAudioTracks();
  if (!audioTracks || audioTracks.length === 0) {
    alert('No audio track detected. Re-share and make sure "Share audio" is enabled.');
    stopTabCapture();
    return;
  }

  isCapturing = true;
  setStatus("Capturing…", true);

  // Stop capture if user stops sharing
  displayStream.getTracks().forEach(t => {
    t.onended = () => stopTabCapture();
  });

  // ---- KEY FIX: route captured audio through WebAudio and record that ----
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // AudioContext may start suspended until a user gesture; this click counts,
    // but we still resume to be safe.
    await audioCtx.resume();

    // Use only the audio tracks for the source node
    audioOnlyStream = new MediaStream(audioTracks);

    audioSourceNode = audioCtx.createMediaStreamSource(audioOnlyStream);
    audioDest = audioCtx.createMediaStreamDestination();
    audioSourceNode.connect(audioDest);

  } catch (e) {
    console.error("AudioContext setup failed:", e);
    setStatus("Audio setup failed", false);
    stopTabCapture();
    return;
  }

  // Record the destination stream (this avoids Recorder start failures)
  const mime = pickAudioMimeType();
  try {
    mediaRecorder = new MediaRecorder(audioDest.stream, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    console.error("MediaRecorder create failed:", e);
    setStatus("Recorder create failed", false);
    stopTabCapture();
    return;
  }

  whisperQueue = [];
  whisperBusy = false;

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      whisperQueue.push(e.data);
      pumpWhisperQueue();
    }
  };

  mediaRecorder.onerror = (e) => {
    console.error("MediaRecorder error:", e);
    setStatus("Recorder error", false);
  };

  // Start ONCE
  try {
    mediaRecorder.start(1200); // chunk length in ms (lower = more live)
  } catch (e) {
    console.error("Recorder start failed:", e.name, e.message);
    setStatus("Recorder start failed", false);
    stopTabCapture();
    return;
  }
}



function stopTabCapture() {
  isCapturing = false;

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch {}
  }

  mediaRecorder = null;

  if (audioSourceNode) {
    try { audioSourceNode.disconnect(); } catch {}
  }
  audioSourceNode = null;

  if (audioOnlyStream) {
    audioOnlyStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
  }
  audioOnlyStream = null;

  if (audioCtx) {
    try { audioCtx.close(); } catch {}
  }
  audioCtx = null;
  audioDest = null;

  if (displayStream) {
    displayStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
  }
  displayStream = null;

  setStatus("Idle");
}


function pickAudioMimeType() {
  // Prefer formats Whisper accepts well. webm/opus is common in Chrome.
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg"
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

async function pumpWhisperQueue() {
  if (whisperBusy) return;
  if (whisperQueue.length === 0) return;

  whisperBusy = true;

  while (whisperQueue.length > 0 && isCapturing) {
    const blob = whisperQueue.shift();
    try {
      const text = await transcribeWithWhisper(blob);
      if (text && text.trim()) {
        appendToTranscript(text);
      }
    } catch (e) {
      console.error(e);
      setStatus(String(e.message || e), false);
    }

  }

  whisperBusy = false;
}

async function transcribeWithWhisper(blob) {
  const key = getKey();

  const fd = new FormData();

  // Use the most compatible model name
  fd.append("model", "whisper-1");

  fd.append("file", blob, "audio.webm");
  fd.append("language", "en");

  let res;
  try {
    res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key },
      body: fd
    });
  } catch (e) {
    // This is where CORS/network errors show up
    throw new Error("Network/CORS error: " + (e?.message || e));
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.text || "";
}


/* -------------------- UI visibility / modes -------------------- */
function applyModeUI() {
  const mode = modeEl.value;

  startTabBtn.style.display = mode === "tab" ? "" : "none";
  tabSettings.style.display = mode === "tab" ? "" : "none";
  tabHint.style.display = mode === "tab" ? "" : "none";

  pttSettings.style.display = mode === "ptt" ? "" : "none";

  // Stop everything when switching
  stopListeningPTT();
  stopTabCapture();
  clearTimeout(silenceTimer);

  setPttIndicator(false);
}

modeEl.addEventListener("change", applyModeUI);

/* -------------------- TAB start -------------------- */
startTabBtn.onclick = () => {
  if (modeEl.value !== "tab") return;
  startTabCapture();
};

/* -------------------- PTT toggle + spacebar anywhere -------------------- */
function applyPttToggle() {
  pttEnabled = (pttToggleEl.value === "on");
  if (!pttEnabled) {
    pttHeld = false;
    setPttIndicator(false);
    stopListeningPTT();
  }
}
pttToggleEl.addEventListener("change", applyPttToggle);

window.addEventListener("keydown", (e) => {
  if (modeEl.value !== "ptt") return;
  if (!pttEnabled) return;
  if (e.code !== "Space") return;

  e.preventDefault();

  if (!pttHeld) {
    pttHeld = true;
    setPttIndicator(true);
    startListeningPTT();
  }
});

window.addEventListener("keyup", (e) => {
  if (modeEl.value !== "ptt") return;
  if (e.code !== "Space") return;

  e.preventDefault();

  if (pttHeld) {
    pttHeld = false;
    setPttIndicator(false);
    stopListeningPTT();

    // Trigger silence schedule
    const latest = transcriptEl.value.trim();
    if (latest) scheduleAutoAnswer(latest);
  }
});

pttHelpBtn.onclick = () => {
  alert(
    "Push-to-talk:\n\n1) Enable Push-to-talk\n2) Hold Space anywhere on the page to listen\n3) Release Space to stop\n\nThe app auto-answers after a short silence."
  );
};

/* -------------------- Clear + font controls -------------------- */
clearBtn.onclick = () => {
  renderBigTranscript("");
  lastTranscriptSent = "";
  outputEl.textContent = "Your answer will appear here…";
  setStatus(isCapturing ? "Capturing…" : "Idle");
};

function changeFont(elm, delta) {
  const size = parseFloat(getComputedStyle(elm).fontSize);
  elm.style.fontSize = Math.max(18, size + delta) + "px";
}

biggerBtn.onclick = () => changeFont(outputEl, 4);
smallerBtn.onclick = () => changeFont(outputEl, -4);

transcriptBiggerBtn.onclick = () => changeFont(transcriptBigEl, 4);
transcriptSmallerBtn.onclick = () => changeFont(transcriptBigEl, -4);

/* -------------------- Init -------------------- */
(function init() {
  if (!speechSupported()) {
    // This only affects PTT mode; tab mode uses Whisper.
    console.warn("SpeechRecognition not supported; PTT mode will not work.");
  }

  applyModeUI();
  applyPttToggle();
  setPttIndicator(false);
  renderBigTranscript("");
  setStatus("Idle");
})();
