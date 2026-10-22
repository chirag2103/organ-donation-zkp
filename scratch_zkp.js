const { initZKP, generateProof } = require('./server/zkpService');
const { ethers } = require('hardhat');

async function testZKP() {
  await initZKP();
  const poseidon = await require('circomlibjs').buildPoseidon();
  const F = poseidon.F;
  const BN128_PRIME = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

  const roleId = 0;
  const passphrase = 'doctor-pass';
  const preimage = Buffer.from(`zkp-credential:role${roleId}:${passphrase}`, 'utf8');
  const hash = ethers.keccak256(preimage);
  const credential = BigInt(hash) % BN128_PRIME;
  const salt = BigInt('12345');
  
  const depth = 20;
  const zero = BigInt(0);
  let layer = [credential, ...Array(Math.pow(2, depth) - 1).fill(zero)];
  const pathElements = [];
  const pathIndices  = [];

  for (let lvl = 0; lvl < depth; lvl++) {
    pathIndices.push(0);
    pathElements.push(layer[1].toString());
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const h = F.toObject(poseidon([layer[i], layer[i + 1]]));
      next.push(BigInt(h));
    }
    layer = next;
  }

  const root = layer[0];

  try {
    console.log("Generating proof...");
    const proof = await generateProof({
      credential,
      roleId,
      salt,
      merkleRoot: root,
      pathElements,
      pathIndices
    });
    console.log("Success!");
  } catch(e) {
    console.error("Failed:", e);
  }
}

testZKP().catch(console.error);
