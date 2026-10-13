// Types for edge.mjs, which stays plain JavaScript so server.mjs can run under
// plain Node. scripts/verify-api.ts imports it and is typechecked.
export declare const EDGE_HOST: "127.0.0.1";
export declare const EDGE_PORT: 3100;
export declare const CLIENT_ADDRESS_HEADER: "x-fuel-client-address";
export declare const EDGE_PROOF_HEADER: "x-fuel-edge-proof";
export declare const EDGE_PROOF_ENV: "FUEL_EDGE_PROOF";
type HeaderBag = Record<string, string | string[] | undefined>;
export declare function stampEdgeHeaders(
  headers: HeaderBag,
  remoteAddress: string | undefined,
  proof: string,
): HeaderBag;
