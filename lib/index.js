/**
 * Model-facing ComfyUI image-generation tools over a fleet of local ComfyUI
 * workers. This plugin owns the model-facing schemas (workflow selection,
 * argument validation, worker routing, queue polling), the presentation, and
 * the sync/async split; it talks to each worker's plain HTTP API
 * (`/prompt`, `/history`, `/queue`, `/system_stats`, `/view`) with `fetch`.
 *
 * Design notes
 * - Workers are declared in config (id -> base URL + optional label/capability).
 *   The tool picks a worker by explicit `worker` id, else the first healthy one.
 * - Generation is a two-step ComfyUI protocol: POST /prompt returns a
 *   `prompt_id`, then the client polls /history/<id> until outputs appear.
 *   Polling is the whole point of this plugin — a raw `web_fetch` cannot do it.
 * - Workflows are named templates stored as JSON under `workflowsDir`. A
 *   workflow is a normal ComfyUI API-format graph; the tool injects `prompt`
 *   and `seed`/batch fields by node title convention before submitting.
 * @module dsh-tool-comfyui
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-comfyui";

/** Services required by the ComfyUI tool suite. */
const inject = ["tools"];

/** Default cooperative tool-call timeout budget (ms) for the ComfyUI tools. */
const DEFAULT_TIMEOUT_MS = 600000;

/** Default per-poll interval while waiting for a prompt to finish (ms). */
const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * Where the tool writes generated images when a worker returns an image it
 * cannot serve over HTTP, and where returned file paths are resolved from.
 */
const DEFAULT_OUTPUT_DIR = "comfyui-output";

/** Node `title`s that receive the model's `prompt` text, in priority order. */
const PROMPT_TITLE_HINTS = ["prompt", "提示词", "positive", "text", "clip text"];

/** Node `title`s / class types that receive a randomized seed. */
const SEED_TITLE_HINTS = ["seed", "随机种子", "noise_seed"];

/* ------------------------------------------------------------------ config */

/**
 * One ComfyUI worker in the fleet.
 * @typedef {object} WorkerConfig
 * @property {string} id - stable id the model uses to address this worker.
 * @property {string} url - base URL, e.g. `http://192.168.11.109:8188`.
 * @property {string} [label] - human description shown in status output.
 * @property {number} [timeoutMs] - per-worker override of the call budget.
 */

const Config = z.object({
	/** Workers the model may target, in default-preference order. */
	workers: z.array(z.object({
		id: z.string().required(),
		url: z.string().required(),
		label: z.string(),
		timeoutMs: z.number()
	})).required(),
	/** Directory holding named workflow JSON templates. */
	workflowsDir: z.string().default("workflows"),
	/** Default template name when the model omits `workflow`. */
	defaultWorkflow: z.string().default("txt2img"),
	/** Cooperative tool-call budget attached as `ToolDefinition.timeoutMs`. */
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
	/** Delay between `/history` polls while waiting for a job (ms). */
	pollIntervalMs: z.number().default(DEFAULT_POLL_INTERVAL_MS),
	/** Where downloaded output images land when a worker serves them as bytes. */
	outputDir: z.string().default(DEFAULT_OUTPUT_DIR),
	/** Register `comfyui_generate`. Defaults to true. */
	generate: z.boolean().default(true),
	/** Register `comfyui_status`. Defaults to true. */
	status: z.boolean().default(true),
	/** Register `comfyui_queue`. Defaults to true. */
	queue: z.boolean().default(true),
	/** Upper bound on images one call may request. */
	maxBatchSize: z.number().default(8)
});

/* ------------------------------------------------------------------- http */

/** Join a base URL and a path without doubling slashes. */
function urlOf(base, path) {
	return `${String(base).replace(/\/+$/u, "")}${path}`;
}

/**
 * One JSON HTTP call against a worker. A non-2xx response becomes a thrown
 * `Error` carrying the worker id and status so the model reads an actionable
 * message instead of a bare fetch failure.
 *
 * @param {string} workerId - worker the request targets, for error text.
 * @param {string} url - absolute request URL.
 * @param {RequestInit} [init] - fetch options.
 * @param {AbortSignal} [signal] - caller cancellation forwarded to fetch.
 * @returns {Promise<any>} the parsed JSON body.
 */
async function requestJson(workerId, url, init, signal) {
	let response;
	try {
		response = await fetch(url, {
			...init,
			signal,
			headers: { "content-type": "application/json", ...init?.headers }
		});
	} catch (error) {
		throw new Error(`comfyui: worker "${workerId}" is unreachable at ${url} (${error?.message ?? error}). Start ComfyUI on that machine or pick another worker with the "worker" argument.`);
	}
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`comfyui: worker "${workerId}" returned HTTP ${response.status} for ${url}: ${text.slice(0, 400)}`);
	}
	try {
		return text.length === 0 ? {} : JSON.parse(text);
	} catch {
		throw new Error(`comfyui: worker "${workerId}" returned non-JSON from ${url}: ${text.slice(0, 200)}`);
	}
}

/** Sleep that rejects promptly when the caller aborts. */
function delay(ms, signal) {
	return new Promise((resolvePromise, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("aborted"));
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/* -------------------------------------------------------------- workflows */

/**
 * Read every `*.json` template in a directory, keyed by file stem. A missing
 * directory is not an error — it yields an empty map so the tool fails later
 * with a message naming the directory it looked in.
 *
 * @param {string} dir - absolute workflows directory.
 * @returns {Promise<Record<string, object>>} template name -> graph.
 */
async function loadWorkflows(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return {};
	}
	const out = {};
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
		const stem = entry.name.slice(0, -".json".length);
		try {
			out[stem] = JSON.parse(await readFile(join(dir, entry.name), "utf8"));
		} catch {
			// A malformed template is skipped here; selecting it later reports
			// "unknown workflow" and the available list makes the cause obvious.
		}
	}
	return out;
}

/** Whether a node input is a graph link (`["nodeId", outputIndex]`). */
function isLink(value) {
	return Array.isArray(value) && value.length === 2 && (typeof value[0] === "string" || typeof value[0] === "number") && typeof value[1] === "number";
}

/**
 * Apply `prompt` / `seed` / batch overrides to a deep copy of a workflow
 * graph, matching nodes by `_meta.title` (ComfyUI's UI title) then by class
 * type hint. Only primitive or link-free string inputs are overwritten, so a
 * link-fed CLIP text node is never broken.
 *
 * @param {object} graph - the template graph (not mutated).
 * @param {string|undefined} prompt - positive prompt text.
 * @param {string|undefined} negativePrompt - negative prompt text.
 * @param {number|undefined} seed - seed for the first seed-bearing node.
 * @param {number|undefined} batchSize - batch size for image-producing nodes.
 * @returns {{graph: object, applied: string[]}} the rewritten graph and a log.
 */
function applyOverrides(graph, prompt, negativePrompt, seed, batchSize) {
	const copy = JSON.parse(JSON.stringify(graph));
	const applied = [];
	let seedAssigned = false;
	for (const [nodeId, node] of Object.entries(copy)) {
		if (node === null || typeof node !== "object") continue;
		const title = String(node?._meta?.title ?? "").toLowerCase();
		const type = String(node?.class_type ?? "").toLowerCase();
		const inputs = node.inputs;
		if (inputs === null || typeof inputs !== "object") continue;

		const wantsPrompt = prompt !== undefined && PROMPT_TITLE_HINTS.some((hint) => title === hint || title.includes(hint));
		if (wantsPrompt) {
			for (const key of ["text", "value", "prompt", "string"]) {
				if (typeof inputs[key] === "string") {
					inputs[key] = prompt;
					applied.push(`${nodeId}:${key}=prompt`);
					break;
				}
			}
		}

		// Negative prompts are conventionally the second CLIPTextEncode node;
		// a "negative" title is the reliable signal.
		if (negativePrompt !== undefined && (title.includes("negative") || title.includes("负面"))) {
			for (const key of ["text", "value", "prompt", "string"]) {
				if (typeof inputs[key] === "string") {
					inputs[key] = negativePrompt;
					applied.push(`${nodeId}:${key}=negative`);
					break;
				}
			}
		}

		if (seed !== undefined && !seedAssigned) {
			const wantsSeed = SEED_TITLE_HINTS.some((hint) => title === hint || title.includes(hint)) || type.includes("sampler") && "seed" in inputs;
			if (wantsSeed && !isLink(inputs.seed) && "seed" in inputs) {
				inputs.seed = seed;
				applied.push(`${nodeId}:seed=${seed}`);
				seedAssigned = true;
			}
		}

		if (batchSize !== undefined && "batch_size" in inputs && !isLink(inputs.batch_size)) {
			inputs.batch_size = batchSize;
			applied.push(`${nodeId}:batch_size=${batchSize}`);
		}

		// Modern ComfyUI moved the seed onto the noise node.
		if (seed !== undefined && "noise_seed" in inputs && !isLink(inputs.noise_seed)) {
			if (node?._meta?.title === undefined || title.includes("seed") || title.includes("noise")) {
				inputs.noise_seed = seed;
				applied.push(`${nodeId}:noise_seed=${seed}`);
				seedAssigned = true;
			}
		}
	}
	if (prompt !== undefined && !applied.some((entry) => entry.endsWith("=prompt"))) {
		throw new Error("comfyui: the selected workflow has no node whose title matches the prompt hints (prompt/positive/提示词). Give that node a `_meta.title` of \"prompt\", or edit the template.");
	}
	return { graph: copy, applied };
}

/* ------------------------------------------------------------- generation */

/** Random 32-bit seed for a call that did not pin one. */
function randomSeed() {
	return Math.floor(Math.random() * 4294967295);
}

/**
 * Normalize ComfyUI's history outputs into a flat image/path list.
 *
 * @param {object} historyEntry - one `/history/<id>` entry.
 * @returns {Array<{filename: string, subfolder: string, type: string, nodeId: string}>}
 */
function collectImages(historyEntry) {
	const images = [];
	const outputs = historyEntry?.outputs ?? {};
	for (const [nodeId, output] of Object.entries(outputs)) {
		for (const image of output?.images ?? []) {
			if (image?.filename === undefined) continue;
			images.push({
				filename: image.filename,
				subfolder: image.subfolder ?? "",
				type: image.type ?? "output",
				nodeId
			});
		}
	}
	return images;
}

/**
 * Submit one prompt and wait for its outputs.
 *
 * @param {WorkerConfig & {url: string}} worker - resolved worker.
 * @param {object} graph - the workflow graph to submit.
 * @param {object} options - polling behaviour.
 * @returns {Promise<{promptId: string, images: Array<object>, status: object}>}
 */
async function runPrompt(worker, graph, options) {
	const clientId = `dsh-${Math.random().toString(36).slice(2)}`;
	const submitted = await requestJson(worker.id, urlOf(worker.url, "/prompt"), {
		method: "POST",
		body: JSON.stringify({ prompt: graph, client_id: clientId })
	}, options.signal);

	const promptId = submitted?.prompt_id;
	if (typeof promptId !== "string" || promptId.length === 0) {
		throw new Error(`comfyui: worker "${worker.id}" accepted the prompt without a prompt_id: ${JSON.stringify(submitted).slice(0, 300)}`);
	}

	const deadline = Date.now() + options.budgetMs;
	for (;;) {
		if (Date.now() > deadline) {
			throw new Error(`comfyui: worker "${worker.id}" did not finish prompt ${promptId} within ${Math.round(options.budgetMs / 1000)}s. It may still be running — check with comfyui_queue.`);
		}
		const history = await requestJson(worker.id, urlOf(worker.url, `/history/${promptId}`), undefined, options.signal);
		const entry = history?.[promptId];
		if (entry !== undefined) {
			const status = entry.status ?? {};
			if (status.status_str === "error" || status.completed === false && status.status_str === "error") {
				throw new Error(`comfyui: worker "${worker.id}" failed prompt ${promptId}: ${JSON.stringify(status.messages ?? status).slice(0, 500)}`);
			}
			const images = collectImages(entry);
			if (images.length > 0 || status.completed === true || status.status_str === "success") {
				return { promptId, images, status };
			}
		}
		await delay(options.pollIntervalMs, options.signal);
	}
}

/** Interactive-call card: a generic card titled by the prompt. */
function presentGenerateCall(args) {
	const title = args.prompt === undefined || args.prompt.length === 0 ? `ComfyUI: ${args.workflow ?? "default"}` : args.prompt;
	return {
		card: "generic",
		title,
		kind: "other",
		rawInput: {
			workflow: args.workflow,
			worker: args.worker,
			prompt: args.prompt,
			negativePrompt: args.negativePrompt,
			seed: args.seed,
			batchSize: args.batchSize
		}
	};
}

/** Model-facing text for a finished generation. */
function formatGenerate(value) {
	const lines = [
		`ComfyUI generation finished on worker "${value.worker}" (prompt_id ${value.promptId}).`,
		`Workflow: ${value.workflow}${value.seed === undefined ? "" : ` | seed ${value.seed}`}`
	];
	if (value.images.length === 0) {
		lines.push("No image outputs were produced. The workflow ran but returned no images — check that it ends in a SaveImage node.");
		return lines.join("\n");
	}
	lines.push(`Produced ${value.images.length} image(s):`);
	for (const image of value.images) {
		lines.push(`- ${image.localPath ?? image.filename}${image.url === undefined ? "" : ` (${image.url})`}`);
	}
	return lines.join("\n");
}

/* ------------------------------------------------------------------- tools */

/**
 * Resolve the worker a call should use: the named one, else the first worker
 * whose `/system_stats` answers.
 *
 * @param {Array<WorkerConfig>} workers - configured fleet.
 * @param {string|undefined} requested - the model's `worker` argument.
 * @param {AbortSignal|undefined} signal - caller cancellation.
 * @returns {Promise<WorkerConfig>} the chosen worker.
 */
async function resolveWorker(workers, requested, signal) {
	if (requested !== undefined && requested.length > 0) {
		const found = workers.find((worker) => worker.id === requested);
		if (found === undefined) {
			throw new Error(`comfyui: unknown worker "${requested}". Configured workers: ${workers.map((worker) => worker.id).join(", ")}`);
		}
		return found;
	}
	const failures = [];
	for (const worker of workers) {
		try {
			await requestJson(worker.id, urlOf(worker.url, "/system_stats"), undefined, signal);
			return worker;
		} catch (error) {
			failures.push(`${worker.id}: ${error?.message ?? error}`);
		}
	}
	throw new Error(`comfyui: no healthy worker. Every configured worker failed:\n${failures.join("\n")}`);
}

/**
 * Register the enabled ComfyUI tools. Each tool's cooperative timeout budget is
 * attached as `ToolDefinition.timeoutMs` for the timeout-policy plugin to
 * enforce; registries are fiber-scoped, so no manual teardown is needed.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - context whose `tools` registry receives the tools.
 * @param {z.infer<typeof Config>} config - resolved plugin config.
 */
function apply(ctx, config) {
	const workers = config.workers;
	const workflowsDir = resolve(config.workflowsDir);
	const outputDir = resolve(config.outputDir);
	const budgetMs = config.timeoutMs;

	/* -- comfyui_status ---------------------------------------------------- */
	if (config.status) {
		ctx.tools.register(defineTool({
			name: "comfyui_status",
			description: "Report the health of every configured ComfyUI worker: reachability, version, GPU, and queue depth. Use it to pick a worker before generating.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						workers: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									id: { type: "string", required: true },
									label: { type: "string" },
									url: { type: "string", required: true },
									online: { type: "boolean", required: true },
									version: { type: "string" },
									gpu: { type: "string" },
									queueRunning: { type: "integer" },
									queuePending: { type: "integer" },
									error: { type: "string" }
								}
							}
						},
						workflows: {
							type: "array",
							required: true,
							items: { type: "string" }
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						"ComfyUI fleet:",
						...value.workers.map((worker) => worker.online ? `- ${worker.id}${worker.label === undefined ? "" : ` (${worker.label})`} @ ${worker.url}: ONLINE ${worker.version ?? ""} ${worker.gpu ?? ""} queue=${worker.queueRunning ?? 0}/${worker.queuePending ?? 0}` : `- ${worker.id} @ ${worker.url}: OFFLINE — ${worker.error ?? "unreachable"}`),
						"",
						`Available workflows: ${value.workflows.length === 0 ? "(none — the workflows directory is empty)" : value.workflows.join(", ")}`
					].join("\n")
				}]
			},
			timeoutMs: 60000,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const results = await Promise.all(workers.map(async (worker) => {
					const base = { id: worker.id, url: worker.url, ...worker.label === undefined ? {} : { label: worker.label } };
					try {
						const stats = await requestJson(worker.id, urlOf(worker.url, "/system_stats"), undefined, exec.signal);
						const devices = stats?.devices ?? [];
						const device = devices[0] ?? {};
						const queue = await requestJson(worker.id, urlOf(worker.url, "/queue"), undefined, exec.signal);
						return {
							...base,
							online: true,
							...stats?.system?.comfyui_version === undefined ? {} : { version: String(stats.system.comfyui_version) },
							...device.name === undefined ? {} : { gpu: `${device.name} (${Math.round((device.vram_total ?? 0) / 1073741824)}GB VRAM)` },
							queueRunning: (queue?.queue_running ?? []).length,
							queuePending: (queue?.queue_pending ?? []).length
						};
					} catch (error) {
						return { ...base, online: false, error: String(error?.message ?? error) };
					}
				}));
				const workflows = Object.keys(await loadWorkflows(workflowsDir)).sort();
				return { workers: results, workflows };
			},
			presentCall: () => ({ card: "generic", title: "ComfyUI fleet status", kind: "other", rawInput: {} })
		}));
	}

	/* -- comfyui_queue ----------------------------------------------------- */
	if (config.queue) {
		ctx.tools.register(defineTool({
			name: "comfyui_queue",
			description: "Read one ComfyUI worker's running and pending queue, or cancel everything queued on it.",
			parameters: {
				worker: { type: "string", description: "Worker id. Omit to use the first healthy worker." },
				cancelAll: { type: "boolean", description: "Interrupt the running job and clear the pending queue." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						worker: { type: "string", required: true },
						running: { type: "integer", required: true },
						pending: { type: "integer", required: true },
						cleared: { type: "boolean" }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `ComfyUI worker "${value.worker}": ${value.running} running, ${value.pending} pending.${value.cleared === true ? " Queue cleared." : ""}`
				}]
			},
			timeoutMs: 60000,
			async execute(args, exec) {
				const worker = await resolveWorker(workers, args.worker, exec.signal);
				if (args.cancelAll === true) {
					await requestJson(worker.id, urlOf(worker.url, "/interrupt"), { method: "POST", body: "{}" }, exec.signal);
					await requestJson(worker.id, urlOf(worker.url, "/queue"), { method: "POST", body: JSON.stringify({ clear: true }) }, exec.signal);
				}
				const queue = await requestJson(worker.id, urlOf(worker.url, "/queue"), undefined, exec.signal);
				return {
					worker: worker.id,
					running: (queue?.queue_running ?? []).length,
					pending: (queue?.queue_pending ?? []).length,
					...args.cancelAll === true ? { cleared: true } : {}
				};
			},
			presentCall: (args) => ({ card: "generic", title: `ComfyUI queue: ${args.worker ?? "auto"}`, kind: "other", rawInput: args })
		}));
	}

	/* -- comfyui_generate -------------------------------------------------- */
	if (config.generate) {
		ctx.tools.register(defineTool({
			name: "comfyui_generate",
			description: "Generate images on a local ComfyUI worker from a named workflow template. Submits the prompt, waits for the GPU to finish, and returns the output file paths.",
			parameters: {
				prompt: { type: "string", required: true, description: "Positive prompt text, injected into the workflow node titled \"prompt\"." },
				workflow: { type: "string", description: `Workflow template name. Defaults to "${config.defaultWorkflow}".` },
				worker: { type: "string", description: "Worker id. Omit to use the first healthy worker." },
				negativePrompt: { type: "string", description: "Negative prompt, injected into a node titled \"negative\" when the template has one." },
				seed: { type: "integer", description: "Fixed seed for reproducibility. Omit for a random seed." },
				batchSize: { type: "integer", description: `Images to produce in one run (1–${config.maxBatchSize}).` }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						worker: { type: "string", required: true },
						workflow: { type: "string", required: true },
						promptId: { type: "string", required: true },
						seed: { type: "integer" },
						applied: { type: "array", required: true, items: { type: "string" } },
						images: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									filename: { type: "string", required: true },
									subfolder: { type: "string" },
									type: { type: "string" },
									url: { type: "string" },
									localPath: { type: "string" }
								}
							}
						}
					}
				},
				render: (_args, value) => [{ type: "text", text: formatGenerate(value) }]
			},
			timeoutMs: budgetMs,
			async execute(args, exec) {
				const templates = await loadWorkflows(workflowsDir);
				const workflowName = args.workflow ?? config.defaultWorkflow;
				const template = templates[workflowName];
				if (template === undefined) {
					const available = Object.keys(templates).sort();
					throw new Error(`comfyui: unknown workflow "${workflowName}". Available: ${available.length === 0 ? `(none — add JSON templates to ${workflowsDir})` : available.join(", ")}`);
				}
				const batchSize = args.batchSize;
				if (batchSize !== undefined && (batchSize < 1 || batchSize > config.maxBatchSize)) {
					throw new Error(`comfyui: batchSize must be between 1 and ${config.maxBatchSize}`);
				}
				const seed = args.seed ?? randomSeed();
				const { graph, applied } = applyOverrides(template, args.prompt, args.negativePrompt, seed, batchSize);
				const worker = await resolveWorker(workers, args.worker, exec.signal);
				const workerBudget = Math.min(worker.timeoutMs ?? budgetMs, budgetMs);
				const { promptId, images } = await runPrompt(worker, graph, {
					signal: exec.signal,
					budgetMs: workerBudget,
					pollIntervalMs: config.pollIntervalMs
				});

				await mkdir(outputDir, { recursive: true });
				const projected = [];
				for (const image of images) {
					const query = new URLSearchParams({
						filename: image.filename,
						subfolder: image.subfolder,
						type: image.type
					});
					const url = urlOf(worker.url, `/view?${query.toString()}`);
					let localPath;
					try {
						const response = await fetch(url, { signal: exec.signal });
						if (response.ok) {
							const bytes = Buffer.from(await response.arrayBuffer());
							localPath = join(outputDir, image.filename);
							await writeFile(localPath, bytes);
						}
					} catch {
						// A worker that cannot serve /view still reports the
						// filename; the caller can fetch it from the worker host.
					}
					projected.push({
						filename: image.filename,
						...image.subfolder.length === 0 ? {} : { subfolder: image.subfolder },
						...image.type === undefined ? {} : { type: image.type },
						url,
						...localPath === undefined ? {} : { localPath }
					});
				}
				return {
					worker: worker.id,
					workflow: workflowName,
					promptId,
					seed,
					applied,
					images: projected
				};
			},
			presentCall: presentGenerateCall,
			presentResult: (args, result) => {
				if (result.isError) return undefined;
				const meta = result.meta;
				if (typeof meta !== "object" || meta === null) return undefined;
				return {
					card: "generic",
					title: `${args.workflow ?? config.defaultWorkflow} on ${meta.worker ?? "worker"}`,
					kind: "other",
					rawInput: meta
				};
			}
		}));
	}
}

export { Config, apply, inject, name };