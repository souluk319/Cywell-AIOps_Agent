const apiProxyBase = "/api/proxy/plugin/cywell-ai-sentinel/cas-api";
const AI_SENTINEL_URL = `/api/plugins/cywell-ai-sentinel/index.html?apiBase=${encodeURIComponent(apiProxyBase)}&surface=console-plugin`;

export default function AISentinelRoute() {
  if (typeof window !== "undefined") {
    window.location.replace(AI_SENTINEL_URL);
  }

  return null;
}

