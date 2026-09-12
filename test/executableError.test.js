const assert = require("node:assert/strict");
const test = require("node:test");

const { describeOndaExecutableError } = require("../out/executableError.js");

test("explains how to configure a missing Onda executable", () => {
  const error = Object.assign(new Error("spawn onda ENOENT"), { code: "ENOENT" });

  assert.deepEqual(describeOndaExecutableError("onda", error), {
    message:
      "Onda executable 'onda' was not found. Install Onda and add it to PATH, "
      + "or set 'onda.server.path' to the executable's full path.",
    canConfigure: true,
  });
});

test("recognizes the string error emitted by the language client", () => {
  const description = describeOndaExecutableError(
    "/missing/onda",
    "Launching server using command /missing/onda failed. Error: spawn /missing/onda ENOENT",
  );

  assert.equal(description.canConfigure, true);
  assert.match(description.message, /'\/missing\/onda' was not found/);
});

test("explains executable permission errors", () => {
  const error = Object.assign(new Error("spawn /opt/onda EACCES"), { code: "EACCES" });
  const description = describeOndaExecutableError("/opt/onda", error);

  assert.equal(description.canConfigure, true);
  assert.match(description.message, /permission was denied/);
});

test("preserves unrelated errors", () => {
  assert.deepEqual(describeOndaExecutableError("onda", new Error("connection closed")), {
    message: "connection closed",
    canConfigure: false,
  });
});
