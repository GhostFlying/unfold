import type { Config } from "./config.js";
import { settingsRevision } from "./config.js";
import { AppError, type ConfigApplication } from "./types.js";

export const backendConnectionRevision = (
  config: Config,
  backend: "traex" | "codex",
) => {
  const { model, effort, ...connection } = config.agents[backend];
  return settingsRevision(connection);
};

export const connectorRevision = (config: Config) =>
  settingsRevision({
    agents: config.agents,
    codebaseHosts: [...config.codebaseHosts].sort(),
  });

// Each lease keeps its original runtime until it finishes, including approval waits.
export class ConnectorRuntime<T> {
  private desired: Config;
  private appliedRevision: string;
  private desiredRevision: string;
  private state: ConfigApplication["state"] = "applied";
  private error?: string;
  private active = 0;
  private applying?: Promise<void>;
  constructor(
    initial: Config,
    private current: T,
    private build: (next: Config, previous: T) => Promise<T>,
  ) {
    this.desired = structuredClone(initial);
    this.appliedRevision = this.desiredRevision = connectorRevision(initial);
  }
  status(): ConfigApplication {
    return {
      state: this.state,
      desiredRevision: this.desiredRevision,
      appliedRevision: this.appliedRevision,
      activeOperations: this.active,
      error: this.error,
    };
  }
  value() {
    return this.current;
  }
  async reload(config: Config, retry = false) {
    const revision = connectorRevision(config);
    if (
      revision !== this.desiredRevision ||
      (retry && this.state === "failed")
    ) {
      this.desired = structuredClone(config);
      this.desiredRevision = revision;
      this.state = "pending";
      this.error = undefined;
    }
    await this.drain();
    return this.status();
  }
  private async drain() {
    if (this.active) return;
    if (this.applying) return this.applying;
    if (this.state !== "pending") return;
    this.applying = (async () => {
      while (!this.active && this.state === "pending") {
        const candidate = this.desired;
        const revision = this.desiredRevision;
        if (revision === this.appliedRevision) {
          this.state = "applied";
          break;
        }
        this.state = "applying";
        try {
          const runtime = await this.build(candidate, this.current);
          this.current = runtime;
          this.appliedRevision = revision;
          this.error = undefined;
          this.state =
            revision === this.desiredRevision ? "applied" : "pending";
        } catch (error: any) {
          this.error =
            error.message || "Connector configuration could not be applied";
          this.state = revision === this.desiredRevision ? "failed" : "pending";
        }
      }
    })().finally(() => {
      this.applying = undefined;
    });
    await this.applying;
  }
  async acquire(config: Config) {
    await this.reload(config);
    if (this.state !== "applied")
      throw new AppError(
        this.state === "failed"
          ? "configuration_failed"
          : "configuration_pending",
        this.error ||
          "Saved connection settings will apply when current work finishes",
        409,
        this.status(),
      );
    this.active++;
    let released = false;
    return {
      runtime: this.current,
      release: async () => {
        if (released) return;
        released = true;
        this.active--;
        await this.drain();
      },
    };
  }
}
