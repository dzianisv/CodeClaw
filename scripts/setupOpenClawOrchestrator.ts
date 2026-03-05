#!/usr/bin/env bun
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, createSign, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

type CliOptions = {
  dryRun: boolean;
  model: string;
  refreshGithubTokenOnly: boolean;
  githubOwners: string[];
  githubRefreshIntervalSeconds: number;
  strictGithubInstallations: boolean;
  restartGatewayOnRefresh: boolean;
  appId?: string;
  appClientId?: string;
  appClientSecret?: string;
  appWebhookSecret?: string;
  appPrivateKeyPath?: string;
  appPrivateKey?: string;
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type GitHubAppConfig = {
  appId: string;
  appClientId?: string;
  appClientSecret?: string;
  appWebhookSecret?: string;
  appPrivateKeyPath: string;
  appPrivateKeyPem: string;
};

type GitHubInstallation = {
  id: number;
  account: {
    login: string;
    type?: string;
  };
};

type GitHubInstallationToken = {
  owner: string;
  installationId: number;
  token: string;
  expiresAt: string;
};

type GitHubRefreshResult = {
  primary: GitHubInstallationToken;
  tokens: GitHubInstallationToken[];
  missingOwners: string[];
  envUpdates: Record<string, string>;
  launchAgentPath: string;
};

type GitHubAppIdentity = {
  appLogin: string;
  assigneeLogins: string[];
  mentionHandles: string[];
};

type BinaryPaths = {
  openclaw: string;
  bun: string;
  launchctl: string;
};

type RunCommandOptions = {
  dryRun: boolean;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  secretValues?: string[];
};

type GitHubMentionHookSetupResult = {
  hooksEnabled: boolean;
  webhookPath: string;
  transformPath?: string;
  appLogin: string;
  mentionHandles: string[];
};

type LocalhostReadinessResult = {
  hooksEnabled: boolean;
  githubMappingPresent: boolean;
  githubChannelConfigured: boolean;
  githubChannelRunning: boolean;
  githubWebhookPath?: string;
};

const DEFAULT_MODEL = "gpt-5.3-codex";
const DEFAULT_GITHUB_OWNERS: string[] = [];
const DEFAULT_GITHUB_REFRESH_INTERVAL_SECONDS = 40 * 60;
const GITHUB_HOOK_MAPPING_ID = "github";
const GITHUB_HOOK_PATH = "github";
const GITHUB_HOOK_TRANSFORM_MODULE = "github-mentions.ts";
const HOOKS_TRANSFORMS_DIR = "~/.openclaw/hooks/transforms";
const LAUNCH_AGENT_LABEL = "ai.openclaw.github-app-token-refresh";
const AUTOMATION_POLICY_START = "<!-- CODECLAW_GITHUB_AUTOMATION_START -->";
const AUTOMATION_POLICY_END = "<!-- CODECLAW_GITHUB_AUTOMATION_END -->";

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(homedir(), ".openclaw");
  const runtimeEnvPath = path.join(stateDir, ".env");
  const codexEnvPath = path.join(homedir(), ".env.d", "codex.env");
  const githubEnvPath = path.join(homedir(), ".env.d", "github.env");

  const codexEnv = parseEnvFile(codexEnvPath);
  const githubEnv = parseEnvFile(githubEnvPath);
  const runtimeEnv = parseEnvFile(runtimeEnvPath);
  const mergedEnv: Record<string, string | undefined> = {
    ...codexEnv,
    ...githubEnv,
    ...runtimeEnv,
    ...process.env,
  };
  const preservedGatewayToken =
    optsFromEnv(mergedEnv.OPENCLAW_GATEWAY_TOKEN) || readGatewayTokenFromConfig(stateDir);

  const binaryPaths = resolveBinaryPaths();
  ensureLaunchdCliShim("codex", opts.dryRun);
  ensureLaunchdCliShim("opencode", opts.dryRun);
  // Preserve absolute binary paths for subprocesses launched from restricted envs (e.g. launchd).
  process.env.OPENCLAW_BIN = binaryPaths.openclaw;
  process.env.BUN_BIN = binaryPaths.bun;
  process.env.LAUNCHCTL_BIN = binaryPaths.launchctl;

  if (opts.refreshGithubTokenOnly) {
    log("Refreshing GitHub App installation tokens");
    const githubApp = resolveGitHubAppConfig(opts, mergedEnv, stateDir, opts.dryRun);
    if (!githubApp) {
      throw new Error(
        "GitHub App credentials are missing. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH (or GITHUB_APP_PRIVATE_KEY) in ~/.openclaw/.env or pass CLI args.",
      );
    }

    const refreshResult = await refreshGithubTokensAndConfigureOpenClaw({
      githubApp,
      owners: opts.githubOwners,
      stateDir,
      runtimeEnvPath,
      dryRun: opts.dryRun,
      strictInstallations: opts.strictGithubInstallations,
      restartGatewayOnRefresh: opts.restartGatewayOnRefresh,
    });

    log("GitHub token refresh completed");
    console.log(
      JSON.stringify(
        {
          primaryOwner: refreshResult.primary.owner,
          primaryInstallationId: refreshResult.primary.installationId,
          primaryTokenExpiresAt: refreshResult.primary.expiresAt,
          refreshedOwners: refreshResult.tokens.map((token) => token.owner),
          missingOwners: refreshResult.missingOwners,
          launchAgentPath: refreshResult.launchAgentPath,
          dryRun: opts.dryRun,
        },
        null,
        2,
      ),
    );
    return;
  }

  log("Loading Azure credentials");
  const azureApiKey =
    optsFromEnv(process.env.AZURE_API_KEY, process.env.AZURE_OPENAI_API_KEY) ||
    optsFromEnv(mergedEnv.AZURE_API_KEY, mergedEnv.AZURE_OPENAI_API_KEY);
  const azureBaseUrlRaw =
    optsFromEnv(process.env.AZURE_BASE_URL, process.env.AZURE_OPENAI_BASE_URL) ||
    optsFromEnv(mergedEnv.AZURE_BASE_URL, mergedEnv.AZURE_OPENAI_BASE_URL);

  if (!azureApiKey) {
    throw new Error(
      "Missing Azure key. Set AZURE_API_KEY or AZURE_OPENAI_API_KEY (or add to ~/.env.d/codex.env).",
    );
  }
  if (!azureBaseUrlRaw) {
    throw new Error(
      "Missing Azure base URL. Set AZURE_BASE_URL or AZURE_OPENAI_BASE_URL (or add to ~/.env.d/codex.env).",
    );
  }

  const azureBaseUrl = normalizeAzureBaseUrl(azureBaseUrlRaw);
  const desiredCustomProviderId = deriveCustomProviderIdFromBaseUrl(azureBaseUrl);
  const runtimeEnvVars: Record<string, string> = {
    AZURE_API_KEY: azureApiKey,
    AZURE_OPENAI_API_KEY: azureApiKey,
    AZURE_BASE_URL: azureBaseUrl,
    AZURE_OPENAI_BASE_URL: azureBaseUrl,
    CUSTOM_API_KEY: azureApiKey,
  };

  const githubApp = resolveGitHubAppConfig(opts, mergedEnv, stateDir, opts.dryRun);
  let githubRefresh: GitHubRefreshResult | undefined;
  let configuredGithubOwners = dedupeOwners(opts.githubOwners);
  if (githubApp) {
    log("Refreshing GitHub App installation tokens and wiring OpenClaw gh-issues skill");
    githubRefresh = await refreshGithubTokensAndConfigureOpenClaw({
      githubApp,
      owners: opts.githubOwners,
      stateDir,
      runtimeEnvPath,
      dryRun: opts.dryRun,
      strictInstallations: opts.strictGithubInstallations,
      restartGatewayOnRefresh: false,
    });
    configuredGithubOwners = dedupeOwners(
      opts.githubOwners.length > 0
        ? opts.githubOwners
        : githubRefresh.tokens.map((token) => token.owner),
    );

    runtimeEnvVars.GITHUB_APP_ID = githubApp.appId;
    runtimeEnvVars.GITHUB_APP_PRIVATE_KEY_PATH = githubApp.appPrivateKeyPath;
    if (githubApp.appClientId) runtimeEnvVars.GITHUB_APP_CLIENT_ID = githubApp.appClientId;
    if (githubApp.appClientSecret) runtimeEnvVars.GITHUB_APP_CLIENT_SECRET = githubApp.appClientSecret;
    if (githubApp.appWebhookSecret) runtimeEnvVars.GITHUB_APP_WEBHOOK_SECRET = githubApp.appWebhookSecret;
    runtimeEnvVars.GITHUB_APP_INSTALL_TARGETS = configuredGithubOwners.join(",");
    runtimeEnvVars.GITHUB_APP_TOKEN_REFRESH_INTERVAL_SECONDS = String(opts.githubRefreshIntervalSeconds);
    runtimeEnvVars.GITHUB_APP_PRIMARY_INSTALLATION_OWNER = githubRefresh.primary.owner;
    runtimeEnvVars.GITHUB_APP_PRIMARY_INSTALLATION_ID = String(githubRefresh.primary.installationId);
    runtimeEnvVars.GITHUB_APP_PRIMARY_TOKEN_EXPIRES_AT = githubRefresh.primary.expiresAt;
    runtimeEnvVars.GH_TOKEN = githubRefresh.primary.token;
    runtimeEnvVars.GITHUB_TOKEN = githubRefresh.primary.token;
    runtimeEnvVars.GITHUB_APP_TOKEN_SOURCE = "github-app-installation";
  }
  const githubWebhookSecret = optsFromEnv(
    opts.appWebhookSecret,
    process.env.GITHUB_APP_WEBHOOK_SECRET,
    runtimeEnvVars.GITHUB_APP_WEBHOOK_SECRET,
    mergedEnv.GITHUB_APP_WEBHOOK_SECRET,
  );
  const githubAppIdentity = await resolveGitHubAppIdentity({
    githubApp,
    env: mergedEnv,
    dryRun: opts.dryRun,
  });
  runtimeEnvVars.GITHUB_APP_LOGIN = githubAppIdentity.appLogin;
  runtimeEnvVars.OPENCLAW_GITHUB_APP_LOGIN = githubAppIdentity.appLogin;
  runtimeEnvVars.GITHUB_APP_SLUG = githubAppIdentity.appLogin;

  log("Ensuring OpenClaw CLI can read current config");
  const versionProbe = runCommand(["openclaw", "--version"], { allowFailure: true, dryRun: opts.dryRun });
  const versionOutput = `${versionProbe.stdout}\n${versionProbe.stderr}`;
  if (versionOutput.includes("Config was last written by a newer OpenClaw")) {
    log("Detected CLI/config version mismatch, attempting OpenClaw self-update");
    runCommand(["openclaw", "update", "--yes", "--no-restart"], {
      allowFailure: true,
      dryRun: opts.dryRun,
    });
  }

  log("Writing runtime env for OpenClaw service");
  upsertEnvFile(runtimeEnvPath, runtimeEnvVars, opts.dryRun);

  const providerAlreadyConfigured = isProviderAlreadyConfigured({
    providerId: desiredCustomProviderId,
    modelId: opts.model,
    expectedBaseUrl: azureBaseUrl,
    dryRun: opts.dryRun,
  });
  if (providerAlreadyConfigured) {
    log("Skipping onboarding; Azure custom provider is already configured");
  } else {
    log("Running non-interactive OpenClaw onboarding with Azure custom provider");
    runCommand(
      [
        "openclaw",
        "onboard",
        "--non-interactive",
        "--accept-risk",
        "--mode",
        "local",
        "--auth-choice",
        "custom-api-key",
        "--custom-base-url",
        azureBaseUrl,
        "--custom-provider-id",
        desiredCustomProviderId,
        "--custom-model-id",
        opts.model,
        "--custom-compatibility",
        "openai",
        "--install-daemon",
        "--daemon-runtime",
        "bun",
        "--skip-channels",
        "--skip-skills",
        "--skip-ui",
        "--json",
      ],
      {
        dryRun: opts.dryRun,
        env: {
          ...process.env,
          CUSTOM_API_KEY: azureApiKey,
        },
        secretValues: [azureApiKey],
      },
    );
  }

  log("Resolving configured custom provider for selected model");
  const providerId =
    resolveCustomProviderIdForModel({
      modelId: opts.model,
      baseUrl: azureBaseUrl,
      dryRun: opts.dryRun,
    }) ?? desiredCustomProviderId;
  const modelRef = providerId ? `${providerId}/${opts.model}` : opts.model;
  if (providerId) {
    runCommand(["openclaw", "models", "set", modelRef], { dryRun: opts.dryRun });
    if (shouldUseAzureResponsesApi(azureBaseUrl, opts.model)) {
      log("Configuring Azure custom provider to use OpenAI Responses API");
      configureAzureResponsesProvider({
        stateDir,
        providerId,
        modelId: opts.model,
        azureBaseUrl,
        dryRun: opts.dryRun,
      });
    }
  }
  log("Enabling coding tool profile for orchestration skills (gh-issues, coding-agent)");
  runCommand(["openclaw", "config", "set", "tools.profile", "coding"], { dryRun: opts.dryRun });
  if (preservedGatewayToken) {
    log("Reapplying stable gateway token to avoid Control UI disconnects across reruns");
    runCommand(["openclaw", "config", "set", "gateway.auth.mode", "token"], { dryRun: opts.dryRun });
    runCommand(["openclaw", "config", "set", "gateway.auth.token", preservedGatewayToken], {
      dryRun: opts.dryRun,
      secretValues: [preservedGatewayToken],
    });
  }
  log("Configuring GitHub mention hook orchestration");
  const githubMentionHooks = configureGithubMentionHooks({
    runtimeEnvPath,
    dryRun: opts.dryRun,
    githubWebhookSecret,
    appIdentity: githubAppIdentity,
  });
  log("Ensuring GitHub hook automation policy in workspace instructions");
  const workspacePolicyPath = ensureGithubAutomationWorkspacePolicy({
    stateDir,
    dryRun: opts.dryRun,
  });

  log("Installing and restarting OpenClaw gateway service");
  runCommand(["openclaw", "gateway", "install", "--runtime", "bun", "--force"], {
    allowFailure: true,
    dryRun: opts.dryRun,
  });
  runCommand(["openclaw", "gateway", "restart"], { dryRun: opts.dryRun });

  log("Running health verification");
  runCommand(["openclaw", "gateway", "status"], { dryRun: opts.dryRun });
  runCommand(["openclaw", "gateway", "health", "--json"], { dryRun: opts.dryRun });
  runCommand(["openclaw", "models", "status", "--json"], { dryRun: opts.dryRun, allowFailure: true });
  const dashboardUrl = resolveDashboardUrl(opts.dryRun);
  const dashboardUrlPath = dashboardUrl
    ? writeDashboardUrlFile({
        stateDir,
        url: dashboardUrl,
        dryRun: opts.dryRun,
      })
    : undefined;
  const dashboardEnvUpdates: Record<string, string> = {};
  if (dashboardUrl) {
    dashboardEnvUpdates.OPENCLAW_DASHBOARD_URL = dashboardUrl;
    const dashboardToken = extractDashboardToken(dashboardUrl);
    if (dashboardToken) {
      dashboardEnvUpdates.OPENCLAW_GATEWAY_TOKEN = dashboardToken;
    }
    upsertEnvFile(runtimeEnvPath, dashboardEnvUpdates, opts.dryRun);
  }
  log("Verifying localhost readiness for hook + GitHub channel flow");
  const localhostReadiness = verifyLocalhostReadiness(opts.dryRun);

  let launchAgentPath: string | undefined;
  if (githubApp) {
    log("Installing launchd refresh job for GitHub App installation tokens");
    launchAgentPath = installGitHubRefreshLaunchAgent({
      dryRun: opts.dryRun,
      stateDir,
      owners: configuredGithubOwners,
      refreshIntervalSeconds: opts.githubRefreshIntervalSeconds,
      strictGithubInstallations: opts.strictGithubInstallations,
      restartGatewayOnRefresh: opts.restartGatewayOnRefresh,
      binaryPaths,
    });
  }

  log("Setup completed");
  console.log(
    JSON.stringify(
      {
        stateDir,
        runtimeEnvPath,
        model: modelRef,
        azureBaseUrl,
        githubAppLinked: Boolean(githubApp),
        githubOwners: configuredGithubOwners,
        githubPrimaryOwner: githubRefresh?.primary.owner,
        githubPrimaryTokenExpiresAt: githubRefresh?.primary.expiresAt,
        dashboardUrl,
        dashboardUrlPath,
        webhookPath: githubMentionHooks.webhookPath,
        hooksEnabled: githubMentionHooks.hooksEnabled,
        transformPath: githubMentionHooks.transformPath,
        githubAppLogin: githubMentionHooks.appLogin,
        mentionHandles: githubMentionHooks.mentionHandles,
        workspacePolicyPath,
        localhostReadiness,
        launchAgentPath,
        dryRun: opts.dryRun,
      },
      null,
      2,
    ),
  );
}

async function resolveGitHubAppIdentity(input: {
  githubApp?: GitHubAppConfig;
  env: Record<string, string | undefined>;
  dryRun: boolean;
}): Promise<GitHubAppIdentity> {
  const explicitLogin = normalizeGitHubAppLogin(
    optsFromEnv(
      process.env.OPENCLAW_GITHUB_APP_LOGIN,
      process.env.GITHUB_APP_LOGIN,
      input.env.OPENCLAW_GITHUB_APP_LOGIN,
      input.env.GITHUB_APP_LOGIN,
    ),
  );
  if (explicitLogin) {
    return buildGitHubAppIdentity(explicitLogin);
  }

  if (!input.githubApp) {
    if (input.dryRun) {
      return buildGitHubAppIdentity("githubapp");
    }
    throw new Error(
      "GitHub App login is not configured. Set GITHUB_APP_LOGIN (or OPENCLAW_GITHUB_APP_LOGIN), or provide GitHub App credentials so login can be resolved automatically.",
    );
  }

  if (input.dryRun) {
    return buildGitHubAppIdentity("githubapp");
  }

  const appJwt = createGitHubAppJwt(input.githubApp.appId, input.githubApp.appPrivateKeyPem);
  const appDetails = await getGitHubAppDetails(appJwt);
  const resolvedLogin = normalizeGitHubAppLogin(appDetails.slug);
  if (!resolvedLogin) {
    throw new Error("Failed to resolve GitHub App login from GitHub API /app response.");
  }
  return buildGitHubAppIdentity(resolvedLogin);
}

async function getGitHubAppDetails(appJwt: string): Promise<{ slug: string }> {
  const response = await fetch("https://api.github.com/app", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "setup-openclaw-orchestrator",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to resolve GitHub App login: HTTP ${response.status} ${text}`);
  }
  const payload = (await response.json()) as { slug?: unknown };
  if (typeof payload.slug !== "string" || !payload.slug.trim()) {
    throw new Error("GitHub API /app response did not include a valid app slug.");
  }
  return { slug: payload.slug.trim() };
}

function buildGitHubAppIdentity(login: string): GitHubAppIdentity {
  const normalized = normalizeGitHubAppLogin(login);
  if (!normalized) {
    throw new Error("GitHub App login cannot be empty.");
  }
  const base = normalized.endsWith("[bot]") ? normalized.slice(0, -5) : normalized;
  const assigneeLogins = uniqueLower([base, `${base}[bot]`]);
  const mentionHandles = assigneeLogins.map((entry) => `@${entry}`);
  return {
    appLogin: base,
    assigneeLogins,
    mentionHandles,
  };
}

function normalizeGitHubAppLogin(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const cleaned = withoutAt.trim().toLowerCase();
  return cleaned || undefined;
}

function uniqueLower(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values.map((entry) => entry.trim().toLowerCase()).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function configureGithubMentionHooks(input: {
  runtimeEnvPath: string;
  dryRun: boolean;
  githubWebhookSecret?: string;
  appIdentity: GitHubAppIdentity;
}): GitHubMentionHookSetupResult {
  const hooksBasePath = resolveHooksBasePath(input.dryRun);
  const webhookPath = `${hooksBasePath.replace(/\/+$/, "")}/${GITHUB_HOOK_PATH}`;
  const transformPath = path.join(
    homedir(),
    ".openclaw",
    "hooks",
    "transforms",
    GITHUB_HOOK_TRANSFORM_MODULE,
  );

  const webhookSecret = input.githubWebhookSecret?.trim();
  if (!webhookSecret) {
    throw new Error(
      "GitHub hook channel requires GITHUB_APP_WEBHOOK_SECRET. Set it in ~/.openclaw/.env or pass --github-app-webhook-secret.",
    );
  }

  const runtimeEnv = parseEnvFile(input.runtimeEnvPath);
  const hooksToken =
    optsFromEnv(process.env.OPENCLAW_HOOKS_TOKEN, runtimeEnv.OPENCLAW_HOOKS_TOKEN) ?? generateHooksToken();
  upsertEnvFile(
    input.runtimeEnvPath,
    {
      OPENCLAW_HOOKS_TOKEN: hooksToken,
      GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
      OPENCLAW_GITHUB_WEBHOOK_SECRET: webhookSecret,
    },
    input.dryRun,
  );
  process.env.OPENCLAW_HOOKS_TOKEN = hooksToken;
  process.env.GITHUB_APP_WEBHOOK_SECRET = webhookSecret;
  process.env.OPENCLAW_GITHUB_WEBHOOK_SECRET = webhookSecret;

  runCommand(["launchctl", "setenv", "OPENCLAW_GITHUB_WEBHOOK_SECRET", webhookSecret], {
    dryRun: input.dryRun,
    allowFailure: true,
    secretValues: [webhookSecret],
  });

  runCommand(["openclaw", "config", "set", "hooks.enabled", "true", "--json"], { dryRun: input.dryRun });
  runCommand(["openclaw", "config", "set", "hooks.token", "${OPENCLAW_HOOKS_TOKEN}"], {
    dryRun: input.dryRun,
  });
  runCommand(["openclaw", "config", "set", "hooks.allowRequestSessionKey", "true", "--json"], {
    dryRun: input.dryRun,
  });
  runCommand(
    ["openclaw", "config", "set", "hooks.allowedSessionKeyPrefixes", '["hook:","hook:github:"]', "--json"],
    { dryRun: input.dryRun },
  );
  runCommand(["openclaw", "config", "set", "hooks.transformsDir", HOOKS_TRANSFORMS_DIR], {
    dryRun: input.dryRun,
  });
  runCommand(["openclaw", "config", "set", "hooks.mappings", JSON.stringify([buildGithubHookMapping()]), "--json"], {
    dryRun: input.dryRun,
  });
  runCommand(["openclaw", "config", "set", "channels.github.enabled", "true", "--json"], {
    dryRun: input.dryRun,
  });
  runCommand(["openclaw", "config", "set", "channels.github.botLogin", input.appIdentity.appLogin], {
    dryRun: input.dryRun,
  });
  runCommand(["openclaw", "config", "set", "channels.github.webhookSecret", "${GITHUB_APP_WEBHOOK_SECRET}"], {
    dryRun: input.dryRun,
  });

  const transformSource = renderGitHubMentionsTransformModule(input.appIdentity);
  writeFileIfChanged(transformPath, transformSource, input.dryRun);

  return {
    hooksEnabled: true,
    webhookPath,
    transformPath,
    appLogin: input.appIdentity.appLogin,
    mentionHandles: input.appIdentity.mentionHandles,
  };
}

function generateHooksToken(): string {
  return randomBytes(32).toString("hex");
}

function resolveHooksBasePath(dryRun: boolean): string {
  if (dryRun) return "/hooks";
  const result = runCommand(["openclaw", "config", "get", "hooks.path", "--json"], {
    dryRun: false,
    allowFailure: true,
  });
  if (result.code !== 0) return "/hooks";
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (typeof parsed === "string" && parsed.trim()) {
      const withSlash = parsed.startsWith("/") ? parsed : `/${parsed}`;
      const trimmed = withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
      return trimmed || "/hooks";
    }
  } catch {
    return "/hooks";
  }
  return "/hooks";
}

function buildGithubHookMapping(): Record<string, unknown> {
  return {
    id: GITHUB_HOOK_MAPPING_ID,
    match: {
      path: GITHUB_HOOK_PATH,
    },
    action: "agent",
    agentId: "main",
    wakeMode: "now",
    transform: {
      module: GITHUB_HOOK_TRANSFORM_MODULE,
    },
  };
}

function renderGitHubMentionsTransformModule(identity: GitHubAppIdentity): string {
  const serializedHandles = JSON.stringify(identity.mentionHandles);
  const assigneeLoginsLiteral = JSON.stringify(identity.assigneeLogins);
  return `import { createHmac, timingSafeEqual } from "node:crypto";

const MENTION_HANDLES = ${serializedHandles};
const ASSIGNEE_LOGINS = new Set(${assigneeLoginsLiteral});
const SELF_LOGINS = new Set(${assigneeLoginsLiteral});

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLogin(value) {
  return safeString(value).toLowerCase();
}

function getHeader(headers, key) {
  return safeString(headers?.[key.toLowerCase()] ?? headers?.[key] ?? "");
}

function sanitizeSegment(value) {
  return safeString(String(value ?? "")).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function resolveRawBody(payload) {
  if (typeof payload?.rawBody === "string") return payload.rawBody;
  if (typeof payload?.__rawBody === "string") return payload.__rawBody;
  return JSON.stringify(payload ?? {});
}

function verifySignature(headers, payload) {
  const secret = safeString(process.env.GITHUB_APP_WEBHOOK_SECRET || "");
  if (!secret) return false;
  const provided = getHeader(headers, "x-hub-signature-256").toLowerCase();
  if (!provided.startsWith("sha256=")) return false;
  const expected = \`sha256=\${createHmac("sha256", secret).update(resolveRawBody(payload)).digest("hex")}\`;
  const lhs = Buffer.from(provided);
  const rhs = Buffer.from(expected);
  if (lhs.length !== rhs.length) return false;
  return timingSafeEqual(lhs, rhs);
}

function extractGitHubContext(payload, event, action) {
  const owner = safeString(payload?.repository?.owner?.login || payload?.repository?.owner?.name || "");
  const repo = safeString(payload?.repository?.name || "");
  if (!owner || !repo) return { kind: null };

  if (event === "issues") {
    const issue = payload?.issue;
    if (!issue?.number) return { kind: null };
    const body = safeString(issue?.body || "");
    let triggerReason = "";
    if (action === "assigned") {
      if (!ASSIGNEE_LOGINS.has(normalizeLogin(payload?.assignee?.login))) return { kind: null };
      triggerReason = "assigned";
    } else if (action === "opened" || action === "edited" || action === "reopened") {
      if (!findMentionedHandle(body)) return { kind: null };
      triggerReason = "mention";
    } else {
      return { kind: null };
    }
    return {
      kind: "issue",
      threadId: String(issue.number),
      body,
      title: safeString(issue?.title || ""),
      url: safeString(issue?.html_url || ""),
      sender: payload?.sender,
      owner,
      repo,
      action,
      triggerReason,
    };
  }

  if (event === "issue_comment" && (action === "created" || action === "edited")) {
    const issue = payload?.issue;
    if (!issue?.number) return { kind: null };
    const body = safeString(payload?.comment?.body || "");
    const mentioned = findMentionedHandle(body);
    const assignedToApp =
      ASSIGNEE_LOGINS.has(normalizeLogin(issue?.assignee?.login)) ||
      (Array.isArray(issue?.assignees) &&
        issue.assignees.some((entry) => ASSIGNEE_LOGINS.has(normalizeLogin(entry?.login))));
    if (!mentioned && !assignedToApp) return { kind: null };
    return {
      kind: issue?.pull_request ? "pr" : "issue",
      threadId: String(issue.number),
      body,
      title: safeString(issue?.title || ""),
      url: safeString(payload?.comment?.html_url || issue?.html_url || ""),
      sender: payload?.comment?.user || payload?.sender,
      owner,
      repo,
      action,
      triggerReason: mentioned ? "mention" : "followup",
    };
  }

  if (event === "pull_request_review_comment" && (action === "created" || action === "edited")) {
    const body = safeString(payload?.comment?.body || "");
    if (!findMentionedHandle(body)) return { kind: null };
    const threadId = payload?.pull_request?.number;
    if (!threadId) return { kind: null };
    return {
      kind: "pr",
      threadId: String(threadId),
      body,
      title: safeString(payload?.pull_request?.title || ""),
      url: safeString(payload?.comment?.html_url || payload?.pull_request?.html_url || ""),
      sender: payload?.comment?.user || payload?.sender,
      owner,
      repo,
      action,
      triggerReason: "mention",
    };
  }

  if (event === "pull_request_review" && action === "submitted") {
    const body = safeString(payload?.review?.body || "");
    if (!findMentionedHandle(body)) return { kind: null };
    const threadId = payload?.pull_request?.number;
    if (!threadId) return { kind: null };
    return {
      kind: "pr",
      threadId: String(threadId),
      body,
      title: safeString(payload?.pull_request?.title || ""),
      url: safeString(payload?.review?.html_url || payload?.pull_request?.html_url || ""),
      sender: payload?.review?.user || payload?.sender,
      owner,
      repo,
      action,
      triggerReason: "mention",
    };
  }

  if (event === "discussion_comment" && (action === "created" || action === "edited")) {
    const body = safeString(payload?.comment?.body || "");
    if (!findMentionedHandle(body)) return { kind: null };
    const threadId = payload?.discussion?.number || payload?.discussion?.id;
    if (!threadId) return { kind: null };
    return {
      kind: "discussion",
      threadId: String(threadId),
      body,
      title: safeString(payload?.discussion?.title || ""),
      url: safeString(payload?.comment?.html_url || payload?.discussion?.html_url || ""),
      sender: payload?.comment?.user || payload?.sender,
      owner,
      repo,
      action,
      triggerReason: "mention",
    };
  }

  return { kind: null };
}

function findMentionedHandle(text) {
  const lower = safeString(text).toLowerCase();
  return MENTION_HANDLES.find((handle) => lower.includes(handle.toLowerCase()));
}

function isLoopSender(sender) {
  const login = normalizeLogin(sender?.login || "");
  const type = normalizeLogin(sender?.type || "");
  if (!login) return false;
  if (type === "bot" || login.endsWith("[bot]")) return true;
  return SELF_LOGINS.has(login);
}

export default ({ payload, headers }) => {
  if (!verifySignature(headers, payload)) return null;

  const event = getHeader(headers, "x-github-event");
  const action = safeString(payload?.action || "");
  const ctx = extractGitHubContext(payload, event, action);
  if (!ctx || !ctx.kind) return null;
  if (isLoopSender(ctx.sender)) return null;

  const deliveryTarget = ctx.kind === "discussion" ? null : \`\${ctx.owner}/\${ctx.repo}#\${ctx.threadId}\`;
  const sessionKey = \`hook:github:\${sanitizeSegment(ctx.owner)}/\${sanitizeSegment(ctx.repo)}:\${ctx.kind}:\${ctx.threadId}\`;
  const structured = {
    source: "github",
    instruction:
      "Treat this as a GitHub repository task context for this thread. Perform repository-scoped work needed to complete the request and reply with concrete results in the same thread as GitHub App. Decline unrelated host/system actions.",
    event,
    action: ctx.action,
    triggerReason: ctx.triggerReason,
    repository: \`\${ctx.owner}/\${ctx.repo}\`,
    kind: ctx.kind,
    threadId: ctx.threadId,
    url: ctx.url || null,
    title: ctx.title || null,
    sender: {
      login: safeString(ctx.sender?.login || ""),
      type: safeString(ctx.sender?.type || ""),
    },
    body: ctx.body || null,
    deliveryId: getHeader(headers, "x-github-delivery") || null,
    installationId: payload?.installation?.id ?? null,
  };
  return {
    kind: "agent",
    name: "GitHub",
    agentId: "main",
    wakeMode: "now",
    sessionKey,
    deliver: Boolean(deliveryTarget),
    channel: deliveryTarget ? "github" : undefined,
    to: deliveryTarget ?? undefined,
    message:
      "GitHub webhook event received. This thread allows repository-scoped task execution for the mentioned app. Complete requested repo work when appropriate; do not only restate the request.\\n" +
      \`\\\`\\\`json\\n\${JSON.stringify(structured, null, 2)}\\n\\\`\\\`\\\`\`,
  };
};
`;
}

function writeFileIfChanged(
  filePath: string,
  content: string,
  dryRun: boolean,
): { updated: boolean; hash: string } {
  const nextHash = createHash("sha256").update(content).digest("hex");
  if (existsSync(filePath)) {
    const current = readFileSync(filePath, "utf8");
    const currentHash = createHash("sha256").update(current).digest("hex");
    if (currentHash === nextHash) {
      return { updated: false, hash: nextHash };
    }
  }
  if (dryRun) {
    console.log(`# dry-run: would write ${filePath}`);
    return { updated: true, hash: nextHash };
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  return { updated: true, hash: nextHash };
}

async function refreshGithubTokensAndConfigureOpenClaw(input: {
  githubApp: GitHubAppConfig;
  owners: string[];
  stateDir: string;
  runtimeEnvPath: string;
  dryRun: boolean;
  strictInstallations: boolean;
  restartGatewayOnRefresh: boolean;
}): Promise<GitHubRefreshResult> {
  let owners = dedupeOwners(input.owners);
  const nowIso = new Date().toISOString();

  let tokens: GitHubInstallationToken[] = [];
  let missingOwners: string[] = [];
  let appJwt: string | undefined;
  let installations: GitHubInstallation[] | undefined;

  if (owners.length === 0) {
    if (input.dryRun) {
      owners = ["dry-run-owner"];
    } else {
      appJwt = createGitHubAppJwt(input.githubApp.appId, input.githubApp.appPrivateKeyPem);
      installations = await listGitHubAppInstallations(appJwt);
      owners = dedupeOwners(installations.map((installation) => installation.account.login));
      if (owners.length === 0) {
        throw new Error(
          "No GitHub App installations found. Install the app to at least one user or organization, then rerun.",
        );
      }
      log(
        `No --github-owner values provided. Auto-discovered installed owners: ${owners.join(", ")}`,
      );
    }
  }
  const ownerSet = new Set(owners.map((owner) => owner.toLowerCase()));

  if (input.dryRun) {
    tokens = owners.map((owner, idx) => ({
      owner,
      installationId: 1000 + idx,
      token: `dry-run-token-${owner.toLowerCase()}`,
      expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    }));
  } else {
    appJwt = appJwt ?? createGitHubAppJwt(input.githubApp.appId, input.githubApp.appPrivateKeyPem);
    installations = installations ?? (await listGitHubAppInstallations(appJwt));
    const installationByOwner = new Map(
      installations.map((installation) => [installation.account.login.toLowerCase(), installation]),
    );

    missingOwners = owners.filter((owner) => !installationByOwner.has(owner.toLowerCase()));
    if (missingOwners.length > 0 && input.strictInstallations) {
      throw new Error(
        `GitHub App is not installed for required owners: ${missingOwners.join(", ")}. Install the app in GitHub settings, then rerun.`,
      );
    }

    for (const owner of owners) {
      const installation = installationByOwner.get(owner.toLowerCase());
      if (!installation) continue;
      const accessToken = await createGitHubInstallationToken(appJwt, installation.id);
      tokens.push({
        owner,
        installationId: installation.id,
        token: accessToken.token,
        expiresAt: accessToken.expires_at,
      });
    }
  }

  if (tokens.length === 0) {
    throw new Error(
      `No GitHub installation tokens generated. Requested owners: ${owners.join(", ")}.`,
    );
  }

  const primary = tokens[0];
  const envUpdates = buildGitHubEnvUpdates({
    app: input.githubApp,
    tokens,
    primary,
    owners,
  });

  upsertEnvFile(input.runtimeEnvPath, envUpdates, input.dryRun);

  const tokenStatePath = path.join(input.stateDir, "github-app", "installations.json");
  const tokenState = {
    updatedAt: nowIso,
    primaryOwner: primary.owner,
    primaryInstallationId: primary.installationId,
    owners: tokens.map((entry) => ({
      owner: entry.owner,
      installationId: entry.installationId,
      expiresAt: entry.expiresAt,
    })),
    missingOwners,
  };
  writeJsonFile(tokenStatePath, tokenState, input.dryRun);

  configureOpenClawGitHubSkillToken(primary.token, input.dryRun);

  if (input.restartGatewayOnRefresh) {
    runCommand(["openclaw", "gateway", "restart"], { dryRun: input.dryRun, allowFailure: true });
  }

  const launchAgentPath = path.join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
  return {
    primary,
    tokens,
    missingOwners: missingOwners.filter((owner) => ownerSet.has(owner.toLowerCase())),
    envUpdates,
    launchAgentPath,
  };
}

function configureOpenClawGitHubSkillToken(token: string, dryRun: boolean) {
  runCommand(["openclaw", "config", "set", 'skills.entries["gh-issues"].enabled', "true", "--json"], {
    dryRun,
  });
  runCommand(
    ["openclaw", "config", "set", 'skills.entries["gh-issues"].apiKey', token],
    {
      dryRun,
      secretValues: [token],
    },
  );
  runCommand(
    ["openclaw", "config", "set", "channels.github.token", token],
    {
      dryRun,
      secretValues: [token],
    },
  );
  runCommand(["launchctl", "setenv", "OPENCLAW_GITHUB_TOKEN", token], {
    dryRun,
    allowFailure: true,
    secretValues: [token],
  });
}

function installGitHubRefreshLaunchAgent(input: {
  dryRun: boolean;
  stateDir: string;
  owners: string[];
  refreshIntervalSeconds: number;
  strictGithubInstallations: boolean;
  restartGatewayOnRefresh: boolean;
  binaryPaths: BinaryPaths;
}): string {
  const launchAgentPath = path.join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
  const logsDir = path.join(input.stateDir, "logs");
  if (!input.dryRun) {
    mkdirSync(path.dirname(launchAgentPath), { recursive: true });
    mkdirSync(logsDir, { recursive: true });
  }

  const scriptPath = path.resolve(process.argv[1] ?? "setupOpenClawOrchestrator.ts");
  const args = [input.binaryPaths.bun, scriptPath, "--refresh-github-token-only"];
  for (const owner of dedupeOwners(input.owners)) {
    args.push("--github-owner", owner);
  }
  if (!input.strictGithubInstallations) {
    args.push("--allow-missing-installations");
  }
  if (input.restartGatewayOnRefresh) {
    args.push("--restart-gateway-on-refresh");
  }

  const plist = renderLaunchAgentPlist({
    label: LAUNCH_AGENT_LABEL,
    programArgs: args,
    startIntervalSeconds: input.refreshIntervalSeconds,
    stdoutPath: path.join(logsDir, "github-app-token-refresh.out.log"),
    stderrPath: path.join(logsDir, "github-app-token-refresh.err.log"),
    stateDir: input.stateDir,
    binaryPaths: input.binaryPaths,
  });

  if (input.dryRun) {
    console.log(`# dry-run: would write ${launchAgentPath}`);
    return launchAgentPath;
  }

  writeFileSync(launchAgentPath, plist, "utf8");
  chmodSync(launchAgentPath, 0o644);
  const uid = process.getuid ? process.getuid() : Number(runCommand(["id", "-u"], { dryRun: false }).stdout.trim());
  const domain = `gui/${uid}`;
  const labelRef = `${domain}/${LAUNCH_AGENT_LABEL}`;
  runCommand(["launchctl", "bootout", labelRef], { dryRun: false, allowFailure: true });
  runCommand(["launchctl", "bootstrap", domain, launchAgentPath], { dryRun: false });
  runCommand(["launchctl", "enable", labelRef], { dryRun: false, allowFailure: true });
  runCommand(["launchctl", "kickstart", "-k", labelRef], { dryRun: false, allowFailure: true });
  return launchAgentPath;
}

function renderLaunchAgentPlist(input: {
  label: string;
  programArgs: string[];
  startIntervalSeconds: number;
  stdoutPath: string;
  stderrPath: string;
  stateDir: string;
  binaryPaths: BinaryPaths;
}): string {
  const argsXml = input.programArgs.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join("\n");
  const launchdPath = buildLaunchdPath(input.binaryPaths);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(input.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${input.startIntervalSeconds}</integer>
    <key>StandardOutPath</key>
    <string>${xmlEscape(input.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(input.stderrPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>OPENCLAW_STATE_DIR</key>
      <string>${xmlEscape(input.stateDir)}</string>
      <key>OPENCLAW_BIN</key>
      <string>${xmlEscape(input.binaryPaths.openclaw)}</string>
      <key>BUN_BIN</key>
      <string>${xmlEscape(input.binaryPaths.bun)}</string>
      <key>LAUNCHCTL_BIN</key>
      <string>${xmlEscape(input.binaryPaths.launchctl)}</string>
      <key>PATH</key>
      <string>${xmlEscape(launchdPath)}</string>
      <key>HOME</key>
      <string>${xmlEscape(homedir())}</string>
    </dict>
  </dict>
</plist>
`;
}

function resolveCustomProviderIdForModel(input: {
  modelId: string;
  baseUrl: string;
  dryRun: boolean;
}): string | undefined {
  if (input.dryRun) return "custom-provider";

  const providersResult = runCommand(["openclaw", "config", "get", "models.providers", "--json"], {
    allowFailure: true,
    dryRun: false,
  });
  if (providersResult.code !== 0) return undefined;

  let providers: Record<string, unknown> = {};
  try {
    providers = JSON.parse(providersResult.stdout) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  for (const [providerId, rawProvider] of Object.entries(providers)) {
    if (!rawProvider || typeof rawProvider !== "object") continue;
    const provider = rawProvider as { baseUrl?: unknown; models?: unknown[] };
    const providerBaseUrl =
      typeof provider.baseUrl === "string" ? normalizeAzureBaseUrl(provider.baseUrl) : "";
    if (providerBaseUrl !== input.baseUrl) continue;

    const models = Array.isArray(provider.models) ? provider.models : [];
    for (const model of models) {
      if (!model || typeof model !== "object") continue;
      const id = (model as { id?: unknown }).id;
      if (typeof id === "string" && id === input.modelId) return providerId;
    }
  }
  return undefined;
}

function resolveGitHubAppConfig(
  opts: CliOptions,
  env: Record<string, string | undefined>,
  stateDir: string,
  dryRun: boolean,
): GitHubAppConfig | undefined {
  const cliProvided = Boolean(
    opts.appId ||
      opts.appClientId ||
      opts.appClientSecret ||
      opts.appWebhookSecret ||
      opts.appPrivateKeyPath ||
      opts.appPrivateKey,
  );
  const appId = optsFromEnv(opts.appId, env.GITHUB_APP_ID);
  const appClientId = optsFromEnv(opts.appClientId, env.GITHUB_APP_CLIENT_ID);
  const appClientSecret = optsFromEnv(opts.appClientSecret, env.GITHUB_APP_CLIENT_SECRET);
  const appWebhookSecret = optsFromEnv(opts.appWebhookSecret, env.GITHUB_APP_WEBHOOK_SECRET);
  const providedPath = optsFromEnv(opts.appPrivateKeyPath, env.GITHUB_APP_PRIVATE_KEY_PATH);
  const inlinePrivateKey = optsFromEnv(opts.appPrivateKey, env.GITHUB_APP_PRIVATE_KEY);

  const hasAny = Boolean(
    appId || appClientId || appClientSecret || appWebhookSecret || providedPath || inlinePrivateKey,
  );
  if (!hasAny) return undefined;
  if (!appId) {
    if (!cliProvided) return undefined;
    throw new Error("GitHub App credentials detected but GITHUB_APP_ID is missing.");
  }

  let appPrivateKeyPath = providedPath
    ? path.resolve(expandHomePath(providedPath))
    : path.join(stateDir, "github-app", "private-key.pem");
  let appPrivateKeyPem = "";

  if (inlinePrivateKey) {
    appPrivateKeyPem = normalizePem(inlinePrivateKey);
  } else if (existsSync(appPrivateKeyPath)) {
    appPrivateKeyPem = readFileSync(appPrivateKeyPath, "utf8");
  } else {
    if (!cliProvided) return undefined;
    throw new Error(
      "GitHub App private key is missing. Set GITHUB_APP_PRIVATE_KEY_PATH to an existing PEM file or provide GITHUB_APP_PRIVATE_KEY.",
    );
  }

  if (inlinePrivateKey && !dryRun) {
    mkdirSync(path.dirname(appPrivateKeyPath), { recursive: true });
    writeFileSync(appPrivateKeyPath, appPrivateKeyPem, { encoding: "utf8", mode: 0o600 });
    chmodSync(appPrivateKeyPath, 0o600);
  }

  return {
    appId,
    appClientId,
    appClientSecret,
    appWebhookSecret,
    appPrivateKeyPath,
    appPrivateKeyPem,
  };
}

async function listGitHubAppInstallations(appJwt: string): Promise<GitHubInstallation[]> {
  const response = await fetch("https://api.github.com/app/installations?per_page=100", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "setup-openclaw-orchestrator",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to list GitHub App installations: HTTP ${response.status} ${text}`);
  }
  return (await response.json()) as GitHubInstallation[];
}

async function createGitHubInstallationToken(
  appJwt: string,
  installationId: number,
): Promise<{ token: string; expires_at: string }> {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "setup-openclaw-orchestrator",
      },
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to create GitHub App installation token for installation ${installationId}: HTTP ${response.status} ${text}`,
    );
  }
  const payload = (await response.json()) as { token: string; expires_at: string };
  if (!payload.token || !payload.expires_at) {
    throw new Error(`Invalid token response from GitHub for installation ${installationId}.`);
  }
  return payload;
}

function createGitHubAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${unsigned}.${signature}`;
}

function buildGitHubEnvUpdates(input: {
  app: GitHubAppConfig;
  tokens: GitHubInstallationToken[];
  primary: GitHubInstallationToken;
  owners: string[];
}): Record<string, string> {
  const updates: Record<string, string> = {
    GITHUB_APP_ID: input.app.appId,
    GITHUB_APP_PRIVATE_KEY_PATH: input.app.appPrivateKeyPath,
    GITHUB_APP_INSTALL_TARGETS: dedupeOwners(input.owners).join(","),
    GITHUB_APP_PRIMARY_INSTALLATION_OWNER: input.primary.owner,
    GITHUB_APP_PRIMARY_INSTALLATION_ID: String(input.primary.installationId),
    GITHUB_APP_PRIMARY_TOKEN_EXPIRES_AT: input.primary.expiresAt,
    OPENCLAW_GITHUB_TOKEN: input.primary.token,
    GH_TOKEN: input.primary.token,
    GITHUB_TOKEN: input.primary.token,
  };
  if (input.app.appClientId) updates.GITHUB_APP_CLIENT_ID = input.app.appClientId;
  if (input.app.appClientSecret) updates.GITHUB_APP_CLIENT_SECRET = input.app.appClientSecret;
  if (input.app.appWebhookSecret) {
    updates.GITHUB_APP_WEBHOOK_SECRET = input.app.appWebhookSecret;
    updates.OPENCLAW_GITHUB_WEBHOOK_SECRET = input.app.appWebhookSecret;
  }

  for (const token of input.tokens) {
    const key = sanitizeEnvKey(token.owner);
    updates[`GITHUB_APP_TOKEN_${key}`] = token.token;
    updates[`GITHUB_APP_TOKEN_${key}_EXPIRES_AT`] = token.expiresAt;
    updates[`GITHUB_APP_INSTALLATION_${key}_ID`] = String(token.installationId);
  }
  return updates;
}

function normalizeAzureBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  return `${url.protocol}//${url.host}`;
}

function deriveCustomProviderIdFromBaseUrl(baseUrl: string): string {
  const host = new URL(baseUrl).host.toLowerCase();
  return `custom-${host.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

function isProviderAlreadyConfigured(input: {
  providerId: string;
  modelId: string;
  expectedBaseUrl: string;
  dryRun: boolean;
}): boolean {
  if (input.dryRun) return false;
  const result = runCommand(["openclaw", "config", "get", `models.providers.${input.providerId}`, "--json"], {
    dryRun: false,
    allowFailure: true,
  });
  if (result.code !== 0) return false;

  let provider: { baseUrl?: unknown; models?: unknown[] } | undefined;
  try {
    provider = JSON.parse(result.stdout) as { baseUrl?: unknown; models?: unknown[] };
  } catch {
    return false;
  }
  if (!provider || typeof provider !== "object") return false;
  const providerBaseUrl =
    typeof provider.baseUrl === "string" ? normalizeAzureBaseUrl(provider.baseUrl) : "";
  if (providerBaseUrl !== input.expectedBaseUrl) return false;
  const models = Array.isArray(provider.models) ? provider.models : [];
  return models.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && id === input.modelId;
  });
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    dryRun: false,
    model: DEFAULT_MODEL,
    refreshGithubTokenOnly: false,
    githubOwners: [...DEFAULT_GITHUB_OWNERS],
    githubRefreshIntervalSeconds: DEFAULT_GITHUB_REFRESH_INTERVAL_SECONDS,
    strictGithubInstallations: true,
    restartGatewayOnRefresh: false,
  };

  const owners: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--model") {
      if (!next) throw new Error("--model requires a value");
      opts.model = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--refresh-github-token-only") {
      opts.refreshGithubTokenOnly = true;
      continue;
    }
    if (arg === "--github-owner") {
      if (!next) throw new Error("--github-owner requires a value");
      owners.push(next.trim());
      i += 1;
      continue;
    }
    if (arg === "--github-refresh-interval-seconds") {
      if (!next) throw new Error("--github-refresh-interval-seconds requires a value");
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 300) {
        throw new Error("--github-refresh-interval-seconds must be a number >= 300");
      }
      opts.githubRefreshIntervalSeconds = Math.floor(parsed);
      i += 1;
      continue;
    }
    if (arg === "--allow-missing-installations") {
      opts.strictGithubInstallations = false;
      continue;
    }
    if (arg === "--restart-gateway-on-refresh") {
      opts.restartGatewayOnRefresh = true;
      continue;
    }
    if (arg === "--github-app-id") {
      if (!next) throw new Error("--github-app-id requires a value");
      opts.appId = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--github-app-client-id") {
      if (!next) throw new Error("--github-app-client-id requires a value");
      opts.appClientId = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--github-app-client-secret") {
      if (!next) throw new Error("--github-app-client-secret requires a value");
      opts.appClientSecret = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--github-app-webhook-secret") {
      if (!next) throw new Error("--github-app-webhook-secret requires a value");
      opts.appWebhookSecret = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--github-app-private-key-path") {
      if (!next) throw new Error("--github-app-private-key-path requires a value");
      opts.appPrivateKeyPath = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--github-app-private-key") {
      if (!next) throw new Error("--github-app-private-key requires a value");
      opts.appPrivateKey = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (owners.length > 0) {
    opts.githubOwners = dedupeOwners(owners);
  }
  if (!opts.model) {
    throw new Error("Model cannot be empty");
  }
  return opts;
}

function ensureBinary(name: string) {
  const probe = spawnSync("/usr/bin/env", ["bash", "-lc", `command -v ${name}`], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    throw new Error(`Required binary not found: ${name}`);
  }
}

function resolveBinaryPaths(): BinaryPaths {
  return {
    openclaw: resolveBinary("openclaw"),
    bun: resolveBinary("bun"),
    launchctl: resolveBinary("launchctl"),
  };
}

function resolveBinary(name: string): string {
  ensureBinary(name);
  const probe = spawnSync("/usr/bin/env", ["bash", "-lc", `command -v ${name}`], {
    encoding: "utf8",
  });
  const resolved = (probe.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!resolved) {
    throw new Error(`Failed to resolve binary path for ${name}`);
  }
  return resolved;
}

function resolveOptionalBinary(name: string): string | undefined {
  const probe = spawnSync("/usr/bin/env", ["bash", "-lc", `command -v ${name}`], {
    encoding: "utf8",
  });
  if (probe.status !== 0) return undefined;
  const resolved = (probe.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return resolved || undefined;
}

function ensureLaunchdCliShim(commandName: string, dryRun: boolean) {
  const resolved = resolveOptionalBinary(commandName);
  if (!resolved) {
    log(`Skipping ${commandName} shim: command not found on current shell PATH`);
    return;
  }

  const shimPath = path.join("/opt/homebrew/bin", commandName);
  if (resolved === shimPath) return;

  if (dryRun) {
    console.log(`# dry-run: would symlink ${shimPath} -> ${resolved}`);
    return;
  }

  try {
    mkdirSync(path.dirname(shimPath), { recursive: true });
    if (existsSync(shimPath)) {
      const stat = lstatSync(shimPath);
      if (stat.isSymbolicLink()) {
        const currentTarget = readlinkSync(shimPath);
        if (currentTarget === resolved) return;
      }
      unlinkSync(shimPath);
    }
    symlinkSync(resolved, shimPath);
  } catch (error) {
    log(
      `Warning: failed to create ${commandName} shim at ${shimPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildLaunchdPath(binaryPaths: BinaryPaths): string {
  const raw = [
    path.dirname(binaryPaths.openclaw),
    path.dirname(binaryPaths.bun),
    path.dirname(binaryPaths.launchctl),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(raw.filter(Boolean))].join(":");
}

function runCommand(command: string[], options: RunCommandOptions): CommandResult {
  const secrets = sanitizeSecrets(options.secretValues ?? []);
  const printable = redactSecrets(
    command.map((token) => (token.includes(" ") ? JSON.stringify(token) : token)).join(" "),
    secrets,
  );
  console.log(`$ ${printable}`);

  if (options.dryRun) {
    return { code: 0, stdout: "", stderr: "" };
  }

  const env = options.env ?? process.env;
  const result = spawnSync(resolveExecutable(command[0], env), command.slice(1), {
    encoding: "utf8",
    env,
  });

  const stdout = redactSecrets(result.stdout ?? "", secrets);
  const stderr = redactSecrets(result.stderr ?? "", secrets);
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);

  const code = result.status ?? 1;
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`Command failed (${code}): ${printable}`);
  }
  return { code, stdout, stderr };
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string {
  if (command === "openclaw" && env.OPENCLAW_BIN) return env.OPENCLAW_BIN;
  if (command === "bun" && env.BUN_BIN) return env.BUN_BIN;
  if (command === "launchctl" && env.LAUNCHCTL_BIN) return env.LAUNCHCTL_BIN;
  return command;
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const output: Record<string, string> = {};
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    output[key] = stripOptionalQuotes(value);
  }
  return output;
}

function readGatewayTokenFromConfig(stateDir: string): string | undefined {
  const configPath = path.join(stateDir, "openclaw.json");
  if (!existsSync(configPath)) return undefined;
  try {
    const payload = JSON.parse(readFileSync(configPath, "utf8")) as {
      gateway?: { auth?: { token?: unknown } };
    };
    const token = payload?.gateway?.auth?.token;
    if (typeof token === "string" && token.trim()) return token.trim();
  } catch {
    return undefined;
  }
  return undefined;
}

function upsertEnvFile(filePath: string, entries: Record<string, string>, dryRun: boolean) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir) && !dryRun) mkdirSync(dir, { recursive: true });

  const existingRaw = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = existingRaw ? existingRaw.split(/\r?\n/) : [];
  const map = new Map<string, string>();
  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      map.set(line.slice(0, idx), line.slice(idx + 1));
    }
  }
  for (const [key, value] of Object.entries(entries)) {
    map.set(key, value);
  }

  const rendered = `${[...map.entries()].map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
  if (dryRun) {
    console.log(`# dry-run: would write ${filePath}`);
    return;
  }
  writeFileSync(filePath, rendered, { encoding: "utf8", mode: 0o600 });
}

function writeJsonFile(filePath: string, payload: unknown, dryRun: boolean) {
  if (dryRun) {
    console.log(`# dry-run: would write ${filePath}`);
    return;
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function resolveDashboardUrl(dryRun: boolean): string | undefined {
  if (dryRun) {
    return "http://127.0.0.1:18789/#token=dry-run-token";
  }
  const result = runCommand(["openclaw", "dashboard", "--no-open"], {
    dryRun: false,
    allowFailure: true,
  });
  if (result.code !== 0) return undefined;
  const raw = `${result.stdout}\n${result.stderr}`;
  const match = raw.match(/Dashboard URL:\s*(\S+)/i);
  return match?.[1];
}

function extractDashboardToken(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
    const params = new URLSearchParams(hash);
    const token = params.get("token");
    return token || undefined;
  } catch {
    return undefined;
  }
}

function writeDashboardUrlFile(input: {
  stateDir: string;
  url: string;
  dryRun: boolean;
}): string {
  const filePath = path.join(input.stateDir, "dashboard.url");
  if (input.dryRun) {
    console.log(`# dry-run: would write ${filePath}`);
    return filePath;
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${input.url}\n`, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

function shouldUseAzureResponsesApi(baseUrl: string, modelId: string): boolean {
  const normalizedModel = modelId.trim().toLowerCase();
  if (!normalizedModel.includes("codex")) return false;
  try {
    const host = new URL(baseUrl).host.toLowerCase();
    return host.endsWith(".openai.azure.com") || host.endsWith(".services.ai.azure.com");
  } catch {
    return false;
  }
}

function configureAzureResponsesProvider(input: {
  stateDir: string;
  providerId: string;
  modelId: string;
  azureBaseUrl: string;
  dryRun: boolean;
}) {
  const responsesBaseUrl = `${input.azureBaseUrl.replace(/\/+$/, "")}/openai/v1`;
  runCommand(
    ["openclaw", "config", "set", `models.providers.${input.providerId}.baseUrl`, responsesBaseUrl],
    { dryRun: input.dryRun },
  );
  runCommand(
    ["openclaw", "config", "set", `models.providers.${input.providerId}.api`, "openai-responses"],
    { dryRun: input.dryRun },
  );
  runCommand(
    ["openclaw", "config", "set", `models.providers.${input.providerId}.models[0].api`, "openai-responses"],
    { dryRun: input.dryRun },
  );

  const agentModelsPath = path.join(input.stateDir, "agents", "main", "agent", "models.json");
  if (input.dryRun) {
    console.log(`# dry-run: would update ${agentModelsPath}`);
    return;
  }
  if (!existsSync(agentModelsPath)) return;

  let parsed: {
    providers?: Record<string, { baseUrl?: string; api?: string; models?: Array<Record<string, unknown>> }>;
  };
  try {
    parsed = JSON.parse(readFileSync(agentModelsPath, "utf8")) as {
      providers?: Record<string, { baseUrl?: string; api?: string; models?: Array<Record<string, unknown>> }>;
    };
  } catch {
    return;
  }
  if (!parsed.providers) return;
  const provider = parsed.providers[input.providerId];
  if (!provider) return;

  provider.baseUrl = responsesBaseUrl;
  provider.api = "openai-responses";
  const providerModels = Array.isArray(provider.models) ? provider.models : [];
  for (const model of providerModels) {
    if (!model || typeof model !== "object") continue;
    const modelEntry = model as { id?: unknown; api?: unknown };
    if (typeof modelEntry.id === "string" && modelEntry.id === input.modelId) {
      modelEntry.api = "openai-responses";
    }
  }
  writeFileSync(agentModelsPath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function ensureGithubAutomationWorkspacePolicy(input: {
  stateDir: string;
  dryRun: boolean;
}): string {
  const workspacePath = resolveAgentsWorkspacePath(input.stateDir, input.dryRun);
  const agentsPath = path.join(workspacePath, "AGENTS.md");
  const policyBlock = `${AUTOMATION_POLICY_START}
## GitHub Hook Automation (CodeClaw)

For sessions that originate from GitHub hook events (session keys containing \`hook:github:\`):

- This scope is limited to repository-task execution for the current thread.
- Execute legitimate repository tasks directly (inspect repos, run local tooling, edit files, run tests).
- Reply in the same GitHub thread with concrete results; do not only paraphrase the request.
- Do not ask for extra permission to post the reply in that same thread.
- Continue to reject unrelated dangerous host/system actions.

${AUTOMATION_POLICY_END}`;
  upsertManagedBlock({
    filePath: agentsPath,
    startMarker: AUTOMATION_POLICY_START,
    endMarker: AUTOMATION_POLICY_END,
    blockContent: policyBlock,
    dryRun: input.dryRun,
  });
  return agentsPath;
}

function resolveAgentsWorkspacePath(stateDir: string, dryRun: boolean): string {
  if (dryRun) {
    return path.join(stateDir, "workspace");
  }
  const configured = runCommand(["openclaw", "config", "get", "agents.defaults.workspace", "--json"], {
    dryRun: false,
    allowFailure: true,
  });
  if (configured.code === 0) {
    try {
      const parsed = JSON.parse(configured.stdout) as unknown;
      if (typeof parsed === "string" && parsed.trim()) {
        return expandHomePath(parsed.trim());
      }
    } catch {
      // fall through to default
    }
  }
  return path.join(stateDir, "workspace");
}

function upsertManagedBlock(input: {
  filePath: string;
  startMarker: string;
  endMarker: string;
  blockContent: string;
  dryRun: boolean;
}) {
  const current = existsSync(input.filePath) ? readFileSync(input.filePath, "utf8") : "";
  const startIdx = current.indexOf(input.startMarker);
  const endIdx = current.indexOf(input.endMarker);
  let next: string;

  if (startIdx >= 0 && endIdx >= 0 && endIdx > startIdx) {
    const endInclusive = endIdx + input.endMarker.length;
    next = `${current.slice(0, startIdx)}${input.blockContent}${current.slice(endInclusive)}`;
  } else if (!current.trim()) {
    next = `${input.blockContent}\n`;
  } else {
    next = `${input.blockContent}\n\n${current}`;
  }

  if (next === current) return;
  if (input.dryRun) {
    console.log(`# dry-run: would update ${input.filePath}`);
    return;
  }
  mkdirSync(path.dirname(input.filePath), { recursive: true });
  writeFileSync(input.filePath, next, { encoding: "utf8", mode: 0o600 });
}

function verifyLocalhostReadiness(dryRun: boolean): LocalhostReadinessResult {
  if (dryRun) {
    return {
      hooksEnabled: true,
      githubMappingPresent: true,
      githubChannelConfigured: true,
      githubChannelRunning: true,
      githubWebhookPath: "/github",
    };
  }

  const hooksEnabledRaw = runCommand(["openclaw", "config", "get", "hooks.enabled", "--json"], {
    dryRun: false,
    allowFailure: true,
  });
  if (hooksEnabledRaw.code !== 0) {
    throw new Error("Localhost readiness check failed: unable to read hooks.enabled.");
  }
  let hooksEnabled = false;
  try {
    hooksEnabled = Boolean(JSON.parse(hooksEnabledRaw.stdout));
  } catch {
    hooksEnabled = false;
  }
  if (!hooksEnabled) {
    throw new Error("Localhost readiness check failed: hooks.enabled is not true.");
  }

  const mappingsRaw = runCommand(["openclaw", "config", "get", "hooks.mappings", "--json"], {
    dryRun: false,
    allowFailure: true,
  });
  if (mappingsRaw.code !== 0) {
    throw new Error("Localhost readiness check failed: unable to read hooks.mappings.");
  }
  let githubMappingPresent = false;
  try {
    const mappings = JSON.parse(mappingsRaw.stdout) as Array<{
      id?: unknown;
      match?: { path?: unknown };
      transform?: { module?: unknown };
    }>;
    githubMappingPresent = Array.isArray(mappings)
      ? mappings.some((entry) => {
          const id = typeof entry?.id === "string" ? entry.id : "";
          const pathMatch = typeof entry?.match?.path === "string" ? entry.match.path : "";
          const module = typeof entry?.transform?.module === "string" ? entry.transform.module : "";
          return (
            id === GITHUB_HOOK_MAPPING_ID &&
            pathMatch === GITHUB_HOOK_PATH &&
            module === GITHUB_HOOK_TRANSFORM_MODULE
          );
        })
      : false;
  } catch {
    githubMappingPresent = false;
  }
  if (!githubMappingPresent) {
    throw new Error(
      "Localhost readiness check failed: hooks.mappings is missing github mapping -> github-mentions.ts.",
    );
  }

  const channelsRaw = runCommand(["openclaw", "channels", "status", "--json"], {
    dryRun: false,
    allowFailure: true,
  });
  if (channelsRaw.code !== 0) {
    throw new Error("Localhost readiness check failed: unable to read channels status.");
  }

  let githubChannelConfigured = false;
  let githubChannelRunning = false;
  let githubWebhookPath: string | undefined;
  try {
    const parsed = JSON.parse(channelsRaw.stdout) as {
      channels?: {
        github?: {
          configured?: unknown;
          running?: unknown;
          webhookPath?: unknown;
        };
      };
    };
    const github = parsed?.channels?.github;
    githubChannelConfigured = Boolean(github?.configured);
    githubChannelRunning = Boolean(github?.running);
    githubWebhookPath = typeof github?.webhookPath === "string" ? github.webhookPath : undefined;
  } catch {
    githubChannelConfigured = false;
    githubChannelRunning = false;
    githubWebhookPath = undefined;
  }

  if (!githubChannelConfigured) {
    throw new Error("Localhost readiness check failed: channels.github is not configured.");
  }
  if (!githubChannelRunning) {
    throw new Error("Localhost readiness check failed: channels.github is not running.");
  }
  if (githubWebhookPath !== "/github") {
    throw new Error(
      `Localhost readiness check failed: channels.github.webhookPath expected /github, got ${githubWebhookPath ?? "null"}.`,
    );
  }

  return {
    hooksEnabled,
    githubMappingPresent,
    githubChannelConfigured,
    githubChannelRunning,
    githubWebhookPath,
  };
}

function optsFromEnv(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function stripOptionalQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizePem(value: string): string {
  const normalized = value.replace(/\\n/g, "\n").trim();
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function expandHomePath(inputPath: string): string {
  if (inputPath.startsWith("~/")) return path.join(homedir(), inputPath.slice(2));
  return inputPath;
}

function dedupeOwners(owners: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const owner of owners.map((value) => value.trim()).filter(Boolean)) {
    const key = owner.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(owner);
  }
  return out;
}

function sanitizeEnvKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function sanitizeSecrets(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length >= 4))];
}

function redactSecrets(text: string, secrets: string[]): string {
  let output = text;
  for (const secret of secrets) {
    output = output.split(secret).join("***REDACTED***");
  }
  return output;
}

function toBase64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function log(message: string) {
  console.log(`\n==> ${message}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
