import { Agent, getAgentByName, type FiberRecoveryContext } from "agents";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { Agent as Pi } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, Type, type AssistantMessage, type Context, type Model, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

type State = {
	requests: number;
	recoveries?: number;
	lastRecoveredAnswer?: string;
};

const SYSTEM_PROMPT = "You are a concise assistant running inside a Cloudflare Durable Object.";

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part?.type === "text" ? part.text : "")).join("\n");
}

function modelFromGatewayName(name: string): Model<any> {
	const [provider, ...id] = name.split("/");

	return {
		id: id.join("/"),
		name,
		provider,
		api: "openai-responses",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function chatMessages(context: Context) {
	return [
		...(context.systemPrompt ? [{ role: "system", content: context.systemPrompt }] : []),
		...context.messages.map((message) => {
			if (message.role === "toolResult") {
				return { role: "tool", tool_call_id: message.toolCallId, content: text(message.content) };
			}

			return {
				role: message.role === "assistant" ? "assistant" : "user",
				content: text(message.content),
				...(message.role === "assistant" && message.content.some((part) => part.type === "toolCall")
					? {
						tool_calls: message.content
							.filter((part): part is ToolCall => part.type === "toolCall")
							.map((part) => ({
								id: part.id,
								type: "function",
								function: { name: part.name, arguments: JSON.stringify(part.arguments) },
							})),
					}
					: {}),
			};
		}),
	];
}

function toolsForGateway(tools: Tool[] | undefined) {
	return tools?.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

function outputText(output: unknown): string {
	const data = output as Record<string, unknown>;
	const choice = Array.isArray(data?.choices) ? (data.choices[0] as Record<string, unknown> | undefined) : undefined;
	const message = choice?.message as Record<string, unknown> | undefined;
	return String(data?.response ?? data?.output_text ?? data?.content ?? message?.content ?? choice?.text ?? "");
}

function assistant(model: Model<any>, content: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: content ? [{ type: "text", text: content }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	};
}

function toolCallAssistant(model: Model<any>, calls: Array<Record<string, any>>): AssistantMessage {
	return {
		...assistant(model, "", "toolUse"),
		content: calls.map((call, index) => ({
			type: "toolCall",
			id: String(call.id ?? `call_${index}`),
			name: String(call.function?.name ?? call.name ?? ""),
			arguments: JSON.parse(String(call.function?.arguments ?? call.arguments ?? "{}")),
		})),
	};
}

function streamFromGateway(env: Env, model: Model<any>, context: Context) {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		try {
			stream.push({ type: "start", partial: assistant(model, "") });
			const output = await env.AI.run(
				model.name,
				{
					messages: chatMessages(context),
					...(context.tools?.length ? { tools: toolsForGateway(context.tools) } : {}),
				},
				{ gateway: { id: env.AI_GATEWAY_ID, collectLog: true } },
			);
			const choice = Array.isArray((output as Record<string, unknown>)?.choices)
				? ((output as { choices: Array<Record<string, any>> }).choices[0])
				: undefined;
			const toolCalls = choice?.message?.tool_calls;
			if (Array.isArray(toolCalls) && toolCalls.length > 0) {
				stream.push({ type: "done", reason: "toolUse", message: toolCallAssistant(model, toolCalls) });
				return;
			}

			const answer = outputText(output);
			const done = assistant(model, answer);

			stream.push({ type: "text_start", contentIndex: 0, partial: done });
			stream.push({ type: "text_delta", contentIndex: 0, delta: answer, partial: done });
			stream.push({ type: "text_end", contentIndex: 0, content: answer, partial: done });
			stream.push({ type: "done", reason: "stop", message: done });
		} catch (error) {
			const failed = assistant(model, "", "error");
			failed.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: "error", error: failed });
		}
	})();

	return stream;
}

async function jsonBody(request: Request) {
	return request.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

function codeTool(env: Env): AgentTool {
	return {
		name: "execute_js",
		label: "Execute JavaScript",
		description: "Run generated JavaScript in an isolated Dynamic Worker sandbox. Use this for calculations or small data transformations. The code must be an async arrow function and network access is blocked.",
		parameters: Type.Object({
			code: Type.String({ description: "An async arrow function, for example: async () => 2 + 2" }),
		}),
		execute: async (_toolCallId, params) => {
			const { code } = params as { code: string };
			const executor = new DynamicWorkerExecutor({ loader: env.LOADER, globalOutbound: null, timeout: 10_000 });
			const result = await executor.execute(code, {});

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ result: result.result, error: result.error, logs: result.logs ?? [] }, null, 2),
					},
				],
				details: result,
			};
		},
	};
}

export class PiAgent extends Agent<Env, State> {
	initialState: State = { requests: 0 };

	status() {
		return {
			ok: true,
			model: this.env.PI_MODEL,
			gateway: this.env.AI_GATEWAY_ID,
			durableExecution: "runFiber",
			requests: this.state.requests,
			recoveries: this.state.recoveries ?? 0,
			lastRecoveredAnswer: this.state.lastRecoveredAnswer,
		};
	}

	private async completeTurn(prompt: string) {
		const model = modelFromGatewayName(this.env.PI_MODEL);
		const pi = new Pi({
			initialState: { systemPrompt: SYSTEM_PROMPT, model, thinkingLevel: "off", tools: [codeTool(this.env)] },
			streamFn: (_model, context) => streamFromGateway(this.env, model, context),
		});

		let answer = "";
		const unsubscribe = pi.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") answer += event.assistantMessageEvent.delta;
		});

		try {
			await pi.prompt(prompt);
			return { answer, model: model.name };
		} finally {
			unsubscribe();
		}
	}

	async runTurn(input: string) {
		const prompt = input.trim();
		if (!prompt) throw new Error("Missing prompt");

		return await this.runFiber("pi-prompt", async (fiber) => {
			fiber.stash({ prompt });
			const result = await this.completeTurn(prompt);
			this.setState({ requests: this.state.requests + 1 });
			return result;
		});
	}

	async onFiberRecovered(ctx: FiberRecoveryContext) {
		if (ctx.name !== "pi-prompt") return;

		const snapshot = ctx.snapshot as { prompt?: unknown } | null;
		if (typeof snapshot?.prompt !== "string") return;

		const { answer } = await this.completeTurn(snapshot.prompt);
		this.setState({
			requests: this.state.requests + 1,
			recoveries: (this.state.recoveries ?? 0) + 1,
			lastRecoveredAnswer: answer,
		});
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const agent = await getAgentByName(env.PiAgent, "default");

		if (request.method === "GET" && url.pathname === "/api/status") return Response.json(await agent.status());
		if (request.method === "POST" && url.pathname === "/api/prompt") {
			const body = await jsonBody(request);
			const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
			if (!prompt) return Response.json({ error: "Missing prompt" }, { status: 400 });

			try {
				return Response.json(await agent.runTurn(prompt));
			} catch (error) {
				return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
			}
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
