// Network changes are requested only from the user's Connect wallet action.
export function requireWallet(provider) {
  if (!provider?.request)
    throw Error("Install MetaMask or a compatible wallet");
  return provider;
}

export async function checkWalletChain(provider, deployment) {
  requireWallet(provider);
  const actual = BigInt(await provider.request({ method: "eth_chainId" }));
  const expected = BigInt(deployment.chainId);
  if (actual !== expected)
    throw Error(
      `Wallet is on chain ${actual}. Click Connect wallet to switch to chain ${expected}.`
    );
}

export async function selectWalletChain(provider, deployment) {
  requireWallet(provider);
  const expected = BigInt(deployment.chainId);
  if (BigInt(await provider.request({ method: "eth_chainId" })) === expected)
    return;
  const params = [{ chainId: "0x" + expected.toString(16) }];
  const switchChain = () =>
    provider.request({ method: "wallet_switchEthereumChain", params });
  try {
    try {
      await switchChain();
    } catch (error) {
      const code = Number(error.code ?? error.data?.originalError?.code);
      if (code !== 4902) throw error;
      const rpcUrl =
        expected === 31337n
          ? {
              localhost: "http://127.0.0.1:8545",
              e2e: "http://127.0.0.1:18545",
            }[deployment.network]
          : undefined;
      if (!rpcUrl)
        throw Error(
          `Add chain ${expected} in your wallet, then click Connect wallet again.`
        );
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: params[0].chainId,
            chainName:
              deployment.network === "e2e"
                ? "Hardhat acceptance test"
                : "Hardhat Local",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: [rpcUrl],
          },
        ],
      });
      // Adding a network need not select it for the connected site.
      await switchChain();
    }
  } catch (error) {
    const code = Number(error.code ?? error.data?.originalError?.code);
    if (code === 4001)
      throw Error(
        "Network change was declined. Click Connect wallet and approve the Hardhat network switch."
      );
    if (code === -32002)
      throw Error(
        "A wallet request is already pending. Open MetaMask and respond to it before trying again."
      );
    throw error;
  }
  await checkWalletChain(provider, deployment);
}
