import { Agent, getAgentByName, type FiberRecoveryContext } from "agents";
import { Agent as Pi } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";

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
		...context.messages.map((message) => ({
			role: message.role === "assistant" ? "assistant" : "user",
			content: text(message.content),
		})),
	];
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

function streamFromGateway(env: Env, model: Model<any>, context: Context) {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		try {
			stream.push({ type: "start", partial: assistant(model, "") });
			const output = await env.AI.run(model.name, { messages: chatMessages(context) }, { gateway: { id: env.AI_GATEWAY_ID, collectLog: true } });
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
			initialState: { systemPrompt: SYSTEM_PROMPT, model, thinkingLevel: "off", tools: [] },
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
