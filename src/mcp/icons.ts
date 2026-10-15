// Icons for serverInfo and each tool (MCP 2025-11-25), as SVG data URIs.

import { readFileSync } from "node:fs";

export interface Icon {
  src: string;
  mimeType: string;
  sizes: string[];
  theme?: "light" | "dark";
}

const dataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const svgFile = (name: string) => readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8");

export const SERVER_ICONS: Icon[] = [
  { src: dataUri(svgFile("ambree-avatar.svg")), mimeType: "image/svg+xml", sizes: ["any"], theme: "light" },
  { src: dataUri(svgFile("ambree-avatar-dark.svg")), mimeType: "image/svg+xml", sizes: ["any"], theme: "dark" },
];

function glyph(body: string, theme: "light" | "dark"): Icon {
  const bg = theme === "light" ? "#F7F2E8" : "#10292B";
  const ink = theme === "light" ? "#10292B" : "#F7F2E8";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">` +
    `<rect width="24" height="24" rx="6" fill="${bg}"/>` +
    `<g fill="none" stroke="${ink}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
  return { src: dataUri(svg), mimeType: "image/svg+xml", sizes: ["any"], theme };
}

const GLYPHS: Record<string, string> = {
  // A map pin.
  find_places: `<path d="M12 20s-5.5-5.2-5.5-9.5a5.5 5.5 0 0 1 11 0C17.5 14.8 12 20 12 20z"/><circle cx="12" cy="10.5" r="2"/>`,
  // An "i" in a circle.
  place_details: `<circle cx="12" cy="12" r="7.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>`,
  // A cloud with rain.
  weather_now: `<path d="M8 15.5h8.5a3.5 3.5 0 0 0 .3-7A5 5 0 0 0 7.2 9.6 3 3 0 0 0 8 15.5z"/><path d="M9 18.5l-.7 1.5M13 18.5l-.7 1.5"/>`,
  // Two arrows swapping.
  replan_day: `<path d="M5 9h12l-3-3"/><path d="M19 15H7l3 3"/>`,
};

export const TOOL_ICONS: Record<string, Icon[]> = Object.fromEntries(
  Object.entries(GLYPHS).map(([name, body]) => [name, [glyph(body, "light"), glyph(body, "dark")]]),
);
