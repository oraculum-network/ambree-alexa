// The simulated Alexa+ page: voice in (Web Speech API), voice out (speechSynthesis),
// and an "Under the hood" view of every MCP call the agent makes.
// The conversation lives only in this page; nothing is stored.
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  const mic = $("mic");
  const micStatus = $("mic-status");
  const interim = $("interim");
  const noVoice = $("no-voice");
  const voiceToggle = $("voice-toggle");
  const form = $("ask");
  const input = $("ask-input");
  const send = $("send");
  const log = $("log");
  const empty = $("empty");
  const live = $("reply-live");
  const hood = $("hood");
  const turns = $("turns");
  const hoodEmpty = $("hood-empty");
  const chips = Array.from(document.querySelectorAll(".chip"));

  const history = [];
  let busy = false;
  let turnCount = 0;

  // ---- Layout: "Under the hood" starts open on wide screens only. ----
  if (!window.matchMedia("(min-width: 960px)").matches) hood.open = false;

  // ---- Mic states: idle, listening, thinking, speaking. ----
  const STATUS = {
    idle: "Tap to talk, or hold Space.",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking. Tap to stop.",
  };
  function setState(state) {
    mic.dataset.state = state;
    micStatus.textContent = STATUS[state];
    mic.setAttribute("aria-label", state === "listening" ? "Stop listening" : state === "speaking" ? "Stop speaking" : "Talk to Ambree");
  }

  // ---- Voice output. ----
  const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
  let voiceOn = true;
  try {
    voiceOn = localStorage.getItem("ambree.voice") !== "off";
  } catch {
    // Storage may be blocked; keep the default.
  }
  function renderVoiceToggle() {
    voiceToggle.textContent = voiceOn ? "Voice on" : "Voice off";
    voiceToggle.setAttribute("aria-pressed", String(voiceOn));
  }
  renderVoiceToggle();
  if (!synth) voiceToggle.hidden = true;
  voiceToggle.addEventListener("click", () => {
    voiceOn = !voiceOn;
    try {
      localStorage.setItem("ambree.voice", voiceOn ? "on" : "off");
    } catch {
      // Not remembered, but still applied for this page.
    }
    if (!voiceOn) stopSpeaking();
    renderVoiceToggle();
  });

  function pickVoice() {
    if (!synth) return null;
    const voices = synth.getVoices().filter((v) => /^en[-_](GB|US)/i.test(v.lang));
    const score = (v) =>
      (/natural|neural|premium|enhanced/i.test(v.name) ? 4 : 0) +
      (/google|samantha|daniel|serena|sonia|libby|aria|jenny|kate/i.test(v.name) ? 2 : 0) +
      (/^en[-_]GB/i.test(v.lang) ? 1 : 0);
    return voices.sort((a, b) => score(b) - score(a))[0] || null;
  }
  let voice = null;
  if (synth) {
    voice = pickVoice();
    synth.addEventListener("voiceschanged", () => {
      voice = pickVoice();
    });
  }

  function stopSpeaking() {
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    if (mic.dataset.state === "speaking") setState("idle");
  }

  function speak(text) {
    if (!synth || !voiceOn || !text) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = voice ? voice.lang : "en-GB";
    u.rate = 1;
    u.onstart = () => setState("speaking");
    u.onend = () => {
      if (mic.dataset.state === "speaking") setState("idle");
    };
    u.onerror = u.onend;
    synth.speak(u);
  }

  // ---- Voice input. ----
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let listening = false;
  let heard = "";

  if (!Recognition) {
    mic.hidden = true;
    micStatus.hidden = true;
    noVoice.hidden = false;
  }

  function startListening() {
    if (!Recognition || busy || listening) return;
    stopSpeaking();
    heard = "";
    rec = new Recognition();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      let partial = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) heard += r[0].transcript;
        else partial += r[0].transcript;
      }
      interim.textContent = (heard + " " + partial).trim();
    };
    rec.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        micStatus.textContent = "Microphone access is blocked. Type instead.";
      } else if (event.error === "no-speech") {
        micStatus.textContent = "I didn't catch that. Tap to try again.";
      }
    };
    rec.onend = () => {
      listening = false;
      const text = heard.trim();
      interim.textContent = "";
      if (text) ask(text);
      else if (mic.dataset.state === "listening") {
        const keep = micStatus.textContent;
        setState("idle");
        if (keep !== STATUS.listening) micStatus.textContent = keep;
      }
    };
    try {
      rec.start();
      listening = true;
      setState("listening");
    } catch {
      setState("idle");
    }
  }

  function stopListening() {
    if (rec && listening) rec.stop();
  }

  // Click toggles; Space held on the focused button is push-to-talk.
  let suppressClick = false;
  mic.addEventListener("click", () => {
    if (suppressClick) return;
    if (mic.dataset.state === "speaking") return stopSpeaking();
    if (listening) stopListening();
    else startListening();
  });
  mic.addEventListener("keydown", (event) => {
    if (event.code !== "Space") return;
    event.preventDefault();
    if (!event.repeat) startListening();
  });
  mic.addEventListener("keyup", (event) => {
    if (event.code !== "Space") return;
    event.preventDefault();
    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 0);
    stopListening();
  });

  // ---- Rendering. ----
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function addMessage(who, text, notice) {
    empty.hidden = true;
    const item = el("li", who === "you" ? "msg msg-you" : "msg msg-ambree");
    item.append(el("span", "who", who === "you" ? "You" : "Ambree"));
    item.append(el("p", "msg-text", text));
    if (notice) item.append(el("p", "notice", notice));
    log.append(item);
    item.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    return item;
  }

  function addHoodTurn(question, data) {
    hoodEmpty.hidden = true;
    turnCount += 1;
    const item = el("li", "hood-turn");
    const head = el("div", "hood-head");
    head.append(el("span", "hood-n", "Turn " + turnCount));
    const badge = data.mode === "llm" ? el("span", "badge badge-llm", "LLM · " + (data.model || "model")) : el("span", "badge badge-offline", "Offline");
    head.append(badge);
    item.append(head);
    item.append(el("p", "hood-q", "“" + question + "”"));
    if (data.notice) item.append(el("p", "hood-notice", data.notice));
    const calls = el("ol", "calls");
    for (const c of data.trace || []) {
      const call = el("li", "call" + (c.ok ? "" : " call-failed"));
      call.append(el("code", "call-name", c.tool));
      // Compact JSON, with a space after each comma so it wraps between arguments.
      call.append(el("code", "call-args", JSON.stringify(c.args).replace(/,"/g, ', "')));
      call.append(el("span", "call-meta", c.ms + " ms · " + (c.ok ? "ok" : "error")));
      calls.append(call);
    }
    if (!calls.children.length) item.append(el("p", "hood-none", "No MCP call this turn."));
    else item.append(calls);
    turns.prepend(item);
  }

  function setBusy(on) {
    busy = on;
    input.disabled = on;
    send.disabled = on;
    for (const c of chips) c.disabled = on;
  }

  // ---- A turn. ----
  async function ask(raw) {
    const text = String(raw || "").trim().slice(0, 300);
    if (!text || busy) return;
    stopSpeaking();
    setBusy(true);
    setState("thinking");
    addMessage("you", text);
    let reply = "";
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "ambree" },
        body: JSON.stringify({ text, history: history.slice(-6) }),
      });
      if (res.status === 401) {
        location.reload();
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || typeof data.reply !== "string") {
        reply = res.status === 429 ? "You're asking quickly. Give me a few seconds, then try again." : "Sorry, something went wrong. Please try again.";
        addMessage("ambree", reply);
      } else {
        reply = data.reply;
        addMessage("ambree", reply, data.notice);
        addHoodTurn(text, data);
        history.push({ role: "user", text: text.slice(0, 400) }, { role: "assistant", text: reply.slice(0, 400) });
        while (history.length > 6) history.shift();
      }
    } catch {
      reply = "I can't reach Ambree right now. Check your connection and try again.";
      addMessage("ambree", reply);
    } finally {
      setBusy(false);
      setState("idle");
    }
    live.textContent = reply;
    speak(reply);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value;
    input.value = "";
    ask(text);
  });
  for (const chip of chips) chip.addEventListener("click", () => ask(chip.dataset.text));

  setState("idle");
})();
