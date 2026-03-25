#!/usr/bin/env node

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
  "MEMBRANE_WORKSPACE_KEY",
  "MEMBRANE_WORKSPACE_SECRET",
  "MEMBRANE_API_URI",
];

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

  const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), "membrane-filter-"));
  const pullDir = path.join(workspaceDir, "pulled-workspace");

  try {
    await fsp.mkdir(pullDir, { recursive: true });
    await pullWorkspaceExport(pullDir, membraneEnv);
    const exportDir = await resolveExportRoot(pullDir);

    const catalog = await buildCatalog(exportDir);
    if (catalog.integrations.length === 0) {
      throw new Error("No integrations were found after pulling the Membrane workspace.");
    }

    const selectedKeys = await resolveSelection(catalog.integrations, args.integrations);
    const selection = computeSelection(catalog, selectedKeys);
    await pruneExport(exportDir, catalog, selection);

    await createZip(exportDir, outputZip);
    console.log(`Created filtered export zip: ${outputZip}`);
    console.log(`Kept integrations: ${selection.selectedIntegrations.join(", ")}`);
    console.log(`Kept shared resources: ${selection.keptRootResources.length}`);
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
  console.log("  node scripts/filter-membrane-export-cli.js");
  console.log("  node scripts/filter-membrane-export-cli.js --integrations hubspot,salesforce");
  console.log("  node scripts/filter-membrane-export-cli.js --output ./filtered-membrane-workspace.zip");
  console.log("  node scripts/filter-membrane-export-cli.js --env-file ./custom.env");
  console.log("");
  console.log("Environment:");
  console.log("  MEMBRANE_WORKSPACE_KEY");
  console.log("  MEMBRANE_WORKSPACE_SECRET");
  console.log("  MEMBRANE_API_URI");
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

async function pullWorkspaceExport(outputDir, env) {
  console.log("Pulling workspace from Membrane...");
  await runCommand(
    "npx",
    ["@membranehq/cli@latest", "pull"],
    {
      cwd: outputDir,
      env,
    },
  );
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

  for (const integration of catalog.integrations) {
    if (!selectedIntegrationSet.has(integration.key)) {
      await removePath(path.join(exportDir, "integrations", integration.dirName));
    }
  }

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
