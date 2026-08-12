import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

/**
 * The GitHub App private key can be provided as:
 *  - a raw PEM (with real newlines) — e.g. Fly.io multiline secret
 *  - a PEM with literal "\n" sequences — e.g. some CI secret stores
 *  - base64 of the PEM — safest for single-line env stores
 */
function resolvePrivateKey(): string {
  const raw = required("GITHUB_APP_PRIVATE_KEY");
  if (raw.includes("BEGIN") && raw.includes("PRIVATE KEY")) {
    return raw.replace(/\\n/g, "\n");
  }
  // assume base64-encoded PEM
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  if (!decoded.includes("BEGIN")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is neither a PEM nor valid base64 PEM",
    );
  }
  return decoded;
}

export const config = {
  port: Number(optional("PORT", "8080")),

  // --- GitHub App identity ---
  appId: required("GITHUB_APP_ID"),
  privateKey: resolvePrivateKey(),
  webhookSecret: required("GITHUB_WEBHOOK_SECRET"),

  // --- aster / OpenRouter ---
  openrouterKey: required("OPENROUTER_API_KEY"),
  asterBaseUrl: optional("ASTER_BASE_URL", "https://openrouter.ai/api/v1"),
  // Orchestration / default model (kept cheap).
  model: optional("ASTER_MODEL", "openai/gpt-4o-mini"),
  // Cheap first pass that drafts candidate findings.
  hypothesisModel: optional("ASTER_HYPOTHESIS_MODEL", "openai/gpt-4o-mini"),
  // Stronger model that refutes/verifies each candidate before it is posted.
  verifyModel: optional("ASTER_VERIFY_MODEL", "anthropic/claude-sonnet-4"),
  effort: optional("ASTER_EFFORT", "medium"),

  // --- review behavior ---
  // Findings below this confidence (0..1) are dropped before commenting.
  minConfidence: Number(optional("MIN_CONFIDENCE", "0.6")),

  // Cost guard 1: re-review a PR when new commits are pushed (`synchronize`).
  // Default true = current behavior. Set REVIEW_ON_SYNCHRONIZE=false to review
  // only when a PR is opened / reopened / marked ready — one review per PR.
  reviewOnSynchronize:
    optional("REVIEW_ON_SYNCHRONIZE", "true").toLowerCase() !== "false",

  // Cost guard 2: skip the review when a PR's changed lines (additions +
  // deletions) exceed this. 0 = no limit (default = current behavior).
  maxDiffLines: Number(optional("MAX_DIFF_LINES", "0")),
  // Max concurrent aster runs on this instance.
  concurrency: Number(optional("REVIEW_CONCURRENCY", "2")),
  // Coalesce rapid pushes to the same PR within this window (ms).
  debounceMs: Number(optional("REVIEW_DEBOUNCE_MS", "8000")),
  // Hard timeout for a single aster run (ms). Default 15 min.
  reviewTimeoutMs: Number(optional("REVIEW_TIMEOUT_MS", String(15 * 60_000))),
} as const;

export type Config = typeof config;
