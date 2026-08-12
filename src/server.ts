import http from "node:http";
import { App } from "@octokit/app";
import { createNodeMiddleware } from "@octokit/webhooks";
import { config } from "./config.js";
import { enqueueReview } from "./queue.js";

const app = new App({
  appId: config.appId,
  privateKey: config.privateKey,
  webhooks: { secret: config.webhookSecret },
});

// PR actions worth (re)reviewing. `synchronize` = new commits pushed.
const REVIEWABLE_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
]);

app.webhooks.on("pull_request", async ({ payload }) => {
  const { action, pull_request: pr, repository } = payload;
  // `installation` is present on App webhook deliveries but isn't uniformly
  // typed across every pull_request action variant, so read it defensively.
  const installationId = (payload as { installation?: { id: number } })
    .installation?.id;

  if (!REVIEWABLE_ACTIONS.has(action)) return;
  if (pr.draft) return; // don't review drafts
  if (pr.user?.type === "Bot") return; // don't review bot-authored PRs
  if (!installationId) return; // should always be present for App webhooks

  // Cost guard 1: skip re-reviews on new pushes when disabled.
  if (action === "synchronize" && !config.reviewOnSynchronize) {
    console.log(
      `[webhook] skip ${repository.owner.login}/${repository.name}#${pr.number} (synchronize disabled)`,
    );
    return;
  }

  // Fire-and-forget: schedule the review and let the handler return so
  // GitHub gets its 2xx well within the webhook timeout. The actual aster
  // run happens in the background via the queue.
  enqueueReview({
    app,
    installationId,
    owner: repository.owner.login,
    repo: repository.name,
    prNumber: pr.number,
    headSha: pr.head.sha,
    action,
    // additions + deletions is present on the pull_request webhook payload,
    // so cost guard 2 needs no extra API call to know the diff size.
    changedLines: (pr.additions ?? 0) + (pr.deletions ?? 0),
  });

  console.log(
    `[webhook] queued ${repository.owner.login}/${repository.name}#${pr.number} (${action})`,
  );
});

app.webhooks.onError((err) => {
  console.error("[webhook] error:", err);
});

// Webhooks-only middleware (no OAuth routes). Handles HMAC verification.
const middleware = createNodeMiddleware(app.webhooks, {
  path: "/api/github/webhooks",
});

const server = http.createServer(async (req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (await middleware(req, res)) return;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(config.port, () => {
  console.log(
    `aster-pr-app listening on :${config.port} — webhook path /api/github/webhooks`,
  );
});
