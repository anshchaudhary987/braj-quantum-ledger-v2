import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../../src/api/server";

describe("Health Endpoint", () => {
  it("returns 200 with ok status", async () => {
    const response = await request(app)
      .get("/health")
      .expect("Content-Type", /json/)
      .expect(200);

    expect(response.body.status).toBe("ok");
    expect(response.body.timestamp).toBeDefined();
  });
});
