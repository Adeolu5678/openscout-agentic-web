import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  filterConfig,
  findFrontMan,
  validateManifest,
  validateNetwork,
  type AgentManifest,
  type NetworkConfig,
} from "../src/runtime/spec";

const ROOT = resolve(process.cwd());
const readJson = <T>(relPath: string): T =>
  JSON.parse(readFileSync(resolve(ROOT, relPath), "utf-8")) as T;

describe("Open Agentic Web MVP Profile 0.3 Manifest & Network Conformance", () => {
  it("validates public/agent-manifest.json and linked openscout_node.network.json", () => {
    const manifest = readJson<AgentManifest>("public/agent-manifest.json");
    const mRes = validateManifest(manifest);
    expect(mRes.valid).toBe(true);
    expect(mRes.errors).toEqual([]);
    expect(manifest.networks[0].name).toBe("openscout_node");
    expect(manifest.networks[0].front_man).toBe("scout_front");

    const rawNet = readJson<NetworkConfig>("public/openscout_node.network.json");
    const filtered = filterConfig(rawNet);
    const nRes = validateNetwork(filtered);
    expect(nRes.valid).toBe(true);
    expect(nRes.errors).toEqual([]);
    expect(nRes.frontMan).toBe("scout_front");

    const frontSpec = filtered.tools.find((t) => t.name === "scout_front");
    expect(frontSpec?.instructions).toContain("OpenScout Agentic Web Node");
    expect(frontSpec?.instructions).not.toContain("{site_name}");
  });

  it("validates public/peers/agent-manifest.json and trust_verifier.network.json", () => {
    const peerManifest = readJson<AgentManifest>("public/peers/agent-manifest.json");
    expect(validateManifest(peerManifest).valid).toBe(true);
    expect(peerManifest.networks[0].name).toBe("trust_verifier");

    const peerNet = readJson<NetworkConfig>("public/peers/trust_verifier.network.json");
    const check = validateNetwork(peerNet);
    expect(check.valid).toBe(true);
    expect(check.frontMan).toBe("verifier_front");
  });

  it("validates public/links.json, .well-known metadata, bridge manifest, and CORS deployment files", () => {
    const links = readJson<{ version: number; networks: Record<string, unknown> }>("public/links.json");
    expect(links.version).toBe(1);
    expect(links.networks).toHaveProperty("openscout_node");

    const wellKnownLink = readJson<{ protocol: string; exports: Array<{ network: string }> }>(
      "public/.well-known/nsdeploy.json"
    );
    expect(wellKnownLink.protocol).toBe("nsdeploy-link/v1");
    expect(wellKnownLink.exports[0].network).toBe("openscout_node");

    const bridgeManifest = readJson<{ networks: Array<{ name: string }>; actions: { module: string } }>(
      "public/bridge/agent-manifest.json"
    );
    expect(bridgeManifest.networks[0].name).toBe("openscout_node");
    expect(existsSync(resolve(ROOT, "public/bridge/action-bridge.html"))).toBe(true);

    const vercelConfig = readJson<{ headers: Array<{ headers: Array<{ key: string; value: string }> }> }>(
      "vercel.json"
    );
    const hasCorsHeader = vercelConfig.headers.some((rule) =>
      rule.headers.some((h) => h.key === "Access-Control-Allow-Origin" && h.value === "*")
    );
    expect(hasCorsHeader).toBe(true);

    const cfHeaders = readFileSync(resolve(ROOT, "public/_headers"), "utf-8");
    expect(cfHeaders).toContain("Access-Control-Allow-Origin: *");
  });

  it("rejects malformed manifests, missing front_man, duplicate agents, and missing tool refs", () => {
    expect(validateManifest(null).valid).toBe(false);
    expect(validateManifest({ networks: [] }).valid).toBe(false);
    expect(
      validateManifest({
        networks: [{ name: "n1", front_man: "", hocon: "./n1.json" }],
      }).valid
    ).toBe(false);

    const missingToolNet: NetworkConfig = {
      tools: [
        {
          name: "front",
          instructions: "Coordinate",
          tools: ["does_not_exist"],
        },
      ],
    };
    const res1 = validateNetwork(missingToolNet);
    expect(res1.valid).toBe(false);
    expect(res1.errors.some((e) => e.includes("does_not_exist"))).toBe(true);

    const dupNet: NetworkConfig = {
      tools: [
        { name: "front", instructions: "A", tools: [] },
        { name: "front", instructions: "B", tools: [] },
      ],
    };
    const res2 = validateNetwork(dupNet);
    expect(res2.valid).toBe(false);
    expect(res2.errors.some((e) => e.includes("Duplicate agent name"))).toBe(true);

    expect(findFrontMan({ tools: [{ name: "helper", class: "CodedTool" }, { name: "lead", instructions: "Go" }] })).toBe(
      "lead"
    );
  });
});
