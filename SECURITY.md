# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use GitHub's
**Report a vulnerability** button on this repository's *Security* tab.

If that button isn't available, open an issue that only says you have a security
report and asks for a private contact, with no details.

The most useful reports include the affected file or endpoint, the steps to
reproduce, and the impact you expect.

## Scope

- The fleet server (`cmd/humansi`, `internal/`): scoring validation, launch
  clearance tokens, rate limits and the SI console relay.
- The web front end (`web/`).

The SI console relays to a model running on the operator's own machine through
Ollama. Problems inside third-party models are out of scope; report those to the model's publisher.
