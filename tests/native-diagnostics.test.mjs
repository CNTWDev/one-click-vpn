import assert from "node:assert/strict";
import test from "node:test";
import { scrubDetail } from "../server/scrub-detail.ts";

test("client error texts keep the reason and lose every address", () => {
  assert.equal(scrubDetail("yaml: line 3: found unknown escape character"), "yaml: line 3: found unknown escape character");
  assert.equal(scrubDetail("dial tcp 203.0.113.7:443: i/o timeout"), "dial tcp …: i/o timeout");
  assert.equal(scrubDetail("dial udp [2001:db8::1]:8443: connection refused"), "dial udp …: connection refused");
  assert.equal(scrubDetail("lookup api.example.com: no such host"), "lookup …: no such host");
  assert.equal(scrubDetail("Get https://api.example.com/v2/native/connect failed"), "Get … failed");
  assert.equal(scrubDetail("bad key yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk="), "bad key …");
  assert.equal(scrubDetail("x".repeat(500))?.length, 1);
  assert.equal(scrubDetail("a ".repeat(300))?.length, 200);
  assert.equal(scrubDetail(42), null);
  assert.equal(scrubDetail("   "), null);
});
