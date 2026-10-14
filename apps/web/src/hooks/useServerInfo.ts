import { useQuery } from "@tanstack/react-query";
import { healthResponse } from "@lastthaw/shared";

/** Server capabilities: whether dev tools (time skip etc.) are enabled on this server. */
export function useServerInfo() {
  return useQuery({
    queryKey: ["server-info"],
    queryFn: async () => healthResponse.parse(await fetch("/api/health").then((r) => r.json())),
    staleTime: 5 * 60_000,
  });
}
