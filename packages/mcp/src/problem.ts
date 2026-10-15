/** RFC 9457 problem+json responses, shaped like docs/contracts/m0.md §6.1 (end). */
export interface ProblemOptions {
  /** Stable `MONACA_*` code; also derives the `type` URI and, by default, the title. */
  code: string;
  status: number;
  detail?: string;
  title?: string;
  /** Request path the problem refers to. */
  instance?: string;
  headers?: Record<string, string>;
}

const PROBLEM_TYPE_BASE = "https://monaca.dev/errors/";

/** `MONACA_INSUFFICIENT_SCOPE` -> `insufficient_scope`. */
export function problemSlug(code: string): string {
  return code.replace(/^MONACA_/, "").toLowerCase();
}

function defaultTitle(code: string): string {
  const words = problemSlug(code).replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function problemBody(options: ProblemOptions): Record<string, unknown> {
  return {
    type: `${PROBLEM_TYPE_BASE}${problemSlug(options.code)}`,
    title: options.title ?? defaultTitle(options.code),
    status: options.status,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.instance === undefined ? {} : { instance: options.instance }),
    monaca_error_code: options.code,
  };
}

export function problemResponse(options: ProblemOptions): Response {
  return new Response(JSON.stringify(problemBody(options)), {
    status: options.status,
    headers: {
      "content-type": "application/problem+json",
      "cache-control": "no-store",
      ...options.headers,
    },
  });
}
