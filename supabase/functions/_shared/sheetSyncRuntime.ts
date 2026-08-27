export type SheetSyncRpcErrorLike = {
  code?: string;
  message?: string;
};

export type SheetSyncRpcResult<T> = {
  data: T | null;
  error: SheetSyncRpcErrorLike | null;
};

type AbortableRpcBuilder<T> = PromiseLike<SheetSyncRpcResult<T>> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<SheetSyncRpcResult<T>>;
};

export type SheetSyncRpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => unknown;
};

export class SheetSyncDeadlineError extends Error {
  readonly code = "sheet_sync_deadline_exceeded";
  readonly rpcName: string;
  readonly timeoutMs: number;

  constructor(rpcName: string, timeoutMs: number) {
    super(`sheet sync RPC ${rpcName} exceeded ${timeoutMs}ms`);
    this.name = "SheetSyncDeadlineError";
    this.rpcName = rpcName;
    this.timeoutMs = timeoutMs;
  }
}

export class SheetSyncRpcError extends Error {
  readonly code: string;
  readonly rpcMessage: string;

  constructor(prefix: string, error: SheetSyncRpcErrorLike | null | undefined) {
    const rpcCode = String(error?.code ?? "unknown");
    super(`${prefix}:${rpcCode}`);
    this.name = "SheetSyncRpcError";
    this.code = rpcCode;
    this.rpcMessage = String(error?.message ?? "");
  }
}

export type SheetSyncLease = {
  jobName: string;
  holder: string;
};

export type SheetSyncLeaseClaim = {
  acquired: boolean;
  lease: SheetSyncLease | null;
  retryAfterSeconds: number;
};

/**
 * Attach an actual AbortSignal to PostgREST and also race a local deadline.
 * The race keeps this helper compatible with a minimal test double, while the
 * abort prevents a real fetch from continuing after the Edge response ends.
 */
export async function sheetSyncRpcWithDeadline<T>(
  client: SheetSyncRpcClient,
  rpcName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<SheetSyncRpcResult<T>> {
  const boundedTimeout = Math.max(1, Math.trunc(timeoutMs));
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const builder = client.rpc(rpcName, args) as AbortableRpcBuilder<T>;
  const abortable = typeof builder?.abortSignal === "function"
    ? builder.abortSignal(controller.signal)
    : builder;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new SheetSyncDeadlineError(rpcName, boundedTimeout));
    }, boundedTimeout);
  });

  try {
    return await Promise.race([
      Promise.resolve(abortable),
      deadline,
    ]);
  } catch (error) {
    if (timedOut && !(error instanceof SheetSyncDeadlineError)) {
      throw new SheetSyncDeadlineError(rpcName, boundedTimeout);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function claimSheetSyncLease(
  client: SheetSyncRpcClient,
  jobName: string,
  ttlSeconds: number,
  timeoutMs = 3_500,
): Promise<SheetSyncLeaseClaim> {
  const holder = crypto.randomUUID();
  const { data, error } = await sheetSyncRpcWithDeadline<Record<string, unknown>>(
    client,
    "claim_sheet_sync_runtime_lease",
    {
      p_job_name: jobName,
      p_holder: holder,
      p_ttl_seconds: Math.max(10, Math.trunc(ttlSeconds)),
    },
    timeoutMs,
  );
  if (error) throw new SheetSyncRpcError("lease_claim_failed", error);
  if (!data || data.ok !== true) throw new SheetSyncRpcError("lease_claim_invalid", null);
  if (data.acquired !== true) {
    return {
      acquired: false,
      lease: null,
      retryAfterSeconds: Math.max(1, Number(data.retry_after_seconds) || 1),
    };
  }
  return {
    acquired: true,
    lease: { jobName, holder },
    retryAfterSeconds: 0,
  };
}

export async function releaseSheetSyncLease(
  client: SheetSyncRpcClient,
  lease: SheetSyncLease,
  timeoutMs = 2_500,
): Promise<void> {
  const { error } = await sheetSyncRpcWithDeadline<Record<string, unknown>>(
    client,
    "release_sheet_sync_runtime_lease",
    { p_job_name: lease.jobName, p_holder: lease.holder },
    timeoutMs,
  );
  if (error) throw new SheetSyncRpcError("lease_release_failed", error);
}

export function sheetSyncDatabaseErrorIsRetryable(error: unknown): boolean {
  const code = error instanceof SheetSyncRpcError
    ? error.code
    : String((error as SheetSyncRpcErrorLike | null)?.code ?? "");
  return ["57014", "55P03", "40P01", "53300", "53400"].includes(code);
}
