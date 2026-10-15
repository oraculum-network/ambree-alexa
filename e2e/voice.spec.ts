// The simulated Alexa+ page in Chromium: unlock, typed and chip turns, the
// "Under the hood" panel, 360 px layout, screenshots, and no foreign requests.

import { mkdirSync, readFileSync } from "node:fs";
import { type Page, test as base, expect } from "@playwright/test";

const PASSCODE = "e2e-passcode-not-real";
const SHOTS = new URL("./screenshots/", import.meta.url);
const dataset = JSON.parse(readFileSync(new URL("../data/places.json", import.meta.url), "utf8")) as { places: Array<{ name: string; rain_ok: boolean }> };
const rainOkNames = dataset.places.filter((p) => p.rain_ok).map((p) => p.name);

const CHIPS: Array<[string, string]> = [
  ["It's raining in Grand Baie. Re-plan my afternoon.", "replan_day"],
  ["What's the weather in Flic en Flac?", "weather_now"],
  ["Find a covered market near Port Louis.", "find_places"],
  ["Tell me about the Blue Penny Museum.", "place_details"],
];

// Every test: no console errors and no request to any other origin.
const test = base.extend<{ guard: { allowConsole: RegExp[] } }>({
  guard: [
    async ({ page, baseURL }, use) => {
      const origin = new URL(baseURL!).origin;
      const errors: string[] = [];
      const foreign: string[] = [];
      const guard = { allowConsole: [] as RegExp[] };
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("request", (r) => {
        const url = r.url();
        if (!url.startsWith("data:") && new URL(url).origin !== origin) foreign.push(url);
      });
      await use(guard);
      expect(foreign, "requests to other origins").toEqual([]);
      expect(errors.filter((e) => !guard.allowConsole.some((re) => re.test(e))), "console errors").toEqual([]);
    },
    { auto: true },
  ],
});

async function unlock(page: Page) {
  await page.goto("/");
  await page.getByLabel("Passcode").fill(PASSCODE);
  await page.getByRole("button", { name: "Open the demo" }).click();
  await expect(page.locator("#ask-input")).toBeVisible();
}

async function askTyped(page: Page, text: string) {
  const before = await page.locator(".msg-ambree").count();
  await page.getByLabel("Ask Ambree").fill(text);
  await page.getByLabel("Ask Ambree").press("Enter");
  await expect(page.locator(".msg-ambree")).toHaveCount(before + 1);
  return page.locator(".msg-ambree .msg-text").last().innerText();
}

async function noHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, "horizontal overflow").toBeLessThanOrEqual(client);
}

test("the unlock gate: a wrong passcode shows an error, the right one opens the app", async ({ page, guard }) => {
  // Chromium logs the expected 401 of the wrong attempt as a console error.
  guard.allowConsole.push(/status of 401/);
  await page.goto("/");
  await expect(page.locator("#unlock-form")).toBeVisible();
  await expect(page.locator("#ask-input")).toHaveCount(0);
  await page.getByLabel("Passcode").fill("not-the-passcode");
  await page.getByRole("button", { name: "Open the demo" }).click();
  await expect(page.locator("#unlock-error")).toHaveText("That passcode didn't work. Try again.");
  await page.getByLabel("Passcode").fill(PASSCODE);
  await page.getByRole("button", { name: "Open the demo" }).click();
  await expect(page.locator(".tag")).toHaveText("FOR ALEXA+ · SIMULATED");
  // http here, so the cookie is amb_session (on https it is __Host-amb_session, with Secure).
  const cookies = await page.context().cookies();
  expect(cookies.map((c) => ({ name: c.name, httpOnly: c.httpOnly, sameSite: c.sameSite, path: c.path, secure: c.secure }))).toEqual([
    { name: "amb_session", httpOnly: true, sameSite: "Strict", path: "/", secure: false },
  ]);
  await expect(page.getByText("A simulated Alexa+ experience. This page is an MCP client of Ambree's Mauritius tools.")).toBeVisible();
  await expect(page.getByText("Staying in Grand Baie · 3 days left")).toBeVisible();
  await expect(page.getByRole("link", { name: "Source" })).toHaveAttribute("href", "https://github.com/oraculum-network/ambree-alexa");
});

test("a typed re-plan names a rain_ok place, and Under the hood lists replan_day", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await unlock(page);
  await expect(page.locator("#hood")).toHaveAttribute("open", "");
  const reply = await askTyped(page, "It's raining in Grand Baie. Re-plan my afternoon.");
  expect(rainOkNames.some((n) => reply.includes(n)), `reply names a rain_ok place: ${reply}`).toBe(true);
  // A typed turn gives focus back to the question box.
  await expect(page.getByLabel("Ask Ambree")).toBeFocused();
  await expect(page.getByLabel("Ask Ambree")).toBeEnabled();
  const turn = page.locator(".hood-turn").first();
  await expect(turn.locator(".badge")).toHaveText("Offline");
  await expect(turn.locator(".call-name")).toHaveText(["replan_day"]);
  await expect(turn.locator(".call-meta")).toContainText(/\d+ ms · ok/);
  await expect(turn.locator(".call-args")).toContainText('{"area":"grand-baie", "window":"afternoon", "reported_weather":"rain"}');
  await expect(page.locator("#reply-live")).toHaveText(reply);
});

test("the suggestion chips work", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await unlock(page);
  for (const [i, [chip, tool]] of CHIPS.entries()) {
    await page.getByRole("button", { name: chip }).click();
    await expect(page.locator(".msg-ambree")).toHaveCount(i + 1);
    await expect(page.locator(".hood-turn").first().locator(".call-name")).toHaveText([tool]);
    await expect(page.locator(".hood-turn").first().locator(".call-meta")).toContainText("ok");
    await expect(page.locator(".msg-ambree .msg-text").last()).not.toContainText("Sorry");
  }
  await expect(page.locator(".msg-you")).toHaveCount(4);
});

test("no horizontal overflow at 360 px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/");
  await noHorizontalOverflow(page);
  await unlock(page);
  await expect(page.locator("#hood")).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: CHIPS[2]![0] }).click();
  await expect(page.locator(".msg-ambree")).toHaveCount(1);
  await page.locator("#hood summary").click();
  await expect(page.locator(".hood-turn")).toHaveCount(1);
  await noHorizontalOverflow(page);
});

for (const [label, width, height] of [
  ["desktop", 1280, 900],
  ["mobile", 360, 780],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`screenshot: ${label} ${width} ${scheme}`, async ({ page }) => {
      mkdirSync(SHOTS, { recursive: true });
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");
      await page.screenshot({ path: new URL(`unlock-${label}-${scheme}.png`, SHOTS).pathname, animations: "disabled" });
      await unlock(page);
      await page.getByRole("button", { name: CHIPS[0]![0] }).click();
      await expect(page.locator(".msg-ambree")).toHaveCount(1);
      await page.getByRole("button", { name: CHIPS[3]![0] }).click();
      await expect(page.locator(".msg-ambree")).toHaveCount(2);
      if (label === "mobile") await page.locator("#hood summary").click();
      // Headless Chromium has no audio to finish speaking, so stop it to show the idle mic.
      await page.evaluate(() => window.speechSynthesis.cancel());
      await expect(page.locator("#mic")).toHaveAttribute("data-state", "idle");
      await noHorizontalOverflow(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: new URL(`app-${label}-${scheme}.png`, SHOTS).pathname, fullPage: true, animations: "disabled" });
    });
  }
}
