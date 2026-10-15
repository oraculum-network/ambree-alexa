// Origin and Host checks. A browser request from another origin is refused; a request
// without Origin (a non-browser MCP client) is allowed. Host is checked too, so a
// DNS-rebinding page can't reach us under a hostname we don't serve.

export interface OriginPolicy {
  allowedOrigins: Set<string>;
  allowedHostnames: Set<string>;
  isAllowedOrigin(origin: string | undefined): boolean;
  isAllowedHost(host: string | undefined): boolean;
}

/** "Example.com:8080" -> "example.com"; "[::1]:3000" -> "[::1]". */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.indexOf(":");
  return colon >= 0 ? h.slice(0, colon) : h;
}

export function createOriginPolicy(opts: { publicOrigin: string; port: number; extraOrigins: string[]; extraHosts?: string[] }): OriginPolicy {
  const allowedOrigins = new Set<string>([
    opts.publicOrigin,
    `http://localhost:${opts.port}`,
    `http://127.0.0.1:${opts.port}`,
    `http://[::1]:${opts.port}`,
    ...opts.extraOrigins,
  ]);
  const allowedHostnames = new Set<string>(["localhost", "127.0.0.1", "[::1]", new URL(opts.publicOrigin).hostname.toLowerCase()]);
  for (const o of opts.extraOrigins) allowedHostnames.add(new URL(o).hostname.toLowerCase());
  // e.g. the host in MCP_URL, which the agent's own calls use as Host.
  for (const h of opts.extraHosts ?? []) allowedHostnames.add(h.toLowerCase());
  return {
    allowedOrigins,
    allowedHostnames,
    isAllowedOrigin: (origin) => origin === undefined || allowedOrigins.has(origin),
    isAllowedHost: (host) => !!host && allowedHostnames.has(hostnameOf(host)),
  };
}
