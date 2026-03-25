#!/usr/bin/env node

const crypto = require("crypto");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline/promises");
const YAML = require("yaml");

const ROOT_RESOURCE_TYPES = [
  "actions",
  "app-data-schemas",
  "app-event-types",
  "connectors",
  "data-link-tables",
  "data-sources",
  "field-mappings",
  "flows",
  "packages",
];

const ROOT_REFERENCE_FIELDS = {
  dataSource: "data-sources",
  dataSourceKey: "data-sources",
  fieldMapping: "field-mappings",
  eventType: "app-event-types",
  dataLinkTable: "data-link-tables",
  appEventType: "app-event-types",
  appDataSchema: "app-data-schemas",
};

const REQUIRED_ENV_KEYS = [
  "MEMBRANE_PULL_WORKSPACE_KEY",
  "MEMBRANE_PULL_WORKSPACE_SECRET",
  "MEMBRANE_PULL_API_URI",
];

const REQUIRED_PUSH_ENV_KEYS = [
  "MEMBRANE_PUSH_WORKSPACE_KEY",
  "MEMBRANE_PUSH_WORKSPACE_SECRET",
];

const JOB_POLL_INTERVAL_MS = 2000;
const JOB_POLL_TIMEOUT_MS = 10 * 60 * 1000;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const projectRoot = process.cwd();
  const envFilePath = path.resolve(args.envFile || ".env");
  const outputZip = path.resolve(args.output || path.join(projectRoot, "filtered-membrane-workspace.zip"));

  const envFromFile = await loadDotEnv(envFilePath);
  const membraneEnv = buildMembraneEnv(envFromFile);
  await assertOutputDoesNotExist(outputZip);

  const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), "membrane-api-filter-"));
  const downloadedZipPath = path.join(workspaceDir, "membrane-export.zip");
  const extractedDir = path.join(workspaceDir, "extracted");

  try {
    // Export through the API, download the archive, and unpack it in a temp folder
    // so filtering can happen without touching project files.
    await exportWorkspaceZip(downloadedZipPath, membraneEnv);
    await extractZip(downloadedZipPath, extractedDir);
    const exportDir = await resolveExportRoot(extractedDir);

    // Build a dependency graph, keep the selected integrations, and preserve only
    // the shared resources those integrations still need.
    const catalog = await buildCatalog(exportDir);
    if (catalog.integrations.length === 0) {
      throw new Error("No integrations were found after exporting the Membrane workspace.");
    }

    const selectedKeys = await resolveSelection(catalog.integrations, args.integrations);
    const selection = computeSelection(catalog, selectedKeys);
    await pruneExport(exportDir, catalog, selection);

    await createZip(exportDir, outputZip);
    console.log(`Created filtered export zip: ${outputZip}`);
    console.log(`Kept integrations: ${selection.selectedIntegrations.join(", ")}`);
    console.log(`Kept shared resources: ${selection.keptRootResources.length}`);
    console.log("");
    console.log("The Membrane export has been downloaded and filtered.");
    console.log(`Output file: ${outputZip}`);
    console.log("");

    // Optional import step into a different target workspace.
    if (await askYesNo("Do you want to import this filtered zip now?", false)) {
      const pushEnv = buildPushMembraneEnv(envFromFile);
      const importOptions = await promptImportOptions();
      const importResult = await importWorkspaceZip(outputZip, pushEnv, importOptions);
      const logPath = await saveImportLog(projectRoot, {
        timestamp: new Date().toISOString(),
        targetWorkspaceKey: pushEnv.MEMBRANE_PUSH_WORKSPACE_KEY || pushEnv.MEMBRANE_WORKSPACE_KEY,
        outputZip,
        importOptions,
        response: importResult,
      });
      console.log(`Saved import log: ${logPath}`);

      if (await askYesNo("Do you want to delete the generated zip file now?", false)) {
        await removePath(outputZip);
        console.log(`Deleted zip file: ${outputZip}`);
      }
    }
  } finally {
    await removePath(workspaceDir);
  }
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--help" || value === "-h") {
      args.help = true;
      continue;
    }

    if (value === "--output" || value === "-o") {
      args.output = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--integrations" || value === "-s") {
      args.integrations = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--env-file") {
      args.envFile = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return args;
}

function printUsage() {
  console.log("Usage:");
  console.log("  node scripts/filter-membrane-export-api.js");
  console.log("  node scripts/filter-membrane-export-api.js --integrations hubspot,salesforce");
  console.log("  node scripts/filter-membrane-export-api.js --output ./filtered-membrane-workspace.zip");
  console.log("  node scripts/filter-membrane-export-api.js --env-file ./custom.env");
  console.log("");
  console.log("Environment:");
  console.log("  MEMBRANE_PULL_WORKSPACE_KEY");
  console.log("  MEMBRANE_PULL_WORKSPACE_SECRET");
  console.log("  MEMBRANE_PULL_API_URI");
  console.log("  MEMBRANE_PUSH_WORKSPACE_KEY");
  console.log("  MEMBRANE_PUSH_WORKSPACE_SECRET");
  console.log("  MEMBRANE_PUSH_API_URI (optional; defaults to MEMBRANE_PULL_API_URI)");
}

async function loadDotEnv(filePath) {
  try {
    const content = await fsp.readFile(filePath, "utf8");
    const env = {};

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      env[key] = value;
    }

    return env;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function buildMembraneEnv(envFromFile) {
  const mergedEnv = {
    ...process.env,
    ...envFromFile,
  };

  const missingKeys = REQUIRED_ENV_KEYS.filter((key) => !mergedEnv[key]);
  if (missingKeys.length > 0) {
    throw new Error(`Missing required environment variables: ${missingKeys.join(", ")}`);
  }

  return mergedEnv;
}

function buildPushMembraneEnv(envFromFile) {
  const mergedEnv = {
    ...process.env,
    ...envFromFile,
  };

  const missingKeys = REQUIRED_PUSH_ENV_KEYS.filter((key) => !mergedEnv[key]);
  if (missingKeys.length > 0) {
    throw new Error(`Missing required push environment variables: ${missingKeys.join(", ")}`);
  }

  return {
    ...mergedEnv,
    MEMBRANE_WORKSPACE_KEY: mergedEnv.MEMBRANE_PUSH_WORKSPACE_KEY,
    MEMBRANE_WORKSPACE_SECRET: mergedEnv.MEMBRANE_PUSH_WORKSPACE_SECRET,
    MEMBRANE_API_URI: mergedEnv.MEMBRANE_PUSH_API_URI || mergedEnv.MEMBRANE_PULL_API_URI,
  };
}

function buildPullApiEnv(env) {
  // The API helpers use the generic MEMBRANE_WORKSPACE_* shape internally.
  return {
    ...env,
    MEMBRANE_WORKSPACE_KEY: env.MEMBRANE_PULL_WORKSPACE_KEY,
    MEMBRANE_WORKSPACE_SECRET: env.MEMBRANE_PULL_WORKSPACE_SECRET,
    MEMBRANE_API_URI: env.MEMBRANE_PULL_API_URI,
  };
}

async function exportWorkspaceZip(outputZipPath, env) {
  console.log("Exporting workspace from Membrane API...");
  const pullEnv = buildPullApiEnv(env);
  const adminToken = createAdminToken(pullEnv);
  const apiBaseUrl = normalizeApiBaseUrl(pullEnv.MEMBRANE_API_URI);

  // Export starts a background job. The zip becomes available only after that
  // job reaches "completed".
  const exportResponse = await fetch(`${apiBaseUrl}/export`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${adminToken}`,
      accept: "application/json",
    },
  });

  const exportBody = await parseJsonResponse(exportResponse);
  if (!exportResponse.ok) {
    throw new Error(
      `Membrane export request failed (${exportResponse.status}): ${stringifyErrorBody(exportBody)}`,
    );
  }

  const backgroundJobUrl = resolveBackgroundJobUrl(apiBaseUrl, exportBody, exportResponse);
  const completedJob = await pollBackgroundJob(backgroundJobUrl, adminToken);
  const downloadUrl = completedJob?.result?.downloadUrl;

  if (!downloadUrl) {
    throw new Error("Membrane export completed without a downloadUrl.");
  }

  console.log("Downloading exported workspace zip...");
  await downloadFile(downloadUrl, outputZipPath);
}

async function importWorkspaceZip(zipPath, env, importOptions) {
  console.log(`Importing filtered zip to target workspace ${env.MEMBRANE_WORKSPACE_KEY}...`);
  const adminToken = createAdminToken(env);
  const apiBaseUrl = normalizeApiBaseUrl(env.MEMBRANE_API_URI);
  const searchParams = new URLSearchParams({
    dryRun: String(importOptions.dryRun),
    partial: String(importOptions.partial),
    diff: String(importOptions.diff),
    force: String(importOptions.force),
  });

  const formData = new FormData();
  const zipBuffer = await fsp.readFile(zipPath);
  formData.append("file", new Blob([zipBuffer], { type: "application/zip" }), path.basename(zipPath));
  formData.append("dryRun", String(importOptions.dryRun));

  const response = await fetch(`${apiBaseUrl}/import?${searchParams.toString()}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      accept: "application/json",
    },
    body: formData,
  });

  const responseBody = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      `Membrane import request failed (${response.status}): ${stringifyErrorBody(responseBody)}`,
    );
  }

  if (isBackgroundJobResponse(responseBody)) {
    // Some imports also run asynchronously and return a background job first.
    const backgroundJobUrl = resolveBackgroundJobUrl(apiBaseUrl, responseBody, response);
    return pollBackgroundJob(backgroundJobUrl, adminToken);
  }

  return responseBody;
}

function createAdminToken(env) {
  const header = {
    alg: "HS512",
    typ: "JWT",
  };

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    workspaceKey: env.MEMBRANE_WORKSPACE_KEY,
    isAdmin: "true",
    iat: issuedAt,
    exp: issuedAt + 7200,
  };

  const encodedHeader = encodeJwtPart(header);
  const encodedPayload = encodeJwtPart(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac("sha512", env.MEMBRANE_WORKSPACE_SECRET)
    .update(signingInput)
    .digest("base64url");

  return `${signingInput}.${signature}`;
}

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function normalizeApiBaseUrl(value) {
  return String(value).replace(/\/+$/, "");
}

async function parseJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    return text ? { raw: text } : {};
  }

  return response.json();
}

function stringifyErrorBody(body) {
  if (!body || (typeof body === "object" && Object.keys(body).length === 0)) {
    return "No response body";
  }

  if (typeof body === "string") {
    return body;
  }

  return JSON.stringify(body);
}

function resolveBackgroundJobUrl(apiBaseUrl, exportBody, exportResponse) {
  const explicitUrl =
    exportBody?.backgroundJobUrl ||
    exportBody?.jobUrl ||
    exportBody?.url ||
    exportBody?.href ||
    exportResponse.headers.get("location") ||
    exportResponse.headers.get("content-location");

  if (explicitUrl) {
    return new URL(explicitUrl, `${apiBaseUrl}/`).toString();
  }

  const backgroundJobId =
    exportBody?.backgroundJobId ||
    exportBody?.jobId ||
    exportBody?.id ||
    exportBody?.job?.id ||
    exportBody?.backgroundJob?.id;

  if (!backgroundJobId) {
    throw new Error(`Could not determine Membrane background job id from response: ${JSON.stringify(exportBody)}`);
  }

  return `${apiBaseUrl}/background-jobs/${backgroundJobId}:${backgroundJobId}`;
}

async function pollBackgroundJob(jobUrl, adminToken) {
  const startedAt = Date.now();
  let lastStatus = null;

  while (Date.now() - startedAt < JOB_POLL_TIMEOUT_MS) {
    const response = await fetch(jobUrl, {
      method: "GET",
      headers: {
        authorization: `Bearer ${adminToken}`,
        accept: "application/json",
      },
    });

    const body = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(
        `Membrane background job request failed (${response.status}): ${stringifyErrorBody(body)}`,
      );
    }

    const status = body?.status;
    const progress = body?.progress;
    if (status !== lastStatus) {
      const progressText = typeof progress === "number" ? ` (${progress}%)` : "";
      console.log(`Background job status: ${status || "unknown"}${progressText}`);
      lastStatus = status;
    }

    if (status === "completed") {
      return body;
    }

    if (status === "failed" || status === "canceled" || status === "cancelled") {
      throw new Error(`Membrane background job ended with status "${status}": ${stringifyErrorBody(body)}`);
    }

    await sleep(JOB_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for Membrane background job after ${JOB_POLL_TIMEOUT_MS / 1000} seconds.`);
}

async function downloadFile(url, destinationPath) {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to download exported zip (${response.status}): ${text}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await fsp.writeFile(destinationPath, Buffer.from(arrayBuffer));
}

function isBackgroundJobResponse(body) {
  return Boolean(
    body &&
      typeof body === "object" &&
      (body.status || body.backgroundJobId || body.jobId || body.id || body.backgroundJobUrl || body.jobUrl),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractZip(sourceZip, destinationDir) {
  await removePath(destinationDir);
  await fsp.mkdir(destinationDir, { recursive: true });

  if (process.platform === "win32") {
    await runPowerShell(
      [
        "Add-Type -AssemblyName 'System.IO.Compression.FileSystem'",
        `$zip = [System.IO.Compression.ZipFile]::OpenRead(${toPowerShellString(sourceZip)})`,
        "try {",
        "  foreach ($entry in $zip.Entries) {",
        `    $targetPath = Join-Path ${toPowerShellString(destinationDir)} $entry.FullName`,
        "    if ([string]::IsNullOrEmpty($entry.Name)) {",
        "      [System.IO.Directory]::CreateDirectory($targetPath) | Out-Null",
        "      continue",
        "    }",
        "    $targetDir = Split-Path -Parent $targetPath",
        "    if ($targetDir) { [System.IO.Directory]::CreateDirectory($targetDir) | Out-Null }",
        "    $entryStream = $entry.Open()",
        "    try {",
        "      $fileStream = [System.IO.File]::Open($targetPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)",
        "      try { $entryStream.CopyTo($fileStream) } finally { $fileStream.Dispose() }",
        "    } finally { $entryStream.Dispose() }",
        "  }",
        "} finally {",
        "  $zip.Dispose()",
        "}",
      ].join("; "),
    );
    return;
  }

  await runCommand("unzip", ["-oq", sourceZip, "-d", destinationDir]);
}

async function buildCatalog(exportDir) {
  const integrationsDir = path.join(exportDir, "integrations");
  const integrationEntries = await listDirectories(integrationsDir);
  const integrations = [];

  for (const entry of integrationEntries) {
    const specPath = path.join(integrationsDir, entry.name, "spec.yaml");
    const spec = await readYamlFile(specPath);
    const childSpecs = await collectSpecs(path.join(integrationsDir, entry.name));

    integrations.push({
      dirName: entry.name,
      specPath,
      spec,
      key: spec.key || entry.name,
      name: spec.name || spec.key || entry.name,
      connectorUuid: spec.connectorUuid || null,
      childSpecs,
    });
  }

  const rootResources = [];
  const rootByUuid = new Map();
  const rootByTypeAndKey = new Map();

  for (const type of ROOT_RESOURCE_TYPES) {
    const typeDir = path.join(exportDir, type);
    const entries = await listDirectories(typeDir);

    for (const entry of entries) {
      const resource = await loadRootResource(typeDir, type, entry.name);
      if (!resource) {
        continue;
      }

      rootResources.push(resource);
      if (resource.uuid) {
        rootByUuid.set(resource.uuid, resource);
      }

      if (resource.key) {
        rootByTypeAndKey.set(`${type}:${resource.key}`, resource);
      }
    }
  }

  return {
    integrations,
    rootResources,
    rootByUuid,
    rootByTypeAndKey,
  };
}

async function resolveExportRoot(baseDir) {
  const directIntegrationsDir = path.join(baseDir, "integrations");
  if (await pathExists(directIntegrationsDir)) {
    return baseDir;
  }

  const membraneDir = path.join(baseDir, "membrane");
  const membraneIntegrationsDir = path.join(membraneDir, "integrations");
  if (await pathExists(membraneIntegrationsDir)) {
    return membraneDir;
  }

  throw new Error(
    `Could not find a Membrane export root inside ${baseDir}. Expected integrations/ or membrane/integrations/.`,
  );
}

async function loadRootResource(typeDir, type, dirName) {
  const resourceDir = path.join(typeDir, dirName);
  const specPath =
    type === "connectors"
      ? path.join(resourceDir, `${dirName}.yml`)
      : path.join(resourceDir, "spec.yaml");

  if (!(await pathExists(specPath))) {
    return null;
  }

  const spec = await readYamlFile(specPath);
  const uuid = spec.uuid || spec.connectorUuid || null;
  const key = spec.key || dirName;

  return {
    type,
    dirName,
    dirPath: resourceDir,
    spec,
    uuid,
    key,
  };
}

async function resolveSelection(integrations, rawSelection) {
  if (rawSelection) {
    const requestedKeys = rawSelection
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    if (requestedKeys.length === 0) {
      throw new Error("No integrations were provided in --integrations.");
    }

    const validKeys = new Set(integrations.map((integration) => integration.key));
    const unknownKeys = requestedKeys.filter((key) => !validKeys.has(key));
    if (unknownKeys.length > 0) {
      throw new Error(`Unknown integrations: ${unknownKeys.join(", ")}`);
    }

    return [...new Set(requestedKeys)];
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("Available integrations:");
    integrations.forEach((integration, index) => {
      console.log(`  ${index + 1}. ${integration.name} (${integration.key})`);
    });

    const answer = await rl.question(
      "Choose integrations to keep by number or key (comma-separated): ",
    );

    const selections = answer
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    if (selections.length === 0) {
      throw new Error("No integrations were selected.");
    }

    const byKey = new Map(integrations.map((integration) => [integration.key, integration.key]));
    const byNumber = new Map(
      integrations.map((integration, index) => [String(index + 1), integration.key]),
    );

    const resolvedKeys = selections.map((item) => byNumber.get(item) || byKey.get(item));
    const invalidSelections = selections.filter((_, index) => !resolvedKeys[index]);
    if (invalidSelections.length > 0) {
      throw new Error(`Invalid selections: ${invalidSelections.join(", ")}`);
    }

    return [...new Set(resolvedKeys)];
  } finally {
    rl.close();
  }
}

function computeSelection(catalog, selectedKeys) {
  const selectedSet = new Set(selectedKeys);
  const keepRootUuids = new Set();
  const keepConnectorsByKey = new Set();
  const queue = [];

  for (const integration of catalog.integrations) {
    if (!selectedSet.has(integration.key)) {
      continue;
    }

    if (integration.connectorUuid) {
      queue.push(integration.connectorUuid);
    }

    keepConnectorsByKey.add(integration.key);

    for (const spec of integration.childSpecs) {
      if (spec.parentUuid) {
        queue.push(spec.parentUuid);
      }

      if (Array.isArray(spec.elements)) {
        for (const element of spec.elements) {
          if (element && element.uuid) {
            queue.push(element.uuid);
          }
        }
      }
    }
  }

  while (queue.length > 0) {
    const uuid = queue.shift();
    if (!uuid || keepRootUuids.has(uuid)) {
      continue;
    }

    const resource = catalog.rootByUuid.get(uuid);
    if (!resource) {
      continue;
    }

    keepRootUuids.add(uuid);

    if (resource.type === "connectors") {
      keepConnectorsByKey.add(resource.key);
    }

    // Shared root resources can point to other shared resources, so we follow
    // those references until the required set is complete.
    for (const nextUuid of findLinkedRootResourceUuids(resource, catalog)) {
      if (!keepRootUuids.has(nextUuid)) {
        queue.push(nextUuid);
      }
    }
  }

  for (const connectorKey of keepConnectorsByKey) {
    const connectorResource = catalog.rootByTypeAndKey.get(`connectors:${connectorKey}`);
    if (connectorResource && connectorResource.uuid) {
      keepRootUuids.add(connectorResource.uuid);
    }
  }

  return {
    selectedIntegrations: [...selectedSet],
    keptRootUuids: keepRootUuids,
    keptRootResources: catalog.rootResources.filter(
      (resource) => resource.uuid && keepRootUuids.has(resource.uuid),
    ),
  };
}

function findLinkedRootResourceUuids(resource, catalog) {
  const linkedUuids = new Set();

  walkObject(resource.spec, (value, key) => {
    if (key === "elements" && Array.isArray(value)) {
      for (const element of value) {
        if (element && element.uuid) {
          linkedUuids.add(element.uuid);
        }
      }
      return;
    }

    const targetType = ROOT_REFERENCE_FIELDS[key];
    if (!targetType) {
      return;
    }

    if (typeof value === "string") {
      const target = catalog.rootByTypeAndKey.get(`${targetType}:${value}`);
      if (target && target.uuid) {
        linkedUuids.add(target.uuid);
      }
      return;
    }

    if (value && typeof value === "object" && typeof value.key === "string") {
      const target = catalog.rootByTypeAndKey.get(`${targetType}:${value.key}`);
      if (target && target.uuid) {
        linkedUuids.add(target.uuid);
      }
    }
  });

  return linkedUuids;
}

async function pruneExport(exportDir, catalog, selection) {
  const selectedIntegrationSet = new Set(selection.selectedIntegrations);
  const keptRootUuidSet = selection.keptRootUuids;

  // Remove all integration folders the user did not keep.
  for (const integration of catalog.integrations) {
    if (!selectedIntegrationSet.has(integration.key)) {
      await removePath(path.join(exportDir, "integrations", integration.dirName));
    }
  }

  // Remove any shared resource that is no longer referenced by the kept integrations.
  for (const resource of catalog.rootResources) {
    if (!resource.uuid || !keptRootUuidSet.has(resource.uuid)) {
      await removePath(resource.dirPath);
    }
  }
}

async function collectSpecs(dirPath) {
  const specs = [];
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const childDir = path.join(dirPath, entry.name);
    const specPath = path.join(childDir, "spec.yaml");
    if (await pathExists(specPath)) {
      specs.push(await readYamlFile(specPath));
    }

    const nestedSpecs = await collectSpecs(childDir);
    specs.push(...nestedSpecs);
  }

  return specs;
}

async function readYamlFile(filePath) {
  const content = await fsp.readFile(filePath, "utf8");
  return YAML.parse(content);
}

async function listDirectories(dirPath) {
  if (!(await pathExists(dirPath))) {
    return [];
  }

  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory());
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removePath(targetPath) {
  if (!(await pathExists(targetPath))) {
    return;
  }

  await fsp.rm(targetPath, { recursive: true, force: true });
}

async function assertOutputDoesNotExist(outputPath) {
  if (await pathExists(outputPath)) {
    throw new Error(`Output file already exists: ${outputPath}`);
  }
}

async function saveImportLog(projectRoot, payload) {
  const logsDir = path.join(projectRoot, "logs");
  await fsp.mkdir(logsDir, { recursive: true });

  // Save the raw import response for auditing and debugging after the run finishes.
  const timestamp = buildTimestampForFileName(new Date());
  const logPath = path.join(logsDir, `membrane-import-${timestamp}.json`);
  await fsp.writeFile(logPath, JSON.stringify(payload, null, 2));
  return logPath;
}

function buildTimestampForFileName(date) {
  const parts = [
    date.getFullYear(),
    padTwo(date.getMonth() + 1),
    padTwo(date.getDate()),
    "-",
    padTwo(date.getHours()),
    padTwo(date.getMinutes()),
    padTwo(date.getSeconds()),
  ];

  return parts.join("");
}

function padTwo(value) {
  return String(value).padStart(2, "0");
}

async function askYesNo(question, defaultValue) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const hint = defaultValue ? "Y/n" : "y/N";
    const answer = (await rl.question(`${question} (${hint}): `)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }

    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function promptImportOptions() {
  const dryRun = await askYesNo("Import with dryRun enabled?", false);
  const partial = await askYesNo(
    "Import with partial enabled? Existing elements not in the archive will be preserved.",
    true,
  );
  const diff = await askYesNo("Import with diff enabled?", true);
  const force = await askYesNo(
    "Import with force enabled? This can bypass read-only restrictions and archive missing elements.",
    false,
  );

  return {
    dryRun,
    partial,
    diff,
    force,
  };
}

function walkObject(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkObject(item, visitor);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [childKey, childValue] of Object.entries(value)) {
    visitor(childValue, childKey);
    walkObject(childValue, visitor);
  }
}

async function createZip(sourceDir, outputZip) {
  await fsp.mkdir(path.dirname(outputZip), { recursive: true });

  if (process.platform === "win32") {
    await runPowerShell(
      [
        "Add-Type -AssemblyName 'System.IO.Compression.FileSystem'",
        `[System.IO.Compression.ZipFile]::CreateFromDirectory(${toPowerShellString(sourceDir)}, ${toPowerShellString(outputZip)})`,
      ].join("; "),
    );
    return;
  }

  await runCommand("zip", ["-rq", outputZip, "."], { cwd: sourceDir });
}

async function runPowerShell(command) {
  const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
  await runCommand(executable, ["-NoProfile", "-Command", command]);
}

async function runCommand(command, args, options = {}) {
  const resolved = resolveCommandForPlatform(command);

  await new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args.concat(args), {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: "inherit",
      shell: resolved.shell,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

function resolveCommandForPlatform(command) {
  if (process.platform !== "win32") {
    return {
      command,
      args: [],
      shell: false,
    };
  }

  if (command === "npx") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npx"],
      shell: false,
    };
  }

  if (command === "npm") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npm"],
      shell: false,
    };
  }

  return {
    command,
    args: [],
    shell: false,
  };
}

function toPowerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
