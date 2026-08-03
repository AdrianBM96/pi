import { spawn } from "node:child_process";
import { extname } from "node:path";
import {
	type BashOperations,
	createBashTool,
	createReadTool,
	type ExtensionAPI,
	type ReadOperations,
} from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE = "/workspace";
const ALLOWED_TOOLS = new Set(["read", "bash"]);
const configuredContainerName = process.env.PI_ISSUE_ANALYSIS_SANDBOX_CONTAINER;

if (!configuredContainerName || !/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(configuredContainerName)) {
	throw new Error("PI_ISSUE_ANALYSIS_SANDBOX_CONTAINER is missing or invalid");
}
const containerName: string = configuredContainerName;

type ContainerExecResult = {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
};

type ContainerExecOptions = {
	cwd?: string;
	input?: string | Buffer;
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeoutSeconds?: number;
};

function executeInContainer(command: string[], options: ContainerExecOptions = {}): Promise<ContainerExecResult> {
	const args = [
		"exec",
		...(options.input === undefined ? [] : ["-i"]),
		"--workdir",
		options.cwd ?? GUEST_WORKSPACE,
		"--env",
		"CI=true",
		"--env",
		"HOME=/tmp/pi-home",
		"--env",
		"TMPDIR=/tmp",
		"--env",
		"NO_COLOR=1",
		containerName,
		...command,
	];

	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}

		const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let failure: Error | undefined;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;

		const terminate = (error: Error) => {
			failure ??= error;
			child.kill("SIGKILL");
		};
		const onAbort = () => terminate(new Error("aborted"));
		options.signal?.addEventListener("abort", onAbort, { once: true });

		if (options.timeoutSeconds !== undefined) {
			timeout = setTimeout(
				() => terminate(new Error(`timeout:${options.timeoutSeconds}`)),
				options.timeoutSeconds * 1000,
			);
		}

		child.stdout.on("data", (chunk: Buffer) => {
			stdout.push(chunk);
			options.onData?.(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr.push(chunk);
			options.onData?.(chunk);
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
		child.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
			if (failure) {
				reject(failure);
				return;
			}
			resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(options.input);
	});
}

async function executeChecked(command: string[], options?: ContainerExecOptions): Promise<Buffer> {
	const result = await executeInContainer(command, options);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString("utf8").trim() || `Container command exited with ${result.exitCode}`);
	}
	return result.stdout;
}

function createContainerReadOperations(): ReadOperations {
	return {
		readFile: (path) =>
			executeChecked([
				"node",
				"-e",
				"const fs=require('node:fs');process.stdout.write(fs.readFileSync(process.argv[1]));",
				path,
			]),
		access: async (path) => {
			await executeChecked([
				"node",
				"-e",
				"require('node:fs').accessSync(process.argv[1],require('node:fs').constants.R_OK);",
				path,
			]);
		},
		detectImageMimeType: async (path) => {
			switch (extname(path).toLowerCase()) {
				case ".png":
					return "image/png";
				case ".jpg":
				case ".jpeg":
					return "image/jpeg";
				case ".gif":
					return "image/gif";
				case ".webp":
					return "image/webp";
				default:
					return null;
			}
		},
	};
}

function createContainerBashOperations(): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const result = await executeInContainer(["/bin/bash", "-lc", command], {
				cwd,
				onData,
				signal,
				timeoutSeconds: timeout,
			});
			return { exitCode: result.exitCode };
		},
	};
}

export default function (pi: ExtensionAPI) {
	const readTool = createReadTool(GUEST_WORKSPACE, { operations: createContainerReadOperations() });
	const bashTool = createBashTool(GUEST_WORKSPACE, {
		operations: createContainerBashOperations(),
		exposeSessionEnvironment: false,
	});

	pi.registerTool(readTool);
	pi.registerTool(bashTool);

	pi.on("session_start", async () => {
		const running = await executeChecked(["/bin/sh", "-c", "test -d /workspace && printf running"]);
		if (running.toString("utf8") !== "running") {
			throw new Error("Issue-analysis Docker sandbox is not ready");
		}
		pi.setActiveTools(["read", "bash"]);
	});

	pi.on("tool_call", (event) => {
		if (!ALLOWED_TOOLS.has(event.toolName)) {
			return { block: true, reason: `Tool ${event.toolName} is not available in issue-analysis CI` };
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		const hostLine = `Current working directory: ${ctx.cwd}`;
		const guestLine = `Current working directory: ${GUEST_WORKSPACE} (isolated Docker workspace)`;
		return {
			systemPrompt: event.systemPrompt.includes(hostLine)
				? event.systemPrompt.replace(hostLine, guestLine)
				: `${event.systemPrompt}\n\n${guestLine}`,
		};
	});
}
