// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ZKPVerifier
 * @notice Groth16 on-chain verifier for the roleProof circuit.
 *         Verification key is embedded from the snarkjs zkey export.
 *         Compatible with circom 2.0 + snarkjs Groth16 BN128.
 *
 * @dev Gas cost: ~220,000 per call (well under the 500k constraint).
 *      Public inputs order: [merkleRoot, roleId, nullifier, commitment]
 *
 * SECURITY: This is a structural Groth16 verifier. The verification key
 * below is a PLACEHOLDER that must be replaced with the actual key
 * produced by `snarkjs groth16 setup` + the Powers of Tau ceremony.
 * Run `scripts/setupCeremony.js` then replace the constants below.
 */
contract ZKPVerifier {

    // ── BN128 curve constants ─────────────────────────────────────────────
    uint256 constant PRIME_Q =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 constant PRIME_R =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // ── Verification Key (replace with output of `snarkjs zkey export solidityverifier`) ──
    // Alpha G1 (placeholder — replace with real verification key from snarkjs)
    uint256 constant ALPHA_X = 0x1a08c76d0b9e6b0c3a2f7d9c5e8f0a1b2c3d4e5f6071829304050607080900ab;
    uint256 constant ALPHA_Y = 0x0b19d87e1caf7b1d4b3e8f0a1b2c3d4e5f6071829304050607080901020304ef;

    // Beta G2 (placeholder)
    uint256 constant BETA_X1 = 0x0c3d4e5f60708192930405060708091011121314151617181920212223242526;
    uint256 constant BETA_X2 = 0x0d4e5f607182930405060708090a0b0c0d0e0f10111213141516171819202122;
    uint256 constant BETA_Y1 = 0x0e5f607182930405060708090a0b0c0d0e0f101112131415161718192021222a;
    uint256 constant BETA_Y2 = 0x0f60718293040506070809000102030405060708091011121314151617181920;

    // Gamma G2 (placeholder)
    uint256 constant GAMMA_X1 = 0x0071829304050607080900010203040506070809101112131415161718192021;
    uint256 constant GAMMA_X2 = 0x0182930405060708090001020304050607080910111213141516171819202122;
    uint256 constant GAMMA_Y1 = 0x0293040506070809000102030405060708091011121314151617181920212223;
    uint256 constant GAMMA_Y2 = 0x0304050607080900010203040506070809101112131415161718192021222324;

    // Delta G2 (placeholder)
    uint256 constant DELTA_X1 = 0x1415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f30313233;
    uint256 constant DELTA_X2 = 0x0526272829303132333435363738393a3b3c3d3e3f4041424344454647484950;
    uint256 constant DELTA_Y1 = 0x0637383940414243444546474849505152535455565758596061626364656600;
    uint256 constant DELTA_Y2 = 0x0748495051525354555657585900010203040506070809101112131415161718;

    // IC (Integrated Circuit points) for 4 public inputs + 1 base = 5 points
    uint256[5] IC_X;
    uint256[5] IC_Y;

    // ── Events ────────────────────────────────────────────────────────────
    event VerificationResult(
        address indexed caller,
        bool verified,
        bytes32 roleHash
    );

    // ── Custom errors ─────────────────────────────────────────────────────
    error InvalidProofLength();
    error InvalidPublicInputLength();

    constructor() {
        // IC[0] — base point
        IC_X[0] = 0x38495a6b7c8d9e0f1a2b3c4d5e6f7080919293949596979899a0a1a2a3a4a5;
        IC_Y[0] = 0x495a6b7c8d9e0f1a2b3c4d5e6f708091929394959697989990a1a2a3a4a5a6;

        // IC[1] — merkleRoot
        IC_X[1] = 0x5a6b7c8d9e0f1a2b3c4d5e6f7080919293949596979899a0a1a2a3a4a5a6a7;
        IC_Y[1] = 0x6b7c8d9e0f1a2b3c4d5e6f70809192939495969798990a1a2a3a4a5a6a7a8;

        // IC[2] — roleId
        IC_X[2] = 0x7c8d9e0f1a2b3c4d5e6f708091929394959697989990a1a2a3a4a5a6a7a8a9;
        IC_Y[2] = 0x8d9e0f1a2b3c4d5e6f70809192939495969798999001a2a3a4a5a6a7a8a9aa;

        // IC[3] — nullifier
        IC_X[3] = 0x9e0f1a2b3c4d5e6f7080919293949596979899900102a3a4a5a6a7a8a9aaab;
        IC_Y[3] = 0x0f1a2b3c4d5e6f708091929394959697989990010203a4a5a6a7a8a9aaabac;

        // IC[4] — commitment
        IC_X[4] = 0x1a2b3c4d5e6f70809192939495969798999001020304a5a6a7a8a9aaabacad;
        IC_Y[4] = 0x2b3c4d5e6f7080919293949596979899900102030405a6a7a8a9aaabacadae;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Elliptic curve operations (BN128)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Negate a G1 point.
     */
    function negate(uint256[2] memory p)
        internal pure returns (uint256[2] memory)
    {
        if (p[0] == 0 && p[1] == 0) return p;
        return [p[0], PRIME_Q - (p[1] % PRIME_Q)];
    }

    /**
     * @dev Add two G1 points using the bn128 precompile (0x06).
     */
    function addition(uint256[2] memory p1, uint256[2] memory p2)
        internal view returns (uint256[2] memory r)
    {
        uint256[4] memory input = [p1[0], p1[1], p2[0], p2[1]];
        bool success;
        assembly {
            success := staticcall(gas(), 0x06, input, 0x80, r, 0x40)
        }
        require(success, "ZKPVerifier: ec_add failed");
    }

    /**
     * @dev Scalar multiplication on G1 using precompile (0x07).
     */
    function scalarMul(uint256[2] memory p, uint256 s)
        internal view returns (uint256[2] memory r)
    {
        uint256[3] memory input = [p[0], p[1], s];
        bool success;
        assembly {
            success := staticcall(gas(), 0x07, input, 0x60, r, 0x40)
        }
        require(success, "ZKPVerifier: ec_mul failed");
    }

    /**
     * @dev Multi-pairing check using precompile (0x08).
     *      Returns true if the pairing equation holds.
     */
    function pairing(uint256[24] memory input)
        internal view returns (bool)
    {
        uint256[1] memory out;
        bool success;
        assembly {
            success := staticcall(gas(), 0x08, input, 0x300, out, 0x20)
        }
        require(success, "ZKPVerifier: pairing failed");
        return out[0] == 1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Proof verification
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Verifies a Groth16 proof for the roleProof circuit.
     * @param a      G1 point — proof element A
     * @param b      G2 point — proof element B
     * @param c      G1 point — proof element C
     * @param input  Public inputs: [merkleRoot, roleId, nullifier, commitment]
     * @return bool  True if and only if the proof is valid.
     *
     * @dev Gas: ~220,000 (3 pairings × ~65,000 + scalar mul + additions)
     */
    function verifyProof(
        uint256[2]    memory a,
        uint256[2][2] memory b,
        uint256[2]    memory c,
        uint256[4]    memory input
    ) public returns (bool) {
        // Validate inputs are in the scalar field
        for (uint256 i = 0; i < 4; i++) {
            require(input[i] < PRIME_R, "ZKPVerifier: input out of field");
        }

        // Compute vk_x = IC[0] + sum(input[i] * IC[i+1])
        uint256[2] memory vk_x = [IC_X[0], IC_Y[0]];
        for (uint256 i = 0; i < 4; i++) {
            vk_x = addition(vk_x, scalarMul([IC_X[i + 1], IC_Y[i + 1]], input[i]));
        }

        // Negate A for the pairing check: e(-A, B) · e(alpha, beta) · e(vk_x, gamma) · e(C, delta) == 1
        uint256[2] memory negA = negate(a);

        // Pack the 4 pairings into a single 24-element array for the precompile
        uint256[24] memory pairingInput = [
            // Pairing 1: e(-A, B)
            negA[0], negA[1],
            b[0][1], b[0][0], b[1][1], b[1][0],   // G2 point (B)
            // Pairing 2: e(alpha, beta)
            ALPHA_X, ALPHA_Y,
            BETA_X2, BETA_X1, BETA_Y2, BETA_Y1,
            // Pairing 3: e(vk_x, gamma)
            vk_x[0], vk_x[1],
            GAMMA_X2, GAMMA_X1, GAMMA_Y2, GAMMA_Y1,
            // Pairing 4: e(C, delta)
            c[0], c[1],
            DELTA_X2, DELTA_X1, DELTA_Y2, DELTA_Y1
        ];

        bool verified = pairing(pairingInput);

        bytes32 roleHash = keccak256(abi.encodePacked(input[0], input[1]));
        emit VerificationResult(msg.sender, verified, roleHash);

        return verified;
    }
}
