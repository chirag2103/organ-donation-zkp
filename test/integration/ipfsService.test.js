const { expect } = require('chai');
const ipfsService = require('../../server/ipfsService');
const http = require('http');

// Requires a running IPFS Kubo daemon on http://127.0.0.1:5001.
// Every test skips gracefully (this.skip()) when the daemon isn't reachable,
// so `npm run test:integration` still passes without IPFS installed.
describe('IPFS Service Integration', function () {
  this.timeout(30000);

  let ipfsDaemonRunning = false;

  before(async function () {
    // Check if IPFS daemon is running on port 5001
    await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 5001,
        path: '/api/v0/version',
        method: 'POST',
      }, (res) => {
        if (res.statusCode === 200) ipfsDaemonRunning = true;
        resolve();
      });
      req.on('error', () => resolve());
      req.end();
    });

    if (!ipfsDaemonRunning) {
      console.warn('    ⚠️  IPFS daemon not detected on :5001 — skipping ipfsService integration tests.');
      this.skip();
    }

    await ipfsService.initIPFS();
  });

  it('✓ uploads a Buffer and returns a valid CIDv1 string', async function () {
    const data = Buffer.from(JSON.stringify({ test: true, ts: Date.now() }));
    const { cid } = await ipfsService.uploadEncryptedRecord(data);

    expect(cid).to.be.a('string');
    // CIDv0 ("Qm..."), or CIDv1 base32 - "bafy..." (dag-pb) / "bafk..." (raw,
    // this Kubo version's default leaf codec for ipfsClient.add()).
    expect(cid.startsWith('Qm') || cid.startsWith('bafy') || cid.startsWith('bafk')).to.be.true;
    expect(cid.length).to.be.greaterThan(10);
  });

  it('✓ round-trips an uploaded encrypted record (upload -> download -> decrypt)', async function () {
    await require('../../server/pfeService').initPFE();
    const pfeService = require('../../server/pfeService');
    const roleKey = await pfeService.issueRoleScopedKey(0, ethersHex());

    const originalRecord = pfeService.encryptWithRoleKey(
      'round-trip-test-' + Date.now(),
      roleKey
    );
    const { cid } = await ipfsService.uploadEncryptedRecord(Buffer.from(originalRecord, 'base64'));
    const retrieved = await ipfsService.downloadRecord(cid, roleKey);

    expect(retrieved.toString()).to.include('round-trip-test-');
  });

  it('✓ unpins a record successfully', async function () {
    const { cid } = await ipfsService.uploadEncryptedRecord(Buffer.from('to-unpin'));
    const result = await ipfsService.unpinRecord(cid);
    expect(result.success).to.be.true;
  });

  it('✓ unpinning a non-existent/invalid CID returns a graceful error (does not throw)', async function () {
    const result = await ipfsService.unpinRecord('QmInvalidCIDThatDoesNotExist123');
    expect(result.success).to.be.false;
    expect(result.error).to.be.a('string');
  });

  it('✓ checkIPFS() reports true when the daemon is reachable', async function () {
    const ok = await ipfsService.checkIPFS();
    expect(ok).to.be.true;
  });
});

// keccak256("bench") as a stand-in commitment hex for issueRoleScopedKey in the
// round-trip test above (no on-chain call needed for this integration point).
function ethersHex() {
  const { ethers } = require('ethers');
  return ethers.keccak256(ethers.toUtf8Bytes('ipfs-roundtrip-key'));
}
