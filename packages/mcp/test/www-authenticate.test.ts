import { describe, expect, test } from "bun:test";
import { buildWwwAuthenticate } from "../src/www-authenticate.ts";

const META = "http://localhost:8080/.well-known/oauth-protected-resource/mcp/demo";

describe("buildWwwAuthenticate (contract §9 exact strings)", () => {
  test("bare challenge only carries the metadata URL", () => {
    expect(buildWwwAuthenticate({ resourceMetadataUrl: META })).toBe(`Bearer resource_metadata="${META}"`);
  });

  test("invalid_token keeps the contract's parameter order", () => {
    expect(buildWwwAuthenticate({ resourceMetadataUrl: META, error: "invalid_token" })).toBe(
      `Bearer error="invalid_token", resource_metadata="${META}"`,
    );
  });

  test("insufficient_scope lists scopes before the metadata URL", () => {
    expect(
      buildWwwAuthenticate({ resourceMetadataUrl: META, error: "insufficient_scope", scope: ["tools:write"] }),
    ).toBe(`Bearer error="insufficient_scope", scope="tools:write", resource_metadata="${META}"`);
  });

  test("multiple scopes are space-delimited; an empty scope list is omitted", () => {
    expect(buildWwwAuthenticate({ resourceMetadataUrl: META, scope: ["a", "b"] })).toBe(
      `Bearer scope="a b", resource_metadata="${META}"`,
    );
    expect(buildWwwAuthenticate({ resourceMetadataUrl: META, scope: [] })).toBe(
      `Bearer resource_metadata="${META}"`,
    );
  });

  test("quotes and backslashes in values are escaped", () => {
    expect(buildWwwAuthenticate({ resourceMetadataUrl: 'http://x/"a\\b"' })).toBe(
      'Bearer resource_metadata="http://x/\\"a\\\\b\\""',
    );
  });
});
