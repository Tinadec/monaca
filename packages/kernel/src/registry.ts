import { DuplicateTokenError, MissingTokenError } from "./errors.ts";

/**
 * A typed DI key. Identity is the object itself, so two tokens with the same name are still
 * different keys; the name exists only for error messages.
 */
export class Token<T> {
  readonly name: string;
  /** Phantom field: carries `T` for inference. Never assigned at runtime. */
  declare readonly __type?: T;

  constructor(name: string) {
    this.name = name;
  }

  toString(): string {
    return `Token(${this.name})`;
  }
}

export function createToken<T>(name: string): Token<T> {
  if (name.trim() === "") throw new TypeError("a DI token needs a non-empty name");
  return new Token<T>(name);
}

/** Small typed service registry. One provider per token; resolving an unknown token throws. */
export class Registry {
  readonly #providers = new Map<Token<unknown>, unknown>();

  provide<T>(token: Token<T>, value: NoInfer<T>): void {
    if (this.#providers.has(token)) throw new DuplicateTokenError(token.name);
    this.#providers.set(token, value);
  }

  resolve<T>(token: Token<T>): T {
    if (!this.#providers.has(token)) {
      throw new MissingTokenError(
        token.name,
        [...this.#providers.keys()].map((t) => t.name),
      );
    }
    return this.#providers.get(token) as T;
  }

  tryResolve<T>(token: Token<T>): T | undefined {
    return this.#providers.has(token) ? (this.#providers.get(token) as T) : undefined;
  }

  has(token: Token<unknown>): boolean {
    return this.#providers.has(token);
  }

  /** Names of every registered token, for diagnostics. */
  names(): string[] {
    return [...this.#providers.keys()].map((t) => t.name);
  }
}
