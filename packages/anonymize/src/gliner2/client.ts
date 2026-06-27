import type { InferRequest, InferResponse, HealthResponse } from "./types";
import { spawn, type ChildProcess } from "node:child_process";

export type Gliner2ClientOptions = {
  binaryPath?: string;
  port?: number;
  modelId?: string;
  variant?: string;
  modelLoadTimeout?: number;
  inferenceTimeout?: number;
};

export class Gliner2Client {
  private process: ChildProcess | null = null;
  private port: number | null = null;
  private baseUrl: string | null = null;
  private opts: Required<Gliner2ClientOptions>;

  constructor(opts: Gliner2ClientOptions = {}) {
    this.opts = {
      binaryPath: opts.binaryPath ?? "",
      port: opts.port ?? 0,
      modelId: opts.modelId ?? "SemplificaAI/gliner2-privacy-filter-PII-multi",
      variant: opts.variant ?? "",
      modelLoadTimeout: opts.modelLoadTimeout ?? 120_000,
      inferenceTimeout: opts.inferenceTimeout ?? 30_000,
    };
  }

  get isRunning(): boolean {
    if (!this.process || this.port == null) {
      return false;
    }
    const { exitCode, killed } = this.process;
    if (exitCode !== null || killed) {
      return false;
    }
    return true;
  }

  private clearProcessState(): void {
    this.process = null;
    this.port = null;
    this.baseUrl = null;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    const binPath = await this.resolveBinary();
    const args = ["--port", String(this.opts.port), "--host", "127.0.0.1"];
    if (this.opts.variant) args.push("--variant", this.opts.variant);
    args.push("--model", this.opts.modelId);

    this.process = spawn(binPath, args, {
      stdio: ["ignore", "pipe", "inherit"],
    });

    this.process.on("exit", () => this.clearProcessState());
    this.process.on("error", () => this.clearProcessState());

    const stdout = this.process.stdout;
    if (!stdout) {
      this.clearProcessState();
      throw new Error("Failed to start gliner2-server: no stdout");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let listeningEventReceived = false;

    for await (const chunk of stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");

      for (const line of lines) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === "listening") {
            this.port = parsed.port as number;
            this.baseUrl = `http://127.0.0.1:${this.port}`;
            listeningEventReceived = true;
            break;
          }
        } catch {
          continue;
        }
      }

      if (this.baseUrl) break;
      buffer = lines.at(-1) ?? "";
    }

    if (!listeningEventReceived) {
      const exitCode = this.process.exitCode;
      this.clearProcessState();
      throw new Error(
        `Failed to start gliner2-server: sidecar exited prematurely${
          exitCode !== null ? ` (exit code ${exitCode})` : ""
        }`,
      );
    }

    await this.waitForModel();
  }

  private async waitForModel(): Promise<void> {
    const deadline = Date.now() + this.opts.modelLoadTimeout;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/health`);
        const health = (await res.json()) as HealthResponse;
        if (health.model_loaded) return;
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
      "Model load timeout — check network and HuggingFace access",
    );
  }

  async infer(
    text: string,
    labels: string[],
    threshold: number,
    signal?: AbortSignal,
  ): Promise<InferResponse> {
    if (!this.isRunning) await this.start();

    const body: InferRequest = { text, labels, threshold };
    const fetchOptions: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };

    // Compose caller signal with internal timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.opts.inferenceTimeout);

    if (signal) {
      signal.addEventListener("abort", () => controller.abort());
    }

    fetchOptions.signal = controller.signal;

    try {
      const res = await fetch(`${this.baseUrl}/v1/infer`, fetchOptions);
      clearTimeout(timeoutId);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Inference failed (${res.status}): ${errText}`);
      }

      return res.json() as Promise<InferResponse>;
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    const proc = this.process;

    proc.kill("SIGTERM");

    const exited = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 5000);

      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    await exited;

    this.clearProcessState();
  }

  dispose(): void {
    this.stop().catch(() => {});
  }

  private async resolveBinary(): Promise<string> {
    if (this.opts.binaryPath) return this.opts.binaryPath;
    const envPath = process.env["ANONYMIZE_GLINER2_SERVER_PATH"];
    if (envPath) return envPath;

    throw new Error(
      "gliner2-server binary not found. " +
        "Provide binaryPath option or set ANONYMIZE_GLINER2_SERVER_PATH.",
    );
  }
}