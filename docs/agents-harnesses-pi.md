---
title: Pi
description: Use Pi as a custom harness on Cloudflare Agents, backed by Durable Objects, fibers, and AI Gateway.
---

# Pi

Pi can be used as a custom harness on top of the Cloudflare Agents SDK runtime.

Use this approach when you want Pi's agent loop and event model, but you want Cloudflare to provide the durable runtime: Durable Objects, Agent state, fibers, static assets, and AI Gateway.

This page shows the smallest useful shape:

- One `Agent` subclass.
- One Durable Object instance.
- One static chat UI.
- One prompt endpoint.
- One Pi turn inside an Agents SDK fiber.
- One AI Gateway model call.

## How It Fits

Harnesses sit above the Agents SDK runtime. The runtime answers where the agent lives and how it stays durable. The harness answers what happens during an agent turn.

In this setup:

- The Agents SDK `Agent` class gives you a Durable Object with persisted state.
- `runFiber()` gives you durable execution for a prompt turn.
- `stash()` checkpoints the recovery input.
- `onFiberRecovered()` defines what recovery means.
- Pi runs the model-facing agent loop.
- `env.AI.run()` calls the model through AI Gateway.

```text
Browser
  -> Worker API
  -> PiAgent Durable Object
  -> runFiber("pi-prompt")
  -> Pi core agent
  -> env.AI.run(... AI Gateway ...)
```

## Install

```sh
npm install agents @earendil-works/pi-agent-core @earendil-works/pi-ai
```

## Configure Wrangler

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "ai": { "binding": "AI" },
  "vars": {
    "PI_MODEL": "openai/gpt-4.1-mini",
    "AI_GATEWAY_ID": "default"
  },
  "durable_objects": {
    "bindings": [{ "name": "PiAgent", "class_name": "PiAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["PiAgent"] }]
}
```

Run `wrangler types` after changing bindings.

## Create an Agent

The Agent stores small durable metadata in Agent state. The prompt itself runs inside a fiber.

```ts
import { Agent, getAgentByName, type FiberRecoveryContext } from "agents";
import { Agent as Pi } from "@earendil-works/pi-agent-core";

type State = {
  requests: number;
  recoveries?: number;
  lastRecoveredAnswer?: string;
};

export class PiAgent extends Agent<Env, State> {
  initialState: State = { requests: 0 };

  async runPrompt(input: string) {
    const prompt = input.trim();
    if (!prompt) throw new Error("Missing prompt");

    return await this.runFiber("pi-prompt", async (fiber) => {
      fiber.stash({ prompt });
      const result = await this.askPi(prompt);
      this.setState({ requests: this.state.requests + 1 });
      return result;
    });
  }

  async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (ctx.name !== "pi-prompt") return;

    const snapshot = ctx.snapshot as { prompt?: unknown } | null;
    if (typeof snapshot?.prompt !== "string") return;

    const { answer } = await this.askPi(snapshot.prompt);
    this.setState({
      requests: this.state.requests + 1,
      recoveries: (this.state.recoveries ?? 0) + 1,
      lastRecoveredAnswer: answer,
    });
  }

  private async askPi(prompt: string) {
    // Create a Pi core agent and bridge its stream to AI Gateway.
  }
}
```

The full working example is intentionally a little longer because it adapts Pi's event stream to `env.AI.run()`.

## Call AI Gateway From Pi

Pi expects a stream function. In a Worker, that function can call the AI binding:

```ts
const output = await env.AI.run(
  env.PI_MODEL,
  { messages },
  { gateway: { id: env.AI_GATEWAY_ID, collectLog: true } },
);
```

The AI binding handles Workers AI and third-party models through AI Gateway. This avoids storing provider API keys in Worker code.

## Add a Worker API

For a minimal HTTP API, route to a single named Agent instance:

```ts
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const agent = await getAgentByName(env.PiAgent, "default");

    if (request.method === "GET" && url.pathname === "/api/status") {
      return Response.json(await agent.status());
    }

    if (request.method === "POST" && url.pathname === "/api/prompt") {
      const { prompt } = (await request.json()) as { prompt?: string };
      return Response.json(await agent.runPrompt(prompt ?? ""));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

For a browser UI, serve static HTML with Workers Static Assets and route `/api/*` to the Worker first.

## Recovery Model

Fibers make the work recoverable, but they do not keep the original HTTP client alive forever.

If the Durable Object is evicted during an inline `runFiber()` call:

1. The original HTTP request is gone.
2. The fiber record and snapshot remain in the Agent's SQLite storage.
3. On the next activation, `onFiberRecovered()` receives the stashed prompt.
4. The Agent can replay the prompt and persist the recovered result in state.

Use `runFiber()` when you want the simplest request/response API and a recovery policy. Use `startFiber()` when callers need durable acceptance, idempotency, cancellation, and later status inspection.

## Persistence

Use the Agents SDK persistence that is already built into the runtime:

- `this.state` and `this.setState()` for small JSON state.
- `fiber.stash()` for recovery checkpoints.
- `this.sql` only when you need queryable history or larger collections.

Do not add KV, D1, R2, or custom persistence for the minimal Pi harness unless your application needs files, cross-agent queries, or large message history.

## When To Use This

Use this Pi harness approach when you want:

- Pi's core agent loop.
- Cloudflare Durable Object identity and state.
- AI Gateway model access.
- Agent fiber recovery.
- A small custom UI or API.

Use a more complete framework, such as Think, when you want built-in chat protocol support, persistent conversation sessions, context management, tool orchestration, and a client SDK integration out of the box.

## Example Repository

See the complete example at:

```text
https://github.com/irvinebroque/pi-on-cloudflare
```
