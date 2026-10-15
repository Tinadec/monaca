import { ConfigError } from "./errors.ts";

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Read-only view over environment-style configuration. An empty string counts as unset, which
 * matches `.env.example` (`MONACA_OTLP_ENDPOINT=` means "disabled"). Error messages name the
 * variable and never echo its value, because values can be secrets.
 */
export class Config {
  readonly #values: EnvLike;

  constructor(values: EnvLike) {
    this.#values = values;
  }

  get(name: string): string | undefined {
    const value = this.#values[name];
    return value === undefined || value === "" ? undefined : value;
  }

  require(name: string): string {
    const value = this.get(name);
    if (value === undefined) throw new ConfigError(name, "required but not set");
    return value;
  }

  getOr(name: string, fallback: string): string {
    return this.get(name) ?? fallback;
  }

  int(name: string, fallback: number): number {
    const raw = this.get(name);
    if (raw === undefined) return fallback;
    if (!/^-?\d+$/.test(raw)) throw new ConfigError(name, "must be an integer");
    return Number(raw);
  }

  bool(name: string, fallback: boolean): boolean {
    const raw = this.get(name);
    if (raw === undefined) return fallback;
    const lowered = raw.toLowerCase();
    if (lowered === "1" || lowered === "true") return true;
    if (lowered === "0" || lowered === "false") return false;
    throw new ConfigError(name, "must be 1, 0, true or false");
  }
}

export function createConfig(values: EnvLike | Config = {}): Config {
  return values instanceof Config ? values : new Config(values);
}
