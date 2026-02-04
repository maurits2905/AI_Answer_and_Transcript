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

const transcriptEl = el("transcript");         // hidden small
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
let recognition = null;
let listening = false;

let silenceTimer = null;
let generating = false;

let pttHeld = false;          // currently holding space
let pttEnabled = true;        // toggle
let lastTranscriptSent = "";  // prevents duplicates

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

function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/* -------------------- Speech Recognition -------------------- */
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

    transcriptEl.value = full;
    renderBigTranscript(full);

    // Auto-answer behavior
    scheduleAutoAnswer(full);
  };

  r.onerror = (e) => {
    setStatus("Speech error: " + (e?.error || "unknown"));
  };

  r.onend = () => {
    // Web Speech API sometimes ends unexpectedly; restart if we still want to listen
    if (listening) {
      try { r.start(); } catch {}
    }
  };

  return r;
}

function startListening() {
  if (listening) return;

  if (!recognition) recognition = initRecognition();
  if (!recognition) return;

  listening = true;
  setStatus("Listening…", true);

  try { recognition.start(); } catch {}
}

function stopListening() {
  listening = false;
  setStatus("Idle");
  if (recognition) {
    try { recognition.stop(); } catch {}
  }
}

/* -------------------- Big transcript rendering -------------------- */
function renderBigTranscript(text) {
  if (!text) {
    transcriptBigEl.textContent = "Transcript will appear here…";
    return;
  }
  transcriptBigEl.textContent = text;

  // Keep view pinned to bottom (feels live)
  transcriptBigEl.scrollTop = transcriptBigEl.scrollHeight;
}

/* -------------------- Auto-answer logic -------------------- */
/**
 * Rules:
 * - In TAB mode: auto-answer uses the silence timer + autoAnswer toggle
 * - In PTT mode: auto-answer always happens after you stop (silence timer),
 *   but only if PTT is enabled and you actually captured enough text.
 */
function scheduleAutoAnswer(currentText) {
  if (generating) return;

  const mode = modeEl.value;

  // TAB mode: respect autoAnswer toggle
  if (mode === "tab" && autoAnswerEl.value !== "on") return;

  // PTT mode: only if PTT enabled
  if (mode === "ptt" && !pttEnabled) return;

  const minChars = Number(minCharsEl?.value || 20);
  if (!currentText || currentText.length < minChars) return;

  clearTimeout(silenceTimer);

  const silenceMs = Math.max(
    300,
    Number((silenceSecEl?.value || 1.2)) * 1000
  );

  silenceTimer = setTimeout(() => {
    const latest = transcriptEl.value.trim();
    if (!latest || latest.length < minChars) return;
    if (latest === lastTranscriptSent) return;

    lastTranscriptSent = latest;

    // Stop listening while generating (reduces feedback loops)
    stopListening();

    generateAnswer(latest);
  }, silenceMs);
}

/* -------------------- Generate answer -------------------- */
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
    setTimeout(() => setStatus("Idle"), 800);
  } catch (e) {
    outputEl.textContent = "Error: " + (e?.message || e);
    setStatus("Error");
  } finally {
    generating = false;

    // Optional: auto-resume listening after answering
    // If you want that, uncomment:
    // if (modeEl.value === "tab") startListening();
  }
}

/* -------------------- Mode handling / UI visibility -------------------- */
function applyModeUI() {
  const mode = modeEl.value;

  // Only show TAB controls in tab mode
  startTabBtn.style.display = mode === "tab" ? "" : "none";
  tabSettings.style.display = mode === "tab" ? "" : "none";
  tabHint.style.display = mode === "tab" ? "" : "none";

  // Only show PTT controls in ptt mode
  pttSettings.style.display = mode === "ptt" ? "" : "none";

  // Reset indicators
  setPttIndicator(false);

  // Stop current listening when switching modes
  stopListening();
  clearTimeout(silenceTimer);
}

modeEl.addEventListener("change", applyModeUI);

/* -------------------- TAB MODE: capture button -------------------- */
startTabBtn.onclick = async () => {
  if (modeEl.value !== "tab") return;

  // In a static GH Pages app, we can only ask the user to share a tab/window and enable "Share audio".
  // This is still useful because it encourages correct setup and primes permissions.
  try {
    await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  } catch {
    // user cancelled
    return;
  }

  startListening();
};

/* -------------------- PTT MODE: toggle + spacebar anywhere -------------------- */
function applyPttToggle() {
  pttEnabled = (pttToggleEl.value === "on");
  if (!pttEnabled) {
    pttHeld = false;
    setPttIndicator(false);
    stopListening();
  }
}

pttToggleEl.addEventListener("change", applyPttToggle);

window.addEventListener("keydown", (e) => {
  if (modeEl.value !== "ptt") return;
  if (!pttEnabled) return;
  if (e.code !== "Space") return;

  // avoid scrolling the page with space
  e.preventDefault();

  if (!pttHeld) {
    pttHeld = true;
    setPttIndicator(true);
    startListening();
  }
});

window.addEventListener("keyup", (e) => {
  if (modeEl.value !== "ptt") return;
  if (e.code !== "Space") return;

  e.preventDefault();

  if (pttHeld) {
    pttHeld = false;
    setPttIndicator(false);

    // We don't instantly answer here; we rely on the silence timer.
    stopListening();

    // Force schedule based on latest transcript so release feels responsive
    const latest = transcriptEl.value.trim();
    if (latest) scheduleAutoAnswer(latest);
  }
});

pttHelpBtn.onclick = () => {
  alert(
    "Push-to-talk:\n\n1) Make sure Push-to-talk is Enabled\n2) Hold Space anywhere on the page to listen\n3) Release Space to stop\n\nThe app auto-generates an answer after a short silence."
  );
};

/* -------------------- Clear + font controls -------------------- */
clearBtn.onclick = () => {
  transcriptEl.value = "";
  lastTranscriptSent = "";
  renderBigTranscript("");
  outputEl.textContent = "Your answer will appear here…";
  setStatus("Idle");
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
    setStatus("SpeechRecognition not supported in this browser");
  } else {
    setStatus("Idle");
  }

  // Start in correct UI state
  applyModeUI();

  // PTT initial
  applyPttToggle();
  setPttIndicator(false);
})();
