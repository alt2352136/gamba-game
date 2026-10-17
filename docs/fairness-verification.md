# Independent fairness verification

The browser has a built-in check for the history currently available to that session. The standalone verifier is an additional tool that lets a reviewer reproduce the cryptographic calculations with Node.js, independently of the browser and Worker helper modules.

## Input format

Prepare a UTF-8 JSON file containing the complete `seeds` and `rounds` arrays returned by `/api/fairness`. The export may include the `houseEdgePercent` field. Keep the public API field names unchanged. For example:

```json
{
  "houseEdgePercent": 1,
  "seeds": [
    {
      "epoch": 1,
      "commitment": "SHA-256 commitment as 64 hex characters",
      "revealed_seed": "revealed 32-byte seed as 64 hex characters"
    }
  ],
  "rounds": [
    {
      "id": "round ID",
      "epoch": 1,
      "nonce": 1,
      "client_seed": "client seed",
      "edge_percent": 1,
      "status": "busted",
      "crash_point": 1.39
    }
  ]
}
```

The example values are illustrative, not a real round record. Include all pages when verifying more than one API page; merging pages must preserve all records and their original field values. An unrevealed seed is expected for the current epoch, so records depending on it are reported as pending rather than failed.

## Run it

From the repository root:

```sh
node tools/verify-fairness.js fairness-export.json
```

The command prints a JSON report with the number of verified seed epochs and rounds, pending records, and any mismatches. It exits with status `2` when a verification mismatch is found, and `1` when the input cannot be read as valid JSON. `passed: true` means no inconsistency was found in the supplied records; `complete: true` additionally means no seed or round remains pending.

## Fixed vector

`tools/fairness-test-vectors.json` contains a fixed known input, expected HMAC-SHA-256 digest, commitment and crash point. Automated tests verify these expected values. A reviewer can use the vector to check that the standalone verifier implements the published formula consistently.

## What this does not prove

Verification cannot establish that no rounds were omitted from an export, that all users see the same history, or that deployed code remained unchanged. It verifies only the authenticity and arithmetic consistency of the supplied records against the published commitment and algorithm.
