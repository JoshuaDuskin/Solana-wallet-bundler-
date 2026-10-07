import { NextRequest, NextResponse } from "next/server";

type Bucket = { started: number; count: number };
const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

function clientId(request: NextRequest, scope: string) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || request.headers.get("x-real-ip") || "unknown";
  return `${scope}:${address}`;
}

function expectedOrigin(request: NextRequest) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!host) return null;
  const protocol = request.headers.get("x-forwarded-proto") || "https";
  return `${protocol}://${host}`;
}

export function rejectIfUnsafe(request: NextRequest, scope: string, limit: number) {
  const origin = request.headers.get("origin");
  const expected = expectedOrigin(request);
  if (!origin || !expected || origin !== expected) {
    return NextResponse.json({ error: "Same-origin requests only" }, { status: 403, headers: securityHeaders() });
  }

  const now = Date.now();
  const key = clientId(request, scope);
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.started >= WINDOW_MS) {
    buckets.set(key, { started: now, count: 1 });
  } else {
    bucket.count += 1;
    if (bucket.count > limit) {
      return NextResponse.json(
        { error: "Too many requests. Try again shortly." },
        { status: 429, headers: { ...securityHeaders(), "Retry-After": "60" } },
      );
    }
  }
  if (buckets.size > 5000) {
    for (const [key, value] of buckets) {
      if (now - value.started >= WINDOW_MS) buckets.delete(key);
    }
  }
  return null;
}

export async function readJson<T>(request: NextRequest) {
  const length = Number(request.headers.get("content-length") || "0");
  if (length > 250_000) throw Error("Request body is too large");
  try {
    return (await request.json()) as T;
  } catch {
    throw Error("Invalid JSON request");
  }
}

export function securityHeaders() {
  return {
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

export function json<T>(body: T, status = 200) {
  return NextResponse.json(body, { status, headers: securityHeaders() });
}

export function errorResponse(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : "Request failed";
  return json({ error: message.slice(0, 240) }, status);
}

export function isBase64(value: unknown, maxLength = 250_000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

export function isDecimalInteger(value: unknown) {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) && value.length <= 30;
}
