export const config = { runtime: "edge" };
export const preferredRegion = "iad1";

import { handleRequest } from "../lib/handler.mjs";

export default async function handler(request) {
  return handleRequest(request);
}
