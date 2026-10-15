// The passcode form: posts JSON to /api/unlock, then opens the app.
"use strict";

(function () {
  const form = document.getElementById("unlock-form");
  const input = document.getElementById("passcode");
  const button = document.getElementById("unlock-button");
  const error = document.getElementById("unlock-error");

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.focus();
    input.select();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const passcode = input.value;
    if (!passcode) return;
    button.disabled = true;
    error.hidden = true;
    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "ambree" },
        body: JSON.stringify({ passcode }),
      });
      if (res.ok) {
        location.replace("/");
        return;
      }
      if (res.status === 429) showError("Too many tries. Wait a minute, then try again.");
      else showError("That passcode didn't work. Try again.");
    } catch {
      showError("Can't reach the server. Check your connection and try again.");
    } finally {
      button.disabled = false;
    }
  });
})();
