import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { App } from "@octokit/app";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

export interface ReviewJob {
  app: App;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  /** The webhook action that triggered this job (opened, synchronize, …). */
  action: string;
  /** Diff size (additions + deletions) from the webhook payload. */
  changedLines: number;
  key: string;
}

/**
 * Run aster against a single PR. aster fetches the diff via the GitHub API
 * (using GITHUB_TOKEN), runs its verification-first pipeline against OpenRouter,
 * and posts findings as an inline PR review — all in one process. We just
 * supply credentials and configuration through the environment.
 */
export async function runReview(job: ReviewJob): Promise<void> {
  const label = `${job.owner}/${job.repo}#${job.prNumber}`;

  // One installation-scoped client, reused for both the "too large" notice
  // (REST) and to mint the raw token aster needs (auth).
  const octokit = await job.app.getInstallationOctokit(job.installationId);

  // Cost guard 2: bail out before spending any tokens on oversized PRs.
  if (config.maxDiffLines > 0 && job.changedLines > config.maxDiffLines) {
    console.log(
      `[review] ${label} skipped: ${job.changedLines} changed lines > MAX_DIFF_LINES=${config.maxDiffLines}`,
    );
    // Post the notice once, on the initial open — not on every pushed commit.
    if (job.action !== "synchronize") {
      try {
        await octokit.request(
          "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
          {
            owner: job.owner,
            repo: job.repo,
            issue_number: job.prNumber,
            body:
              `🤖 **aster** skipped automated review: this PR changes ` +
              `**${job.changedLines.toLocaleString()} lines**, over the ` +
              `${config.maxDiffLines.toLocaleString()}-line limit for auto-review. ` +
              `Consider splitting it into smaller PRs for a useful review.`,
          },
        );
      } catch (err) {
        console.error(`[review] ${label} failed to post too-large notice:`, err);
      }
    }
    return;
  }

  // A GitHub App installation token is a valid Bearer token for the REST API,
  // and any review aster posts with it appears as the App (YourApp[bot]).
  const auth = (await octokit.auth({
    type: "installation",
    installationId: job.installationId,
  })) as { token: string };
  const token = auth.token;

  const args = [
    "review",
    "--pr",
    String(job.prNumber),
    "--repo",
    `${job.owner}/${job.repo}`,
    "--comment", // post findings as a PR review
    "--yes", // non-interactive: skip the confirmation prompt
    "--min-confidence",
    String(config.minConfidence),
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // GitHub auth for fetching the diff and posting the review.
    GITHUB_TOKEN: token,
    // aster reads the provider key from ASTER_API_KEY (OpenAI-compatible).
    ASTER_API_KEY: config.openrouterKey,
    ASTER_BASE_URL: config.asterBaseUrl,
    ASTER_MODEL: config.model,
    ASTER_HYPOTHESIS_MODEL: config.hypothesisModel,
    ASTER_VERIFY_MODEL: config.verifyModel,
    ASTER_EFFORT: config.effort,
  };

  console.log(
    `[review] ${label} starting (${job.action}, ${job.changedLines} lines, sha ${job.headSha.slice(0, 7)})`,
  );
  const startedAt = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync("aster", args, {
      env,
      timeout: config.reviewTimeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (stdout.trim()) console.log(`[aster:${label}]\n${stdout.trim()}`);
    if (stderr.trim()) console.warn(`[aster:${label}:stderr]\n${stderr.trim()}`);
    console.log(
      `[review] ${label} done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );

    // aster prints "Posted N comment(s)" when it found issues; anything else
    // (e.g. "Nothing posted.") means the PR came back clean. In that case,
    // leave a positive sign-off so the author knows the bot actually ran.
    const posted = /Posted\s+(\d+)\s+comment/i.exec(`${stdout}\n${stderr}`);
    const postedCount = posted ? Number(posted[1]) : 0;
    if (postedCount === 0 && config.cleanReviewMode !== "off") {
      await postCleanSignoff(octokit, job, config.cleanReviewMode);
    }
  } catch (err) {
    // execFile rejects on non-zero exit, timeout, or spawn failure.
    const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
    if (e.stdout?.trim()) console.log(`[aster:${label}]\n${e.stdout.trim()}`);
    if (e.stderr?.trim()) console.error(`[aster:${label}:stderr]\n${e.stderr.trim()}`);
    console.error(
      `[review] ${label} FAILED after ${((Date.now() - startedAt) / 1000).toFixed(1)}s${
        e.killed ? " (timed out / killed)" : ""
      }: ${e.message}`,
    );
    throw err;
  }
}

type InstallationOctokit = Awaited<ReturnType<App["getInstallationOctokit"]>>;

/**
 * Leave a positive review when a PR comes back clean, so the author sees the
 * bot ran. `approve` submits a formal APPROVE; `comment` posts a neutral note.
 */
async function postCleanSignoff(
  octokit: InstallationOctokit,
  job: ReviewJob,
  mode: "comment" | "approve",
): Promise<void> {
  const event = mode === "approve" ? "APPROVE" : "COMMENT";
  const body =
    "✅ **aster** reviewed this PR and found no high-confidence issues.";
  try {
    await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        owner: job.owner,
        repo: job.repo,
        pull_number: job.prNumber,
        event,
        body,
      },
    );
    console.log(
      `[review] ${job.owner}/${job.repo}#${job.prNumber} clean — posted ${event} sign-off`,
    );
  } catch (err) {
    console.error(
      `[review] ${job.owner}/${job.repo}#${job.prNumber} clean sign-off failed:`,
      err,
    );
  }
}
