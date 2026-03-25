# Membrane Export Filter

This project exports a Membrane workspace, lets you keep only selected integrations, and produces a filtered zip that can be imported into another workspace.

There are two supported flows:

- `CLI`: exports with `npx @membranehq/cli@latest pull`
- `API`: exports with Membrane's `/export` API and background-job polling

Both flows:

- ask which integrations to keep
- remove unselected integrations
- keep only the shared resources still referenced by the selected integrations
- create `filtered-membrane-workspace.zip`

## Environment Variables

Create a local `.env` file based on `.env.example`.

Source workspace:

```env
MEMBRANE_PULL_WORKSPACE_KEY=your-workspace-key
MEMBRANE_PULL_WORKSPACE_SECRET=your-workspace-secret
MEMBRANE_PULL_API_URI=https://api.getmembrane.com
```

Target workspace:

```env
MEMBRANE_PUSH_WORKSPACE_KEY=your-target-workspace-key
MEMBRANE_PUSH_WORKSPACE_SECRET=your-target-workspace-secret
MEMBRANE_PUSH_API_URI=https://api.getmembrane.com
```

`MEMBRANE_PUSH_API_URI` is optional and falls back to `MEMBRANE_PULL_API_URI`.

## Install

```bash
npm install
```

## CLI Flow

Run:

```bash
npm run pull-and-filter-cli
```

With preselected integrations:

```bash
npm run pull-and-filter-cli -- --integrations slack,salesforce
```

Custom output:

```bash
npm run pull-and-filter-cli -- --output ./my-filtered-export.zip
```

At the end, the script can optionally push the filtered workspace to the target workspace with Membrane CLI `push`.

## API Flow

Run:

```bash
npm run export-and-filter-api
```

With preselected integrations:

```bash
npm run export-and-filter-api -- --integrations slack,salesforce
```

Custom output:

```bash
npm run export-and-filter-api -- --output ./my-filtered-export.zip
```

The API flow:

1. creates an admin JWT
2. calls `GET /export`
3. polls the background job
4. downloads the zip
5. filters the workspace
6. creates the filtered zip
7. can optionally import the filtered zip into the target workspace

If you choose import, the script asks about:

- `dryRun`: preview changes without applying them
- `partial`: preserve existing elements not included in the archive
- `diff`: request textual diff output
- `force`: bypass read-only restrictions and allow archiving missing elements

After import, the script:

- prints the response
- saves a timestamped JSON log under `logs/`
- can optionally delete the generated zip

## Logs

API import logs are saved as:

```text
logs/membrane-import-YYYYMMDD-HHMMSS.json
```

Each log contains:

- timestamp
- target workspace key
- output zip path
- import options
- full import response

## Output Behavior

Default output:

```text
filtered-membrane-workspace.zip
```

If that file already exists, the script stops before doing any work so an existing artifact is not overwritten.

## Files

- `scripts/filter-membrane-export-cli.js`
- `scripts/filter-membrane-export-api.js`

## Notes

- The dependency pruning is UUID/key aware, so shared actions, flows, data sources, field mappings, packages, and connectors are only kept when still referenced.
- The CLI and API scripts intentionally share nearly the same pruning logic. The main difference is only how the Membrane export is retrieved.
