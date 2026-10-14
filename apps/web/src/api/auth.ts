import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, keys } from "./client.js";

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return await api.me();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      qc.setQueryData(keys.me, null);
      void qc.invalidateQueries();
    },
  });
}
