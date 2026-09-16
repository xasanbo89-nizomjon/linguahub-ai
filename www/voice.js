// Provider-agnostic voice input foundation. The UI only depends on this
// adapter; a future cloud/native provider can replace the implementation.
(function () {
"use strict";
var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
var button;
var recognition;
function setState(active, message) { if (!button) return; button.setAttribute("aria-pressed", String(active)); button.title = message; button.classList.toggle("is-recording", active); }
function start() {
if (!Recognition) { setState(false, "Voice input is not supported in this browser"); return; }
recognition = new Recognition(); recognition.continuous = false; recognition.interimResults = true; recognition.lang = document.documentElement.lang || "en-US";
recognition.onresult = function (event) { var text = Array.prototype.slice.call(event.results).map(function (r) { return r[0].transcript; }).join(""); var input = document.getElementById("user-input"); if (input) { input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); } };
recognition.onend = function () { setState(false, "Hold to talk"); };
recognition.onerror = function () { setState(false, "Voice input unavailable. Type your message instead."); };
setState(true, "Release to stop recording"); recognition.start();
}
function stop() { if (recognition) recognition.stop(); }
function speak(text) { if (!window.speechSynthesis || !text) return false; window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); return true; }
document.addEventListener("DOMContentLoaded", function () { button = document.getElementById("voice-ptt-btn"); if (button) { button.disabled = !Recognition; button.addEventListener("pointerdown", start); ["pointerup", "pointercancel", "pointerleave"].forEach(function (event) { button.addEventListener(event, stop); }); } var speaker = document.getElementById("voice-speak-btn"); if (speaker) { speaker.disabled = !window.speechSynthesis; speaker.addEventListener("click", function () { var replies = document.querySelectorAll(".message.ai .message-content"); var latest = replies[replies.length - 1]; if (latest) speak(latest.textContent); }); } });
window.LinguaHubVoice = { isSupported: function () { return Boolean(Recognition); }, start: start, stop: stop, speak: speak };
})();
