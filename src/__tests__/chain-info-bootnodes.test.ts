/**
 * Regression test for #188 — /chain-info must advertise the canonical
 * DNS-pinned Gemtek bootnode, not the dead bastion /ip4 multiaddr.
 *
 * A freshly-restored node reads `bootnodes` from /chain-info for peer
 * auto-discovery; a dead default leaves it with an unreachable peer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const CANONICAL_BOOTNODE =
  "/dns4/bootnode.materios.fluxpointstudios.com/tcp/30333/p2p/12D3KooWPueKoxRAirTTKH4Y2qQAsJDegWMjS4k89Z7izCbZKgkM";
const DEAD_BASTION =
  "/ip4/5.78.94.109/tcp/30333/p2p/12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp";

describe("/chain-info bootnodes (#188)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.MATERIOS_RPC_URL = "ws://localhost:9945";
    // Stub every RPC call; we only care about the bootnodes field.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BOOTNODES;
  });

  it("defaults to the canonical DNS-pinned bootnode, not the dead bastion", async () => {
    const { initChainInfoPoller } = await import("../routes/chain-info.js");
    const { config } = await import("../config.js");
    config.materiosRpcUrl = "ws://localhost:9945";
    await initChainInfoPoller();

    const { __test_getCachedChainInfo } = await import("../routes/chain-info.js");
    const info = __test_getCachedChainInfo();
    expect(info).not.toBeNull();
    expect(info!.bootnodes).toContain(CANONICAL_BOOTNODE);
    expect(info!.bootnodes).not.toContain(DEAD_BASTION);
  });

  it("honors a BOOTNODES env override (comma-separated)", async () => {
    process.env.BOOTNODES = "/dns4/a.example/tcp/30333/p2p/abc,/dns4/b.example/tcp/30333/p2p/def";
    const { initChainInfoPoller, __test_getCachedChainInfo } = await import(
      "../routes/chain-info.js"
    );
    const { config } = await import("../config.js");
    config.materiosRpcUrl = "ws://localhost:9945";
    await initChainInfoPoller();

    const info = __test_getCachedChainInfo();
    expect(info!.bootnodes).toEqual([
      "/dns4/a.example/tcp/30333/p2p/abc",
      "/dns4/b.example/tcp/30333/p2p/def",
    ]);
  });
});
