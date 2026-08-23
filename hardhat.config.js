require('@nomicfoundation/hardhat-toolbox');
require('@nomicfoundation/hardhat-network-helpers');

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: false,
    },
  },

  networks: {
    // ── Local Hardhat node (default) ──────────────────────────────────────
    localhost: {
      url: 'http://127.0.0.1:8545',
      chainId: 31337,
    },

    // ── Ganache PoA (for integration testing) ─────────────────────────────
    ganache: {
      url: process.env.GANACHE_URL || 'http://127.0.0.1:7545',
      chainId: 1337,
      accounts: process.env.GANACHE_PRIVATE_KEY
        ? [process.env.GANACHE_PRIVATE_KEY]
        : { mnemonic: process.env.MNEMONIC || 'test test test test test test test test test test test junk' },
    },

    // ── Sepolia testnet (optional) ────────────────────────────────────────
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || '',
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
      chainId: 11155111,
    },
  },

  // Hardhat Network settings for testing
  hardhat: {
    chainId: 31337,
    mining: {
      auto: true,
      interval: 0,
    },
    accounts: {
      count: 10,
      accountsBalance: '10000000000000000000000', // 10,000 ETH each
    },
    // Enable evm_increaseTime for TTL tests
    allowUnlimitedContractSize: false,
  },

  // Gas reporting
  gasReporter: {
    enabled: process.env.REPORT_GAS === 'true',
    currency: 'USD',
    coinmarketcap: process.env.COINMARKETCAP_API_KEY || '',
    outputFile: 'gas-report.txt',
    noColors: true,
    excludeContracts: ['MockZKPVerifier'],
  },

  // Contract size checker
  contractSizer: {
    alphaSort: true,
    runOnCompile: false,
    disambiguatePaths: false,
  },

  // Paths
  paths: {
    sources:   './contracts',
    tests:     './test',
    cache:     './cache',
    artifacts: './artifacts',
  },
};
