import { describe, expect, it } from "vitest";
import { assertKey, createS3 } from "../src/index.js";

/** Runs against the Docker SeaweedFS S3 (dev compose). */
const cfg = { endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:58333", accessKey: process.env.S3_ACCESS_KEY ?? "wim_s3_dev", secretKey: process.env.S3_SECRET_KEY ?? "wim_s3_dev_password", bucket: "wim-storage-test" };

describe("S3 client", () => {
  it("put/get/delete with SigV4 against real S3; anonymous and wrongly signed access refused", async () => {
    const s3 = createS3(cfg);
    await s3.ensureBucket();
    const key = `orgs/test/${Date.now()}/shot-1.png`;
    await s3.put(key, Buffer.from("PNGDATA"), "image/png");
    expect((await s3.get(key))!.toString()).toBe("PNGDATA");
    expect((await fetch(`${cfg.endpoint}/${cfg.bucket}/${key}`)).status).toBe(403);
    const wrong = createS3({ ...cfg, secretKey: "not-the-secret" });
    await expect(wrong.get(key)).rejects.toThrow(/403/);
    await s3.delete(key);
    expect(await s3.get(key)).toBeNull();
  });
  it("refuses unsafe keys", () => {
    for (const k of ["../x", "a/../b", "/abs", "a//b", "a b", ""]) expect(() => assertKey(k), k).toThrow();
  });
});
