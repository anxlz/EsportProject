'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/ui';

/**
 * A mutation that refreshes the listed queries and shows a toast on success.
 * Errors stay on `mutation.error` so the open form/dialog can display them in place.
 */
export function useAction<TVars, TResult = unknown>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: {
    invalidate: string[][];
    success?: string | ((r: TResult) => string);
    onSuccess?: (r: TResult) => void;
  },
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result) => {
      await Promise.all(opts.invalidate.map((queryKey) => qc.invalidateQueries({ queryKey })));
      if (opts.success)
        toast(typeof opts.success === 'function' ? opts.success(result) : opts.success);
      opts.onSuccess?.(result);
    },
  });
}
