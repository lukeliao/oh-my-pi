import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, Model, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type } from "arktype";

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: type({ text: "string" }),
};

function contextWithTools(tools: Tool[] = [echoTool]): Context {
	return {
		messages: [{ role: "user", content: "call tool", timestamp: Date.now() }],
		tools,
	};
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function capturePayload(
	model: Model<"openai-completions">,
	tools?: Tool[],
	reasoning: "high" | "max" | "xhigh" = "high",
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, contextWithTools(tools), {
		apiKey: "test-key",
		signal: abortedSignal(),
		reasoning,
		toolChoice: "auto",
		maxTokens: 123,
		onPayload: payload => resolve(payload),
	});
	return (await promise) as Record<string, unknown>;
}

function customDeepseekFlash(): Model<"openai-completions"> {
	return buildModel({
		...getBundledModel("openai", "gpt-4o-mini"),
		api: "openai-completions",
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		provider: "ds",
		baseUrl: "https://api.deepseek.com/v1",
		reasoning: true,
		compat: {
			supportsReasoningEffort: true,
			reasoningEffortMap: { xhigh: "max" },
		},
	} as ModelSpec<"openai-completions">);
}

describe("issue #1207 — DeepSeek V4 keeps reasoning with tools", () => {
	it("detects the documented direct DeepSeek V4 compat shape", () => {
		const model = getBundledModel("deepseek", "deepseek-v4-flash") as Model<"openai-completions">;
		const compat = model.compat;

		expect(compat.supportsToolChoice).toBe(false);
		expect(compat.maxTokensField).toBe("max_tokens");
		expect(compat.extraBody).toEqual({ thinking: { type: "enabled" } });
		// DeepSeek V4 Flash's reasoning_effort is the official three-tier ladder
		// low/high/max (Thinking Mode docs: low→low, high→high, xhigh→high,
		// max→max); no synthetic lower tiers, no alias map for in-ladder tiers.
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.thinking?.effortMap).toBeUndefined();
	});

	it("drops user reasoning map entries outside the honest DeepSeek ladder", () => {
		const model = customDeepseekFlash();

		expect(model.compat.supportsToolChoice).toBe(false);
		// Arbitrary DeepSeek-compatible endpoints keep the conservative
		// [high, max] ladder (only the direct deepseek provider exposes the
		// official three-tier low/high/max surface). The stale user `xhigh`
		// alias targets a tier outside that ladder, so it is filtered out.
		expect(model.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
		expect(model.thinking?.effortMap).toBeUndefined();
	});

	it("omits tool_choice but preserves documented reasoning when tools are present", async () => {
		const body = await capturePayload(customDeepseekFlash());

		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
		expect(body.thinking).toEqual({ type: "enabled" });
		expect(body.max_tokens).toBe(123);
		expect(body.max_completion_tokens).toBeUndefined();
	});

	it("maps xhigh to high on the direct DeepSeek V4 Flash wire instead of throwing", async () => {
		// Official Thinking Mode effort table: V4 Flash accepts xhigh and maps it
		// server-side to high. The wire ladder stays low/high/max; the xhigh alias
		// must resolve through compat.reasoningEffortMap so an explicit xhigh
		// request emits reasoning_effort="high" rather than failing
		// requireSupportedEffort.
		const model = getBundledModel("deepseek", "deepseek-v4-flash") as Model<"openai-completions">;
		const body = await capturePayload(model, undefined, "xhigh");

		expect(body.reasoning_effort).toBe("high");
	});

	it("derives the Flash xhigh alias from a custom runtime spec, not just the bundled catalog", () => {
		// Regression for the runtime compat builder: generated-policies.ts only runs
		// during gen:models, so a custom spec built via buildModel must still derive
		// the xhigh→high alias from mergeModelReasoningEffortMap.
		const base = getBundledModel("openai", "gpt-4o-mini");
		const model = buildModel({
			...base,
			api: "openai-completions",
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			reasoning: true,
			compat: { ...base.compatConfig, supportsReasoningEffort: true },
		} as ModelSpec<"openai-completions">);

		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.compat?.reasoningEffortMap).toEqual({ xhigh: "high" });
	});

	it("does not mix Fireworks DeepSeek effort with the native thinking toggle", async () => {
		const model = getBundledModel("fireworks", "deepseek-v4-pro") as Model<"openai-completions">;
		const compat = model.compat;
		const body = await capturePayload(model);

		expect(compat.extraBody).toBeUndefined();
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
		expect(body.thinking).toBeUndefined();
		expect(body.max_tokens).toBe(123);
	});

	it("preserves OpenRouter reasoning when tool_choice auto is present", async () => {
		const model = getBundledModel("openrouter", "deepseek/deepseek-v4-flash") as Model<"openai-completions">;
		const compat = model.compat;
		const body = await capturePayload(model);

		expect(compat.disableReasoningOnToolChoice).toBe(false);
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBe("auto");
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(body.reasoning_effort).toBeUndefined();
	});

	it("does not nest anyOf branches in OpenRouter DeepSeek tool schemas", async () => {
		const model = getBundledModel("openrouter", "deepseek/deepseek-v4-flash") as Model<"openai-completions">;
		const unionTool: Tool = {
			name: "union_repro",
			description: "Union schema repro",
			parameters: type({
				paths: "(string | string[])?",
			}),
		};
		const body = await capturePayload(model, [unionTool]);
		const tools = body.tools as Array<{ function: { parameters: Record<string, unknown> } }>;
		const properties = tools[0].function.parameters.properties as Record<string, Record<string, unknown>>;
		const branches = properties.paths.anyOf as Array<Record<string, unknown>>;

		expect(branches.map(branch => branch.type)).toEqual(["string", "array", "null"]);
		expect(branches.some(branch => Array.isArray(branch.anyOf))).toBe(false);
	});
});
