/** Deterministic model stand-in: each call is answered by a handler that sees the prompt. */
import type { ComponentHealth, JsonSchema, ModelRuntime, StructuredGeneration, StructuredOptions } from "../../model/runtime";

export type FakeCall = { prompt: string; schema?: JsonSchema; options?: StructuredOptions };
export type FakeHandler = (call: FakeCall) => unknown;

export class FakeModel implements ModelRuntime {
  readonly provider = "fake";
  readonly calls: FakeCall[] = [];

  constructor(private readonly handler: FakeHandler, readonly model: string | null = "fake-model") {}

  async health(): Promise<ComponentHealth> {
    return { status: "ok", detail: "Fake model" };
  }

  async generate(prompt: string) {
    this.calls.push({ prompt });
    const value = await this.handler({ prompt });
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  async generateStructured(prompt: string, schema: JsonSchema, options?: StructuredOptions): Promise<StructuredGeneration> {
    const call = { prompt, schema, options };
    this.calls.push(call);
    const value = await this.handler(call);
    if (value instanceof Error) throw value;
    return { response: typeof value === "string" ? value : JSON.stringify(value), done: true, done_reason: "stop" };
  }
}
