const request = require("supertest");
const app = require("../../src/api/index");

describe("Testing the health check endpoint", () => {
  test("It should response the GET method", () => {
    return request(app)
      .get("/health-check")
      .then(response => {
        expect(response.statusCode).toBe(200);
      });
  });
});