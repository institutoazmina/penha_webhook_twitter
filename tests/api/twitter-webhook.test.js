const request = require("supertest");
const app = require("../../src/api/index");

describe("Testing the webhook endpoint", () => {
    test("GET method (without crc_token)", () => {
        return request(app)
            .get("/twitter-webhook")
            .then(response => {
                expect(response.statusCode).toBe(400);
                expect(response.body.error).toBe('crc_token');
                expect(response.body.error_type).toBe('missing');
            });
    });

    test("GET method (without crc_token)", () => {
        return request(app)
            .get("/twitter-webhook?crc_token=foobar")
            .then(response => {
                expect(response.statusCode).toBe(400);
                expect(response.body.error).toBe('crc_token');
                expect(response.body.error_type).toBe('missing');
            });
    });
});