pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

// ─────────────────────────────────────────────────────────────────────────────
// Merkle Proof component (binary Merkle tree, Poseidon hash at each level)
// ─────────────────────────────────────────────────────────────────────────────
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component hashers[levels];
    signal levelHashes[levels + 1];
    levelHashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        hashers[i] = Poseidon(2);

        // If pathIndices[i] == 0 → left child (current hash is left)
        // If pathIndices[i] == 1 → right child (current hash is right)
        // left  = levelHashes[i] * (1 - pathIndices[i]) + pathElements[i] * pathIndices[i]
        // right = pathElements[i] * (1 - pathIndices[i]) + levelHashes[i] * pathIndices[i]
        var isRight = pathIndices[i];

        signal left[levels];
        signal right[levels];

        left[i]  <== levelHashes[i] * (1 - isRight) + pathElements[i] * isRight;
        right[i] <== pathElements[i] * (1 - isRight) + levelHashes[i] * isRight;

        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];

        levelHashes[i + 1] <== hashers[i].out;
    }

    root <== levelHashes[levels];
}

// ─────────────────────────────────────────────────────────────────────────────
// RoleProof template
// Proves: caller knows a `credential` that:
//   1. Produces the correct nullifier  = Poseidon(credential, salt)
//   2. Produces the correct commitment = Poseidon(credential, roleId)
//   3. Is a member of the Merkle tree rooted at `merkleRoot`
// levels = 20 → supports up to 2^20 (≈ 1M) registered credentials
// ─────────────────────────────────────────────────────────────────────────────
template RoleProof(levels) {
    // ── Private inputs (never appear on-chain) ─────────────────────────────
    signal input credential;          // Secret credential scalar
    signal input pathElements[levels]; // Sibling hashes in Merkle proof
    signal input pathIndices[levels];  // 0 = left, 1 = right at each level
    signal input salt;                 // Random salt for nullifier uniqueness

    // ── Public inputs (committed on-chain as publicInputs[4]) ─────────────
    signal input merkleRoot;   // Merkle root stored in RoleRegistry
    signal input roleId;       // 0–5 matching the declared role
    signal input nullifier;    // Poseidon(credential, salt) — prevents replay
    signal input commitment;   // Poseidon(credential, roleId) — binds to role

    // ── Constraint 1: Verify nullifier = Poseidon(credential, salt) ───────
    component nullifierHash = Poseidon(2);
    nullifierHash.inputs[0] <== credential;
    nullifierHash.inputs[1] <== salt;
    nullifierHash.out === nullifier;

    // ── Constraint 2: Verify commitment = Poseidon(credential, roleId) ────
    component commitmentHash = Poseidon(2);
    commitmentHash.inputs[0] <== credential;
    commitmentHash.inputs[1] <== roleId;
    commitmentHash.out === commitment;

    // ── Constraint 3: Verify Merkle inclusion of credential ───────────────
    component mp = MerkleProof(levels);
    mp.leaf <== credential;
    for (var i = 0; i < levels; i++) {
        mp.pathElements[i] <== pathElements[i];
        mp.pathIndices[i]   <== pathIndices[i];
    }
    mp.root === merkleRoot;

    // ── Constraint 4: roleId is in range [0, 5] ───────────────────────────
    // We encode this as: roleId * (roleId - 1) * (roleId - 2) * ... not needed
    // Instead, enforce via LessThan comparator (6 bits)
    component ltCheck = LessThan(4); // 4-bit comparison, max value 15
    ltCheck.in[0] <== roleId;
    ltCheck.in[1] <== 6;
    ltCheck.out === 1;
}

// ── Main component (public signals must match PFEKeyIssuer expectation) ──────
component main { public [merkleRoot, roleId, nullifier, commitment] }
    = RoleProof(20);
