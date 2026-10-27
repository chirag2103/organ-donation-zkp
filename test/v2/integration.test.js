const { execFile } = require("child_process");
const path = require("path");
describe("Live browser / API / IPFS / blockchain acceptance", function () {
  this.timeout(300000);
  it("runs the isolated complete synthetic demonstration", function (done) {
    if (process.env.RUN_LIVE_E2E !== "1") {
      console.log(
        "Live stack explicitly skipped: run npm run demo (requires Kubo and Edge)."
      );
      this.skip();
      return;
    }
    execFile(
      process.execPath,
      [path.resolve("scripts/demo.js")],
      { windowsHide: true, timeout: 280000 },
      (error, stdout, stderr) => {
        if (stdout) console.log(stdout);
        if (error) console.error(stderr);
        done(error);
      }
    );
  });
});
